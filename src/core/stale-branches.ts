import { getDefaultBranch } from './default-branch';
import { findMergedBranches, type MergedBranch } from './merged-branches';
import { GONE_REFS_ARGS, isProtectedBranch, parseLocalBranchRefs, type LocalBranchRef, type SweepSettings } from './sweep-logic';
import type { WorkflowContext } from './workflow';

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
	/**
	 * Branches whose upstream is not gone but whose work is already on the
	 * default branch. Only searched with `includeMergedBranches`; never
	 * protected, current or checked out in the main worktree.
	 */
	readonly merged: readonly MergedBranch[];
	/** `includeMergedBranches` is on, but merged branches could not be searched (the reason is in the output). */
	readonly mergedSkipped: boolean;
	/** Worktree path of each stale or merged branch checked out in a linked worktree (removed before the branch is deleted). */
	readonly worktrees: ReadonlyMap<string, string>;
};

/** Path of the main worktree: the first entry of `git worktree list --porcelain`. */
async function findMainWorktree({ git }: WorkflowContext): Promise<string | undefined> {
	const { stdout } = await git(['worktree', 'list', '--porcelain']);
	return /^worktree (.+)$/m.exec(stdout)?.[1];
}

/**
 * Fetches, prunes remote references and missing worktrees (unless disabled in
 * the settings), then finds the local branches whose upstream is gone, split
 * by the protected-branch patterns. Branches checked out here or in the main
 * worktree are set apart: `git worktree remove` cannot free them. With
 * `includeMergedBranches`, also finds the other branches already merged into
 * the default branch.
 */
export async function findStaleBranches(context: WorkflowContext): Promise<StaleBranches> {
	const { settings, git, ui, output } = context;
	if (settings.autoFetchPrune) {
		// Merged branches are checked against the remote's default branch:
		// follow it when it was renamed, which a plain fetch does not do once
		// <remote>/HEAD exists (Git 2.48+; older versions ignore the setting).
		const followRemoteHead = settings.includeMergedBranches
			? (await git(['remote'])).stdout
					.split('\n')
					.filter(Boolean)
					.flatMap((remote) => ['-c', `remote.${remote}.followRemoteHEAD=always`])
			: [];
		await ui.withProgress({ title: 'Fetching and pruning remote references' }, () =>
			Promise.all([
				git([...followRemoteHead, 'fetch', '-p']),
				// Forget worktrees whose directory no longer exists: until then Git
				// treats their branches as checked out and refuses to delete them.
				git(['worktree', 'prune']),
			])
		);
	} else {
		output.appendLine('Auto fetch/prune disabled; using local ref state.');
	}

	const refs = parseLocalBranchRefs((await git(GONE_REFS_ARGS)).stdout);
	const isProtected = (ref: LocalBranchRef) => isProtectedBranch(ref.name, settings.protectedBranches);
	const gone = refs.filter((ref) => ref.gone);
	const deletable = refs.filter((ref) => !isProtected(ref) && (ref.gone || settings.includeMergedBranches));
	const mainWorktree = deletable.some((ref) => ref.worktreePath && !ref.isCurrent)
		? await findMainWorktree(context)
		: undefined;
	const isInMainWorktree = (worktreePath: string | undefined): worktreePath is string =>
		worktreePath !== undefined && worktreePath === mainWorktree;

	const checkedOut: CheckedOutBranch[] = [];
	const stale: string[] = [];
	for (const { name, gone: isGone, isCurrent, worktreePath } of deletable) {
		if (!isGone) {
			continue;
		}
		if (isCurrent) {
			checkedOut.push({ name, where: 'current' });
		} else if (isInMainWorktree(worktreePath)) {
			checkedOut.push({ name, where: 'main-worktree', worktreePath });
		} else {
			stale.push(name);
		}
	}

	// Never offered when checked out where they cannot be removed: unlike stale
	// branches, they are not reported as skipped, as their upstream still exists.
	const { merged, skipped: mergedSkipped = false } = settings.includeMergedBranches
		? await findMerged(
				context,
				deletable.filter((ref) => !ref.gone && !ref.isCurrent && !isInMainWorktree(ref.worktreePath)).map((ref) => ref.name)
			)
		: { merged: [] };

	const offered = new Set([...stale, ...merged.map((branch) => branch.name)]);
	const worktrees = new Map(
		deletable.flatMap(({ name, worktreePath }) => (worktreePath && offered.has(name) ? [[name, worktreePath] as const] : []))
	);
	return { stale, protected: gone.filter(isProtected).map((ref) => ref.name), checkedOut, merged, mergedSkipped, worktrees };
}

/**
 * Looks for merged branches among `branches`, against the remote default
 * branch (`refs/remotes/<remote>/HEAD`, set by `git clone` or
 * `git remote set-head <remote> --auto`).
 */
async function findMerged(
	{ git, ui, output }: WorkflowContext,
	branches: readonly string[]
): Promise<{ merged: MergedBranch[]; skipped?: boolean }> {
	const base = await getDefaultBranch(git);
	if (!base) {
		const [remote] = (await git(['remote'])).stdout.split('\n').filter(Boolean);
		output.appendLine(
			remote
				? `Merged branches were not checked: the default branch of "${remote}" is unknown. To set it, run: git remote set-head ${remote} --auto`
				: 'Merged branches were not checked: the repository has no remote.'
		);
		return { merged: [], skipped: true };
	}
	if (branches.length === 0) {
		return { merged: [] };
	}
	const merged = await ui.withProgress({ title: `Looking for branches merged into ${base.remoteRef}` }, () =>
		findMergedBranches(git, branches, base)
	);
	return { merged };
}

/** Why a checked-out stale branch was skipped, and how to delete it. */
export function describeCheckedOutBranch(branch: CheckedOutBranch): string {
	return branch.where === 'current'
		? `Skipped "${branch.name}": it is the current branch. Switch to another branch to delete it.`
		: `Skipped "${branch.name}": it is checked out in the main worktree (${branch.worktreePath}). Switch branches there to delete it.`;
}

/** What to say when {@link findStaleBranches} finds no branch at all. */
export function noBranchesFound(settings: SweepSettings, found: StaleBranches): string {
	if (found.mergedSkipped) {
		return 'No stale branches found. Merged branches were not checked.';
	}
	return settings.includeMergedBranches ? 'No stale or merged branches found.' : 'No stale branches found.';
}
