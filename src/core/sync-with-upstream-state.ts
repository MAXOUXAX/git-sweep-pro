import * as path from 'node:path';
import { syncMessages } from './sync-with-upstream-messages';
import type { SweepWorkflowDeps } from './sweep-workflow';

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

export type SyncWithUpstreamDeps = SweepWorkflowDeps & {
	readonly workspaceState: {
		get: <T>(key: string) => T | undefined;
		update: (key: string, value: unknown) => Thenable<void>;
	};
	readonly fileExists: (filePath: string) => boolean;
	readonly readFileUtf8: (filePath: string) => string;
};

export function getMemento(deps: SyncWithUpstreamDeps): SyncMemento | undefined {
	return deps.workspaceState.get<SyncMemento>(MEMENTO_KEY);
}

/**
 * Resolves the actual Git directory path via `git rev-parse --absolute-git-dir`.
 * Works correctly for worktrees and submodules where `.git` is a file pointing
 * at the real gitdir rather than a directory.
 * @returns The absolute path to the .git directory, or undefined if not a git repo
 */
export async function resolveGitDir(
	workspaceRoot: string,
	deps: SyncWithUpstreamDeps
): Promise<string | undefined> {
	try {
		const result = await deps.runGitCommand(['rev-parse', '--absolute-git-dir'], workspaceRoot);
		const dir = result.stdout.trim();
		return dir || undefined;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.toLowerCase().includes('not a git repository')) {
			return undefined;
		}
		throw error;
	}
}

export function showSyncGitCommandError(deps: SyncWithUpstreamDeps, message: string): void {
	const lowerMessage = message.toLowerCase();
	if (lowerMessage.includes('not a git repository')) {
		deps.ui.showErrorMessage(syncMessages.notGitRepo);
	} else if (lowerMessage.includes('command not found') || lowerMessage.includes('enoent')) {
		deps.ui.showErrorMessage(syncMessages.gitNotInstalled);
	} else {
		deps.ui.showErrorMessage(syncMessages.errorGeneric(message));
	}
}

export async function saveMemento(deps: SyncWithUpstreamDeps, memento: SyncMemento): Promise<void> {
	await deps.workspaceState.update(MEMENTO_KEY, memento);
}

export async function clearMemento(deps: SyncWithUpstreamDeps): Promise<void> {
	await deps.workspaceState.update(MEMENTO_KEY, undefined);
}

export function isRebaseInProgress(gitDir: string, deps: SyncWithUpstreamDeps): boolean {
	const rebaseMerge = path.join(gitDir, 'rebase-merge');
	const rebaseApply = path.join(gitDir, 'rebase-apply');
	return deps.fileExists(rebaseMerge) || deps.fileExists(rebaseApply);
}

export function readRebaseHeadName(gitDir: string, deps: SyncWithUpstreamDeps): string | undefined {
	const headNamePaths = [
		path.join(gitDir, 'rebase-merge', 'head-name'),
		path.join(gitDir, 'rebase-apply', 'head-name'),
	];

	for (const p of headNamePaths) {
		if (deps.fileExists(p)) {
			try {
				const content = deps.readFileUtf8(p).trim();
				if (!content) {
					continue;
				}
				return content.startsWith('refs/heads/') ? content.replace(/^refs\/heads\//, '') : content;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === 'ENOENT' || code === 'ENOTDIR') {
					return undefined;
				}
				throw err;
			}
		}
	}
	return undefined;
}
