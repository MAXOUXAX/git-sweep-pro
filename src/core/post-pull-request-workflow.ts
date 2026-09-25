import { createBranchDeleter } from './branch-deletion';
import { branchPickLabel, findBranchByPickLabel, findOtherWorktreeBranch, localBranchName, parseBranches, type BranchItem } from './branch-list';
import { createDeletionRecorder } from './deletion-log';
import { describeGitFailure, isNoUpstreamError, toErrorMessage } from './errors';
import { escapeForShell } from './git-command';
import { getDefaultBranch } from './merged-branches';
import { GONE_REFS_ARGS, isProtectedBranch, parseGoneBranchRefs } from './sweep-logic';
import { runSweepWorkflow, singlePick, type SweepWorkflowDeps, type WorkflowOutcome } from './sweep-workflow';

export type PostPullRequestDeps = SweepWorkflowDeps;

export async function runPostPullRequestWorkflow(deps: PostPullRequestDeps): Promise<WorkflowOutcome> {
	const workspaceRoot = deps.getWorkspaceRoot();
	if (!workspaceRoot) {
		deps.ui.showErrorMessage('No workspace folder is open.');
		return 'failed';
	}

	deps.output.show(true);
	deps.output.header('--- Post Pull Request session started ---');
	deps.output.header(`Workspace: ${workspaceRoot}`);

	const runGit = (args: string[]) => deps.runGitCommand(args, workspaceRoot);

	try {
		await deps.ui.withProgress(
			{ title: 'Fetching remotes' },
			() => runGit(['fetch', '-p'])
		);

		const [currentBranchResult, branchListResult, goneRefsResult] = await Promise.all([
			runGit(['rev-parse', '--abbrev-ref', 'HEAD']),
			runGit(['branch', '--no-column', '-a']),
			runGit([...GONE_REFS_ARGS]),
		]);

		const currentBranch = currentBranchResult.stdout.trim();
		if (!currentBranch || currentBranch === 'HEAD') {
			deps.ui.showErrorMessage('Could not determine current branch (detached HEAD?).');
			return 'failed';
		}

		const branchItems = parseBranches(branchListResult.stdout);
		if (branchItems.length === 0) {
			deps.ui.showInformationMessage('No other branches available to checkout.');
			return 'cancelled';
		}

		const defaultBranch = await getDefaultBranch(runGit);
		const isGone = parseGoneBranchRefs(goneRefsResult.stdout).includes(currentBranch);

		// Pre-select the default branch; when it is checked out in another
		// worktree, prefer the default remote's ref (it can only be used detached here).
		const isDefault = (b: BranchItem) => localBranchName(b) === defaultBranch?.name;
		const preferred =
			branchItems.find((b) => isDefault(b) && !b.isRemote && !b.inOtherWorktree) ??
			branchItems.find((b) => b.isRemote && b.ref === defaultBranch?.remoteRef) ??
			branchItems.find(isDefault);

		const quickPickItems = branchItems.map((b) => ({
			label: branchPickLabel(b),
			description: [
				b.isRemote ? 'remote' : undefined,
				isDefault(b) ? 'default' : undefined,
				b.inOtherWorktree ? 'checked out in another worktree' : undefined,
			]
				.filter(Boolean)
				.join(', ') || undefined,
			picked: b === preferred,
		}));

		const selected = await deps.ui.showQuickPick(quickPickItems, {
			canPickMany: false,
			ignoreFocusOut: true,
			matchOnDescription: true,
			title: 'Post Pull Request: Branch to switch to',
			placeHolder: isGone && defaultBranch
				? `Branch merged. Switch to ${defaultBranch.name}?`
				: 'Choose a branch (local preferred for pull)',
		});

		const selectedItem = singlePick(selected);
		if (!selectedItem) {
			deps.output.appendLine('Operation cancelled.');
			deps.output.header('--- Post Pull Request session ended ---');
			return 'cancelled';
		}

		const targetItem = findBranchByPickLabel(branchItems, selectedItem.label);
		if (!targetItem) {
			deps.output.appendLine('[error] Could not match selected branch to branch list.');
			deps.ui.showErrorMessage('Internal error — selected branch not found.');
			return 'failed';
		}

		const targetRef = targetItem.ref;
		const localTarget = localBranchName(targetItem);

		// A branch checked out in another worktree cannot be checked out here
		// too: switch to a detached HEAD at the same commit instead.
		const detached = findOtherWorktreeBranch(branchItems, targetItem) !== undefined;

		try {
			await deps.ui.withProgress(
				{ title: detached ? `Checking out ${targetRef} as a detached HEAD` : `Checking out ${localTarget}` },
				async () => {
					if (detached) {
						await runGit(['checkout', '--detach', targetRef]);
					} else if (targetItem.isRemote) {
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
			const msg = toErrorMessage(checkoutError);
			deps.ui.showErrorMessage(`Checkout failed: ${msg}`);
			deps.output.appendLine(`[error] Checkout failed: ${msg}`);
			deps.output.header('--- Post Pull Request session ended ---');
			return 'failed';
		}

		deps.output.appendLine(
			detached
				? `Checked out ${targetRef} as a detached HEAD ("${localTarget}" is checked out in another worktree).`
				: `Checked out: ${localTarget}`
		);
		let outcome: WorkflowOutcome = 'ok';

		if (isProtectedBranch(currentBranch, deps.getSettings().protectedBranches)) {
			deps.output.appendLine(`Branch "${currentBranch}" is protected; skipping deletion.`);
		} else {
			const deleteBranch = createBranchDeleter({
				runGit,
				log: (line) => deps.output.appendLine(line),
				worktrees: new Map(),
				onDeleted: deps.deletionLog && createDeletionRecorder(deps.deletionLog, 'post-pr', deps.output.appendLine).record,
			});
			const result = await deps.ui.withProgress({ title: `Deleting branch ${currentBranch}` }, () =>
				deleteBranch(currentBranch, '-D')
			);
			if (result === 'deleted') {
				deps.output.appendLine(`Deleted branch: ${currentBranch}`);
			} else {
				deps.ui.showErrorMessage(
					`Could not delete branch "${currentBranch}". You can delete it manually with: git branch -D ${escapeForShell(currentBranch)}`
				);
				outcome = 'failed';
			}
		}

		// Sweep here intentionally uses safe delete (-d only): dryRun=false, forceDelete=false.
		// runSweepWorkflow is not given forceDelete to avoid -D on other gone branches.
		if ((await runSweepWorkflow({ dryRun: false, forceDelete: false }, deps)) === 'failed') {
			outcome = 'failed';
		}

		if (detached) {
			deps.output.header('--- Post Pull Request session ended ---');
			deps.ui.showInformationMessage(
				`Switched to a detached HEAD at ${targetRef} because "${localTarget}" is checked out in another worktree. Pull skipped.`
			);
			return outcome;
		}

		let pulled = false;
		try {
			await deps.ui.withProgress(
				{ title: `Pulling ${localTarget}` },
				() => runGit(['pull'])
			);
			pulled = true;
			deps.output.appendLine(`Pulled latest changes for ${localTarget}.`);
		} catch (pullError) {
			if (isNoUpstreamError(toErrorMessage(pullError))) {
				deps.output.appendLine(`No upstream configured for ${localTarget}. Pull skipped.`);
				deps.ui.showInformationMessage(
					`Switched to ${localTarget}. (No upstream—pull skipped.)`
				);
			} else {
				throw pullError;
			}
		}

		deps.output.header('--- Post Pull Request session ended ---');
		if (pulled) {
			deps.ui.showInformationMessage(`Switched to ${localTarget} and pulled.`);
		}
		return outcome;
	} catch (error) {
		const message = toErrorMessage(error);
		deps.ui.showErrorMessage(...describeGitFailure(message, { failed: true }));
		deps.output.appendLine(`[error] ${message}`);
		deps.output.header('--- Post Pull Request session ended ---');
		return 'failed';
	}
}
