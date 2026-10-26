import type { IgnoredFiles } from './clean-plan';
import type { RunGit } from './git-command';

/*
 * `git worktree remove` deletes the ignored files of a worktree, and
 * `gsp restore` cannot bring them back. Those that a build or an install
 * recreates are fine to lose; any other one (a `.env`, local notes, a
 * database) blocks the removal unless `--force` is given.
 */

/**
 * Folders whose content a build, an install or a cache recreates: dependency,
 * build-output and cache folders. A folder counts only when Git reports it as
 * one wholly ignored entry, at any depth (`packages/app/node_modules/`); a
 * file that merely sits under a folder with such a name (an ignored
 * `tools/build/credentials.json` in a tracked `tools/build/`) does not.
 * Documented in the README.
 */
export const REGENERABLE_FOLDERS: readonly string[] = [
	'node_modules',
	'.pnpm-store',
	'vendor/bundle',
	'dist',
	'build',
	'out',
	'.next',
	'.nuxt',
	'.svelte-kit',
	'.turbo',
	'.cache',
	'.parcel-cache',
	'.vite',
	'coverage',
	'target',
	'__pycache__',
	'.pytest_cache',
	'.mypy_cache',
	'.venv',
	'venv',
	'.gradle',
	'.dart_tool',
	'DerivedData',
];

/** Files a tool recreates, matched against the file name. */
export const REGENERABLE_FILES: readonly string[] = ['*.tsbuildinfo', '.DS_Store'];

/** Names that look like secrets, matched against the file name, ignoring case: never regenerable, wherever they are. */
export const SECRET_FILES: readonly string[] = ['.env', '.env.*', '*.pem', '*.key', '*credentials*', '*secret*', '.npmrc', '.netrc'];

/**
 * Secret-like names no compiler produces, looked for inside the regenerable
 * folders that are not dependencies: a build output or a cache only holds a
 * `.env` or a key if someone put it there.
 */
const SECRET_FILES_IN_FOLDERS: readonly string[] = ['.env', '.env.*', '*.pem', '*.key', '.npmrc', '.netrc'];

/** Regenerable folders installed from a registry: packages ship `.env` or `.npmrc` files of their own, so they are not searched. */
const DEPENDENCY_FOLDERS: ReadonlySet<string> = new Set(['node_modules', '.pnpm-store', 'vendor/bundle', '.venv', 'venv']);

/** How many ignored files a plan names; the rest are only counted. */
export const IGNORED_SAMPLE_SIZE = 10;

/** `*` matches any run of characters, everything else itself. */
function matchesFileName(name: string, pattern: string, ignoreCase = false): boolean {
	const source = pattern
		.split('*')
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
		.join('.*');
	return new RegExp(`^${source}$`, ignoreCase ? 'i' : '').test(name);
}

const isSecretLike = (name: string) => SECRET_FILES.some((pattern) => matchesFileName(name, pattern, true));

/**
 * True when `relativePath`, an entry of `git status --ignored=matching`, is
 * regenerable: a regenerable file, or a wholly ignored regenerable folder
 * (ending with `/`). A secret-like name never is.
 */
export function isRegenerable(relativePath: string): boolean {
	const segments = relativePath.split('/').filter(Boolean);
	const name = segments.at(-1) ?? '';
	if (isSecretLike(name)) {
		return false;
	}
	if (!relativePath.endsWith('/')) {
		return REGENERABLE_FILES.some((pattern) => matchesFileName(name, pattern));
	}
	return regenerableFolderOf(segments) !== undefined;
}

/** The regenerable folder that the directory `segments` is, if any. */
function regenerableFolderOf(segments: readonly string[]): string | undefined {
	return REGENERABLE_FOLDERS.find((folder) => {
		const parts = folder.split('/');
		return parts.length <= segments.length && parts.every((part, offset) => segments[segments.length - parts.length + offset] === part);
	});
}

/** Escapes the characters a `:(glob)` pathspec gives a meaning to. */
const globLiteral = (path: string) => path.replace(/[*?[\]\\]/g, '\\$&');

/**
 * The ignored files of the worktree at `worktreePath` that are not
 * regenerable. Read-only: `--no-optional-locks` keeps status from rewriting
 * the index, `--untracked-files=normal` overrides a config that hides them,
 * and `--ignored=matching` reports a wholly ignored folder as one entry
 * instead of descending into it (`node_modules/` stays one line).
 *
 * Git does not list what such a folder holds, so a `.env` copied into an
 * ignored `dist/` would go unseen: the regenerable folders other than
 * dependencies are searched for secret-like names with `git ls-files`, which
 * writes nothing either.
 */
export async function findIgnoredFiles(git: RunGit, worktreePath: string): Promise<IgnoredFiles> {
	const { stdout } = await git(['-C', worktreePath, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal', '--ignored=matching', '-z']);
	const entries = stdout
		.split('\0')
		.filter((entry) => entry.startsWith('!! '))
		.map((entry) => entry.slice(3));
	const regenerableFolders = entries.filter((entry) => {
		const folder = entry.endsWith('/') && isRegenerable(entry) ? regenerableFolderOf(entry.split('/').filter(Boolean)) : undefined;
		return folder !== undefined && !DEPENDENCY_FOLDERS.has(folder);
	});
	const secrets =
		regenerableFolders.length === 0
			? []
			: (
					await git([
						'-C',
						worktreePath,
						'ls-files',
						'--others',
						'--ignored',
						'--exclude-standard',
						'-z',
						'--',
						...regenerableFolders.flatMap((folder) => SECRET_FILES_IN_FOLDERS.map((pattern) => `:(glob,icase)${globLiteral(folder)}**/${pattern}`)),
					])
				).stdout
					.split('\0')
					.filter(Boolean);
	const ignored = [...entries.filter((entry) => !isRegenerable(entry)), ...secrets].sort();
	return { count: ignored.length, sample: ignored.slice(0, IGNORED_SAMPLE_SIZE) };
}
