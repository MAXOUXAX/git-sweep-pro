import { isNotFullyMergedError, isProtectedBranch, parseGoneBranchRefs, type SweepMode, type SweepSettings } from './sweep-logic';

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
		showInformationMessage: (message: string) => void;
		showErrorMessage: (message: string) => void;
		confirm: (message: string, confirmLabel: string) => PromiseLike<boolean>;
	};
};

function normalizeQuickPickSelection(
	selection: readonly QuickPickItemLike[] | QuickPickItemLike | undefined
): readonly QuickPickItemLike[] {
	if (!selection) {
		return [];
	}

	if (Array.isArray(selection)) {
		return selection;
	}

	return [selection as QuickPickItemLike];
}

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

		const quickPickItems: QuickPickItemLike[] = candidateBranches.map((branch) => ({
			label: branch,
			picked: true,
		}));

		const selected = await deps.ui.showQuickPick(quickPickItems, {
			canPickMany: true,
			ignoreFocusOut: true,
			matchOnDescription: true,
			title: mode.dryRun ? 'Git Sweep Pro: Select branches to include in dry run' : 'Git Sweep Pro: Select branches to delete',
			placeHolder: 'All stale tracked branches are pre-selected. Uncheck any you want to keep.',
		});

		const selectedItems = normalizeQuickPickSelection(selected);

		if (selectedItems.length === 0) {
			deps.output.appendLine('Operation cancelled or no branches selected.');
			deps.ui.showInformationMessage('Git Sweep Pro: No branches selected.');
			return;
		}

		const branchNames = selectedItems.map((item) => item.label);
		deps.output.appendLine(`${mode.dryRun ? '[DRY RUN]' : '[DELETE]'} Selected branches:`);
		for (const branch of branchNames) {
			deps.output.appendLine(`- ${branch}`);
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
				`Delete ${branchNames.length} branch(es) with git branch ${deleteFlagLabel}? This cannot be undone.`,
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
					deps.output.appendLine(`[delete-failed] ${branch}: ${message}`);
				}
			}
		}

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
						deps.output.appendLine(`[delete-failed] ${branch}: ${message}`);
					}
				}
			} else {
				deps.output.appendLine('Force-delete of not-fully-merged branches declined.');
			}
		}

		if (deletedCount === branchNames.length) {
			deps.ui.showInformationMessage(`Git Sweep Pro: Deleted ${deletedCount} branch(es).`);
		} else {
			deps.ui.showErrorMessage(
				`Git Sweep Pro: Deleted ${deletedCount}/${branchNames.length} branch(es). See "Git Sweep" output for details.`
			);
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
