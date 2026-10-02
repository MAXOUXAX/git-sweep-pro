import { GONE_REFS_ARGS, isProtectedBranch, parseLocalBranchRefs, type LocalBranchRef } from './sweep-logic';
import type { SweepWorkflowDeps } from './sweep-workflow';

export type StaleBranches = {
	/** Branches whose upstream is gone: the sweep candidates. */
	readonly stale: string[];
	/** Branches whose upstream is gone but that match a protected pattern. */
	readonly protected: string[];
	/** The current branch, when its upstream is gone: it cannot be deleted from here. */
	readonly current: string | undefined;
	/** Worktree path of each stale branch checked out in another worktree. */
	readonly worktrees: ReadonlyMap<string, string>;
};

/**
 * Fetches, prunes remote references and missing worktrees (unless disabled in
 * the settings), then finds the local branches whose upstream is gone, split
 * by the protected-branch patterns. The current branch is set apart.
 */
export async function findStaleBranches(workspaceRoot: string, deps: SweepWorkflowDeps): Promise<StaleBranches> {
	const settings = deps.getSettings();
	if (settings.autoFetchPrune) {
		await deps.ui.withProgress(
			{
				title: 'Fetching and pruning remote references',
			},
			() => deps.runGitCommand(['fetch', '-p'], workspaceRoot)
		);
		// Forget worktrees whose directory no longer exists: until then Git
		// treats their branches as checked out and refuses to delete them.
		await deps.runGitCommand(['worktree', 'prune'], workspaceRoot);
	} else {
		deps.output.appendLine('Auto fetch/prune disabled; using local ref state.');
	}

	const gone = parseLocalBranchRefs((await deps.runGitCommand([...GONE_REFS_ARGS], workspaceRoot)).stdout).filter(
		(ref) => ref.gone
	);
	const isProtected = (ref: LocalBranchRef) => isProtectedBranch(ref.name, settings.protectedBranches);
	const deletable = gone.filter((ref) => !isProtected(ref));
	const others = deletable.filter((ref) => !ref.isCurrent);
	return {
		stale: others.map((ref) => ref.name),
		protected: gone.filter(isProtected).map((ref) => ref.name),
		current: deletable.find((ref) => ref.isCurrent)?.name,
		worktrees: new Map(others.flatMap((ref) => (ref.worktreePath ? [[ref.name, ref.worktreePath] as const] : []))),
	};
}
