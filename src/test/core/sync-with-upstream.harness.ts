import { MEMENTO_KEY, type SyncContext, type SyncMemento } from '../../core/sync-state';
import { createFakeContext, createMemoryStore, type GitEntry } from '../fake-context';

export type { GitEntry };

export type HarnessOptions = {
	workspaceRoot?: string;
	/** Branch the single-select picker returns; `undefined` dismisses it. */
	quickPickSelection?: { label: string } | undefined;
	git?: Record<string, GitEntry | GitEntry[]>;
	/** Return true/false for rebase-state paths (for example rebase-merge, rebase-apply, or head-name). Omit to default to false. */
	fileExists?: (path: string) => boolean;
	/** When set, git sets .current=true when a rebase (non-continue) command runs. Use with stateful fileExists for conflict tests. */
	rebaseAttemptedRef?: { current: boolean };
	/** When set, git sets .current=true when 'rebase --continue' runs. Use with stateful fileExists for resume push-failure tests. */
	rebaseContinueRanRef?: { current: boolean };
	readFileUtf8?: (path: string) => string;
	memento?: SyncMemento | undefined;
};

export function createHarness(options: HarnessOptions = {}) {
	const root = options.workspaceRoot ?? '/repo';
	const fake = createFakeContext({
		root,
		git: options.git,
		pick: [options.quickPickSelection?.label],
		onGit: (command) => {
			if (options.rebaseAttemptedRef && command.startsWith('rebase ') && !command.includes('--continue')) {
				options.rebaseAttemptedRef.current = true;
			}
			if (options.rebaseContinueRanRef && command === 'rebase --continue') {
				options.rebaseContinueRanRef.current = true;
			}
		},
	});
	const store = createMemoryStore(options.memento ? { [MEMENTO_KEY]: options.memento } : {});
	const mementoUpdates: Array<{ key: string; value: unknown }> = [];
	const mementoGets: string[] = [];
	const context: SyncContext = {
		...fake.context,
		gitDir: `${root}/.git`,
		state: {
			get: <T>(key: string) => {
				mementoGets.push(key);
				return store.get<T>(key);
			},
			update: async <T>(key: string, change: (current: T | undefined) => T | undefined) => {
				await store.update<T>(key, (current) => {
					const value = change(current);
					mementoUpdates.push({ key, value });
					return value;
				});
			},
		},
		fileExists: options.fileExists ?? (() => false),
		readFileUtf8: options.readFileUtf8 ?? (() => ''),
	};
	return { ...fake, context, quickPickRequests: fake.pickRequests, mementoUpdates, mementoGets };
}

/** No rebase in progress. Use for sync-flow tests that should proceed past the initial checks. */
export const fileExistsNoRebase = (_p: string) => false;

/** Matches git branch -a: simple branch names; parseBranches uses whole line as name. */
export const baseBranchList = [
	'* feature/my-branch',
	'  main',
	'  develop',
	'  remotes/origin/HEAD -> origin/main',
	'  remotes/origin/main',
	'  remotes/origin/develop',
].join('\n');

export const baseGitForSync = {
	'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
	'fetch -p': { stdout: '' },
	'rev-parse --abbrev-ref HEAD': { stdout: 'feature/my-branch' },
	'branch --no-column -a': { stdout: baseBranchList },
};
