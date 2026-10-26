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

/** A rebase or a bisect in progress in a worktree, and the branch it works on: none for a rebase started on a detached HEAD. */
export type WorktreeOperation = { readonly kind: 'rebase' | 'bisect'; readonly branch: string | undefined };

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
	for (const folder of ['rebase-merge', 'rebase-apply']) {
		if (fs.existsSync(path.join(gitDir, folder))) {
			// A rebase started on a detached HEAD records `detached HEAD` instead of a branch.
			const head = await read(`${folder}/head-name`);
			return { kind: 'rebase', branch: head.startsWith('refs/heads/') ? head.slice('refs/heads/'.length) : undefined };
		}
	}
	// The branch, or a commit when the bisect started on a detached HEAD.
	const bisected = await read('BISECT_START');
	return bisected ? { kind: 'bisect', branch: bisected.replace(/^refs\/heads\//, '') } : undefined;
}

/**
 * Why `gsp worktree remove` keeps a worktree. Every one but `locked-worktree`
 * is lifted by `--discard-changes`; a lock never is.
 */
export type WorktreeKeptReason = Extract<
	SkipReason,
	'locked-worktree' | 'rebase-in-progress' | 'bisect-in-progress' | 'dirty-worktree' | 'submodules' | 'ignored-files'
>;

type Kept = {
	readonly kind: 'kept';
	readonly worktree: Worktree;
	readonly reason: WorktreeKeptReason;
	/** The ignored files removing it would delete, regenerable ones left out; empty unless the reason is `ignored-files`. */
	readonly ignoredFiles: readonly string[];
	/** The uncommitted changes and untracked files removing it would delete; empty unless the reason is `dirty-worktree`. */
	readonly changedFiles: readonly string[];
	/** What resolves it; names `--discard-changes` second, after the way that loses nothing, when that flag lifts it. */
	readonly hint: string;
	/** The command that resolves it without losing anything, or null when a person has to act first. */
	readonly next: string | null;
};

export type WorktreeRemoval =
	| {
			readonly kind: 'removed';
			readonly worktree: Worktree;
			/** The main worktree, when the command ran inside the one it removed: the directory to continue in. */
			readonly nextCwd: string | null;
	  }
	| Kept
	| { readonly kind: 'main'; readonly worktree: Worktree }
	| { readonly kind: 'ambiguous'; readonly target: string; readonly worktrees: readonly [Worktree, Worktree] }
	| { readonly kind: 'not-found'; readonly target: string };

const command = (...args: string[]) => args.map(quoteShellArg).join(' ');

/** The first few of `files`, for a hint: "a, b, c and 4 more". */
export function listFew(files: readonly string[], shown = 3): string {
	const few = files.slice(0, shown).join(', ');
	return files.length > shown ? `${few} and ${files.length - shown} more` : few;
}

/**
 * The paths `git status --porcelain -z` reports: changed, staged and
 * untracked. A rename or a copy is followed by its source, which is skipped.
 */
export function parseStatusPaths(status: string): string[] {
	const entries = status.split('\0');
	const paths: string[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.length < 4) {
			continue;
		}
		paths.push(entry.slice(3));
		if (entry[0] === 'R' || entry[0] === 'C') {
			index++;
		}
	}
	return paths;
}

/** The uncommitted changes and untracked files of the worktree at `worktreePath`. Read-only. */
export async function listChangedFiles(git: RunGit, worktreePath: string): Promise<string[]> {
	const { stdout } = await git(['-C', worktreePath, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal', '-z']);
	return parseStatusPaths(stdout);
}

/**
 * What keeps `worktree` from being removed safely, as `gsp clean` checks a
 * branch's worktree: locked, a rebase or bisect in progress, uncommitted
 * changes or untracked files, submodules, or ignored files a build does not
 * recreate. `discardChanges` lifts every check but the lock, which a person
 * set and only a person lifts. Read-only.
 */
async function removalBlocker(git: RunGit, worktree: Worktree, discardChanges: boolean): Promise<Omit<Kept, 'kind' | 'worktree'> | undefined> {
	const at = worktree.path;
	const remove = (...flags: string[]) => command('gsp', 'worktree', 'remove', at, ...flags);
	const discard = remove('--discard-changes');
	const kept = (reason: WorktreeKeptReason, hint: string, next: string | null, files: { ignored?: readonly string[]; changed?: readonly string[] } = {}) => ({
		reason,
		hint,
		next,
		ignoredFiles: files.ignored ?? [],
		changedFiles: files.changed ?? [],
	});
	if (worktree.state === 'locked') {
		const unlock = `${command('git', 'worktree', 'unlock', at)} && ${remove()}`;
		return kept('locked-worktree', unlock, unlock);
	}
	if (discardChanges) {
		return undefined;
	}
	const operation = await worktreeOperation(git, at);
	if (operation?.kind === 'rebase') {
		const finish = `${command('git', '-C', at, 'rebase', '--continue')} && ${remove()}`;
		return kept('rebase-in-progress', `${finish}, or, to drop the rebase with the worktree: ${discard}`, finish);
	}
	if (operation?.kind === 'bisect') {
		// Resetting a bisect loses nothing.
		const reset = `${command('git', '-C', at, 'bisect', 'reset')} && ${remove()}`;
		return kept('bisect-in-progress', reset, reset);
	}
	const changed = await listChangedFiles(git, at);
	if (changed.length > 0) {
		const stash = `${command('git', '-C', at, 'stash', '--include-untracked')} && ${remove()}`;
		return kept('dirty-worktree', `${stash}, or, to delete ${listFew(changed)} for good: ${discard}`, stash, { changed });
	}
	const ignored = await listIgnoredFiles(git, at);
	if (await hasSubmodules(git, at)) {
		// --discard-changes deletes the ignored files too: name them with the submodules.
		const also = ignored.length > 0 ? ` and move what you need out of it (${listFew(ignored)})` : '';
		return kept(
			'submodules',
			`check the submodules of ${quoteShellArg(at)} (${command('git', '-C', at, 'submodule', 'foreach', '--recursive', 'git', 'status', '--short')})${also}, then: ${discard}`,
			null,
			{ ignored }
		);
	}
	if (ignored.length > 0) {
		return kept('ignored-files', `move what you need out of ${quoteShellArg(at)} (${listFew(ignored)}), then: ${discard}`, null, { ignored });
	}
	return undefined;
}

/**
 * Finds the worktree `target` names, like {@link resolveWorktree}, and also
 * by the branch being rebased or bisected there: HEAD is detached meanwhile,
 * so Git lists no branch for it.
 */
async function findWorktree(git: RunGit, worktrees: readonly Worktree[], target: string, baseDir: string): Promise<WorktreeResolution> {
	const resolution = resolveWorktree(worktrees, target, baseDir);
	if (resolution.kind !== 'not-found') {
		return resolution;
	}
	for (const worktree of worktrees) {
		if (worktree.branch === undefined && worktree.state !== 'prunable' && (await worktreeOperation(git, worktree.path))?.branch === target) {
			return { kind: 'found', worktree: { ...worktree, branch: target } };
		}
	}
	return resolution;
}

/** True when `dir` is `root` or inside it, through symlinks. */
function isInside(dir: string, root: string): boolean {
	const relative = path.relative(canonical(root), canonical(dir));
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Removes one linked worktree, with the checks `gsp clean` makes before
 * removing one: a worktree that is locked, mid-rebase or mid-bisect, has
 * uncommitted changes, holds submodules or ignored files a build does not
 * recreate is kept, with a hint. `discardChanges` lifts every check but the
 * lock. The main worktree is refused. `baseDir` is the directory the command
 * was invoked from, so a relative path is read the way the user typed it. The
 * branch checked out there is never deleted.
 */
export async function removeWorktree(context: WorkflowContext, target: string, discardChanges: boolean, baseDir = context.root): Promise<WorktreeRemoval> {
	const worktrees = await listWorktrees(context);
	const resolution = await findWorktree(context.git, worktrees, target, baseDir);
	if (resolution.kind !== 'found') {
		return resolution;
	}
	const { worktree } = resolution;
	if (worktree.state === 'main') {
		return { kind: 'main', worktree };
	}
	// A prunable worktree has no directory left to check.
	if (worktree.state !== 'prunable') {
		const blocker = await removalBlocker(context.git, worktree, discardChanges);
		if (blocker) {
			return { kind: 'kept', worktree, ...blocker };
		}
	}
	const main = worktrees.find((candidate) => candidate.state === 'main');
	const nextCwd = main && worktree.state !== 'prunable' && isInside(baseDir, worktree.path) ? main.path : null;
	await context.git([...WORKTREE_REMOVE, ...(discardChanges ? ['--force'] : []), worktree.path]);
	return { kind: 'removed', worktree, nextCwd };
}

/** The `--json` document of `gsp worktree remove`, once the target is found and is a linked worktree. */
export type WorktreeRemoveDocument = {
	readonly schema: typeof CLEAN_SCHEMA;
	readonly command: 'worktree remove';
	readonly worktree: { readonly path: string; readonly branch: string | null };
	readonly removed: boolean;
	/** Why it was kept; null once removed. */
	readonly reason: WorktreeKeptReason | null;
	/** The ignored files removing it would delete, regenerable ones left out; null unless the reason is `ignored-files` or `submodules`. */
	readonly ignoredFiles: IgnoredFiles | null;
	/** The uncommitted changes and untracked files that kept it; null unless the reason is `dirty-worktree`. */
	readonly changedFiles: IgnoredFiles | null;
	/** What resolves it, `--discard-changes` named second when it lifts the reason; null once removed. */
	readonly hint: string | null;
	/** The command to run next, losing nothing; null once removed, or when a person has to act first. */
	readonly next: string | null;
	/** The directory to continue in when the command ran inside the worktree it removed; null otherwise. */
	readonly nextCwd: string | null;
};

export function worktreeRemoveDocument(removal: Extract<WorktreeRemoval, { kind: 'removed' | 'kept' }>): WorktreeRemoveDocument {
	const kept = removal.kind === 'kept' ? removal : undefined;
	return {
		schema: CLEAN_SCHEMA,
		command: 'worktree remove',
		worktree: { path: removal.worktree.path, branch: removal.worktree.branch ?? null },
		removed: !kept,
		reason: kept?.reason ?? null,
		ignoredFiles: kept?.reason === 'ignored-files' || kept?.reason === 'submodules' ? summarizeIgnored(kept.ignoredFiles) : null,
		changedFiles: kept?.reason === 'dirty-worktree' ? summarizeIgnored(kept.changedFiles) : null,
		hint: kept?.hint ?? null,
		next: kept?.next ?? null,
		nextCwd: removal.kind === 'removed' ? removal.nextCwd : null,
	};
}
