import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StateStore } from '../core/state-store';

/**
 * Persists workflow state (e.g. a sync paused on conflicts) as JSON inside the
 * repository's git directory, so a paused operation can be resumed from the
 * terminal or the editor alike. Setting a key to `undefined` removes it; the
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
			fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
		},
	};
}

/** In-memory store for runs outside a repository (the workflow reports that error itself). */
export function createMemoryStateStore(): StateStore {
	const state = new Map<string, unknown>();
	return {
		get: <T>(key: string) => state.get(key) as T | undefined,
		update: async (key, value) => {
			if (value === undefined) {
				state.delete(key);
			} else {
				state.set(key, value);
			}
		},
	};
}

/** Location of the state file for a repository's (per-worktree) git directory. */
export function stateFilePath(gitDir: string): string {
	return path.join(gitDir, 'git-sweep-pro', 'state.json');
}
