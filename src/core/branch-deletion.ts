import { toErrorMessage } from './errors';
import { isNotFullyMergedError } from './sweep-logic';

export type DeleteResult = 'deleted' | 'not-fully-merged' | 'failed';

type BranchDeleterDeps = {
	readonly runGit: (args: string[]) => Promise<{ stdout: string }>;
	readonly log: (line: string) => void;
	/** Worktree path of each branch checked out in a linked worktree. */
	readonly worktrees: ReadonlyMap<string, string>;
};

/**
 * Deletes local branches with `git branch -d` or `-D`, first removing the
 * linked worktree a branch is checked out in. A safe delete checks that the
 * branch is merged before it removes the worktree, so a refused delete never
 * leaves a branch without its worktree.
 */
export function createBranchDeleter({ runGit, log, worktrees }: BranchDeleterDeps) {
	const removed = new Set<string>();

	/** `git branch -d` refuses a branch whose upstream is gone unless HEAD contains it. */
	const isMergedIntoHead = async (branch: string): Promise<boolean> => {
		try {
			// Lists the branch only when HEAD contains it, and succeeds either way:
			// unlike merge-base --is-ancestor, no expected failure is logged as an error.
			const { stdout } = await runGit(['branch', '--format=%(refname:short)', '--merged', 'HEAD', '--list', branch]);
			return stdout.trim() === branch;
		} catch {
			return false;
		}
	};

	const notFullyMerged = (branch: string): DeleteResult => {
		log(`[not-fully-merged] ${branch}: commits are not reachable from the current branch (likely squash/rebase merged).`);
		return 'not-fully-merged';
	};

	return async (branch: string, flag: '-d' | '-D'): Promise<DeleteResult> => {
		const worktree = worktrees.get(branch);
		if (worktree && !removed.has(branch)) {
			if (flag === '-d' && !(await isMergedIntoHead(branch))) {
				return notFullyMerged(branch);
			}
			try {
				// Without --force, Git refuses when the worktree has changes or is locked.
				await runGit(['worktree', 'remove', worktree]);
				removed.add(branch);
				log(`Removed worktree ${worktree}`);
			} catch (error) {
				log(`[worktree-not-removed] ${branch}: could not remove worktree ${worktree}: ${toErrorMessage(error)}`);
				return 'failed';
			}
		}
		try {
			await runGit(['branch', flag, branch]);
			return 'deleted';
		} catch (error) {
			const message = toErrorMessage(error);
			if (flag === '-d' && isNotFullyMergedError(message)) {
				return notFullyMerged(branch);
			}
			log(`[delete-failed] ${branch}: ${message}`);
			return 'failed';
		}
	};
}
