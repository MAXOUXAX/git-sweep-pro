import { describeDeletion, latestDeletions, type DeletedBranch, type DeletionLog } from './deletion-log';
import { describeGitFailure, toErrorMessage } from './errors';
import { quoteShellArg } from './git-command';
import type { SweepWorkflowDeps, WorkflowOutcome } from './sweep-workflow';

export type RestoreDeps = SweepWorkflowDeps & {
	readonly deletionLog: DeletionLog;
	readonly now?: () => Date;
};

type RunGit = (args: string[]) => Promise<{ stdout: string }>;

/** A recorded deletion, and why it cannot be restored when it cannot. */
export type RestoreCandidate = {
	readonly entry: DeletedBranch;
	readonly blocker: string | undefined;
};

const lineSet = (stdout: string) => new Set(stdout.split('\n').map((line) => line.trim()));

/**
 * The newest recorded deletion of each branch, checked against the
 * repository: a branch whose name is in use again is never overwritten, and
 * a commit that Git garbage-collected cannot come back.
 */
export async function inspectDeletions(deps: RestoreDeps, workspaceRoot: string): Promise<RestoreCandidate[]> {
	const entries = latestDeletions(deps.deletionLog.list());
	if (entries.length === 0) {
		return [];
	}
	const runGit: RunGit = (args) => deps.runGitCommand(args, workspaceRoot);
	const [refs, commits] = await Promise.all([
		runGit(['for-each-ref', '--format=%(refname)', 'refs/heads']),
		// Prints the commits that still exist, and skips the others.
		runGit(['rev-list', '--no-walk', '--ignore-missing', ...new Set(entries.map((entry) => entry.sha))]),
	]);
	const existingRefs = lineSet(refs.stdout);
	const availableCommits = lineSet(commits.stdout);
	return entries.map((entry) => ({
		entry,
		blocker: existingRefs.has(`refs/heads/${entry.branch}`)
			? 'a branch with this name already exists'
			: availableCommits.has(entry.sha)
				? undefined
				: `Git has garbage-collected its commit ${entry.sha.slice(0, 7)}`,
	}));
}

/** Recreates one branch at its recorded commit; resolves to why it could not, if it could not. */
async function restoreBranch(deps: RestoreDeps, runGit: RunGit, { entry, blocker }: RestoreCandidate): Promise<string | undefined> {
	if (blocker) {
		return blocker;
	}
	try {
		// Fails instead of overwriting a branch created since the inspection.
		await runGit(['branch', entry.branch, entry.sha]);
	} catch (error) {
		return toErrorMessage(error);
	}
	deps.output.appendLine(`Restored ${entry.branch} at ${entry.sha.slice(0, 7)}.`);
	if (entry.worktree) {
		deps.output.appendLine(
			`Its worktree was removed. To recreate it, run: git worktree add ${quoteShellArg(entry.worktree)} ${quoteShellArg(entry.branch)}`
		);
	}
	try {
		await deps.deletionLog.forget(entry);
	} catch (error) {
		deps.output.appendLine(`[warning] Could not remove ${entry.branch} from the deleted-branch log: ${toErrorMessage(error)}`);
	}
	return undefined;
}

/** The deletions to restore: the ones named, or the ones the user picks; otherwise how the workflow ends. */
async function chooseDeletions(
	deps: RestoreDeps,
	requested: readonly string[],
	candidates: readonly RestoreCandidate[]
): Promise<readonly RestoreCandidate[] | WorkflowOutcome> {
	const named = (name: string) => candidates.filter(({ entry }) => entry.branch === name);
	if (requested.length > 0) {
		const unknown = requested.filter((name) => named(name).length === 0);
		if (unknown.length > 0) {
			deps.ui.showErrorMessage(`No recorded deletion for: ${unknown.join(', ')}.`);
			return 'failed';
		}
		// In the order given, once each.
		return [...new Set(requested)].flatMap(named);
	}

	const restorable = candidates.filter((candidate) => !candidate.blocker);
	if (restorable.length === 0) {
		deps.output.appendLine('No deleted branches to restore.');
		deps.ui.showInformationMessage('No deleted branches to restore.');
		return 'ok';
	}
	const now = deps.now?.() ?? new Date();
	const picked = await deps.ui.pickBranches({
		items: restorable.map(({ entry }) => ({ label: entry.branch, picked: false, description: describeDeletion(entry, now) })),
		title: 'Select branches to restore',
	});
	const chosen = restorable.filter(({ entry }) => picked?.includes(entry.branch));
	if (chosen.length === 0) {
		deps.output.appendLine('Operation cancelled or no branches selected.');
		deps.ui.showInformationMessage('No branches selected.');
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
export async function runRestoreWorkflow(deps: RestoreDeps, requested: readonly string[]): Promise<WorkflowOutcome> {
	const workspaceRoot = deps.getWorkspaceRoot();
	if (!workspaceRoot) {
		deps.ui.showErrorMessage('No workspace folder is open.');
		return 'failed';
	}
	const runGit: RunGit = (args) => deps.runGitCommand(args, workspaceRoot);

	deps.output.show(true);
	deps.output.header('--- Restore session started ---');
	deps.output.header(`Workspace: ${workspaceRoot}`);
	try {
		const chosen = await chooseDeletions(deps, requested, await inspectDeletions(deps, workspaceRoot));
		if (typeof chosen === 'string') {
			return chosen;
		}

		const restored: string[] = [];
		const failed: string[] = [];
		for (const candidate of chosen) {
			const { branch } = candidate.entry;
			const reason = await restoreBranch(deps, runGit, candidate);
			if (reason === undefined) {
				restored.push(branch);
			} else {
				deps.output.appendLine(`[restore-failed] ${branch}: ${reason}`);
				failed.push(`${branch} (${reason})`);
			}
		}

		if (failed.length > 0) {
			deps.ui.showErrorMessage(`Restored ${restored.length} of ${chosen.length} branch(es). Could not restore ${failed.join('; ')}.`);
			return 'failed';
		}
		deps.ui.showInformationMessage(`Restored ${restored.length} branch(es): ${restored.join(', ')}.`);
		return 'ok';
	} catch (error) {
		deps.ui.showErrorMessage(...describeGitFailure(toErrorMessage(error), { failed: true }));
		return 'failed';
	} finally {
		deps.output.header('--- Restore session ended ---');
	}
}
