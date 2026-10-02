import { chooseBranch, localBranchName, parseBranches, splitRemoteRef, type BranchItem } from './branch-list';
import { describeGitFailure, isNoUpstreamError, toErrorMessage } from './errors';
import { syncMessages } from './sync-messages';
import { clearMemento, isRebaseInProgress, saveMemento, TEMP_BRANCH_PREFIX, type SyncContext } from './sync-state';
import type { WorkflowOutcome } from './workflow';

/**
 * Name of the temporary branch a sync onto the remote `upstreamRef` uses.
 * Worktrees share branches, so the name also depends on the worktree's own
 * Git directory: syncs from two worktrees must not reset each other's branch.
 */
export function tempBranchNameFor(upstreamRef: string, gitDir: string): string {
	const safeSuffix = upstreamRef.replace(/[/\s]/g, '_').slice(0, 40);
	// djb2 hash of the full ref and Git directory: refs sharing a 40-char
	// prefix must not collide, or sync/cleanup could delete the wrong temp branch.
	const key = `${gitDir}\n${upstreamRef}`;
	let hash = 5381;
	for (let i = 0; i < key.length; i++) {
		hash = ((hash << 5) + hash + key.charCodeAt(i)) >>> 0;
	}
	return `${TEMP_BRANCH_PREFIX}${safeSuffix}_${hash.toString(16)}`;
}

async function prepareUpstreamForRebase(
	{ git, ui, output }: SyncContext,
	targetItem: BranchItem,
	upstreamRef: string,
	tempBranch: string | undefined
): Promise<string> {
	if (targetItem.isRemote && tempBranch) {
		await ui.withProgress(
			{ title: syncMessages.creatingTempBranch(upstreamRef) },
			() => git(['checkout', '-B', tempBranch, upstreamRef])
		);

		const { remote, branch } = splitRemoteRef(upstreamRef);
		await ui.withProgress(
			{ title: syncMessages.pulling(upstreamRef) },
			() => git(['pull', '--ff-only', remote ?? '', branch])
		);

		return tempBranch;
	}

	if (targetItem.inOtherWorktree) {
		// It cannot be checked out (and so pulled) here: rebase onto it as it is.
		output.appendLine(syncMessages.infoUpstreamInOtherWorktree(upstreamRef));
		return upstreamRef;
	}

	await ui.withProgress(
		{ title: syncMessages.checkingOut(upstreamRef) },
		() => git(['checkout', upstreamRef])
	);

	try {
		await ui.withProgress(
			{ title: syncMessages.pulling(upstreamRef) },
			() => git(['pull', '--ff-only'])
		);
	} catch (pullError) {
		if (!isNoUpstreamError(toErrorMessage(pullError))) {
			throw pullError;
		}
		output.appendLine(syncMessages.infoPullSkippedLocal);
	}

	return upstreamRef;
}

export async function syncLocalBranchFromRemote(
	{ git, output }: SyncContext,
	upstreamRef: string,
	featureBranch: string
): Promise<void> {
	const localUpstream = splitRemoteRef(upstreamRef).branch;

	if (localUpstream === featureBranch) {
		output.appendLine(syncMessages.infoUpdateSkippedSameBranch(localUpstream));
		return;
	}

	const branchExists = await git(['rev-parse', '--verify', `refs/heads/${localUpstream}`])
		.then(() => true)
		.catch(() => false);
	if (branchExists) {
		output.appendLine(syncMessages.infoUpdateSkippedExisting(localUpstream));
		return;
	}

	try {
		await git(['branch', localUpstream, upstreamRef]);
		output.appendLine(syncMessages.infoLocalBranchSynced(localUpstream, upstreamRef));
	} catch {
		output.appendLine(syncMessages.infoUpdateSkipped(localUpstream));
	}
}

async function cleanupAfterSyncError(
	{ git, ui, output }: SyncContext,
	featureBranch: string | undefined,
	tempBranchToCleanup: string | undefined,
	hasStash: boolean
): Promise<void> {
	if (!featureBranch && !tempBranchToCleanup && !hasStash) {
		return;
	}
	output.appendLine(syncMessages.infoCleanupAttempted);
	if (featureBranch) {
		try {
			await git(['checkout', featureBranch]);
		} catch {
			/* best-effort */
		}
	}
	if (tempBranchToCleanup) {
		try {
			await git(['branch', '-D', tempBranchToCleanup]);
		} catch {
			output.appendLine(syncMessages.infoTempBranchNotDeleted(tempBranchToCleanup));
		}
	}
	if (hasStash) {
		try {
			await git(['stash', 'pop']);
		} catch {
			const listResult = await git(['stash', 'list']).catch(() => ({ stdout: '', stderr: '' }));
			const line = listResult.stdout.split('\n').find((l) => l.includes('gsp-sync-with-upstream'));
			const ref = line?.match(/^(stash@\{\d+\})/)?.[1];
			if (ref) {
				output.appendLine(syncMessages.infoStashRefOnFailure(ref));
				ui.showErrorMessage(syncMessages.stashNotRestored(ref));
			} else {
				// Never point at stash@{0} blindly: it may be an unrelated stash.
				output.appendLine(syncMessages.infoStashUnknownRef);
				ui.showErrorMessage(syncMessages.stashNotRestoredUnknownRef);
			}
		}
	}
}

/**
 * Rebases the current branch onto `requested` (or the branch the user picks),
 * stashing local changes around it, then force-pushes with a lease. Pauses on
 * rebase conflicts; {@link runResumeWorkflow} picks up from there.
 */
export async function runSyncWorkflow(context: SyncContext, requested?: string): Promise<WorkflowOutcome> {
	const { git, ui, output } = context;
	if (isRebaseInProgress(context)) {
		ui.showInformationMessage(syncMessages.rebaseAlreadyInProgress);
		return 'paused';
	}

	output.header(syncMessages.outputHeader);
	output.header(`Workspace: ${context.root}`);

	let featureBranch: string | undefined;
	let hasStash = false;
	let tempBranchToCleanup: string | undefined;
	let skipOuterCleanup = false;
	let outcome: WorkflowOutcome = 'ok';

	try {
		await ui.withProgress({ title: syncMessages.fetchingRemotes }, () => git(['fetch', '-p']));

		const [currentBranchResult, branchListResult] = await Promise.all([
			git(['rev-parse', '--abbrev-ref', 'HEAD']),
			git(['branch', '--no-column', '-a']),
		]);

		const currentBranch = currentBranchResult.stdout.trim();
		if (!currentBranch || currentBranch === 'HEAD') {
			ui.showErrorMessage(syncMessages.couldNotDetermineBranch);
			output.appendLine(`[error] ${syncMessages.couldNotDetermineBranch}`);
			output.header(syncMessages.outputFailed);
			return 'failed';
		}

		const branchItems = parseBranches(branchListResult.stdout);
		if (branchItems.length === 0) {
			ui.showInformationMessage(syncMessages.noBranchesForSync);
			output.appendLine(syncMessages.operationCancelled);
			return 'cancelled';
		}

		const targetItem = await chooseBranch(ui, branchItems, {
			requested,
			title: syncMessages.pickBranchTitle,
			placeholder: syncMessages.pickBranchPlaceholder,
			describe: (b) => (b.isRemote ? undefined : b.inOtherWorktree ? 'local, checked out in another worktree (used as is)' : 'local'),
		});
		if (!targetItem) {
			output.appendLine(syncMessages.operationCancelled);
			return 'cancelled';
		}

		const upstreamRef = targetItem.ref;

		if (localBranchName(targetItem) === currentBranch) {
			ui.showInformationMessage(syncMessages.cannotSyncOntoItself(currentBranch));
			output.appendLine(syncMessages.operationCancelled);
			return 'cancelled';
		}

		// From here on, a failure returns to this branch and restores the stash.
		featureBranch = currentBranch;

		// A status failure must not pass for a clean tree: proceeding without a
		// stash would rebase over local changes, so let the outer catch abort.
		const statusResult = await git(['status', '--porcelain', '-u']);
		const hasLocalChanges = statusResult.stdout.trim().length > 0;
		if (hasLocalChanges) {
			// A stash failure here is a real error: continuing would rebase on a
			// dirty tree, so let the outer catch abort and clean up.
			await git(['stash', 'push', '-u', '-m', 'gsp-sync-with-upstream']);
			hasStash = true;
		}

		const isRemote = targetItem.isRemote;
		// Register the temp branch for cleanup before creating it, so a failure
		// inside prepareUpstreamForRebase (e.g. pull error) still cleans it up.
		if (isRemote) {
			tempBranchToCleanup = tempBranchNameFor(upstreamRef, context.gitDir);
		}
		const branchToRebaseOnto = await prepareUpstreamForRebase(context, targetItem, upstreamRef, tempBranchToCleanup);

		const makeMemento = () => ({
			workspaceRoot: context.root,
			featureBranch: currentBranch,
			hasStash,
			upstreamRef,
			upstreamIsRemote: isRemote,
			...(isRemote && { tempBranchToCleanup: branchToRebaseOnto }),
		});

		await ui.withProgress(
			{ title: syncMessages.returningTo(featureBranch) },
			() => git(['checkout', currentBranch])
		);

		try {
			await ui.withProgress(
				{ title: syncMessages.rebasing(upstreamRef) },
				() => git(['rebase', branchToRebaseOnto])
			);
		} catch (rebaseError) {
			const isConflict = isRebaseInProgress(context);

			if (isConflict) {
				await saveMemento(context, makeMemento());
				ui.showInformationMessage(syncMessages.rebaseConflicts);
				output.header(syncMessages.outputRebasePaused);
				return 'paused';
			}
			throw rebaseError;
		}

		try {
			await ui.withProgress(
				{ title: syncMessages.forcePush },
				() => git(['push', '--force-with-lease'])
			);
		} catch (pushError) {
			const msg = toErrorMessage(pushError);

			let memento = makeMemento();
			await saveMemento(context, memento);
			output.appendLine(syncMessages.infoStateSavedForResume);

			if (hasStash) {
				try {
					await git(['stash', 'pop']);
					memento = { ...memento, hasStash: false };
					await saveMemento(context, memento);
				} catch (popError) {
					// The memento keeps hasStash: true, so Resume will retry the pop.
					const popMsg = toErrorMessage(popError);
					output.appendLine(`[stash-pop-error] ${popMsg}`);
					output.appendLine(syncMessages.infoStashKeptForResume);
				}
			}
			if (isRemote && branchToRebaseOnto) {
				try {
					await git(['branch', '-D', branchToRebaseOnto]);
					memento = { ...memento, tempBranchToCleanup: undefined };
					await saveMemento(context, memento);
				} catch {
					output.appendLine(syncMessages.infoTempBranchNotDeleted(branchToRebaseOnto));
				}
			}

			ui.showErrorMessage(syncMessages.pushFailed(msg));
			skipOuterCleanup = true;
			throw pushError;
		}

		if (isRemote) {
			try {
				await git(['branch', '-D', branchToRebaseOnto]);
			} catch {
				output.appendLine(syncMessages.infoTempBranchNotDeleted(branchToRebaseOnto));
			}
			await syncLocalBranchFromRemote(context, upstreamRef, featureBranch);
		}

		if (hasStash) {
			try {
				await ui.withProgress(
					{ title: syncMessages.recoveringStash },
					() => git(['stash', 'pop'])
				);
			} catch (popError) {
				const popMsg = toErrorMessage(popError);
				ui.showErrorMessage(syncMessages.rebaseOkStashFailed);
				output.appendLine(`[stash-pop-error] ${popMsg}`);
				outcome = 'failed';
			}
		}

		// A stale memento from a previous conflict/push failure (resolved outside
		// the Resume command) must not survive a successful sync: Resume trusts
		// the memento and would otherwise act on the outdated state.
		await clearMemento(context);

		output.header(syncMessages.outputComplete);
		// After a failed stash pop, its error is the outcome: no success on top of it.
		if (outcome === 'ok') {
			ui.showInformationMessage(syncMessages.syncedWith(featureBranch, upstreamRef));
		}
		return outcome;
	} catch (error) {
		if (!skipOuterCleanup) {
			await cleanupAfterSyncError(context, featureBranch, tempBranchToCleanup, hasStash);
		}

		const message = toErrorMessage(error);

		if (!skipOuterCleanup) {
			ui.showErrorMessage(...describeGitFailure(message));
		}
		output.appendLine(`[error] ${message}`);
		output.header(syncMessages.outputFailed);
		return 'failed';
	} finally {
		output.header(syncMessages.outputSessionEnded);
	}
}
