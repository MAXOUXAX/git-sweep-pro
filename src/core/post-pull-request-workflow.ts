import { parseBranches } from './branch-list';
import { escapeForShell } from './git-command';
import { parseGoneBranches } from './sweep-logic';
import { runSweepWorkflow, type QuickPickItemLike, type SweepWorkflowDeps } from './sweep-workflow';

export type PostPullRequestDeps = SweepWorkflowDeps;

/**
 * Returns the default branch name (e.g. "main") from the first remote's HEAD ref, or undefined.
 * Discovers the remote dynamically via refs/remotes/<remote>/HEAD; does not assume "origin".
 */
async function getDefaultBranchName(runGit: (args: string[]) => Promise<{ stdout: string; stderr: string }>): Promise<string | undefined> {
	try {
		const list = await runGit(['for-each-ref', '--format=%(refname)', 'refs/remotes/*/HEAD']);
		const firstRef = list.stdout.trim().split(/\r?\n/)[0];
		if (!firstRef) {
			return undefined;
		}
		const match = firstRef.match(/^refs\/remotes\/([^/]+)\/HEAD$/);
		if (!match) {
			return undefined;
		}
		const remoteName = match[1];
		const r = await runGit(['rev-parse', '--abbrev-ref', firstRef]);
		const out = r.stdout.trim();
		const prefix = `${remoteName}/`;
		return out.startsWith(prefix) ? out.slice(prefix.length) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Returns true if the current branch tracks a gone remote.
 * Uses pre-fetched `git branch -avv` output; no internal git calls.
 */
function isCurrentBranchGone(branchOutput: string, currentBranch: string): boolean {
	try {
		return parseGoneBranches(branchOutput).includes(currentBranch);
	} catch {
		return false;
	}
}

/**
 * Normalizes `git branch -avv` output to `git branch -a` format for parseBranches.
 * Strips hash and tracking info from each line, keeping only the branch ref.
 */
function toBranchAFormat(avvOutput: string): string {
	return avvOutput
		.split(/\r?\n/)
		.map((line) => {
			const trimmed = line.trim();
			if (!trimmed) {
				return '';
			}
			const isCurrent = trimmed.startsWith('*');
			const rest = trimmed.replace(/^\*\s+/, '').trim();
			if (!rest || rest === 'HEAD') {
				return '';
			}
			if (rest.startsWith('remotes/')) {
				const firstToken = rest.split(/\s+/)[0];
				if (firstToken.endsWith('/HEAD') || firstToken.includes('->')) {
					return '';
				}
				return (isCurrent ? '* ' : '  ') + firstToken;
			}
			const firstToken = rest.split(/\s+/)[0];
			return (isCurrent ? '* ' : '  ') + firstToken;
		})
		.filter((l) => l.length > 0)
		.join('\n');
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

	const runGit = (args: string[]) => deps.runGitCommand(args, workspaceRoot);

	try {
		await deps.ui.withProgress(
			{ title: 'Git Sweep Pro: Fetching remotes...' },
			() => runGit(['fetch', '-p'])
		);

		const [currentBranchResult, branchListResult] = await Promise.all([
			runGit(['rev-parse', '--abbrev-ref', 'HEAD']),
			runGit(['branch', '-avv']),
		]);

		const currentBranch = currentBranchResult.stdout.trim();
		if (!currentBranch || currentBranch === 'HEAD') {
			deps.ui.showErrorMessage('Git Sweep Pro: Could not determine current branch (detached HEAD?).');
			return;
		}

		const branchItems = parseBranches(toBranchAFormat(branchListResult.stdout));
		if (branchItems.length === 0) {
			deps.ui.showInformationMessage('Git Sweep Pro: No other branches available to checkout.');
			return;
		}

		const defaultBranch = await getDefaultBranchName(runGit);
		const isGone = isCurrentBranchGone(branchListResult.stdout, currentBranch);

		const quickPickItems = branchItems.map((b) => {
			const isDefault = Boolean(defaultBranch && toLocalBranchRef(b.ref, b.isRemote) === defaultBranch);
			return {
				label: b.isRemote ? `${b.label} (remote)` : b.label,
				description: [b.isRemote ? 'remote' : undefined, isDefault ? 'default' : undefined]
					.filter(Boolean)
					.join(', ') || undefined,
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
			deps.output.appendLine('--- Post Pull Request session ended ---');
			return;
		}

		const chosenLabel = selectedItem.label;
		const targetItem = branchItems.find((b) => {
			const label = b.isRemote ? `${b.label} (remote)` : b.label;
			return label === chosenLabel;
		});
		if (!targetItem) {
			deps.output.appendLine('[error] Could not match selected branch to branch list.');
			deps.ui.showErrorMessage('Git Sweep Pro: Internal error — selected branch not found.');
			return;
		}

		const targetRef = targetItem.ref;
		const localTarget = toLocalBranchRef(targetRef, targetItem.isRemote);

		try {
			await deps.ui.withProgress(
				{ title: `Git Sweep Pro: Checking out ${localTarget}...` },
				async () => {
					if (targetItem.isRemote) {
						// Attempt to switch to an existing local branch first to preserve
						// any local commits; only create a new tracking branch if it doesn't exist.
						try {
							await runGit(['checkout', localTarget]);
						} catch {
							await runGit(['checkout', '-b', localTarget, '--track', targetRef]);
						}
					} else {
						await runGit(['checkout', targetRef]);
					}
				}
			);
		} catch (checkoutError) {
			const msg = checkoutError instanceof Error ? checkoutError.message : String(checkoutError);
			deps.ui.showErrorMessage(`Git Sweep Pro: Checkout failed: ${msg}`);
			deps.output.appendLine(`[error] Checkout failed: ${msg}`);
			deps.output.appendLine('--- Post Pull Request session ended ---');
			return;
		}

		deps.output.appendLine(`Checked out: ${localTarget}`);

		try {
			await deps.ui.withProgress(
				{ title: `Git Sweep Pro: Deleting branch ${currentBranch}...` },
				() => runGit(['branch', '-D', currentBranch])
			);
			deps.output.appendLine(`Deleted branch: ${currentBranch}`);
		} catch {
			deps.ui.showErrorMessage(
				`Git Sweep Pro: Could not delete branch "${currentBranch}". You can delete it manually with: git branch -D ${escapeForShell(currentBranch)}`
			);
		}

		// Sweep here intentionally uses safe delete (-d only): dryRun=false, forceDelete=false.
		// runSweepWorkflow is not given forceDelete to avoid -D on other gone branches.
		await runSweepWorkflow({ dryRun: false, forceDelete: false }, deps);

		let pulled = false;
		try {
			await deps.ui.withProgress(
				{ title: `Git Sweep Pro: Pulling ${localTarget}...` },
				() => runGit(['pull'])
			);
			pulled = true;
			deps.output.appendLine(`Pulled latest changes for ${localTarget}.`);
		} catch (pullError) {
			const msg = pullError instanceof Error ? pullError.message : String(pullError);
			if (/no upstream|no tracking|please specify.*branch/i.test(msg)) {
				deps.output.appendLine(`No upstream configured for ${localTarget}. Pull skipped.`);
				deps.ui.showInformationMessage(
					`Git Sweep Pro: Switched to ${localTarget}. (No upstream—pull skipped.)`
				);
			} else {
				throw pullError;
			}
		}

		deps.output.appendLine('--- Post Pull Request session ended ---');
		if (pulled) {
			deps.ui.showInformationMessage(`Git Sweep Pro: Switched to ${localTarget} and pulled.`);
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
		deps.output.appendLine(`[error] ${message}`);
		deps.output.appendLine('--- Post Pull Request session ended ---');
	}
}
