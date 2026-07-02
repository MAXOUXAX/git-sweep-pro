import { syncMessages } from './sync-with-upstream-messages';
import {
	clearMemento,
	getMemento,
	isRebaseInProgress,
	readRebaseHeadName,
	resolveGitDir,
	showSyncGitCommandError,
	type SyncWithUpstreamDeps,
} from './sync-with-upstream-state';
import { syncLocalBranchFromRemote } from './sync-with-upstream-sync-flow';

export async function runResumeFlow(deps: SyncWithUpstreamDeps): Promise<void> {
	const workspaceRoot = deps.getWorkspaceRoot();
	if (!workspaceRoot) {
		deps.ui.showErrorMessage(syncMessages.noWorkspace);
		return;
	}

	let gitDir: string | undefined;
	try {
		gitDir = await resolveGitDir(workspaceRoot, deps);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		showSyncGitCommandError(deps, message);
		return;
	}
	if (!gitDir) {
		deps.ui.showErrorMessage(syncMessages.notGitRepo);
		return;
	}

	deps.output.show(true);
	deps.output.appendLine(syncMessages.outputResumeHeader);

	const runGit = (args: string[]) => deps.runGitCommand(args, workspaceRoot);

	const rebaseActive = isRebaseInProgress(gitDir, deps);
	const memento = getMemento(deps);

	if (!memento) {
		// Never resume a rebase this extension did not start: continuing and
		// force-pushing someone's manual rebase would be destructive.
		if (rebaseActive) {
			deps.ui.showErrorMessage(syncMessages.rebaseNotStartedByExtension);
			deps.output.appendLine(syncMessages.rebaseNotStartedByExtension);
		} else {
			deps.ui.showInformationMessage(syncMessages.noRebaseNothingToResume);
			deps.output.appendLine(syncMessages.nothingToResume);
		}
		return;
	}

	if (memento.workspaceRoot !== workspaceRoot) {
		deps.ui.showErrorMessage(syncMessages.rebaseInOtherWorkspace);
		deps.output.appendLine(syncMessages.rebaseInOtherWorkspace);
		return;
	}

	const featureBranch = memento.featureBranch;
	if (!featureBranch) {
		deps.ui.showErrorMessage(syncMessages.couldNotDetermineRebaseBranch);
		return;
	}
	const hasStash = memento.hasStash;
	const tempBranchToCleanup = memento.tempBranchToCleanup;

	if (rebaseActive) {
		const rebasingBranch = readRebaseHeadName(gitDir, deps);
		if (rebasingBranch && rebasingBranch !== featureBranch) {
			deps.ui.showErrorMessage(syncMessages.rebaseBranchMismatch(featureBranch, rebasingBranch));
			deps.output.appendLine(syncMessages.rebaseBranchMismatch(featureBranch, rebasingBranch));
			return;
		}
	}

	if (rebaseActive) {
		try {
			await deps.ui.withProgress(
				{ title: syncMessages.rebaseContinue },
				() => runGit(['rebase', '--continue'])
			);
		} catch (continueError) {
			const msg = continueError instanceof Error ? continueError.message : String(continueError);
			if (isRebaseInProgress(gitDir, deps)) {
				deps.ui.showErrorMessage(syncMessages.remainingConflicts);
				deps.output.appendLine(`[error] ${msg}`);
				return;
			}
			deps.ui.showErrorMessage(syncMessages.errorGeneric(msg));
			deps.output.appendLine(`[error] ${msg}`);
			return;
		}
	} else {
		deps.output.appendLine(syncMessages.infoNoRebaseInProgress);
	}

	if (!rebaseActive) {
		try {
			await deps.ui.withProgress(
				{ title: syncMessages.returningTo(featureBranch) },
				() => runGit(['checkout', featureBranch])
			);
		} catch (checkoutError) {
			const msg = checkoutError instanceof Error ? checkoutError.message : String(checkoutError);
			deps.ui.showErrorMessage(syncMessages.errorGeneric(msg));
			deps.output.appendLine(`[error] ${msg}`);
			return;
		}
	}

	try {
		await deps.ui.withProgress(
			{ title: syncMessages.forcePush },
			() => runGit(['push', '--force-with-lease'])
		);
	} catch (pushError) {
		const msg = pushError instanceof Error ? pushError.message : String(pushError);
		deps.ui.showErrorMessage(syncMessages.rebaseOkPushFailed(msg));
		deps.output.appendLine(`[error] ${msg}`);
		deps.output.appendLine(syncMessages.outputFailed);
		return;
	}

	if (tempBranchToCleanup) {
		try {
			await runGit(['branch', '-D', tempBranchToCleanup]);
		} catch {
			deps.output.appendLine(syncMessages.infoTempBranchNotDeleted(tempBranchToCleanup));
		}
	}

	if (memento.upstreamIsRemote) {
		await syncLocalBranchFromRemote(deps, runGit, memento.upstreamRef, featureBranch);
	}

	if (hasStash) {
		try {
			await deps.ui.withProgress(
				{ title: syncMessages.recoveringStash },
				() => runGit(['stash', 'pop'])
			);
		} catch (popError) {
			deps.ui.showErrorMessage(syncMessages.stashPopFailed);
			deps.output.appendLine(`[stash-pop-error] ${popError}`);
		}
	}

	await clearMemento(deps);
	deps.output.appendLine(syncMessages.outputResumeComplete);
	deps.ui.showInformationMessage(syncMessages.syncedSuccess(featureBranch));
}
