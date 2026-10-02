import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StateStore } from '../core/state-store';

/** How long an update waits for another gsp process to release the state file. */
const LOCK_TIMEOUT_MS = 5000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `task` while holding `lockPath`, created exclusively so that only one
 * process at a time reads, changes and writes the state file.
 */
async function withLock(lockPath: string, task: () => void): Promise<void> {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			fs.closeSync(fs.openSync(lockPath, 'wx'));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw error;
			}
		}
		// Never remove another process's lock based on age: it may still be writing.
		if (Date.now() >= deadline) {
			throw new Error(`Another gsp command is updating ${path.dirname(lockPath)}. If none is running, delete ${lockPath}.`);
		} else {
			await sleep(20);
		}
	}
	try {
		task();
	} finally {
		fs.rmSync(lockPath, { force: true });
	}
}

/**
 * Persists workflow state (e.g. a sync paused on conflicts) as JSON inside the
 * repository's git directory, so a paused operation can be resumed from the
 * terminal or the editor alike. Updates hold a lock file, so concurrent runs
 * never lose each other's changes; the file is deleted once empty.
 */
export function createFileStateStore(filePath: string): StateStore {
	const read = (): Record<string, unknown> => {
		try {
			return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return {};
			}
			throw error;
		}
	};

	const write = (state: Record<string, unknown>): void => {
		if (Object.keys(state).length === 0) {
			fs.rmSync(filePath, { force: true });
			return;
		}
		// Write a temporary file, then rename it over the state file: an
		// interrupted run never leaves a truncated file (rename is atomic).
		const temporary = `${filePath}.${process.pid}.tmp`;
		try {
			fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
			fs.renameSync(temporary, filePath);
		} catch (error) {
			// A failed write (ENOSPC) or rename (EPERM on Windows) must not leave it behind.
			fs.rmSync(temporary, { force: true });
			throw error;
		}
	};

	return {
		get: <T>(key: string) => read()[key] as T | undefined,
		update: async <T>(key: string, change: (current: T | undefined) => T | undefined) => {
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			await withLock(`${filePath}.lock`, () => {
				const state = read();
				const value = change(state[key] as T | undefined);
				if (value === undefined) {
					delete state[key];
				} else {
					state[key] = value;
				}
				write(state);
			});
		},
	};
}

/** Location of the state file for a repository's (per-worktree) git directory. */
export function stateFilePath(gitDir: string): string {
	return path.join(gitDir, 'git-sweep-pro', 'state.json');
}
