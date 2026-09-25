import pc from 'picocolors';
import type { NoticeOptions, QuickPickItemLike, SweepWorkflowDeps, WorkflowOutcome, WorkflowUi } from '../core/sweep-workflow';
import type { CliOptions } from './args';
import type { CliIo } from './io';
import type { Prompter } from './prompter';
import { createRpcFrontend } from './rpc-frontend';

/** Where a CLI run renders its prompts, notifications and output. */
export type Frontend = {
	readonly ui: WorkflowUi;
	/** True when someone answers the prompts; otherwise they take their defaults. */
	readonly canPrompt: boolean;
	/** Workflow output: the "Git Sweep" output channel in VS Code. */
	readonly output: SweepWorkflowDeps['output'];
	/** Every git command and its output. */
	readonly trace: (line: string) => void;
	readonly intro?: (title: string) => void;
	readonly outro?: (outcome: WorkflowOutcome) => void;
};

export type TerminalOptions = {
	/** Accept pre-selected branches and answer yes to every confirmation. */
	readonly yes: boolean;
	/**
	 * Answer for the (single) branch picker, given on the command line
	 * (`post-pr main`, `sync origin/main`). Matches a local branch label or a
	 * remote one shown as "<ref> (remote)".
	 */
	readonly presetPick: string | undefined;
	/** Show git traces and session headers, without spinners so traces are not interleaved with them. */
	readonly verbose: boolean;
};

/**
 * Picks the front end once per run: RPC for the extension, interactive
 * widgets for a human at the keyboard, plain text for pipes and CI.
 */
export async function createFrontend(options: CliOptions, io: CliIo): Promise<Frontend> {
	if (options.rpc) {
		return createRpcFrontend(io);
	}
	const terminal: TerminalOptions = { yes: options.yes, presetPick: options.positionals[0], verbose: options.verbose };
	if (io.interactive && io.loadPrompter) {
		return createInteractiveFrontend(io, terminal, await io.loadPrompter());
	}
	return createPlainFrontend(io, terminal);
}

const OUTRO: Record<WorkflowOutcome, string> = {
	ok: 'Done.',
	cancelled: 'Cancelled.',
	paused: 'Paused: resolve the conflicts, then run "git sweep-pro sync --continue".',
	failed: 'Finished with errors.',
};

function traceTo(io: CliIo, options: TerminalOptions): (line: string) => void {
	return (line) => {
		if (options.verbose) {
			io.stderr(`${line}\n`);
		}
	};
}

function printProgress(io: CliIo, title: string): void {
	io.stderr(`${pc.cyan('…')} ${title}\n`);
}

/** Terminal wording of a notification: the output is already on screen, so only a dry run is called out. */
function notice(message: string, options?: NoticeOptions): string {
	return options?.dryRun ? `Dry run: ${message}` : message;
}

/** The picker item named on the command line; failing to find it fails the workflow. */
function findPresetPick(items: readonly QuickPickItemLike[], preset: string): QuickPickItemLike {
	const match = items.find((item) => item.label === preset || item.label === `${preset} (remote)`);
	if (!match) {
		throw new Error(`Branch "${preset}" is not available. Choose one of: ${items.map((i) => i.label).join(', ')}`);
	}
	return match;
}

/**
 * Plain text for pipes and CI. Every prompt takes a safe default so the CLI
 * never blocks: pickers keep their pre-selection and confirmations are
 * refused unless `--yes` was given.
 */
export function createPlainFrontend(io: CliIo, options: TerminalOptions): Frontend {
	return {
		canPrompt: false,
		trace: traceTo(io, options),
		output: {
			show: () => undefined,
			appendLine: (line) => io.stderr(`${pc.dim(line)}\n`),
			header: (line) => {
				if (options.verbose) {
					io.stderr(`${pc.dim(line)}\n`);
				}
			},
		},
		ui: {
			withProgress: (progress, task) => {
				printProgress(io, progress.title);
				return task();
			},
			showQuickPick: async (items, pickOptions) => {
				if (options.presetPick !== undefined) {
					return findPresetPick(items, options.presetPick);
				}
				const preselected = items.find((item) => item.picked);
				if (!preselected) {
					throw new Error(`${pickOptions.title}: no default available; pass the branch as an argument.`);
				}
				return preselected;
			},
			pickBranches: async ({ items }) => items.filter((item) => item.picked).map((item) => item.label),
			showInformationMessage: (message, notification) => io.stdout(`${notice(message, notification)}\n`),
			showErrorMessage: (message, notification) => io.stderr(`${pc.red('error:')} ${notice(message, notification)}\n`),
			confirm: async (message, confirmLabel) => {
				if (options.yes) {
					return true;
				}
				io.stderr(`${message}\n`);
				io.stderr(`${pc.yellow('Not confirmed:')} "${confirmLabel}" needs --yes when not running in a terminal.\n`);
				return false;
			},
		},
	};
}

/** Interactive widgets (see {@link Prompter}) for a human at the keyboard. */
export function createInteractiveFrontend(io: CliIo, options: TerminalOptions, prompter: Prompter): Frontend {
	return {
		canPrompt: true,
		trace: traceTo(io, options),
		output: {
			show: () => undefined,
			appendLine: (line) => prompter.detail(line),
			header: (line) => {
				if (options.verbose) {
					prompter.detail(line);
				}
			},
		},
		intro: (title) => prompter.intro(title),
		outro: (outcome) => prompter.outro(OUTRO[outcome]),
		ui: {
			withProgress: (progress, task) => {
				if (options.verbose) {
					printProgress(io, progress.title);
					return task();
				}
				return prompter.spin(progress.title, task);
			},
			showQuickPick: async (items, pickOptions) => {
				if (options.presetPick !== undefined) {
					return findPresetPick(items, options.presetPick);
				}
				const defaultIndex = items.findIndex((item) => item.picked);
				const index = await prompter.select(
					pickOptions.title,
					items.map((item, value) => ({ value, label: item.label, hint: item.description })),
					defaultIndex >= 0 ? defaultIndex : undefined
				);
				return index === undefined ? undefined : items[index];
			},
			pickBranches: async ({ items, title }) => {
				if (options.yes) {
					return items.filter((item) => item.picked).map((item) => item.label);
				}
				const values = await prompter.multiselect(
					`${title} ${pc.dim('(space: toggle, a: all, enter: confirm)')}`,
					items.map((item, value) => ({ value, label: item.label, hint: item.description })),
					items.flatMap((item, index) => (item.picked ? [index] : []))
				);
				return values?.map((index) => items[index].label);
			},
			showInformationMessage: (message, notification) => prompter.success(notice(message, notification)),
			showErrorMessage: (message, notification) => prompter.error(notice(message, notification)),
			confirm: async (message, confirmLabel) => options.yes || (await prompter.confirm(message, confirmLabel)) === true,
		},
	};
}
