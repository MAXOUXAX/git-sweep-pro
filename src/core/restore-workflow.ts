import { deletionLabel, describeDeletion, latestDeletions, type DeletedBranch } from './deletion-log';
import { describeGitFailure, toErrorMessage } from './errors';
import { quoteShellArg } from './git-command';
import type { WorkflowContext, WorkflowOutcome } from './workflow';

/** A recorded deletion, checked against the repository. */
export type RestoreCandidate = {
	readonly entry: DeletedBranch;
	/** Why it cannot be restored, when it cannot. */
	readonly blocker: string | undefined;
	/** The upstream to track again: the recorded one, if it still exists. */
	readonly upstream: string | undefined;
};

const lineSet = (stdout: string) => new Set(stdout.split('\n').map((line) => line.trim()));

/**
 * The newest recorded deletion of each branch, checked against the
 * repository: a branch whose name is in use again (locally, or on its
 * remote as last fetched for a remote deletion) is never overwritten, a
 * commit that Git garbage-collected cannot come back, and an upstream that
 * was deleted is not tracked again (the next sweep would delete the branch).
 */
export async function inspectDeletions({ deletionLog, git }: WorkflowContext): Promise<RestoreCandidate[]> {
	const entries = latestDeletions(deletionLog.list());
	if (entries.length === 0) {
		return [];
	}
	const [refs, commits] = await Promise.all([
		git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']),
		// Prints the commits that still exist, and skips the others.
		git(['rev-list', '--no-walk', '--ignore-missing', ...new Set(entries.map((entry) => entry.sha))]),
	]);
	const existingRefs = lineSet(refs.stdout);
	const availableCommits = lineSet(commits.stdout);
	return entries.map((entry) => ({
		entry,
		blocker: existingRefs.has(entry.remote ? `refs/remotes/${entry.remote}/${entry.branch}` : `refs/heads/${entry.branch}`)
			? `a branch with this name already exists${entry.remote ? ` on ${entry.remote}` : ''}`
			: availableCommits.has(entry.sha)
				? undefined
				: `Git has garbage-collected its commit ${entry.sha.slice(0, 7)}`,
		upstream: entry.upstream && existingRefs.has(entry.upstream) ? entry.upstream : undefined,
	}));
}

/**
 * Pushes a branch deleted on its remote back at its recorded commit. The
 * empty lease makes the push fail if a branch of that name was created
 * there since, instead of moving it.
 */
async function restoreRemoteBranch({ git, output, deletionLog }: WorkflowContext, entry: DeletedBranch & { remote: string }): Promise<string | undefined> {
	const ref = `refs/heads/${entry.branch}`;
	try {
		await git(['push', `--force-with-lease=${ref}:`, entry.remote, `${entry.sha}:${ref}`]);
	} catch (error) {
		return toErrorMessage(error);
	}
	output.appendLine(`Restored ${entry.branch} on ${entry.remote} at ${entry.sha.slice(0, 7)}.`);
	try {
		await deletionLog.forget(entry.branch, entry.remote);
	} catch (error) {
		output.appendLine(`[warning] Could not remove ${deletionLabel(entry)} from the deleted-branch log: ${toErrorMessage(error)}`);
	}
	return undefined;
}

/** Recreates one branch at its recorded commit; resolves to why it could not, if it could not. */
async function restoreBranch(context: WorkflowContext, { entry, blocker, upstream }: RestoreCandidate): Promise<string | undefined> {
	if (blocker) {
		return blocker;
	}
	if (entry.remote !== undefined) {
		return restoreRemoteBranch(context, { ...entry, remote: entry.remote });
	}
	const { git, output, deletionLog } = context;
	try {
		// Fails instead of overwriting a branch created since the inspection.
		await git(['branch', entry.branch, entry.sha]);
	} catch (error) {
		return toErrorMessage(error);
	}
	output.appendLine(`Restored ${entry.branch} at ${entry.sha.slice(0, 7)}.`);
	if (upstream) {
		const name = upstream.replace(/^refs\/(?:remotes|heads)\//, '');
		try {
			await git(['branch', `--set-upstream-to=${upstream}`, entry.branch]);
			output.appendLine(`It tracks ${name} again.`);
		} catch (error) {
			output.appendLine(`[warning] Could not set ${name} as the upstream of ${entry.branch}: ${toErrorMessage(error)}`);
		}
	}
	if (entry.worktree) {
		output.appendLine(
			`Its worktree was removed. To recreate it, run: git worktree add ${quoteShellArg(entry.worktree)} ${quoteShellArg(entry.branch)}`
		);
	}
	try {
		await deletionLog.forget(entry.branch);
	} catch (error) {
		output.appendLine(`[warning] Could not remove ${entry.branch} from the deleted-branch log: ${toErrorMessage(error)}`);
	}
	return undefined;
}

/** The deletions to restore: the ones named, or the ones the user picks; otherwise how the workflow ends. */
async function chooseDeletions(
	{ output, ui }: WorkflowContext,
	requested: readonly string[],
	candidates: readonly RestoreCandidate[],
	now: Date
): Promise<readonly RestoreCandidate[] | WorkflowOutcome> {
	const named = (name: string) => candidates.filter(({ entry }) => deletionLabel(entry) === name);
	if (requested.length > 0) {
		const unknown = requested.filter((name) => named(name).length === 0);
		if (unknown.length > 0) {
			ui.showErrorMessage(`No recorded deletion for: ${unknown.join(', ')}.`);
			return 'failed';
		}
		// In the order given, once each.
		return [...new Set(requested)].flatMap(named);
	}

	const restorable = candidates.filter((candidate) => !candidate.blocker);
	if (restorable.length === 0) {
		output.appendLine('No deleted branches to restore.');
		ui.showInformationMessage('No deleted branches to restore.');
		return 'ok';
	}
	const picked = await ui.pickMany({
		items: restorable.map(({ entry }) => ({ label: deletionLabel(entry), picked: false, description: describeDeletion(entry, now) })),
		title: 'Select branches to restore',
	});
	const chosen = restorable.filter(({ entry }) => picked?.includes(deletionLabel(entry)));
	if (chosen.length === 0) {
		output.appendLine('Operation cancelled or no branches selected.');
		ui.showInformationMessage('No branches selected.');
		return 'cancelled';
	}
	return chosen;
}

/**
 * Recreates branches deleted by Git Sweep Pro at the commit they pointed to.
 * `requested` names the branches to restore; when empty, the user picks among
 * the recorded deletions that can be restored (see {@link inspectDeletions}).
 * Restoring works while the commits still exist, i.e. until `git gc` prunes
 * them (by default two weeks after they became unreachable).
 */
export async function runRestoreWorkflow(
	context: WorkflowContext,
	requested: readonly string[],
	now: Date = new Date()
): Promise<WorkflowOutcome> {
	const { output, ui } = context;
	output.header('--- Restore session started ---');
	output.header(`Workspace: ${context.root}`);
	try {
		const chosen = await chooseDeletions(context, requested, await inspectDeletions(context), now);
		if (typeof chosen === 'string') {
			return chosen;
		}

		const restored: string[] = [];
		const failed: string[] = [];
		for (const candidate of chosen) {
			const branch = deletionLabel(candidate.entry);
			const reason = await restoreBranch(context, candidate);
			if (reason === undefined) {
				restored.push(branch);
			} else {
				output.appendLine(`[restore-failed] ${branch}: ${reason}`);
				failed.push(`${branch} (${reason})`);
			}
		}

		if (failed.length > 0) {
			ui.showErrorMessage(`Restored ${restored.length} of ${chosen.length} branch(es). Could not restore ${failed.join('; ')}.`);
			return 'failed';
		}
		ui.showInformationMessage(`Restored ${restored.length} branch(es): ${restored.join(', ')}.`);
		return 'ok';
	} catch (error) {
		ui.showErrorMessage(...describeGitFailure(toErrorMessage(error), { failed: true }));
		return 'failed';
	} finally {
		output.header('--- Restore session ended ---');
	}
}
