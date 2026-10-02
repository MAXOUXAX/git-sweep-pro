import * as path from 'node:path';
import type { StateStore } from './state-store';
import type { WorkflowContext } from './workflow';

export const MEMENTO_KEY = 'git-sweep-pro.syncWithUpstream.memento';
export const TEMP_BRANCH_PREFIX = '__gsp_sync_';

export type SyncMemento = {
	readonly workspaceRoot: string;
	readonly featureBranch: string;
	readonly hasStash: boolean;
	readonly upstreamRef: string;
	/** True when upstreamRef is a remote ref (e.g. "origin/main"). */
	readonly upstreamIsRemote: boolean;
	/** Temporary branch to delete after recovery (remote branch case). */
	readonly tempBranchToCleanup?: string;
};

export type SyncContext = WorkflowContext & {
	/** Git directory of the worktree (`git rev-parse --absolute-git-dir`), where a rebase keeps its state. */
	readonly gitDir: string;
	/** Per-worktree store of the paused sync. */
	readonly state: StateStore;
	readonly fileExists: (filePath: string) => boolean;
	readonly readFileUtf8: (filePath: string) => string;
};

export function getMemento(context: SyncContext): SyncMemento | undefined {
	return context.state.get<SyncMemento>(MEMENTO_KEY);
}

export async function saveMemento(context: SyncContext, memento: SyncMemento): Promise<void> {
	await context.state.update(MEMENTO_KEY, () => memento);
}

export async function clearMemento(context: SyncContext): Promise<void> {
	await context.state.update(MEMENTO_KEY, () => undefined);
}

export function isRebaseInProgress({ gitDir, fileExists }: SyncContext): boolean {
	return fileExists(path.join(gitDir, 'rebase-merge')) || fileExists(path.join(gitDir, 'rebase-apply'));
}

export function readRebaseHeadName({ gitDir, fileExists, readFileUtf8 }: SyncContext): string | undefined {
	const headNamePaths = [
		path.join(gitDir, 'rebase-merge', 'head-name'),
		path.join(gitDir, 'rebase-apply', 'head-name'),
	];

	for (const p of headNamePaths) {
		if (fileExists(p)) {
			try {
				const content = readFileUtf8(p).trim();
				if (!content) {
					continue;
				}
				return content.startsWith('refs/heads/') ? content.replace(/^refs\/heads\//, '') : content;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === 'ENOENT' || code === 'ENOTDIR') {
					// File vanished between the exists check and the read: try the
					// other head-name location instead of giving up.
					continue;
				}
				throw err;
			}
		}
	}
	return undefined;
}
