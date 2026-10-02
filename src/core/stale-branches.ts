import { GONE_REFS_ARGS, isProtectedBranch, parseLocalBranchRefs, type LocalBranchRef } from './sweep-logic';
import type { SweepWorkflowDeps } from './sweep-workflow';

/** A stale branch that a sweep run from here cannot delete, because it is checked out. */
export type CheckedOutBranch =
	| { readonly name: string; readonly where: 'current' }
	| { readonly name: string; readonly where: 'main-worktree'; readonly worktreePath: string };

export type StaleBranches = {
	/** Branches whose upstream is gone: the sweep candidates. */
	readonly stale: string[];
	/** Branches whose upstream is gone but that match a protected pattern. */
	readonly protected: string[];
	/** Stale branches checked out where they cannot be removed from here. */
	readonly checkedOut: readonly CheckedOutBranch[];
	/** Worktree path of each stale branch checked out in a linked worktree (removed before the branch is deleted). */
	readonly worktrees: ReadonlyMap<string, string>;
};

/** Path of the main worktree: the first entry of `git worktree list --porcelain`. */
async function findMainWorktree(workspaceRoot: string, deps: SweepWorkflowDeps): Promise<string | undefined> {
	const { stdout } = await deps.runGitCommand(['worktree', 'list', '--porcelain'], workspaceRoot);
	return /^worktree (.+)$/m.exec(stdout)?.[1];
}

/**
 * Fetches, prunes remote references and missing worktrees (unless disabled in
 * the settings), then finds the local branches whose upstream is gone, split
 * by the protected-branch patterns. Branches checked out here or in the main
 * worktree are set apart: `git worktree remove` cannot free them.
 */
export async function findStaleBranches(workspaceRoot: string, deps: SweepWorkflowDeps): Promise<StaleBranches> {
	const settings = deps.getSettings();
	if (settings.autoFetchPrune) {
		await deps.ui.withProgress({ title: 'Fetching and pruning remote references' }, () =>
			Promise.all([
				deps.runGitCommand(['fetch', '-p'], workspaceRoot),
				// Forget worktrees whose directory no longer exists: until then Git
				// treats their branches as checked out and refuses to delete them.
				deps.runGitCommand(['worktree', 'prune'], workspaceRoot),
			])
		);
	} else {
		deps.output.appendLine('Auto fetch/prune disabled; using local ref state.');
	}

	const gone = parseLocalBranchRefs((await deps.runGitCommand([...GONE_REFS_ARGS], workspaceRoot)).stdout).filter(
		(ref) => ref.gone
	);
	const isProtected = (ref: LocalBranchRef) => isProtectedBranch(ref.name, settings.protectedBranches);
	const deletable = gone.filter((ref) => !isProtected(ref));
	const mainWorktree = deletable.some((ref) => ref.worktreePath && !ref.isCurrent)
		? await findMainWorktree(workspaceRoot, deps)
		: undefined;

	const checkedOut: CheckedOutBranch[] = [];
	const stale: string[] = [];
	const worktrees = new Map<string, string>();
	for (const { name, isCurrent, worktreePath } of deletable) {
		if (isCurrent) {
			checkedOut.push({ name, where: 'current' });
			continue;
		}
		if (worktreePath !== undefined && worktreePath === mainWorktree) {
			checkedOut.push({ name, where: 'main-worktree', worktreePath });
			continue;
		}
		stale.push(name);
		if (worktreePath) {
			worktrees.set(name, worktreePath);
		}
	}
	return { stale, protected: gone.filter(isProtected).map((ref) => ref.name), checkedOut, worktrees };
}

/** Why a checked-out stale branch was skipped, and how to delete it. */
export function describeCheckedOutBranch(branch: CheckedOutBranch): string {
	return branch.where === 'current'
		? `"${branch.name}" is stale, but it is the current branch, so it was skipped. Switch to another branch to delete it.`
		: `"${branch.name}" is stale, but it is checked out in the main worktree (${branch.worktreePath}), so it was skipped. Switch branches there to delete it.`;
}
