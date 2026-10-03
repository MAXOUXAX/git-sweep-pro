import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkflowContext } from './workflow';

/**
 * How a worktree is registered: the main one, a plain linked one, a linked one
 * Git locked, or one whose directory is gone and that `git worktree prune`
 * can forget.
 */
export type WorktreeState = 'main' | 'linked' | 'prunable' | 'locked';

export type Worktree = {
	/** Absolute path of the worktree's working directory, as Git reports it. */
	readonly path: string;
	/** Checked-out branch, or `undefined` for a detached HEAD. */
	readonly branch: string | undefined;
	readonly state: WorktreeState;
};

const WORKTREE_PREFIX = 'worktree ';
const BRANCH_PREFIX = 'branch ';
const HEADS_PREFIX = 'refs/heads/';

function worktreeState(isMain: boolean, locked: boolean, prunable: boolean): WorktreeState {
	if (isMain) {
		return 'main';
	}
	if (locked) {
		return 'locked';
	}
	return prunable ? 'prunable' : 'linked';
}

/**
 * Parses `git worktree list --porcelain`. Git lists the main worktree first,
 * then one blank-line separated block per linked worktree:
 *
 *     worktree <path>
 *     HEAD <sha>
 *     branch <ref> | detached
 *     [bare] [locked [reason]] [prunable <reason>]
 *
 * `locked` and `prunable` can appear together; a locked worktree cannot be
 * pruned, so it is reported as locked.
 */
export function parseWorktrees(porcelain: string): Worktree[] {
	return porcelain
		.split(/\n\s*\n/)
		.map((block) => block.trim())
		.filter(Boolean)
		.map((block, index) => {
			let worktreePath = '';
			let branch: string | undefined;
			let locked = false;
			let prunable = false;
			for (const line of block.split('\n')) {
				if (line.startsWith(WORKTREE_PREFIX)) {
					worktreePath = line.slice(WORKTREE_PREFIX.length);
				} else if (line.startsWith(BRANCH_PREFIX)) {
					branch = line.slice(BRANCH_PREFIX.length).replace(HEADS_PREFIX, '');
				} else if (line.startsWith('locked')) {
					locked = true;
				} else if (line.startsWith('prunable')) {
					prunable = true;
				}
			}
			return { path: worktreePath, branch, state: worktreeState(index === 0, locked, prunable) };
		});
}

/** One line for `gsp worktree list`: path, branch (or `detached`) and state. */
export function describeWorktree({ path: worktreePath, branch, state }: Worktree): string {
	return `${worktreePath}  ${branch ?? 'detached'} (${state})\n`;
}

/** Every registered worktree, main first. */
export async function listWorktrees({ git }: WorkflowContext): Promise<Worktree[]> {
	const { stdout } = await git(['worktree', 'list', '--porcelain']);
	return parseWorktrees(stdout);
}

/** Path of the main worktree: the first entry of the listing, as Git always reports it. */
export async function findMainWorktree(context: WorkflowContext): Promise<string | undefined> {
	return (await listWorktrees(context))[0]?.path;
}

export type WorktreePrune = {
	/** Paths of the registrations Git forgot. */
	readonly pruned: readonly string[];
};

/**
 * Runs `git worktree prune`, then diffs the registrations before and after to
 * report exactly what was forgotten. Only registrations whose directory is
 * gone are dropped: existing worktrees are never touched. With `dryRun`, git is
 * not run and the prunable registrations are reported instead.
 */
export async function pruneWorktrees(context: WorkflowContext, dryRun = false): Promise<WorktreePrune> {
	const before = await listWorktrees(context);
	if (dryRun) {
		return { pruned: before.filter((worktree) => worktree.state === 'prunable').map((worktree) => worktree.path) };
	}
	await context.git(['worktree', 'prune']);
	const remaining = new Set((await listWorktrees(context)).map((worktree) => worktree.path));
	return { pruned: before.map((worktree) => worktree.path).filter((worktreePath) => !remaining.has(worktreePath)) };
}

/** Absolute, symlink-resolved path when it exists, otherwise the lexical absolute path. */
function canonical(absolutePath: string): string {
	try {
		return fs.realpathSync(absolutePath);
	} catch {
		return path.resolve(absolutePath);
	}
}

export type WorktreeResolution =
	| { readonly kind: 'found'; readonly worktree: Worktree }
	/** The target names a path and a branch that belong to different worktrees. */
	| { readonly kind: 'ambiguous'; readonly target: string; readonly worktrees: readonly [Worktree, Worktree] }
	| { readonly kind: 'not-found'; readonly target: string };

/**
 * Finds a worktree by the path it was registered under (absolute, or relative
 * to `baseDir`: the directory the command was invoked from) or by the branch it
 * has checked out. Git reports canonical paths, so both sides are compared
 * through symlinks. A path and a branch that name different worktrees are
 * ambiguous rather than silently picking one.
 */
export function resolveWorktree(worktrees: readonly Worktree[], target: string, baseDir: string): WorktreeResolution {
	const targetPath = canonical(path.resolve(baseDir, target));
	const byPath =
		worktrees.find((worktree) => worktree.path === target) ?? worktrees.find((worktree) => canonical(worktree.path) === targetPath);
	const byBranch = worktrees.find((worktree) => worktree.branch === target);
	if (byPath && byBranch && byPath !== byBranch) {
		return { kind: 'ambiguous', target, worktrees: [byPath, byBranch] };
	}
	const worktree = byPath ?? byBranch;
	return worktree ? { kind: 'found', worktree } : { kind: 'not-found', target };
}

export type WorktreeRemoval =
	| { readonly kind: 'removed'; readonly worktree: Worktree }
	| { readonly kind: 'main'; readonly worktree: Worktree }
	| { readonly kind: 'ambiguous'; readonly target: string; readonly worktrees: readonly [Worktree, Worktree] }
	| { readonly kind: 'not-found'; readonly target: string };

/**
 * Removes one linked worktree. The main worktree is refused, and without
 * `force` Git refuses a dirty or locked worktree: its reason travels up as the
 * thrown error. `baseDir` is the directory the command was invoked from, so a
 * relative path is read the way the user typed it.
 */
export async function removeWorktree(context: WorkflowContext, target: string, force: boolean, baseDir = context.root): Promise<WorktreeRemoval> {
	const resolution = resolveWorktree(await listWorktrees(context), target, baseDir);
	if (resolution.kind !== 'found') {
		return resolution;
	}
	if (resolution.worktree.state === 'main') {
		return { kind: 'main', worktree: resolution.worktree };
	}
	await context.git(['worktree', 'remove', ...(force ? ['--force'] : []), resolution.worktree.path]);
	return { kind: 'removed', worktree: resolution.worktree };
}
