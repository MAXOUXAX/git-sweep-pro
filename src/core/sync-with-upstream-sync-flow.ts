import type { BranchItem } from './branch-list';
import { parseBranches } from './branch-list';
import { syncMessages } from './sync-with-upstream-messages';
import {
	isRebaseInProgress,
	resolveGitDir,
	saveMemento,
	TEMP_BRANCH_PREFIX,
	type SyncWithUpstreamDeps,
} from './sync-with-upstream-state';
import type { QuickPickItemLike } from './sweep-workflow';

type RunGit = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

type PrepareUpstreamResult = {
	branchToRebaseOnto: string;
	tempBranchToCleanup: string | undefined;
};

async function prepareUpstreamForRebase(
	deps: SyncWithUpstreamDeps,
	runGit: RunGit,
	targetItem: BranchItem,
	upstreamRef: string
): Promise<PrepareUpstreamResult> {
	if (targetItem.isRemote) {
		const safeSuffix = upstreamRef.replace(/[/\s]/g, '_').slice(0, 40);
		const tempBranch = `${TEMP_BRANCH_PREFIX}${safeSuffix}`;

		await deps.ui.withProgress(
			{ title: syncMessages.creatingTempBranch(upstreamRef) },
			() => runGit(['checkout', '-B', tempBranch, upstreamRef])
		);

		try {
			const slashIdx = upstreamRef.indexOf('/');
			const remoteName = upstreamRef.slice(0, slashIdx);
			const branchName = upstreamRef.slice(slashIdx + 1);
			await deps.ui.withProgress(
				{ title: syncMessages.pulling(upstreamRef) },
				() => runGit(['pull', remoteName, branchName])
			);
		} catch {
			deps.output.appendLine(syncMessages.infoPullSkipped);
		}

		return { branchToRebaseOnto: tempBranch, tempBranchToCleanup: tempBranch };
	}

	await deps.ui.withProgress(
		{ title: syncMessages.checkingOut(upstreamRef) },
		() => runGit(['checkout', upstreamRef])
	);

	try {
		await deps.ui.withProgress(
			{ title: syncMessages.pulling(upstreamRef) },
			() => runGit(['pull'])
		);
	} catch {
		deps.output.appendLine(syncMessages.infoPullSkippedLocal);
	}

	return { branchToRebaseOnto: upstreamRef, tempBranchToCleanup: undefined };
}

async function maybeSyncLocalBranchFromRemote(
	deps: SyncWithUpstreamDeps,
	runGit: RunGit,
	upstreamRef: string,
	featureBranch: string,
	branchToRebaseOnto: string
): Promise<void> {
	try {
		await runGit(['branch', '-D', branchToRebaseOnto]);
	} catch {
		deps.output.appendLine(syncMessages.infoTempBranchNotDeleted(branchToRebaseOnto));
	}
	const slashIdx = upstreamRef.indexOf('/');
	const localUpstream = slashIdx > 0 ? upstreamRef.slice(slashIdx + 1) : upstreamRef;

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
			const match = line?.match(/^(stash@\{\d+\})/);
			const ref = match?.[1] ?? 'stash@{0}';
			deps.output.appendLine(syncMessages.infoStashRefOnFailure(ref));
		}
	}
}

function showSyncErrorMessage(deps: SyncWithUpstreamDeps, message: string): void {
	const lowerMessage = message.toLowerCase();
	if (lowerMessage.includes('not a git repository')) {
		deps.ui.showErrorMessage(syncMessages.notGitRepo);
	} else if (lowerMessage.includes('command not found') || lowerMessage.includes('enoent')) {
		deps.ui.showErrorMessage(syncMessages.gitNotInstalled);
	} else {
		deps.ui.showErrorMessage(syncMessages.errorGeneric(message));
	}
}

export async function runSyncFlow(deps: SyncWithUpstreamDeps): Promise<void> {
	const workspaceRoot = deps.getWorkspaceRoot();
	if (!workspaceRoot) {
		deps.ui.showErrorMessage(syncMessages.noWorkspace);
		return;
	}

	const gitDir = await resolveGitDir(workspaceRoot, deps);
	if (!gitDir) {
		deps.ui.showErrorMessage(syncMessages.notGitRepo);
		return;
	}

	if (isRebaseInProgress(gitDir, deps)) {
		deps.ui.showInformationMessage(syncMessages.rebaseAlreadyInProgress);
		return;
	}

	deps.output.appendLine(syncMessages.outputHeader);
	deps.output.appendLine(`Workspace: ${workspaceRoot}`);

	const runGit = (args: string[]) => deps.runGitCommand(args, workspaceRoot);

	let featureBranch: string | undefined;
	let hasStash = false;
	let tempBranchToCleanup: string | undefined;
	let skipOuterCleanup = false;

	try {
		await deps.ui.withProgress(
			{ title: syncMessages.fetchingRemotes },
			() => runGit(['fetch', '-p'])
		);

		const [currentBranchResult, branchListResult] = await Promise.all([
			runGit(['rev-parse', '--abbrev-ref', 'HEAD']),
			runGit(['branch', '-a']),
		]);

		featureBranch = currentBranchResult.stdout.trim();
		if (!featureBranch || featureBranch === 'HEAD') {
			deps.ui.showErrorMessage(syncMessages.couldNotDetermineBranch);
			return;
		}

		const branchItems = parseBranches(branchListResult.stdout);
		if (branchItems.length === 0) {
			deps.ui.showInformationMessage(syncMessages.noBranchesForSync);
			return;
		}

		const quickPickItems = branchItems.map((b) => ({
			label: b.isRemote ? `${b.label} (remote)` : b.label,
			description: b.isRemote ? undefined : 'local',
			picked: false,
		}));

		const selected = await deps.ui.showQuickPick(quickPickItems, {
			canPickMany: false,
			ignoreFocusOut: true,
			matchOnDescription: true,
			title: syncMessages.pickBranchTitle,
			placeHolder: syncMessages.pickBranchPlaceholder,
		});

		const selectedItem: QuickPickItemLike | undefined =
			selected === undefined || Array.isArray(selected) ? undefined : (selected as QuickPickItemLike);
		if (!selectedItem) {
			deps.output.appendLine(syncMessages.operationCancelled);
			return;
		}

		const chosenLabel = selectedItem.label;
		const targetItem = branchItems.find((b) => {
			const label = b.isRemote ? `${b.label} (remote)` : b.label;
			return label === chosenLabel;
		});
		if (!targetItem) {
			return;
		}

		const upstreamRef = targetItem.ref;

		const statusResult = await runGit(['status', '--porcelain', '-u']).catch(() => ({ stdout: '', stderr: '' }));
		const hasLocalChanges = statusResult.stdout.trim().length > 0;
		if (hasLocalChanges) {
			try {
				await runGit(['stash', 'push', '-u', '-m', 'gsp-sync-with-upstream']);
				hasStash = true;
			} catch {
				deps.output.appendLine(syncMessages.infoNoStash);
			}
		}

		const isRemote = targetItem.isRemote;
		const { branchToRebaseOnto, tempBranchToCleanup: preparedTemp } = await prepareUpstreamForRebase(
			deps,
			runGit,
			targetItem,
			upstreamRef
		);
		tempBranchToCleanup = preparedTemp;

		await deps.ui.withProgress(
			{ title: syncMessages.returningTo(featureBranch) },
			() => runGit(['checkout', featureBranch!])
		);

		try {
			await deps.ui.withProgress(
				{ title: syncMessages.rebasing(upstreamRef) },
				() => runGit(['rebase', branchToRebaseOnto])
			);
		} catch (rebaseError) {
			const isConflict = isRebaseInProgress(gitDir, deps);

			if (isConflict) {
				await saveMemento(deps, {
					workspaceRoot,
					featureBranch,
					hasStash,
					upstreamRef,
					...(isRemote && { tempBranchToCleanup: branchToRebaseOnto }),
				});
				deps.ui.showInformationMessage(syncMessages.rebaseConflicts);
				deps.output.appendLine(syncMessages.outputRebasePaused);
				return;
			}
			throw rebaseError;
		}

		try {
			await deps.ui.withProgress(
				{ title: syncMessages.forcePush },
				() => runGit(['push', '--force-with-lease'])
			);
		} catch (pushError) {
			const msg = pushError instanceof Error ? pushError.message : String(pushError);

			let memento = {
				workspaceRoot,
				featureBranch,
				hasStash,
				upstreamRef,
				...(isRemote && { tempBranchToCleanup: branchToRebaseOnto }),
			};
			await saveMemento(deps, memento);
			deps.output.appendLine(syncMessages.infoStateSavedForResume);

			if (hasStash) {
				try {
					await runGit(['stash', 'pop']);
					memento = { ...memento, hasStash: false };
					await saveMemento(deps, memento);
				} catch {
					/* noop */
				}
			}
			if (isRemote && branchToRebaseOnto) {
				try {
					await runGit(['branch', '-D', branchToRebaseOnto]);
					memento = { ...memento, tempBranchToCleanup: undefined };
					await saveMemento(deps, memento);
				} catch {
					/* noop */
				}
			}

			deps.ui.showErrorMessage(syncMessages.pushFailed(msg));
			skipOuterCleanup = true;
			throw pushError;
		}

		if (isRemote) {
			await maybeSyncLocalBranchFromRemote(deps, runGit, upstreamRef, featureBranch, branchToRebaseOnto);
		}

		if (hasStash) {
			try {
				await deps.ui.withProgress(
					{ title: syncMessages.recoveringStash },
					() => runGit(['stash', 'pop'])
				);
			} catch (popError) {
				deps.ui.showErrorMessage(syncMessages.rebaseOkStashFailed);
				deps.output.appendLine(`[stash-pop-error] ${popError}`);
			}
		}

		deps.output.appendLine(syncMessages.outputComplete);
		deps.ui.showInformationMessage(syncMessages.syncedWith(featureBranch, upstreamRef));
	} catch (error) {
		if (!skipOuterCleanup) {
			await cleanupAfterSyncError(deps, runGit, featureBranch, tempBranchToCleanup, hasStash);
		}

		const message = error instanceof Error ? error.message : String(error);

		if (!skipOuterCleanup) {
			showSyncErrorMessage(deps, message);
		}
		deps.output.appendLine(`[error] ${message}`);
		deps.output.appendLine(syncMessages.outputFailed);
	}
}
