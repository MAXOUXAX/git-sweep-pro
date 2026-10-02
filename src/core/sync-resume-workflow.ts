import { describeGitFailure, toErrorMessage } from './errors';
import { syncMessages } from './sync-messages';
import { clearMemento, getMemento, isRebaseInProgress, readRebaseHeadName, type SyncContext } from './sync-state';
import { syncLocalBranchFromRemote } from './sync-workflow';
import type { WorkflowOutcome } from './workflow';

/**
 * Finishes a sync paused on conflicts or on a failed push: continues the
 * rebase, force-pushes, cleans up and restores the stash. Only resumes a
 * rebase that {@link runSyncWorkflow} started (see {@link getMemento}).
 */
export async function runResumeWorkflow(context: SyncContext): Promise<WorkflowOutcome> {
	context.output.header(syncMessages.outputResumeHeader);
	try {
		return await resume(context);
	} catch (error) {
		const message = toErrorMessage(error);
		context.ui.showErrorMessage(...describeGitFailure(message));
		context.output.appendLine(`[error] ${message}`);
		context.output.header(syncMessages.outputFailed);
		return 'failed';
	} finally {
		context.output.header(syncMessages.outputSessionEnded);
	}
}

async function resume(context: SyncContext): Promise<WorkflowOutcome> {
	const { git, ui, output } = context;
	let rebaseActive = isRebaseInProgress(context);
	const memento = getMemento(context);

	if (!memento) {
		// Never resume a rebase this extension did not start: continuing and
		// force-pushing someone's manual rebase would be destructive.
		if (rebaseActive) {
			ui.showErrorMessage(syncMessages.rebaseNotStartedByExtension);
			output.appendLine(syncMessages.rebaseNotStartedByExtension);
			output.header(syncMessages.outputFailed);
		} else {
			ui.showInformationMessage(syncMessages.noRebaseNothingToResume);
			output.appendLine(syncMessages.nothingToResume);
			output.header(syncMessages.outputResumeComplete);
		}
		return rebaseActive ? 'failed' : 'ok';
	}

	if (memento.workspaceRoot !== context.root) {
		ui.showErrorMessage(syncMessages.rebaseInOtherWorkspace);
		output.appendLine(syncMessages.rebaseInOtherWorkspace);
		output.header(syncMessages.outputFailed);
		return 'failed';
	}

	const featureBranch = memento.featureBranch;
	if (!featureBranch) {
		ui.showErrorMessage(syncMessages.couldNotDetermineRebaseBranch);
		output.appendLine(`[error] ${syncMessages.couldNotDetermineRebaseBranch}`);
		output.header(syncMessages.outputFailed);
		return 'failed';
	}
	const hasStash = memento.hasStash;
	const tempBranchToCleanup = memento.tempBranchToCleanup;

	if (rebaseActive) {
		const rebasingBranch = readRebaseHeadName(context);
		if (rebasingBranch && rebasingBranch !== featureBranch) {
			ui.showErrorMessage(syncMessages.rebaseBranchMismatch(featureBranch, rebasingBranch));
			output.appendLine(syncMessages.rebaseBranchMismatch(featureBranch, rebasingBranch));
			output.header(syncMessages.outputFailed);
			return 'failed';
		}
	}

	if (rebaseActive) {
		try {
			await ui.withProgress(
				{ title: syncMessages.rebaseContinue },
				() => git(['rebase', '--continue'])
			);
		} catch (continueError) {
			const msg = toErrorMessage(continueError);
			if (isRebaseInProgress(context)) {
				ui.showErrorMessage(syncMessages.remainingConflicts);
				output.appendLine(`[error] ${msg}`);
				output.header(syncMessages.outputRebasePaused);
				return 'paused';
			}
			// The rebase ended between the initial check and the continue attempt
			// (e.g. finished manually): fall back to the non-rebase resume path.
			output.appendLine(`[info] ${msg}`);
			rebaseActive = false;
		}
	}

	if (!rebaseActive) {
		output.appendLine(syncMessages.infoNoRebaseInProgress);
		try {
			await ui.withProgress(
				{ title: syncMessages.returningTo(featureBranch) },
				() => git(['checkout', featureBranch])
			);
		} catch (checkoutError) {
			const msg = toErrorMessage(checkoutError);
			ui.showErrorMessage(msg);
			output.appendLine(`[error] ${msg}`);
			output.header(syncMessages.outputFailed);
			return 'failed';
		}
	}

	try {
		await ui.withProgress(
			{ title: syncMessages.forcePush },
			() => git(['push', '--force-with-lease'])
		);
	} catch (pushError) {
		const msg = toErrorMessage(pushError);
		ui.showErrorMessage(syncMessages.rebaseOkPushFailed(msg));
		output.appendLine(`[error] ${msg}`);
		output.header(syncMessages.outputFailed);
		return 'failed';
	}

	if (tempBranchToCleanup) {
		try {
			await git(['branch', '-D', tempBranchToCleanup]);
		} catch {
			output.appendLine(syncMessages.infoTempBranchNotDeleted(tempBranchToCleanup));
		}
	}

	if (memento.upstreamIsRemote) {
		await syncLocalBranchFromRemote(context, memento.upstreamRef, featureBranch);
	}

	let outcome: WorkflowOutcome = 'ok';
	if (hasStash) {
		try {
			await ui.withProgress(
				{ title: syncMessages.recoveringStash },
				() => git(['stash', 'pop'])
			);
		} catch (popError) {
			const popMsg = toErrorMessage(popError);
			ui.showErrorMessage(syncMessages.stashPopFailed);
			output.appendLine(`[stash-pop-error] ${popMsg}`);
			outcome = 'failed';
		}
	}

	await clearMemento(context);
	output.header(syncMessages.outputResumeComplete);
	ui.showInformationMessage(syncMessages.syncedSuccess(featureBranch));
	return outcome;
}
