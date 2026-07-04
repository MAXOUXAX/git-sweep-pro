import { isNotFullyMergedError, isProtectedBranch, parseGoneBranchRefs, type SweepMode, type SweepSettings } from './sweep-logic';
import { formatSweepOutcome, formatSweepSummary, type SelectableBranch } from './sweep-selection';

export type QuickPickItemLike = {
	readonly label: string;
	readonly description?: string;
	readonly picked?: boolean;
};

type ProgressOptions = {
	readonly title: string;
};

export type SweepWorkflowDeps = {
	readonly getWorkspaceRoot: () => string | undefined;
	readonly getSettings: () => SweepSettings;
	readonly output: {
		show: (preserveFocus: boolean) => void;
		appendLine: (line: string) => void;
	};
	readonly runGitCommand: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
	readonly ui: {
		withProgress: <T>(options: ProgressOptions, task: () => Promise<T>) => PromiseLike<T>;
		showQuickPick: (
			items: QuickPickItemLike[],
			options: {
				readonly canPickMany: boolean;
				readonly ignoreFocusOut: boolean;
				readonly matchOnDescription: boolean;
				readonly title: string;
				readonly placeHolder: string;
			}
		) => PromiseLike<readonly QuickPickItemLike[] | QuickPickItemLike | undefined>;
		/**
		 * Shows a multi-select branch picker with quick-action buttons (select all,
		 * clear all, invert selection). Resolves to the labels of the selected
		 * branches, or `undefined` when the picker was dismissed.
		 */
		pickBranches: (options: {
			readonly items: readonly SelectableBranch[];
			readonly title: string;
			readonly placeHolder: string;
		}) => PromiseLike<readonly string[] | undefined>;
		showInformationMessage: (message: string) => void;
		showErrorMessage: (message: string) => void;
		confirm: (message: string, confirmLabel: string) => PromiseLike<boolean>;
	};
};

export async function runSweepWorkflow(mode: SweepMode, deps: SweepWorkflowDeps): Promise<void> {
	const workspaceRoot = deps.getWorkspaceRoot();
	if (!workspaceRoot) {
		deps.ui.showErrorMessage('Git Sweep Pro: No workspace folder is open.');
		return;
	}

	deps.output.show(true);
	deps.output.appendLine('--- Git Sweep session started ---');
	deps.output.appendLine(`Workspace: ${workspaceRoot}`);
	deps.output.appendLine(`Mode: ${mode.dryRun ? 'dry-run' : 'delete'}, delete flag: ${mode.forceDelete ? '-D' : '-d'}`);

	const settings = deps.getSettings();

	try {
		if (settings.autoFetchPrune) {
			await deps.ui.withProgress(
				{
					title: 'Git Sweep Pro: Fetching and pruning remote references...',
				},
				() => deps.runGitCommand(['fetch', '-p'], workspaceRoot)
			);
		} else {
			deps.output.appendLine('Auto fetch/prune disabled; using local ref state.');
		}

		const branchResult = await deps.runGitCommand(
			['for-each-ref', '--format=%(refname:short)%09%(upstream:track)', 'refs/heads'],
			workspaceRoot
		);
		const goneBranches = parseGoneBranchRefs(branchResult.stdout);

		if (goneBranches.length === 0) {
			deps.output.appendLine('No stale tracked branches found.');
			deps.ui.showInformationMessage('Git Sweep Pro: No stale branches found.');
			return;
		}

		const protectedPatterns = settings.protectedBranches;
		const candidateBranches = goneBranches.filter((branch) => !isProtectedBranch(branch, protectedPatterns));
		const protectedBranches = goneBranches.filter((branch) => isProtectedBranch(branch, protectedPatterns));

		if (protectedBranches.length > 0) {
			deps.output.appendLine('Protected branches skipped (matched gitSweepPro.protectedBranches):');
			for (const branch of protectedBranches) {
				deps.output.appendLine(`- ${branch}`);
			}
		}

		if (candidateBranches.length === 0) {
			deps.output.appendLine('All stale branches are protected; nothing to do.');
			deps.ui.showInformationMessage(
				`Git Sweep Pro: All ${protectedBranches.length} stale branch(es) are protected.`
			);
			return;
		}

		const quickPickItems: SelectableBranch[] = candidateBranches.map((branch) => ({
			label: branch,
			picked: true,
		}));

		const selected = await deps.ui.pickBranches({
			items: quickPickItems,
			title: mode.dryRun ? 'Git Sweep Pro: Select branches to include in dry run' : 'Git Sweep Pro: Select branches to delete',
			placeHolder: 'All stale tracked branches are pre-selected. Use the title-bar actions to select all, clear, or invert.',
		});

		if (selected === undefined) {
			deps.output.appendLine('Operation cancelled or no branches selected.');
			deps.ui.showInformationMessage('Git Sweep Pro: No branches selected.');
			return;
		}

		const branchNames = [...selected];

		if (branchNames.length === 0) {
			deps.output.appendLine('Operation cancelled or no branches selected.');
			deps.ui.showInformationMessage('Git Sweep Pro: No branches selected.');
			return;
		}

		deps.output.appendLine(`${mode.dryRun ? '[DRY RUN]' : '[DELETE]'} Selected branches:`);
		for (const branch of branchNames) {
			deps.output.appendLine(`- ${branch}`);
		}

		const summary = formatSweepSummary({
			totalDetected: goneBranches.length,
			protectedCount: protectedBranches.length,
			selectedCount: branchNames.length,
			mode,
		});
		deps.output.appendLine('Summary:');
		for (const line of summary.split('\n')) {
			deps.output.appendLine(`  ${line}`);
		}

		if (mode.dryRun) {
			deps.ui.showInformationMessage(
				`Git Sweep Pro (dry run): ${branchNames.length} branch(es) would be deleted.`
			);
			return;
		}

		if (settings.confirmBeforeDelete) {
			const deleteFlagLabel = mode.forceDelete ? '-D' : '-d';
			const confirmed = await deps.ui.confirm(
				`${summary}\n\nDelete ${branchNames.length} branch(es) with git branch ${deleteFlagLabel}? This cannot be undone.`,
				`Delete ${branchNames.length}`
			);
			if (!confirmed) {
				deps.output.appendLine('Deletion cancelled at confirmation prompt.');
				deps.ui.showInformationMessage('Git Sweep Pro: Deletion cancelled.');
				return;
			}
		}

		let deletedCount = 0;
		const deleteFlag = mode.forceDelete ? '-D' : '-d';
		const notFullyMerged: string[] = [];
		const failedBranches: string[] = [];

		for (const branch of branchNames) {
			try {
				await deps.runGitCommand(['branch', deleteFlag, branch], workspaceRoot);
				deletedCount += 1;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!mode.forceDelete && isNotFullyMergedError(message)) {
					notFullyMerged.push(branch);
					deps.output.appendLine(
						`[not-fully-merged] ${branch}: commits are not reachable from the current branch (likely squash/rebase merged).`
					);
				} else {
					failedBranches.push(branch);
					deps.output.appendLine(`[delete-failed] ${branch}: ${message}`);
				}
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
				`${notFullyMerged.length} branch(es) look squash/rebase merged (remote gone, but not a fast-forward merge locally). ` +
					'Force-delete them with git branch -D? This cannot be undone.',
				`Force-delete ${notFullyMerged.length}`
			);
			if (confirmed) {
				for (const branch of notFullyMerged) {
					try {
						await deps.runGitCommand(['branch', '-D', branch], workspaceRoot);
						deletedCount += 1;
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						failedBranches.push(branch);
						deps.output.appendLine(`[delete-failed] ${branch}: ${message}`);
					}
				}
			} else {
				skippedCount = notFullyMerged.length;
				deps.output.appendLine('Force-delete of not-fully-merged branches declined.');
			}
		}

		const outcome = formatSweepOutcome({
			deleted: deletedCount,
			skipped: skippedCount,
			failed: failedBranches.length,
		});

		if (failedBranches.length > 0) {
			deps.ui.showErrorMessage(`Git Sweep Pro: ${outcome} See "Git Sweep" output for details.`);
		} else {
			deps.ui.showInformationMessage(`Git Sweep Pro: ${outcome}`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const lowerMessage = message.toLowerCase();

		if (lowerMessage.includes('not a git repository')) {
			deps.ui.showErrorMessage('Git Sweep Pro: The selected workspace folder is not a Git repository.');
		} else if (lowerMessage.includes('command not found') || lowerMessage.includes('enoent')) {
			deps.ui.showErrorMessage('Git Sweep Pro: Git is not installed or not available in PATH.');
		} else {
			deps.ui.showErrorMessage(`Git Sweep Pro failed: ${message}`);
		}
	} finally {
		deps.output.appendLine('--- Git Sweep session ended ---');
	}
}
