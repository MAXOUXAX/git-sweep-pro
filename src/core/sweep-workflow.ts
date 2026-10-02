import { createBranchDeleter } from './branch-deletion';
import { canRecordDeletions, createDeletionRecorder } from './deletion-log';
import { describeGitFailure, toErrorMessage } from './errors';
import { quoteShellArg } from './git-command';
import { describeMergedBranch } from './merged-branches';
import { describeCheckedOutBranch, findStaleBranches, noBranchesFound } from './stale-branches';
import type { SweepMode } from './sweep-logic';
import { formatSweepOutcome, formatSweepSummary } from './sweep-selection';
import type { PickItem, WorkflowContext, WorkflowOutcome } from './workflow';

const DELETE_FLAG: Record<SweepMode, '-d' | '-D'> = { dryRun: '-d', safeDelete: '-d', forceDelete: '-D' };

/** Ends a deletion prompt: whether the user can take the deletion back. */
function undoNote(context: WorkflowContext): string {
	return canRecordDeletions(context.deletionLog) ? 'You can restore them later.' : 'This cannot be undone.';
}

export async function runSweepWorkflow(context: WorkflowContext, mode: SweepMode): Promise<WorkflowOutcome> {
	const { settings, output, ui } = context;
	const dryRun = mode === 'dryRun';
	output.header('--- Git Sweep session started ---');
	output.header(`Workspace: ${context.root}`);
	output.header(`Mode: ${dryRun ? 'dry-run' : 'delete'}, delete flag: ${DELETE_FLAG[mode]}`);

	try {
		const found = await findStaleBranches(context);
		const { stale: staleBranches, protected: protectedBranches, checkedOut, merged, worktrees: worktreeOf } = found;
		const mergedOf = new Map(merged.map((branch) => [branch.name, describeMergedBranch(branch)]));
		const candidateBranches = [...staleBranches, ...mergedOf.keys()];
		/** How a branch was merged and where it is checked out, e.g. "merged into origin/main, checked out in worktree /wt". */
		const describeBranch = (branch: string, worktreeLabel: string): string =>
			[mergedOf.get(branch), worktreeOf.has(branch) ? `${worktreeLabel} ${worktreeOf.get(branch)}` : undefined]
				.filter(Boolean)
				.join(', ');

		if (candidateBranches.length === 0 && protectedBranches.length === 0 && checkedOut.length === 0) {
			output.appendLine(noBranchesFound(settings, found));
			ui.showInformationMessage(noBranchesFound(settings, found), found.mergedSkipped ? { seeOutput: true } : undefined);
			return 'ok';
		}

		if (protectedBranches.length > 0) {
			output.appendLine('Protected branches skipped:');
			for (const branch of protectedBranches) {
				output.appendLine(`- ${branch}`);
			}
		}

		const checkedOutNotices = checkedOut.map(describeCheckedOutBranch);
		checkedOutNotices.forEach((notice) => output.appendLine(notice));

		if (candidateBranches.length === 0) {
			output.appendLine('No stale branch can be deleted from here; nothing to do.');
			ui.showInformationMessage(
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
		const quickPickItems: PickItem[] = candidateBranches.map((branch) => {
			const description = describeBranch(branch, 'checked out in worktree');
			return { label: branch, picked: !mergedOf.has(branch) && !worktreeOf.has(branch), ...(description ? { description } : {}) };
		});

		const selected = await ui.pickMany({
			items: quickPickItems,
			title: dryRun ? 'Select branches to include in dry run' : 'Select branches to delete',
		});

		const branchNames = [...(selected ?? [])];
		const keptWorktreeBranches = [...worktreeOf.keys()].filter((branch) => !branchNames.includes(branch));
		if (selected !== undefined && keptWorktreeBranches.length > 0) {
			output.appendLine('Not selected (worktree kept):');
			keptWorktreeBranches.forEach((branch) => output.appendLine(`- ${branch} (worktree ${worktreeOf.get(branch)})`));
		}
		if (branchNames.length === 0) {
			output.appendLine('Operation cancelled or no branches selected.');
			ui.showInformationMessage('No branches selected.');
			return 'cancelled';
		}

		output.appendLine(`${dryRun ? '[DRY RUN]' : '[DELETE]'} Selected branches:`);
		for (const branch of branchNames) {
			const description = describeBranch(branch, 'removes worktree');
			output.appendLine(description ? `- ${branch} (${description})` : `- ${branch}`);
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
		output.appendLine('Summary:');
		for (const line of summary.split('\n')) {
			output.appendLine(`  ${line}`);
		}

		if (dryRun) {
			ui.showInformationMessage(`${branchNames.length} branch(es) would be deleted.`, { dryRun: true });
			return 'ok';
		}

		if (settings.confirmBeforeDelete) {
			const confirmed = await ui.confirm(
				`${summary}\n\nDelete ${branchNames.length} branch(es) with git branch ${DELETE_FLAG[mode]}? ${undoNote(context)}`,
				`Delete ${branchNames.length}`
			);
			if (!confirmed) {
				output.appendLine('Deletion cancelled at confirmation prompt.');
				ui.showInformationMessage('Deletion cancelled.');
				return 'cancelled';
			}
		}

		const recorder = createDeletionRecorder(context.deletionLog, 'sweep', output.appendLine);
		const deleteBranch = createBranchDeleter({ git: context.git, log: output.appendLine, worktrees: worktreeOf, onDeleted: recorder.record });
		let deletedCount = 0;
		const notFullyMerged: string[] = [];
		const failedBranches: string[] = [];

		for (const branch of branchNames) {
			const result = await deleteBranch(branch, DELETE_FLAG[mode]);
			if (result === 'deleted') {
				deletedCount += 1;
			} else if (result === 'not-fully-merged') {
				notFullyMerged.push(branch);
			} else {
				failedBranches.push(branch);
			}
		}

		let skippedCount = 0;

		// A safe delete (-d) checks the upstream, or HEAD once the upstream is
		// gone, so it refuses branches merged via squash or rebase: their commits
		// live under new SHAs on the base branch. Offer a targeted force-delete.
		if (notFullyMerged.length > 0) {
			output.appendLine(
				`${notFullyMerged.length} branch(es) were not deleted because Git does not see them as fully merged. ` +
					'This is expected when a pull request was merged with a squash or rebase strategy.'
			);
			const confirmed = await ui.confirm(
				`${notFullyMerged.length} branch(es) are not fully merged as far as Git can tell, as is usual after a squash or rebase merge. ` +
					`Force-delete them with git branch -D? ${undoNote(context)}`,
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
				output.appendLine('Force-delete of not-fully-merged branches declined.');
			}
		}

		if (recorder.recorded.length > 0) {
			output.appendLine(`To restore them, run: gsp restore ${recorder.recorded.map(quoteShellArg).join(' ')}`);
		}

		const outcome = formatSweepOutcome({
			deleted: deletedCount,
			skipped: skippedCount,
			failed: failedBranches.length,
		});

		if (failedBranches.length > 0) {
			ui.showErrorMessage(outcome, { seeOutput: true });
			return 'failed';
		}
		ui.showInformationMessage(outcome);
		return 'ok';
	} catch (error) {
		ui.showErrorMessage(...describeGitFailure(toErrorMessage(error), { failed: true }));
		return 'failed';
	} finally {
		output.header('--- Git Sweep session ended ---');
	}
}
