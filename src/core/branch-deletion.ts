import type { Deletion } from './deletion-log';
import { toErrorMessage } from './errors';
import type { RunGit } from './git-command';
import { isNotFullyMergedError } from './sweep-logic';

export type DeleteResult = 'deleted' | 'not-fully-merged' | 'failed';

type BranchDeleterDeps = {
	readonly git: RunGit;
	readonly log: (line: string) => void;
	/** Worktree path of each branch checked out in a linked worktree. */
	readonly worktrees: ReadonlyMap<string, string>;
	/** Called after each deletion with the commit the branch pointed to, to record it for undo. */
	readonly onDeleted: (deletion: Deletion) => Promise<unknown>;
};

/**
 * Deletes local branches with `git branch -d` or `-D`, first removing the
 * linked worktree a branch is checked out in. A safe delete checks that the
 * branch is merged before it removes the worktree, so a refused delete never
 * leaves a branch without its worktree.
 */
export function createBranchDeleter({ git, log, worktrees, onDeleted }: BranchDeleterDeps) {
	const removed = new Set<string>();

	/** `git branch -d` refuses a branch whose upstream is gone unless HEAD contains it. */
	const isMergedIntoHead = async (branch: string): Promise<boolean> => {
		try {
			// Lists the branch only when HEAD contains it, and succeeds either way:
			// unlike merge-base --is-ancestor, no expected failure is logged as an error.
			const { stdout } = await git(['branch', '--format=%(refname:short)', '--merged', 'HEAD', '--list', branch]);
			return stdout.trim() === branch;
		} catch {
			return false;
		}
	};

	const notFullyMerged = (branch: string): DeleteResult => {
		log(`[not-fully-merged] ${branch}: commits are not reachable from the current branch (likely squash/rebase merged).`);
		return 'not-fully-merged';
	};

	/** Tip and upstream of the branch, read right before deleting it so the recorded commit is the one deleted. */
	const readBranch = async (branch: string): Promise<Pick<Deletion, 'sha' | 'upstream'> | undefined> => {
		const ref = `refs/heads/${branch}`;
		try {
			// A pattern also matches the refs below it ("a" matches "a/b"): keep the exact ref.
			const { stdout } = await git(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(upstream)', ref]);
			const [, sha, upstream] = stdout.split('\n').map((line) => line.split('\t')).find(([name]) => name === ref) ?? [];
			return sha ? { sha, ...(upstream ? { upstream } : {}) } : undefined;
		} catch {
			return undefined;
		}
	};

	return async (branch: string, flag: '-d' | '-D'): Promise<DeleteResult> => {
		const worktree = worktrees.get(branch);
		if (worktree && !removed.has(branch)) {
			if (flag === '-d' && !(await isMergedIntoHead(branch))) {
				return notFullyMerged(branch);
			}
			try {
				// Without --force, Git refuses when the worktree has changes or is locked.
				await git(['worktree', 'remove', worktree]);
				removed.add(branch);
				log(`Removed worktree ${worktree}`);
			} catch (error) {
				log(`[worktree-not-removed] ${branch}: could not remove worktree ${worktree}: ${toErrorMessage(error)}`);
				return 'failed';
			}
		}
		const tip = await readBranch(branch);
		try {
			await git(['branch', flag, branch]);
		} catch (error) {
			const message = toErrorMessage(error);
			if (flag === '-d' && isNotFullyMergedError(message)) {
				return notFullyMerged(branch);
			}
			log(`[delete-failed] ${branch}: ${message}`);
			return 'failed';
		}
		if (tip) {
			await onDeleted({ branch, ...tip, ...(removed.has(branch) ? { worktree } : {}) });
		} else {
			log(`[warning] Could not read the last commit of ${branch}, so it cannot be restored.`);
		}
		return 'deleted';
	};
}
