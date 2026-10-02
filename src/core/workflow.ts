import type { DeletionLog } from './deletion-log';
import type { RunGit } from './git-command';
import type { SweepSettings } from './sweep-logic';

/** A choice offered in a picker (a branch, a file). Pickers resolve to the labels of the chosen items. */
export type PickItem = {
	readonly label: string;
	/** Extra context shown next to the label (e.g. the worktree a branch is checked out in). */
	readonly description?: string;
	/** Pre-selected (multi-select) or the default choice (single-select). */
	readonly picked?: boolean;
};

/**
 * Context a front end may render around a notification. The core writes
 * neutral messages; each host adds its own framing (product name, pointers).
 */
export type NoticeOptions = {
	/** The message reports a dry run. */
	readonly dryRun?: boolean;
	/** The message is a raw error from a failed operation. */
	readonly failed?: boolean;
	/** More details were written to the workflow output. */
	readonly seeOutput?: boolean;
};

/**
 * Everything a workflow needs from its front end. Implemented by the CLI's
 * terminal prompts and by its RPC bridge to the VS Code extension.
 */
export type WorkflowUi = {
	withProgress: <T>(options: { readonly title: string }, task: () => Promise<T>) => PromiseLike<T>;
	/** Single-select picker; resolves to the chosen label, or `undefined` when dismissed. */
	pickOne: (options: {
		readonly items: readonly PickItem[];
		readonly title: string;
		readonly placeholder: string;
	}) => PromiseLike<string | undefined>;
	/**
	 * Multi-select picker with quick actions (select all, clear all,
	 * invert). Resolves to the chosen labels, or `undefined` when dismissed.
	 */
	pickMany: (options: { readonly items: readonly PickItem[]; readonly title: string }) => PromiseLike<readonly string[] | undefined>;
	showInformationMessage: (message: string, options?: NoticeOptions) => void;
	showErrorMessage: (message: string, options?: NoticeOptions) => void;
	confirm: (message: string, confirmLabel: string) => PromiseLike<boolean>;
};

/** The workflow log: the "Git Sweep" output channel in VS Code, stderr in a terminal. */
export type WorkflowOutput = {
	readonly appendLine: (line: string) => void;
	/** Session framing (start and end markers, workspace, mode): always kept in VS Code, only shown in a terminal with --verbose. */
	readonly header: (line: string) => void;
};

/** How a workflow ended. The CLI maps it to its exit code. */
export type WorkflowOutcome = 'ok' | 'failed' | 'paused' | 'cancelled';

/** What every workflow runs against: one repository, seen through one front end. */
export type WorkflowContext = {
	/** Top-level directory of the repository's working tree. */
	readonly root: string;
	readonly settings: SweepSettings;
	/** Runs git in {@link root}. */
	readonly git: RunGit;
	readonly output: WorkflowOutput;
	readonly ui: WorkflowUi;
	/** Where deleted branches are recorded so `restore` can bring them back. */
	readonly deletionLog: DeletionLog;
};
