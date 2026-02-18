import { parseGoneBranches, type SweepMode } from './sweep-logic';

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

	try {
		await deps.ui.withProgress(
			{
				title: 'Git Sweep Pro: Fetching and pruning remote references...',
			},
			() => deps.runGitCommand(['fetch', '-p'], workspaceRoot)
		);

		const branchResult = await deps.runGitCommand(['branch', '-vv'], workspaceRoot);
		const goneBranches = parseGoneBranches(branchResult.stdout);

		if (goneBranches.length === 0) {
			deps.output.appendLine('No stale tracked branches found.');
			deps.ui.showInformationMessage('Git Sweep Pro: No stale branches found.');
			return;
		}

		const quickPickItems: QuickPickItemLike[] = goneBranches.map((branch) => ({
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

		let deletedCount = 0;
		const deleteFlag = mode.forceDelete ? '-D' : '-d';

		for (const branch of branchNames) {
			try {
				await deps.runGitCommand(['branch', deleteFlag, branch], workspaceRoot);
				deletedCount += 1;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				deps.output.appendLine(`[delete-failed] ${branch}: ${message}`);
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
