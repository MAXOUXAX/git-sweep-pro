import * as fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { CLEAN_SCHEMA, type IgnoredFiles, type SkipReason } from './clean-plan';
import { quoteShellArg, type RunGit } from './git-command';
import { listIgnoredFiles, summarizeIgnored } from './ignored-files';
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

/** Every registered worktree, main first. */
export async function listWorktrees({ git }: WorkflowContext): Promise<Worktree[]> {
	const { stdout } = await git(['worktree', 'list', '--porcelain']);
	return parseWorktrees(stdout);
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
export function canonical(absolutePath: string): string {
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

/**
 * True when the linked worktree at `worktreePath` holds submodules, which
 * `git worktree remove` refuses without `--force`. Same test as Git's:
 * a `modules` folder in the worktree's Git directory, or a submodule checked
 * out in it. Read-only.
 */
export async function hasSubmodules(git: RunGit, worktreePath: string): Promise<boolean> {
	const modules = path.resolve(worktreePath, (await git(['-C', worktreePath, 'rev-parse', '--git-path', 'modules'])).stdout.trim());
	if (fs.existsSync(modules)) {
		return true;
	}
	const { stdout } = await git(['-C', worktreePath, 'ls-files', '--stage', '-z']);
	return stdout
		.split('\0')
		.filter((entry) => entry.startsWith('160000 '))
		.some((entry) => fs.existsSync(path.join(worktreePath, entry.slice(entry.indexOf('\t') + 1), '.git')));
}

/**
 * `git worktree remove`, made to refuse untracked files: Git checks the
 * worktree with a plain `git status`, which a `status.showUntrackedFiles=no`
 * config blinds to them, and would then delete them.
 */
export const WORKTREE_REMOVE: readonly string[] = ['-c', 'status.showUntrackedFiles=normal', 'worktree', 'remove'];

/** A rebase or a bisect in progress in a worktree, and the branch it works on. */
export type WorktreeOperation = { readonly kind: 'rebase' | 'bisect'; readonly branch: string };

/** The rebase or bisect in progress in the worktree at `worktreePath`, read from its git dir. */
export async function worktreeOperation(git: RunGit, worktreePath: string): Promise<WorktreeOperation | undefined> {
	const gitDir = await git(['-C', worktreePath, 'rev-parse', '--absolute-git-dir']).then(
		(result) => result.stdout.trim(),
		() => ''
	);
	if (!gitDir) {
		return undefined;
	}
	const read = (file: string) =>
		readFile(path.join(gitDir, file), 'utf8').then(
			(text) => text.trim(),
			() => ''
		);
	for (const file of ['rebase-merge/head-name', 'rebase-apply/head-name']) {
		const head = await read(file);
		if (head.startsWith('refs/heads/')) {
			return { kind: 'rebase', branch: head.slice('refs/heads/'.length) };
		}
	}
	// The branch, or a commit when the bisect started on a detached HEAD.
	const bisected = await read('BISECT_START');
	return bisected ? { kind: 'bisect', branch: bisected.replace(/^refs\/heads\//, '') } : undefined;
}

/**
 * Why `gsp worktree remove` keeps a worktree. Every one but `locked-worktree`
 * is lifted by `--force`, which Git needs twice for a locked worktree.
 */
export type WorktreeKeptReason = Extract<
	SkipReason,
	'locked-worktree' | 'rebase-in-progress' | 'bisect-in-progress' | 'dirty-worktree' | 'submodules' | 'ignored-files'
>;

export type WorktreeRemoval =
	| { readonly kind: 'removed'; readonly worktree: Worktree }
	| {
			readonly kind: 'kept';
			readonly worktree: Worktree;
			readonly reason: WorktreeKeptReason;
			/** The ignored files removing it would delete, regenerable ones left out; empty unless the reason is `ignored-files`. */
			readonly ignoredFiles: readonly string[];
			readonly hint: string | null;
	  }
	| { readonly kind: 'main'; readonly worktree: Worktree }
	| { readonly kind: 'ambiguous'; readonly target: string; readonly worktrees: readonly [Worktree, Worktree] }
	| { readonly kind: 'not-found'; readonly target: string };

const command = (...args: string[]) => args.map(quoteShellArg).join(' ');

/**
 * What keeps `worktree` from being removed safely, as `gsp clean` checks a
 * branch's worktree: locked, a rebase or bisect in progress, uncommitted
 * changes or untracked files, submodules, or ignored files a build does not
 * recreate. `force` lifts every check but the lock, which Git only lifts
 * with a double `--force`. Read-only.
 */
async function removalBlocker(git: RunGit, worktree: Worktree, force: boolean): Promise<Omit<Extract<WorktreeRemoval, { kind: 'kept' }>, 'kind' | 'worktree'> | undefined> {
	const at = worktree.path;
	const remove = (...flags: string[]) => command('gsp', 'worktree', 'remove', at, ...flags);
	const kept = (reason: WorktreeKeptReason, hint: string, ignoredFiles: readonly string[] = []) => ({ reason, hint, ignoredFiles });
	if (worktree.state === 'locked') {
		return kept('locked-worktree', `${command('git', 'worktree', 'unlock', at)} && ${remove()}`);
	}
	if (force) {
		return undefined;
	}
	const operation = await worktreeOperation(git, at);
	if (operation) {
		return operation.kind === 'rebase'
			? kept('rebase-in-progress', `${command('git', '-C', at, 'rebase', '--continue')} && ${remove()}`)
			: kept('bisect-in-progress', `${command('git', '-C', at, 'bisect', 'reset')} && ${remove()}`);
	}
	const { stdout: status } = await git(['-C', at, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal']);
	if (status.trim().length > 0) {
		return kept('dirty-worktree', `${command('git', '-C', at, 'stash', '--include-untracked')} && ${remove()}`);
	}
	if (await hasSubmodules(git, at)) {
		return kept('submodules', `check the submodules of ${quoteShellArg(at)} (${command('git', '-C', at, 'submodule', 'foreach', '--recursive', 'git', 'status', '--short')}), then: ${remove('--force')}`);
	}
	const ignored = await listIgnoredFiles(git, at);
	if (ignored.length > 0) {
		return kept('ignored-files', `move what you need out of ${quoteShellArg(at)}, then: ${remove('--force')}`, ignored);
	}
	return undefined;
}

/**
 * Removes one linked worktree, with the checks `gsp clean` makes before
 * removing one: a worktree that is locked, mid-rebase or mid-bisect, has
 * uncommitted changes, holds submodules or ignored files a build does not
 * recreate is kept, with a hint. `force` lifts every check but the lock. The
 * main worktree is refused. `baseDir` is the directory the command was
 * invoked from, so a relative path is read the way the user typed it. The
 * branch checked out there is never deleted.
 */
export async function removeWorktree(context: WorkflowContext, target: string, force: boolean, baseDir = context.root): Promise<WorktreeRemoval> {
	const resolution = resolveWorktree(await listWorktrees(context), target, baseDir);
	if (resolution.kind !== 'found') {
		return resolution;
	}
	const { worktree } = resolution;
	if (worktree.state === 'main') {
		return { kind: 'main', worktree };
	}
	// A prunable worktree has no directory left to check.
	if (worktree.state !== 'prunable') {
		const blocker = await removalBlocker(context.git, worktree, force);
		if (blocker) {
			return { kind: 'kept', worktree, ...blocker };
		}
	}
	await context.git([...WORKTREE_REMOVE, ...(force ? ['--force'] : []), worktree.path]);
	return { kind: 'removed', worktree };
}

/** The `--json` document of `gsp worktree remove`, once the target is found and is a linked worktree. */
export type WorktreeRemoveDocument = {
	readonly schema: typeof CLEAN_SCHEMA;
	readonly command: 'worktree remove';
	readonly worktree: { readonly path: string; readonly branch: string | null };
	readonly removed: boolean;
	/** Why it was kept; null once removed. */
	readonly reason: WorktreeKeptReason | null;
	/** The ignored files that kept it, regenerable ones left out; null unless the reason is `ignored-files`. */
	readonly ignoredFiles: IgnoredFiles | null;
	/** What to run to remove it; null once removed. */
	readonly hint: string | null;
};

export function worktreeRemoveDocument(removal: Extract<WorktreeRemoval, { kind: 'removed' | 'kept' }>): WorktreeRemoveDocument {
	const kept = removal.kind === 'kept' ? removal : undefined;
	return {
		schema: CLEAN_SCHEMA,
		command: 'worktree remove',
		worktree: { path: removal.worktree.path, branch: removal.worktree.branch ?? null },
		removed: !kept,
		reason: kept?.reason ?? null,
		ignoredFiles: kept?.reason === 'ignored-files' ? summarizeIgnored(kept.ignoredFiles) : null,
		hint: kept?.hint ?? null,
	};
}
