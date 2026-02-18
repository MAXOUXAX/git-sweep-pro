import { parseBranches } from './branch-list';
import { escapeForShell } from './git-command';
import { parseGoneBranches } from './sweep-logic';
import { runSweepWorkflow, type QuickPickItemLike, type SweepWorkflowDeps } from './sweep-workflow';

export type PostPullRequestDeps = SweepWorkflowDeps;

/**
 * Returns the default branch name (e.g. "main") from origin/HEAD, or undefined.
 */
async function getDefaultBranchName(runGit: (cmd: string) => Promise<{ stdout: string; stderr: string }>): Promise<string | undefined> {
	try {
		const r = await runGit('git rev-parse --abbrev-ref refs/remotes/origin/HEAD');
		const out = r.stdout.trim();
		return out.startsWith('origin/') ? out.replace(/^origin\//, '') : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Returns true if the current branch tracks a gone remote.
 */
async function isCurrentBranchGone(
	runGit: (cmd: string) => Promise<{ stdout: string; stderr: string }>,
	currentBranch: string
): Promise<boolean> {
	try {
		const r = await runGit('git branch -vv');
		return parseGoneBranches(r.stdout).includes(currentBranch);
	} catch {
		return false;
	}
}

/**
 * For a remote ref like "origin/main", returns the local branch name "main".
 * For a local ref, returns it as-is.
 */
function toLocalBranchRef(ref: string, isRemote: boolean): string {
	if (!isRemote) {
		return ref;
	}
	const slashIdx = ref.indexOf('/');
	return slashIdx > 0 ? ref.slice(slashIdx + 1) : ref;
}

export async function runPostPullRequestWorkflow(deps: PostPullRequestDeps): Promise<void> {
	const workspaceRoot = deps.getWorkspaceRoot();
	if (!workspaceRoot) {
		deps.ui.showErrorMessage('Git Sweep Pro: No workspace folder is open.');
		return;
	}

	deps.output.show(true);
	deps.output.appendLine('--- Post Pull Request session started ---');
	deps.output.appendLine(`Workspace: ${workspaceRoot}`);

	const runGit = (cmd: string) => deps.runGitCommand(cmd, workspaceRoot);

	try {
		await deps.ui.withProgress(
			{ title: 'Git Sweep Pro: Fetching remotes...' },
			() => runGit('git fetch -p')
		);

		const [currentBranchResult, branchListResult] = await Promise.all([
			runGit('git rev-parse --abbrev-ref HEAD'),
			runGit('git branch -a'),
		]);

		const currentBranch = currentBranchResult.stdout.trim();
		if (!currentBranch || currentBranch === 'HEAD') {
			deps.ui.showErrorMessage('Git Sweep Pro: Could not determine current branch (detached HEAD?).');
			return;
		}

		const branchItems = parseBranches(branchListResult.stdout, currentBranch);
		if (branchItems.length === 0) {
			deps.ui.showInformationMessage('Git Sweep Pro: No other branches available to checkout.');
			return;
		}

		const [defaultBranch, isGone] = await Promise.all([
			getDefaultBranchName(runGit),
			isCurrentBranchGone(runGit, currentBranch),
		]);

		const quickPickItems = branchItems.map((b) => {
			const isDefault = Boolean(defaultBranch && toLocalBranchRef(b.ref, b.isRemote) === defaultBranch);
			return {
				label: b.isRemote ? `${b.label} (remote)` : b.label,
				description: b.isRemote ? 'remote' : isDefault ? 'default' : undefined,
				picked: isDefault,
			};
		});

		const selected = await deps.ui.showQuickPick(quickPickItems, {
			canPickMany: false,
			ignoreFocusOut: true,
			matchOnDescription: true,
			title: 'Post Pull Request: Branch to switch to',
			placeHolder: isGone && defaultBranch
				? `Branch merged. Switch to ${defaultBranch}?`
				: 'Choose a branch (local preferred for pull)',
		});

		const selectedItem: QuickPickItemLike | undefined =
			selected === undefined || Array.isArray(selected) ? undefined : (selected as QuickPickItemLike);
		if (!selectedItem) {
			deps.output.appendLine('Operation cancelled.');
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

		const targetRef = targetItem.ref;
		const localTarget = toLocalBranchRef(targetRef, targetItem.isRemote);

		await deps.ui.withProgress(
			{ title: `Git Sweep Pro: Checking out ${localTarget}...` },
			async () => {
				if (targetItem.isRemote) {
					await runGit(`git checkout -B ${escapeForShell(localTarget)} ${escapeForShell(targetRef)}`);
				} else {
					await runGit(`git checkout ${escapeForShell(targetRef)}`);
				}
			}
		);

		deps.output.appendLine(`Checked out: ${localTarget}`);

		try {
			await deps.ui.withProgress(
				{ title: `Git Sweep Pro: Deleting branch ${currentBranch}...` },
				() => runGit(`git branch -D ${escapeForShell(currentBranch)}`)
			);
			deps.output.appendLine(`Deleted branch: ${currentBranch}`);
		} catch {
			deps.ui.showErrorMessage(
				`Git Sweep Pro: Could not delete branch "${currentBranch}". You can delete it manually with: git branch -D ${escapeForShell(currentBranch)}`
			);
		}

		await runSweepWorkflow({ dryRun: false, forceDelete: false }, deps);

		await deps.ui.withProgress(
			{ title: 'Git Sweep Pro: Pulling...' },
			() => runGit('git pull')
		);

		deps.output.appendLine('--- Post Pull Request session ended ---');
		deps.ui.showInformationMessage(`Git Sweep Pro: Switched to ${localTarget} and pulled.`);
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
		deps.output.appendLine(`[error] ${message}`);
		deps.output.appendLine('--- Post Pull Request session ended ---');
	}
}
