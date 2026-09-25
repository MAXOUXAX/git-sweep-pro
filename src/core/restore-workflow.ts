import { describeDeletion, latestDeletions, type DeletedBranch, type DeletionLog } from './deletion-log';
import { describeGitFailure, toErrorMessage } from './errors';
import { quoteShellArg } from './git-command';
import type { SweepWorkflowDeps, WorkflowOutcome } from './sweep-workflow';

export type RestoreDeps = SweepWorkflowDeps & {
	readonly deletionLog: DeletionLog;
	readonly now?: () => Date;
};

type RunGit = (args: string[]) => Promise<{ stdout: string }>;

async function localBranches(runGit: RunGit): Promise<Set<string>> {
	const { stdout } = await runGit(['for-each-ref', '--format=%(refname)', 'refs/heads']);
	return new Set(stdout.split('\n').flatMap((ref) => (ref.startsWith('refs/heads/') ? [ref.slice('refs/heads/'.length)] : [])));
}

async function commitExists(runGit: RunGit, sha: string): Promise<boolean> {
	try {
		await runGit(['cat-file', '-e', `${sha}^{commit}`]);
		return true;
	} catch {
		return false;
	}
}

/** Recreates one branch at its recorded commit; resolves to why it could not, if it could not. */
async function restoreBranch(
	deps: RestoreDeps,
	runGit: RunGit,
	entry: DeletedBranch,
	existing: ReadonlySet<string>
): Promise<string | undefined> {
	const commit = entry.sha.slice(0, 7);
	if (existing.has(entry.branch)) {
		return 'a branch with this name already exists';
	}
	if (!(await commitExists(runGit, entry.sha))) {
		return `Git has garbage-collected its commit ${commit}`;
	}
	try {
		// Refuses to overwrite a branch created since the check above.
		await runGit(['branch', entry.branch, entry.sha]);
	} catch (error) {
		return toErrorMessage(error);
	}
	deps.output.appendLine(`Restored ${entry.branch} at ${commit}.`);
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

/**
 * The newest recorded deletion of each branch, except branches whose name is
 * in use again: those cannot be restored.
 */
export async function findRestorableDeletions(deps: RestoreDeps, workspaceRoot: string): Promise<DeletedBranch[]> {
	const existing = await localBranches((args) => deps.runGitCommand(args, workspaceRoot));
	return latestDeletions(deps.deletionLog.list()).filter((entry) => !existing.has(entry.branch));
}

/** The deletions to restore: the ones named, or the ones the user picks; otherwise how the workflow ends. */
async function chooseDeletions(
	deps: RestoreDeps,
	requested: readonly string[],
	existing: ReadonlySet<string>
): Promise<{ chosen: DeletedBranch[] } | { outcome: WorkflowOutcome }> {
	const candidates = latestDeletions(deps.deletionLog.list());
	if (requested.length > 0) {
		const unknown = requested.filter((name) => !candidates.some((entry) => entry.branch === name));
		if (unknown.length > 0) {
			deps.ui.showErrorMessage(`No recorded deletion for: ${unknown.join(', ')}.`);
			return { outcome: 'failed' };
		}
		// In the order given, once each.
		return { chosen: [...new Set(requested)].flatMap((name) => candidates.filter((entry) => entry.branch === name)) };
	}

	// A name in use again cannot be restored: do not offer it.
	const restorable = candidates.filter((entry) => !existing.has(entry.branch));
	if (restorable.length === 0) {
		deps.output.appendLine('No deleted branches to restore.');
		deps.ui.showInformationMessage('No deleted branches to restore.');
		return { outcome: 'ok' };
	}
	const now = deps.now?.() ?? new Date();
	const picked = await deps.ui.pickBranches({
		items: restorable.map((entry) => ({ label: entry.branch, picked: false, description: describeDeletion(entry, now) })),
		title: 'Select branches to restore',
	});
	const chosen = restorable.filter((entry) => picked?.includes(entry.branch));
	if (chosen.length === 0) {
		deps.output.appendLine('Operation cancelled or no branches selected.');
		deps.ui.showInformationMessage('No branches selected.');
		return { outcome: 'cancelled' };
	}
	return { chosen };
}

/**
 * Recreates branches deleted by Git Sweep Pro at the commit they pointed to.
 * `requested` names the branches to restore; when empty, the user picks among
 * the recorded deletions (the newest deletion of each name). A branch whose
 * name is in use again is never overwritten. Restoring works while the
 * commits still exist, i.e. until `git gc` prunes them (by default two weeks
 * after they became unreachable).
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
		const existing = await localBranches(runGit);
		const choice = await chooseDeletions(deps, requested, existing);
		if ('outcome' in choice) {
			return choice.outcome;
		}

		const restored: string[] = [];
		const failed: string[] = [];
		for (const entry of choice.chosen) {
			const reason = await restoreBranch(deps, runGit, entry, existing);
			if (reason === undefined) {
				restored.push(entry.branch);
			} else {
				deps.output.appendLine(`[restore-failed] ${entry.branch}: ${reason}`);
				failed.push(`${entry.branch} (${reason})`);
			}
		}

		if (failed.length > 0) {
			deps.ui.showErrorMessage(
				`Restored ${restored.length} of ${choice.chosen.length} branch(es). Could not restore ${failed.join('; ')}.`
			);
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
