import { createDeletionLog, type DeletionLog } from '../core/deletion-log';
import type { StateStore } from '../core/state-store';
import type { SweepSettings } from '../core/sweep-logic';
import type { NoticeOptions, PickItem, WorkflowContext } from '../core/workflow';

/** The answer a fake `git` gives: its output, or the error it throws. */
export type GitEntry = { readonly stdout?: string; readonly stderr?: string } | Error;

export type FakeContextOptions = {
	readonly root?: string;
	/** On top of {@link DEFAULT_SETTINGS}, without the confirmation before deleting. */
	readonly settings?: Partial<SweepSettings>;
	/** Answers by command line (args joined by spaces); an array answers successive calls, repeating its last entry. */
	readonly git?: Record<string, GitEntry | readonly GitEntry[]>;
	/** Answers commands missing from {@link git}; defaults to an empty output. */
	readonly gitFallback?: (args: readonly string[]) => GitEntry;
	/** Runs before each git command (e.g. to flip a fake rebase state). */
	readonly onGit?: (command: string) => void;
	/** Answers of the single-select picker, one per call (the last one repeats). */
	readonly pick?: readonly (string | undefined)[];
	/** Answers the multi-select picker; dismisses it by default. */
	readonly pickBranches?: (items: readonly PickItem[]) => readonly string[] | undefined;
	readonly confirm?: boolean;
	readonly deletionLog?: DeletionLog;
};

/** The settings' defaults, as in package.json. */
export const DEFAULT_SETTINGS: SweepSettings = {
	protectedBranches: [],
	autoFetchPrune: true,
	confirmBeforeDelete: true,
	includeMergedBranches: false,
};

/** An in-memory {@link StateStore}, with its content exposed for assertions. */
export function createMemoryStore(initial: Record<string, unknown> = {}): StateStore & { readonly state: Record<string, unknown> } {
	const state: Record<string, unknown> = { ...initial };
	return {
		state,
		get: <T>(key: string) => state[key] as T | undefined,
		update: async (key: string, value: unknown) => {
			if (value === undefined) {
				delete state[key];
			} else {
				state[key] = value;
			}
		},
	};
}

/**
 * A {@link WorkflowContext} whose git and UI are scripted, recording every
 * command run, line logged and prompt shown.
 */
export function createFakeContext(options: FakeContextOptions = {}) {
	const recorded = {
		commands: [] as string[],
		/** Output lines and session headers, in order. */
		outputLines: [] as string[],
		/** Output lines without the session headers. */
		appendedLines: [] as string[],
		infoMessages: [] as string[],
		errorMessages: [] as string[],
		noticeOptions: [] as Array<NoticeOptions | undefined>,
		progressTitles: [] as string[],
		pickRequests: [] as Array<{ items: readonly PickItem[]; title: string; placeholder: string }>,
		pickBranchesRequests: [] as Array<{ items: readonly PickItem[]; title: string }>,
		confirmRequests: [] as Array<{ message: string; confirmLabel: string }>,
	};
	const calls: Record<string, number> = {};

	const answer = (args: readonly string[]): GitEntry => {
		const command = args.join(' ');
		const entry = options.git?.[command];
		if (entry === undefined) {
			return options.gitFallback?.(args) ?? {};
		}
		if (Array.isArray(entry)) {
			const index = calls[command] ?? 0;
			calls[command] = index + 1;
			return entry[Math.min(index, entry.length - 1)];
		}
		return entry as GitEntry;
	};

	const context: WorkflowContext = {
		root: options.root ?? '/repo',
		settings: { ...DEFAULT_SETTINGS, confirmBeforeDelete: false, ...options.settings },
		git: async (args) => {
			const command = args.join(' ');
			options.onGit?.(command);
			recorded.commands.push(command);
			const entry = answer(args);
			if (entry instanceof Error) {
				throw entry;
			}
			return { stdout: entry.stdout ?? '', stderr: entry.stderr ?? '' };
		},
		output: {
			appendLine: (line) => {
				recorded.outputLines.push(line);
				recorded.appendedLines.push(line);
			},
			header: (line) => recorded.outputLines.push(line),
		},
		ui: {
			withProgress: async ({ title }, task) => {
				recorded.progressTitles.push(title);
				return task();
			},
			pickBranch: async (request) => {
				recorded.pickRequests.push(request);
				const answers = options.pick ?? [];
				return answers[Math.min(recorded.pickRequests.length, answers.length) - 1];
			},
			pickBranches: async ({ items, title }) => {
				recorded.pickBranchesRequests.push({ items, title });
				return options.pickBranches?.(items);
			},
			showInformationMessage: (message, notice) => {
				recorded.infoMessages.push(message);
				recorded.noticeOptions.push(notice);
			},
			showErrorMessage: (message, notice) => {
				recorded.errorMessages.push(message);
				recorded.noticeOptions.push(notice);
			},
			confirm: async (message, confirmLabel) => {
				recorded.confirmRequests.push({ message, confirmLabel });
				return options.confirm ?? true;
			},
		},
		deletionLog: options.deletionLog ?? createDeletionLog(createMemoryStore()),
	};

	return { context, ...recorded };
}
