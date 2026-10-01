import { toErrorMessage } from './errors';
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
import type { WorkflowOutcome } from './sweep-workflow';

export async function runResumeFlow(deps: SyncWithUpstreamDeps): Promise<WorkflowOutcome> {
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

	deps.output.show(true);
	deps.output.header(syncMessages.outputResumeHeader);
	try {
		return await doResume(deps, workspaceRoot, gitDir);
	} catch (error) {
		const message = toErrorMessage(error);
		showSyncGitCommandError(deps, message);
		deps.output.appendLine(`[error] ${message}`);
		deps.output.header(syncMessages.outputFailed);
		return 'failed';
	} finally {
		deps.output.header(syncMessages.outputSessionEnded);
	}
}

async function doResume(deps: SyncWithUpstreamDeps, workspaceRoot: string, gitDir: string): Promise<WorkflowOutcome> {
	const runGit = (args: string[]) => deps.runGitCommand(args, workspaceRoot);

	let rebaseActive = isRebaseInProgress(gitDir, deps);
	const memento = getMemento(deps);

	if (!memento) {
		// Never resume a rebase this extension did not start: continuing and
		// force-pushing someone's manual rebase would be destructive.
		if (rebaseActive) {
			deps.ui.showErrorMessage(syncMessages.rebaseNotStartedByExtension);
			deps.output.appendLine(syncMessages.rebaseNotStartedByExtension);
			deps.output.header(syncMessages.outputFailed);
		} else {
			deps.ui.showInformationMessage(syncMessages.noRebaseNothingToResume);
			deps.output.appendLine(syncMessages.nothingToResume);
			deps.output.header(syncMessages.outputResumeComplete);
		}
		return rebaseActive ? 'failed' : 'ok';
	}

	if (memento.workspaceRoot !== workspaceRoot) {
		deps.ui.showErrorMessage(syncMessages.rebaseInOtherWorkspace);
		deps.output.appendLine(syncMessages.rebaseInOtherWorkspace);
		deps.output.header(syncMessages.outputFailed);
		return 'failed';
	}

	const featureBranch = memento.featureBranch;
	if (!featureBranch) {
		deps.ui.showErrorMessage(syncMessages.couldNotDetermineRebaseBranch);
		deps.output.appendLine(`[error] ${syncMessages.couldNotDetermineRebaseBranch}`);
		deps.output.header(syncMessages.outputFailed);
		return 'failed';
	}
	const hasStash = memento.hasStash;
	const tempBranchToCleanup = memento.tempBranchToCleanup;

	if (rebaseActive) {
		const rebasingBranch = readRebaseHeadName(gitDir, deps);
		if (rebasingBranch && rebasingBranch !== featureBranch) {
			deps.ui.showErrorMessage(syncMessages.rebaseBranchMismatch(featureBranch, rebasingBranch));
			deps.output.appendLine(syncMessages.rebaseBranchMismatch(featureBranch, rebasingBranch));
			deps.output.header(syncMessages.outputFailed);
			return 'failed';
		}
	}

	if (rebaseActive) {
		try {
			await deps.ui.withProgress(
				{ title: syncMessages.rebaseContinue },
				() => runGit(['rebase', '--continue'])
			);
		} catch (continueError) {
			const msg = toErrorMessage(continueError);
			if (isRebaseInProgress(gitDir, deps)) {
				deps.ui.showErrorMessage(syncMessages.remainingConflicts);
				deps.output.appendLine(`[error] ${msg}`);
				deps.output.header(syncMessages.outputRebasePaused);
				return 'paused';
			}
			// The rebase ended between the initial check and the continue attempt
			// (e.g. finished manually): fall back to the non-rebase resume path.
			deps.output.appendLine(`[info] ${msg}`);
			rebaseActive = false;
		}
	}

	if (!rebaseActive) {
		deps.output.appendLine(syncMessages.infoNoRebaseInProgress);
		try {
			await deps.ui.withProgress(
				{ title: syncMessages.returningTo(featureBranch) },
				() => runGit(['checkout', featureBranch])
			);
		} catch (checkoutError) {
			const msg = toErrorMessage(checkoutError);
			deps.ui.showErrorMessage(msg);
			deps.output.appendLine(`[error] ${msg}`);
			deps.output.header(syncMessages.outputFailed);
			return 'failed';
		}
	}

	try {
		await deps.ui.withProgress(
			{ title: syncMessages.forcePush },
			() => runGit(['push', '--force-with-lease'])
		);
	} catch (pushError) {
		const msg = toErrorMessage(pushError);
		deps.ui.showErrorMessage(syncMessages.rebaseOkPushFailed(msg));
		deps.output.appendLine(`[error] ${msg}`);
		deps.output.header(syncMessages.outputFailed);
		return 'failed';
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

	let outcome: WorkflowOutcome = 'ok';
	if (hasStash) {
		try {
			await deps.ui.withProgress(
				{ title: syncMessages.recoveringStash },
				() => runGit(['stash', 'pop'])
			);
		} catch (popError) {
			const popMsg = toErrorMessage(popError);
			deps.ui.showErrorMessage(syncMessages.stashPopFailed);
			deps.output.appendLine(`[stash-pop-error] ${popMsg}`);
			outcome = 'failed';
		}
	}

	await clearMemento(deps);
	deps.output.header(syncMessages.outputResumeComplete);
	deps.ui.showInformationMessage(syncMessages.syncedSuccess(featureBranch));
	return outcome;
}
