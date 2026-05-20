import { syncMessages } from './sync-with-upstream-messages';
import {
	clearMemento,
	getMemento,
	isRebaseInProgress,
	readRebaseHeadName,
	resolveGitDir,
	type SyncWithUpstreamDeps,
} from './sync-with-upstream-state';

export async function runResumeFlow(deps: SyncWithUpstreamDeps): Promise<void> {
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

	deps.output.appendLine(syncMessages.outputResumeHeader);

	const runGit = (args: string[]) => deps.runGitCommand(args, workspaceRoot);

	const rebaseActive = isRebaseInProgress(gitDir, deps);
	const memento = getMemento(deps);

	if (memento && memento.workspaceRoot !== workspaceRoot) {
		deps.ui.showErrorMessage(syncMessages.rebaseInOtherWorkspace);
		deps.output.appendLine(syncMessages.rebaseInOtherWorkspace);
		return;
	}

	if (!rebaseActive && !memento) {
		deps.ui.showInformationMessage(syncMessages.noRebaseNothingToResume);
		deps.output.appendLine(syncMessages.nothingToResume);
		return;
	}

	const featureBranch = memento?.featureBranch ?? readRebaseHeadName(gitDir, deps);
	if (!featureBranch) {
		deps.ui.showErrorMessage(syncMessages.couldNotDetermineRebaseBranch);
		return;
	}

	const hasStash = memento?.hasStash ?? false;
	const tempBranchToCleanup = memento?.tempBranchToCleanup;

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
