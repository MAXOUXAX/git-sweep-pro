import { createBranchDeleter } from './branch-deletion';
import { canRecordDeletions, createDeletionRecorder, type DeletionLog } from './deletion-log';
import { describeGitFailure, toErrorMessage } from './errors';
import { quoteShellArg } from './git-command';
import { describeMergedBranch } from './merged-branches';
import { describeCheckedOutBranch, findStaleBranches, noBranchesFound } from './stale-branches';
import type { SweepMode, SweepSettings } from './sweep-logic';
import { formatSweepOutcome, formatSweepSummary, type SelectableBranch } from './sweep-selection';

export type QuickPickItemLike = {
	readonly label: string;
	readonly description?: string;
	readonly picked?: boolean;
};

type ProgressOptions = {
	readonly title: string;
};

export type QuickPickOptionsLike = {
	readonly canPickMany: boolean;
	readonly ignoreFocusOut: boolean;
	readonly matchOnDescription: boolean;
	readonly title: string;
	readonly placeHolder: string;
};

/**
 * Context a front end may render around a notification. The core writes
 * neutral messages; each host adds its own framing (product name, pointers).
 */
export type NoticeOptions = {
	/** The message reports a dry run. */
	readonly dryRun?: boolean;
	/** The message is a raw error from a failed operation. */
	readonly failed?: boolean;
	/** More details were written to the workflow output. */
	readonly seeOutput?: boolean;
};

/**
 * Everything a workflow needs from its front end. Implemented by the VS Code
 * extension, the CLI's terminal prompts, and the CLI's RPC bridge.
 */
export type WorkflowUi = {
	withProgress: <T>(options: ProgressOptions, task: () => Promise<T>) => PromiseLike<T>;
	showQuickPick: (
		items: QuickPickItemLike[],
		options: QuickPickOptionsLike
	) => PromiseLike<readonly QuickPickItemLike[] | QuickPickItemLike | undefined>;
	/**
	 * Shows a multi-select branch picker with quick-action buttons (select all,
	 * clear all, invert selection). Resolves to the labels of the selected
	 * branches, or `undefined` when the picker was dismissed.
	 */
	pickBranches: (options: {
		readonly items: readonly SelectableBranch[];
		readonly title: string;
	}) => PromiseLike<readonly string[] | undefined>;
	showInformationMessage: (message: string, options?: NoticeOptions) => void;
	showErrorMessage: (message: string, options?: NoticeOptions) => void;
	confirm: (message: string, confirmLabel: string) => PromiseLike<boolean>;
};

/** How a workflow ended. The CLI maps it to its exit code. */
export type WorkflowOutcome = 'ok' | 'failed' | 'paused' | 'cancelled';

export type SweepWorkflowDeps = {
	readonly getWorkspaceRoot: () => string | undefined;
	readonly getSettings: () => SweepSettings;
	readonly output: {
		show: (preserveFocus: boolean) => void;
		appendLine: (line: string) => void;
		/** Session framing (start and end markers, workspace, mode): always kept in VS Code, only shown in a terminal with --verbose. */
		header: (line: string) => void;
	};
	readonly runGitCommand: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
	readonly ui: WorkflowUi;
	/** Where deletions are recorded so they can be undone with `restore`. */
	readonly deletionLog?: DeletionLog;
};

/** Narrows a single-select quick pick result to the picked item (or undefined when dismissed). */
export function singlePick(
	selected: readonly QuickPickItemLike[] | QuickPickItemLike | undefined
): QuickPickItemLike | undefined {
	return selected === undefined || Array.isArray(selected) ? undefined : (selected as QuickPickItemLike);
}

function describeDeleteFlag(mode: SweepMode): '-d' | '-D' {
	return mode.forceDelete ? '-D' : '-d';
}

/** Ends a deletion prompt: whether the user can take the deletion back. */
function undoNote(deps: SweepWorkflowDeps): string {
	return canRecordDeletions(deps.deletionLog) ? 'You can restore them later.' : 'This cannot be undone.';
}

export async function runSweepWorkflow(mode: SweepMode, deps: SweepWorkflowDeps): Promise<WorkflowOutcome> {
	const workspaceRoot = deps.getWorkspaceRoot();
	if (!workspaceRoot) {
		deps.ui.showErrorMessage('No workspace folder is open.');
		return 'failed';
	}

	deps.output.show(true);
	deps.output.header('--- Git Sweep session started ---');
	deps.output.header(`Workspace: ${workspaceRoot}`);
	deps.output.header(`Mode: ${mode.dryRun ? 'dry-run' : 'delete'}, delete flag: ${describeDeleteFlag(mode)}`);

	const settings = deps.getSettings();

	try {
		const {
			stale: staleBranches,
			protected: protectedBranches,
			checkedOut,
			merged,
			worktrees: worktreeOf,
		} = await findStaleBranches(workspaceRoot, deps);
		const mergedOf = new Map(merged.map((branch) => [branch.name, describeMergedBranch(branch)]));
		const candidateBranches = [...staleBranches, ...mergedOf.keys()];
		/** How a branch was merged and where it is checked out, e.g. "merged into origin/main, checked out in worktree /wt". */
		const describeBranch = (branch: string, worktreeLabel: string): string =>
			[mergedOf.get(branch), worktreeOf.has(branch) ? `${worktreeLabel} ${worktreeOf.get(branch)}` : undefined]
				.filter(Boolean)
				.join(', ');

		if (candidateBranches.length === 0 && protectedBranches.length === 0 && checkedOut.length === 0) {
			deps.output.appendLine(noBranchesFound(settings));
			deps.ui.showInformationMessage(noBranchesFound(settings));
			return 'ok';
		}

		if (protectedBranches.length > 0) {
			deps.output.appendLine('Protected branches skipped:');
			for (const branch of protectedBranches) {
				deps.output.appendLine(`- ${branch}`);
			}
		}

		const checkedOutNotices = checkedOut.map(describeCheckedOutBranch);
		checkedOutNotices.forEach((notice) => deps.output.appendLine(notice));

		if (candidateBranches.length === 0) {
			deps.output.appendLine('No stale branch can be deleted from here; nothing to do.');
			deps.ui.showInformationMessage(
				checkedOut.length === 0
					? `All ${protectedBranches.length} stale branch(es) are protected.`
					: [
							...checkedOutNotices,
							...(protectedBranches.length > 0 ? [`${protectedBranches.length} other stale branch(es) are protected.`] : []),
						].join(' ')
			);
			return 'ok';
		}

		// Only stale branches outside other worktrees are pre-selected. Deleting
		// a branch checked out in another worktree also removes that worktree's
		// directory, and a merged branch may still be in use: its upstream exists.
		const quickPickItems: SelectableBranch[] = candidateBranches.map((branch) => {
			const description = describeBranch(branch, 'checked out in worktree');
			return description ? { label: branch, picked: false, description } : { label: branch, picked: true };
		});

		const selected = await deps.ui.pickBranches({
			items: quickPickItems,
			title: mode.dryRun ? 'Select branches to include in dry run' : 'Select branches to delete',
		});

		const branchNames = [...(selected ?? [])];
		const keptWorktreeBranches = [...worktreeOf.keys()].filter((branch) => !branchNames.includes(branch));
		if (selected !== undefined && keptWorktreeBranches.length > 0) {
			deps.output.appendLine('Not selected (worktree kept):');
			keptWorktreeBranches.forEach((branch) => deps.output.appendLine(`- ${branch} (worktree ${worktreeOf.get(branch)})`));
		}
		if (branchNames.length === 0) {
			deps.output.appendLine('Operation cancelled or no branches selected.');
			deps.ui.showInformationMessage('No branches selected.');
			return 'cancelled';
		}

		deps.output.appendLine(`${mode.dryRun ? '[DRY RUN]' : '[DELETE]'} Selected branches:`);
		for (const branch of branchNames) {
			const description = describeBranch(branch, 'removes worktree');
			deps.output.appendLine(description ? `- ${branch} (${description})` : `- ${branch}`);
		}

		const summary = formatSweepSummary({
			totalDetected: staleBranches.length + protectedBranches.length + checkedOut.length,
			mergedCount: merged.length,
			protectedCount: protectedBranches.length,
			checkedOutCount: checkedOut.length,
			selectedCount: branchNames.length,
			worktreeCount: branchNames.filter((branch) => worktreeOf.has(branch)).length,
			mode,
		});
		deps.output.appendLine('Summary:');
		for (const line of summary.split('\n')) {
			deps.output.appendLine(`  ${line}`);
		}

		if (mode.dryRun) {
			deps.ui.showInformationMessage(`${branchNames.length} branch(es) would be deleted.`, { dryRun: true });
			return 'ok';
		}

		if (settings.confirmBeforeDelete) {
			const confirmed = await deps.ui.confirm(
				`${summary}\n\nDelete ${branchNames.length} branch(es) with git branch ${describeDeleteFlag(mode)}? ${undoNote(deps)}`,
				`Delete ${branchNames.length}`
			);
			if (!confirmed) {
				deps.output.appendLine('Deletion cancelled at confirmation prompt.');
				deps.ui.showInformationMessage('Deletion cancelled.');
				return 'cancelled';
			}
		}

		const recorder = deps.deletionLog && createDeletionRecorder(deps.deletionLog, 'sweep', deps.output.appendLine);
		const deleteBranch = createBranchDeleter({
			runGit: (args) => deps.runGitCommand(args, workspaceRoot),
			log: (line) => deps.output.appendLine(line),
			worktrees: worktreeOf,
			onDeleted: recorder?.record,
		});
		let deletedCount = 0;
		const notFullyMerged: string[] = [];
		const failedBranches: string[] = [];

		for (const branch of branchNames) {
			const result = await deleteBranch(branch, describeDeleteFlag(mode));
			if (result === 'deleted') {
				deletedCount += 1;
			} else if (result === 'not-fully-merged') {
				notFullyMerged.push(branch);
			} else {
				failedBranches.push(branch);
			}
		}

		let skippedCount = 0;

		// Branches whose remote is gone but that a safe delete (-d) refuses because
		// they are "not fully merged" were almost certainly merged via squash or
		// rebase. Their commits live under a new SHA on the base branch, so the
		// local branch is genuinely stale. Offer a targeted force-delete.
		if (notFullyMerged.length > 0) {
			deps.output.appendLine(
				`${notFullyMerged.length} branch(es) were not deleted because they are not fully merged into the current branch. ` +
					'This is expected when a pull request was merged with a squash or rebase strategy.'
			);
			const confirmed = await deps.ui.confirm(
				`${notFullyMerged.length} branch(es) are not merged into the current branch, as is usual after a squash or rebase merge. ` +
					`Force-delete them with git branch -D? ${undoNote(deps)}`,
				`Force-delete ${notFullyMerged.length}`
			);
			if (confirmed) {
				for (const branch of notFullyMerged) {
					if ((await deleteBranch(branch, '-D')) === 'deleted') {
						deletedCount += 1;
					} else {
						failedBranches.push(branch);
					}
				}
			} else {
				skippedCount = notFullyMerged.length;
				deps.output.appendLine('Force-delete of not-fully-merged branches declined.');
			}
		}

		if (recorder && recorder.recorded.length > 0) {
			deps.output.appendLine(`To restore them, run: git sweep-pro restore ${recorder.recorded.map(quoteShellArg).join(' ')}`);
		}

		const outcome = formatSweepOutcome({
			deleted: deletedCount,
			skipped: skippedCount,
			failed: failedBranches.length,
		});

		if (failedBranches.length > 0) {
			deps.ui.showErrorMessage(outcome, { seeOutput: true });
			return 'failed';
		}
		deps.ui.showInformationMessage(outcome);
		return 'ok';
	} catch (error) {
		deps.ui.showErrorMessage(...describeGitFailure(toErrorMessage(error), { failed: true }));
		return 'failed';
	} finally {
		deps.output.header('--- Git Sweep session ended ---');
	}
}
