import { createBranchDeleter } from './branch-deletion';
import { chooseBranch, findOtherWorktreeBranch, localBranchName, parseBranches, type BranchItem } from './branch-list';
import { getDefaultBranch } from './default-branch';
import { createDeletionRecorder } from './deletion-log';
import { describeGitFailure, isNoUpstreamError, toErrorMessage } from './errors';
import { quoteShellArg } from './git-command';
import { GONE_REFS_ARGS, isProtectedBranch, parseGoneBranchRefs } from './sweep-logic';
import { runSweepWorkflow } from './sweep-workflow';
import type { WorkflowContext, WorkflowOutcome } from './workflow';

/**
 * After a pull request is merged: switches to `requested` (or the branch the
 * user picks, the default branch first), force-deletes the branch that was
 * checked out, sweeps the other stale branches, then pulls.
 */
export async function runPostPullRequestWorkflow(context: WorkflowContext, requested?: string): Promise<WorkflowOutcome> {
	const { git, output, ui } = context;
	output.header('--- Post Pull Request session started ---');
	output.header(`Workspace: ${context.root}`);

	try {
		await ui.withProgress({ title: 'Fetching remotes' }, () => git(['fetch', '-p']));

		const [currentBranchResult, branchListResult, goneRefsResult] = await Promise.all([
			git(['rev-parse', '--abbrev-ref', 'HEAD']),
			git(['branch', '--no-column', '-a']),
			git(GONE_REFS_ARGS),
		]);

		const currentBranch = currentBranchResult.stdout.trim();
		if (!currentBranch || currentBranch === 'HEAD') {
			ui.showErrorMessage('Could not determine current branch (detached HEAD?).');
			return 'failed';
		}

		const branchItems = parseBranches(branchListResult.stdout);
		if (branchItems.length === 0) {
			ui.showInformationMessage('No other branches available to checkout.');
			return 'cancelled';
		}

		const defaultBranch = await getDefaultBranch(git);
		const isGone = parseGoneBranchRefs(goneRefsResult.stdout).includes(currentBranch);

		// Pre-select the default branch; when it is checked out in another
		// worktree, prefer the default remote's ref (it can only be used detached here).
		const isDefault = (b: BranchItem) => localBranchName(b) === defaultBranch?.name;
		const target = await chooseBranch(ui, branchItems, {
			requested,
			title: 'Post Pull Request: Branch to switch to',
			placeholder:
				isGone && defaultBranch ? `Branch merged. Switch to ${defaultBranch.name}?` : 'Choose a branch (local preferred for pull)',
			describe: (b) =>
				[b.isRemote && 'remote', isDefault(b) && 'default', b.inOtherWorktree && 'checked out in another worktree']
					.filter(Boolean)
					.join(', ') || undefined,
			preferred:
				branchItems.find((b) => isDefault(b) && !b.isRemote && !b.inOtherWorktree) ??
				branchItems.find((b) => b.isRemote && b.ref === defaultBranch?.remoteRef) ??
				branchItems.find(isDefault),
		});
		if (!target) {
			output.appendLine('Operation cancelled.');
			return 'cancelled';
		}

		const localTarget = localBranchName(target);
		// A branch checked out in another worktree cannot be checked out here
		// too: switch to a detached HEAD at the same commit instead.
		const detached = findOtherWorktreeBranch(branchItems, target) !== undefined;

		try {
			await ui.withProgress(
				{ title: detached ? `Checking out ${target.ref} as a detached HEAD` : `Checking out ${localTarget}` },
				async () => {
					if (detached) {
						await git(['checkout', '--detach', target.ref]);
					} else if (target.isRemote) {
						// Attempt to switch to an existing local branch first to preserve
						// any local commits; only create a new tracking branch if it doesn't exist.
						try {
							await git(['checkout', localTarget]);
						} catch {
							await git(['checkout', '-b', localTarget, '--track', target.ref]);
						}
					} else {
						await git(['checkout', target.ref]);
					}
				}
			);
		} catch (checkoutError) {
			const msg = toErrorMessage(checkoutError);
			ui.showErrorMessage(`Checkout failed: ${msg}`);
			output.appendLine(`[error] Checkout failed: ${msg}`);
			return 'failed';
		}

		output.appendLine(
			detached
				? `Checked out ${target.ref} as a detached HEAD ("${localTarget}" is checked out in another worktree).`
				: `Checked out: ${localTarget}`
		);
		let outcome: WorkflowOutcome = 'ok';

		if (isProtectedBranch(currentBranch, context.settings.protectedBranches)) {
			output.appendLine(`Branch "${currentBranch}" is protected; skipping deletion.`);
		} else {
			const deleteBranch = createBranchDeleter({
				git,
				log: output.appendLine,
				worktrees: new Map(),
				onDeleted: createDeletionRecorder(context.deletionLog, 'post-pr', output.appendLine).record,
			});
			const result = await ui.withProgress({ title: `Deleting branch ${currentBranch}` }, () => deleteBranch(currentBranch, '-D'));
			if (result === 'deleted') {
				output.appendLine(`Deleted branch: ${currentBranch}`);
			} else {
				ui.showErrorMessage(
					`Could not delete branch "${currentBranch}". You can delete it manually with: git branch -D ${quoteShellArg(currentBranch)}`
				);
				outcome = 'failed';
			}
		}

		// Other stale branches only get a safe delete (-d): -D is reserved for
		// the branch whose pull request was just merged.
		if ((await runSweepWorkflow(context, 'safeDelete')) === 'failed') {
			outcome = 'failed';
		}

		if (detached) {
			ui.showInformationMessage(
				`Switched to a detached HEAD at ${target.ref} because "${localTarget}" is checked out in another worktree. Pull skipped.`
			);
			return outcome;
		}

		try {
			await ui.withProgress({ title: `Pulling ${localTarget}` }, () => git(['pull']));
			output.appendLine(`Pulled latest changes for ${localTarget}.`);
			ui.showInformationMessage(`Switched to ${localTarget} and pulled.`);
		} catch (pullError) {
			if (!isNoUpstreamError(toErrorMessage(pullError))) {
				throw pullError;
			}
			output.appendLine(`No upstream configured for ${localTarget}. Pull skipped.`);
			ui.showInformationMessage(`Switched to ${localTarget}. (No upstream—pull skipped.)`);
		}
		return outcome;
	} catch (error) {
		const message = toErrorMessage(error);
		ui.showErrorMessage(...describeGitFailure(message, { failed: true }));
		output.appendLine(`[error] ${message}`);
		return 'failed';
	} finally {
		output.header('--- Post Pull Request session ended ---');
	}
}
