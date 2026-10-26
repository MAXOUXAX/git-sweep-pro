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
 * build-output and cache folders. Matched against any segment of a path, so
 * `packages/app/node_modules/` counts too. Documented in the README.
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

/** How many ignored files a plan names; the rest are only counted. */
export const IGNORED_SAMPLE_SIZE = 10;

function matchesFileName(name: string, pattern: string): boolean {
	return pattern.startsWith('*') ? name.endsWith(pattern.slice(1)) : name === pattern;
}

/** True when `relativePath` (a file, or a directory ending with `/`) is in a regenerable folder or is a regenerable file. */
export function isRegenerable(relativePath: string): boolean {
	const segments = relativePath.split('/').filter(Boolean);
	const name = segments.at(-1) ?? '';
	if (!relativePath.endsWith('/') && REGENERABLE_FILES.some((pattern) => matchesFileName(name, pattern))) {
		return true;
	}
	// A folder counts when the path is inside it, or is it.
	return REGENERABLE_FOLDERS.some((folder) => {
		const parts = folder.split('/');
		return segments.some((_, index) => parts.every((part, offset) => segments[index + offset] === part));
	});
}

/**
 * The ignored files of the worktree at `worktreePath` that are not
 * regenerable. Read-only: `--no-optional-locks` keeps status from rewriting
 * the index, `--untracked-files=normal` overrides a config that hides them,
 * and `--ignored=matching` reports a wholly ignored folder as one entry
 * instead of descending into it (`node_modules/` stays one line).
 */
export async function findIgnoredFiles(git: RunGit, worktreePath: string): Promise<IgnoredFiles> {
	const { stdout } = await git(['-C', worktreePath, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal', '--ignored=matching', '-z']);
	const ignored = stdout
		.split('\0')
		.filter((entry) => entry.startsWith('!! '))
		.map((entry) => entry.slice(3))
		.filter((entry) => !isRegenerable(entry))
		.sort();
	return { count: ignored.length, sample: ignored.slice(0, IGNORED_SAMPLE_SIZE) };
}
