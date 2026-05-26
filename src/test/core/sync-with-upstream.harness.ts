import type { QuickPickItemLike } from '../../core/sweep-workflow';
import type { SyncMemento, SyncWithUpstreamDeps } from '../../core/sync-with-upstream-state';
import { MEMENTO_KEY } from '../../core/sync-with-upstream-state';

export type GitEntry = { stdout?: string; stderr?: string } | Error;

export type HarnessOptions = {
	workspaceRoot?: string;
	quickPickSelection?: QuickPickItemLike | undefined;
	git?: Record<string, GitEntry | GitEntry[]>;
	/** Return true/false for rebase-state paths (for example rebase-merge, rebase-apply, or head-name). Omit to default to false. */
	fileExists?: (path: string) => boolean;
	/** When set, runGitCommand will set .current=true when a rebase (non-continue) command runs. Use with stateful fileExists for conflict tests. */
	rebaseAttemptedRef?: { current: boolean };
	/** When set, runGitCommand will set .current=true when 'rebase --continue' runs. Use with stateful fileExists for resume push-failure tests. */
	rebaseContinueRanRef?: { current: boolean };
	readFileUtf8?: (path: string) => string;
	memento?: SyncMemento | undefined;
};

export type Harness = {
	deps: SyncWithUpstreamDeps;
	outputLines: string[];
	infoMessages: string[];
	errorMessages: string[];
	commands: string[];
	progressTitles: string[];
	quickPickRequests: Array<{ items: QuickPickItemLike[]; title: string }>;
	mementoUpdates: Array<{ key: string; value: unknown }>;
	mementoGets: string[];
};

export function createHarness(options: HarnessOptions = {}): Harness {
	const outputLines: string[] = [];
	const infoMessages: string[] = [];
	const errorMessages: string[] = [];
	const commands: string[] = [];
	const progressTitles: string[] = [];
	const quickPickRequests: Array<{ items: QuickPickItemLike[]; title: string }> = [];
	const mementoUpdates: Array<{ key: string; value: unknown }> = [];
	const mementoGets: string[] = [];
	const callCount: Record<string, number> = {};

	const resolveGitEntry = (command: string): GitEntry | undefined => {
		const entry = options.git?.[command];
		if (entry === undefined) {
			return undefined;
		}
		if (Array.isArray(entry)) {
			const idx = callCount[command] ?? 0;
			callCount[command] = idx + 1;
			return entry[idx] ?? entry[entry.length - 1];
		}
		return entry;
	};

	const workspaceStateStore: Record<string, unknown> = {
		...(options.memento !== undefined && { [MEMENTO_KEY]: options.memento }),
	};

	const deps: SyncWithUpstreamDeps = {
		getWorkspaceRoot: () => options.workspaceRoot,
		output: {
			appendLine: (line) => outputLines.push(line),
		},
		runGitCommand: async (args, _cwd) => {
			const key = args.join(' ');
			if (options.rebaseAttemptedRef && key.startsWith('rebase ') && !key.includes('--continue')) {
				options.rebaseAttemptedRef.current = true;
			}
			if (options.rebaseContinueRanRef && key === 'rebase --continue') {
				options.rebaseContinueRanRef.current = true;
			}
			commands.push(key);
			const entry = resolveGitEntry(key);
			if (entry instanceof Error) {
				throw entry;
			}
			return { stdout: entry?.stdout ?? '', stderr: entry?.stderr ?? '' };
		},
		ui: {
			withProgress: async (progress, task) => {
				progressTitles.push(progress.title);
				return task();
			},
			showQuickPick: async (items, config) => {
				quickPickRequests.push({ items, title: config.title });
				return options.quickPickSelection;
			},
			showInformationMessage: (message) => infoMessages.push(message),
			showErrorMessage: (message) => errorMessages.push(message),
		},
		workspaceState: {
			get: <T>(key: string) => {
				mementoGets.push(key);
				return workspaceStateStore[key] as T | undefined;
			},
			update: async (key, value) => {
				mementoUpdates.push({ key, value });
				workspaceStateStore[key] = value;
			},
		},
		fileExists: options.fileExists ?? (() => false),
		readFileUtf8: options.readFileUtf8 ?? (() => ''),
	};

	return { deps, outputLines, infoMessages, errorMessages, commands, progressTitles, quickPickRequests, mementoUpdates, mementoGets };
}

/** No rebase in progress. Use for sync-flow tests that should proceed past the initial checks. */
export const fileExistsNoRebase = (p: string) => !p.includes('rebase');

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
	'branch -a': { stdout: baseBranchList },
};
