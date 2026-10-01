import { toErrorMessage } from './errors';
import { branchPickLabel, findBranchByPickLabel, localBranchName, parseBranches, splitRemoteRef, type BranchItem } from './branch-list';
import { syncMessages } from './sync-with-upstream-messages';
import {
	clearMemento,
	isRebaseInProgress,
	resolveGitDir,
	saveMemento,
	showSyncGitCommandError,
	TEMP_BRANCH_PREFIX,
	type SyncWithUpstreamDeps,
} from './sync-with-upstream-state';
import { singlePick, type WorkflowOutcome } from './sweep-workflow';

type RunGit = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

export function tempBranchNameFor(upstreamRef: string): string {
	const safeSuffix = upstreamRef.replace(/[/\s]/g, '_').slice(0, 40);
	// djb2 hash of the full ref: refs sharing a 40-char prefix must not
	// collide, or sync/cleanup could delete the wrong temp branch.
	let hash = 5381;
	for (let i = 0; i < upstreamRef.length; i++) {
		hash = ((hash << 5) + hash + upstreamRef.charCodeAt(i)) >>> 0;
	}
	return `${TEMP_BRANCH_PREFIX}${safeSuffix}_${hash.toString(16)}`;
}

async function prepareUpstreamForRebase(
	deps: SyncWithUpstreamDeps,
	runGit: RunGit,
	targetItem: BranchItem,
	upstreamRef: string,
	tempBranch: string | undefined
): Promise<string> {
	if (targetItem.isRemote && tempBranch) {
		await deps.ui.withProgress(
			{ title: syncMessages.creatingTempBranch(upstreamRef) },
			() => runGit(['checkout', '-B', tempBranch, upstreamRef])
		);

		const { remote, branch } = splitRemoteRef(upstreamRef);
		await deps.ui.withProgress(
			{ title: syncMessages.pulling(upstreamRef) },
			() => runGit(['pull', '--ff-only', remote ?? '', branch])
		);

		return tempBranch;
	}

	await deps.ui.withProgress(
		{ title: syncMessages.checkingOut(upstreamRef) },
		() => runGit(['checkout', upstreamRef])
	);

	try {
		await deps.ui.withProgress(
			{ title: syncMessages.pulling(upstreamRef) },
			() => runGit(['pull', '--ff-only'])
		);
	} catch (pullError) {
		const msg = toErrorMessage(pullError);
		if (!/no upstream|no tracking|please specify.*branch/i.test(msg)) {
			throw pullError;
		}
		deps.output.appendLine(syncMessages.infoPullSkippedLocal);
	}

	return upstreamRef;
}

export async function syncLocalBranchFromRemote(
	deps: SyncWithUpstreamDeps,
	runGit: RunGit,
	upstreamRef: string,
	featureBranch: string
): Promise<void> {
	const localUpstream = splitRemoteRef(upstreamRef).branch;

	if (localUpstream === featureBranch) {
		deps.output.appendLine(syncMessages.infoUpdateSkippedSameBranch(localUpstream));
		return;
	}

	const branchExists = await runGit(['rev-parse', '--verify', `refs/heads/${localUpstream}`])
		.then(() => true)
		.catch(() => false);
	if (branchExists) {
		deps.output.appendLine(syncMessages.infoUpdateSkippedExisting(localUpstream));
		return;
	}

	try {
		await runGit(['branch', localUpstream, upstreamRef]);
		deps.output.appendLine(syncMessages.infoLocalBranchSynced(localUpstream, upstreamRef));
	} catch {
		deps.output.appendLine(syncMessages.infoUpdateSkipped(localUpstream));
	}
}

async function cleanupAfterSyncError(
	deps: SyncWithUpstreamDeps,
	runGit: RunGit,
	featureBranch: string | undefined,
	tempBranchToCleanup: string | undefined,
	hasStash: boolean
): Promise<void> {
	deps.output.appendLine(syncMessages.infoCleanupAttempted);
	if (featureBranch) {
		try {
			await runGit(['checkout', featureBranch]);
		} catch {
			/* best-effort */
		}
	}
	if (tempBranchToCleanup) {
		try {
			await runGit(['branch', '-D', tempBranchToCleanup]);
		} catch {
			deps.output.appendLine(syncMessages.infoTempBranchNotDeleted(tempBranchToCleanup));
		}
	}
	if (hasStash) {
		try {
			await runGit(['stash', 'pop']);
		} catch {
			const listResult = await runGit(['stash', 'list']).catch(() => ({ stdout: '', stderr: '' }));
			const line = listResult.stdout.split('\n').find((l) => l.includes('gsp-sync-with-upstream'));
			const ref = line?.match(/^(stash@\{\d+\})/)?.[1];
			if (ref) {
				deps.output.appendLine(syncMessages.infoStashRefOnFailure(ref));
				deps.ui.showErrorMessage(syncMessages.stashNotRestored(ref));
			} else {
				// Never point at stash@{0} blindly: it may be an unrelated stash.
				deps.output.appendLine(syncMessages.infoStashUnknownRef);
				deps.ui.showErrorMessage(syncMessages.stashNotRestoredUnknownRef);
			}
		}
	}
}

export async function runSyncFlow(deps: SyncWithUpstreamDeps): Promise<WorkflowOutcome> {
	const workspaceRoot = deps.getWorkspaceRoot();
	if (!workspaceRoot) {
		deps.ui.showErrorMessage(syncMessages.noWorkspace);
		return 'failed';
	}

	let gitDir: string | undefined;
	try {
		gitDir = await resolveGitDir(workspaceRoot, deps);
	} catch (error) {
		const message = toErrorMessage(error);
		showSyncGitCommandError(deps, message);
		return 'failed';
	}
	if (!gitDir) {
		deps.ui.showErrorMessage(syncMessages.notGitRepo);
		return 'failed';
	}

	if (isRebaseInProgress(gitDir, deps)) {
		deps.ui.showInformationMessage(syncMessages.rebaseAlreadyInProgress);
		return 'paused';
	}

	deps.output.show(true);
	deps.output.header(syncMessages.outputHeader);
	deps.output.header(`Workspace: ${workspaceRoot}`);

	const runGit = (args: string[]) => deps.runGitCommand(args, workspaceRoot);

	let featureBranch: string | undefined;
	let hasStash = false;
	let tempBranchToCleanup: string | undefined;
	let skipOuterCleanup = false;
	let outcome: WorkflowOutcome = 'ok';

	try {
		await deps.ui.withProgress(
			{ title: syncMessages.fetchingRemotes },
			() => runGit(['fetch', '-p'])
		);

		const [currentBranchResult, branchListResult] = await Promise.all([
			runGit(['rev-parse', '--abbrev-ref', 'HEAD']),
			runGit(['branch', '--no-column', '-a']),
		]);

		const currentBranch = currentBranchResult.stdout.trim();
		if (!currentBranch || currentBranch === 'HEAD') {
			deps.ui.showErrorMessage(syncMessages.couldNotDetermineBranch);
			deps.output.appendLine(`[error] ${syncMessages.couldNotDetermineBranch}`);
			deps.output.header(syncMessages.outputFailed);
			return 'failed';
		}
		featureBranch = currentBranch;

		const branchItems = parseBranches(branchListResult.stdout);
		if (branchItems.length === 0) {
			deps.ui.showInformationMessage(syncMessages.noBranchesForSync);
			deps.output.appendLine(syncMessages.operationCancelled);
			return 'cancelled';
		}

		const quickPickItems = branchItems.map((b) => ({
			label: branchPickLabel(b),
			description: b.isRemote ? undefined : 'local',
		}));

		const selected = await deps.ui.showQuickPick(quickPickItems, {
			canPickMany: false,
			ignoreFocusOut: true,
			matchOnDescription: true,
			title: syncMessages.pickBranchTitle,
			placeHolder: syncMessages.pickBranchPlaceholder,
		});

		const selectedItem = singlePick(selected);
		if (!selectedItem) {
			deps.output.appendLine(syncMessages.operationCancelled);
			return 'cancelled';
		}

		const targetItem = findBranchByPickLabel(branchItems, selectedItem.label);
		if (!targetItem) {
			deps.ui.showErrorMessage(syncMessages.internalBranchNotFound);
			deps.output.appendLine(`[error] ${syncMessages.internalBranchNotFound}`);
			deps.output.header(syncMessages.outputFailed);
			return 'failed';
		}

		const upstreamRef = targetItem.ref;

		if (localBranchName(targetItem) === featureBranch) {
			deps.ui.showInformationMessage(syncMessages.cannotSyncOntoItself(featureBranch));
			deps.output.appendLine(syncMessages.operationCancelled);
			return 'cancelled';
		}

		// A status failure must not pass for a clean tree: proceeding without a
		// stash would rebase over local changes, so let the outer catch abort.
		const statusResult = await runGit(['status', '--porcelain', '-u']);
		const hasLocalChanges = statusResult.stdout.trim().length > 0;
		if (hasLocalChanges) {
			// A stash failure here is a real error: continuing would rebase on a
			// dirty tree, so let the outer catch abort and clean up.
			await runGit(['stash', 'push', '-u', '-m', 'gsp-sync-with-upstream']);
			hasStash = true;
		}

		const isRemote = targetItem.isRemote;
		// Register the temp branch for cleanup before creating it, so a failure
		// inside prepareUpstreamForRebase (e.g. pull error) still cleans it up.
		if (isRemote) {
			tempBranchToCleanup = tempBranchNameFor(upstreamRef);
		}
		const branchToRebaseOnto = await prepareUpstreamForRebase(
			deps,
			runGit,
			targetItem,
			upstreamRef,
			tempBranchToCleanup
		);

		const makeMemento = () => ({
			workspaceRoot,
			featureBranch: currentBranch,
			hasStash,
			upstreamRef,
			upstreamIsRemote: isRemote,
			...(isRemote && { tempBranchToCleanup: branchToRebaseOnto }),
		});

		await deps.ui.withProgress(
			{ title: syncMessages.returningTo(featureBranch) },
			() => runGit(['checkout', currentBranch])
		);

		try {
			await deps.ui.withProgress(
				{ title: syncMessages.rebasing(upstreamRef) },
				() => runGit(['rebase', branchToRebaseOnto])
			);
		} catch (rebaseError) {
			const isConflict = isRebaseInProgress(gitDir, deps);

			if (isConflict) {
				await saveMemento(deps, makeMemento());
				deps.ui.showInformationMessage(syncMessages.rebaseConflicts);
				deps.output.header(syncMessages.outputRebasePaused);
				return 'paused';
			}
			throw rebaseError;
		}

		try {
			await deps.ui.withProgress(
				{ title: syncMessages.forcePush },
				() => runGit(['push', '--force-with-lease'])
			);
		} catch (pushError) {
			const msg = toErrorMessage(pushError);

			let memento = makeMemento();
			await saveMemento(deps, memento);
			deps.output.appendLine(syncMessages.infoStateSavedForResume);

			if (hasStash) {
				try {
					await runGit(['stash', 'pop']);
					memento = { ...memento, hasStash: false };
					await saveMemento(deps, memento);
				} catch (popError) {
					// The memento keeps hasStash: true, so Resume will retry the pop.
					const popMsg = toErrorMessage(popError);
					deps.output.appendLine(`[stash-pop-error] ${popMsg}`);
					deps.output.appendLine(syncMessages.infoStashKeptForResume);
				}
			}
			if (isRemote && branchToRebaseOnto) {
				try {
					await runGit(['branch', '-D', branchToRebaseOnto]);
					memento = { ...memento, tempBranchToCleanup: undefined };
					await saveMemento(deps, memento);
				} catch {
					deps.output.appendLine(syncMessages.infoTempBranchNotDeleted(branchToRebaseOnto));
				}
			}

			deps.ui.showErrorMessage(syncMessages.pushFailed(msg));
			skipOuterCleanup = true;
			throw pushError;
		}

		if (isRemote) {
			try {
				await runGit(['branch', '-D', branchToRebaseOnto]);
			} catch {
				deps.output.appendLine(syncMessages.infoTempBranchNotDeleted(branchToRebaseOnto));
			}
			await syncLocalBranchFromRemote(deps, runGit, upstreamRef, featureBranch);
		}

		if (hasStash) {
			try {
				await deps.ui.withProgress(
					{ title: syncMessages.recoveringStash },
					() => runGit(['stash', 'pop'])
				);
			} catch (popError) {
				const popMsg = toErrorMessage(popError);
				deps.ui.showErrorMessage(syncMessages.rebaseOkStashFailed);
				deps.output.appendLine(`[stash-pop-error] ${popMsg}`);
				outcome = 'failed';
			}
		}

		// A stale memento from a previous conflict/push failure (resolved outside
		// the Resume command) must not survive a successful sync: Resume trusts
		// the memento and would otherwise act on the outdated state.
		await clearMemento(deps);

		deps.output.header(syncMessages.outputComplete);
		deps.ui.showInformationMessage(syncMessages.syncedWith(featureBranch, upstreamRef));
		return outcome;
	} catch (error) {
		if (!skipOuterCleanup) {
			await cleanupAfterSyncError(deps, runGit, featureBranch, tempBranchToCleanup, hasStash);
		}

		const message = toErrorMessage(error);

		if (!skipOuterCleanup) {
			showSyncGitCommandError(deps, message);
		}
		deps.output.appendLine(`[error] ${message}`);
		deps.output.header(syncMessages.outputFailed);
		return 'failed';
	} finally {
		deps.output.header(syncMessages.outputSessionEnded);
	}
}
