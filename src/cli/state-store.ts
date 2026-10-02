import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StateStore } from '../core/state-store';

/**
 * Persists workflow state (e.g. a sync paused on conflicts) as JSON inside the
 * repository's git directory, so a paused operation can be resumed from the
 * terminal or the editor alike. Concurrent runs are not locked against each
 * other: the last write wins. Setting a key to `undefined` removes it; the
 * file is deleted once empty.
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

	return {
		get: <T>(key: string) => read()[key] as T | undefined,
		update: async (key, value) => {
			const state = read();
			if (value === undefined) {
				delete state[key];
			} else {
				state[key] = value;
			}
			if (Object.keys(state).length === 0) {
				fs.rmSync(filePath, { force: true });
				return;
			}
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
		},
	};
}

/** Location of the state file for a repository's (per-worktree) git directory. */
export function stateFilePath(gitDir: string): string {
	return path.join(gitDir, 'git-sweep-pro', 'state.json');
}
