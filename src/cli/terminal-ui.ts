import pc from 'picocolors';
import type { QuickPickItemLike, WorkflowUi } from '../core/sweep-workflow';
import { stripProductPrefix, type CliIo } from './io';
import type { Prompter } from './prompter';

export type TerminalUiOptions = {
	/** Accept pre-selected branches and answer yes to every confirmation. */
	readonly yes: boolean;
	/**
	 * Answer for the (single) branch picker, given on the command line
	 * (`post-pr main`, `sync origin/main`). Matches a local branch label or a
	 * remote one shown as "<ref> (remote)".
	 */
	readonly presetPick: string | undefined;
	/** Show spinners; off with --verbose so git traces are not interleaved with them. */
	readonly spinners: boolean;
};

export type TerminalUi = WorkflowUi & {
	/** Prints a line of workflow output (secondary detail). */
	readonly detail: (line: string) => void;
};

/**
 * Renders workflow prompts in a terminal.
 *
 * With a human at the keyboard (`prompter` given), prompts are interactive
 * widgets. Otherwise (pipes, CI) output is plain text and every prompt takes a
 * safe default so the CLI never blocks: pickers keep their pre-selection and
 * confirmations are refused unless `--yes` was given.
 */
export function createTerminalUi(io: CliIo, options: TerminalUiOptions, prompter?: Prompter): TerminalUi {
	const interactive = io.interactive && prompter !== undefined;

	const showError = (message: string): void => {
		if (interactive) {
			prompter.error(message);
		} else {
			io.stderr(`${pc.red('error:')} ${message}\n`);
		}
	};

	const pickSingle = async (items: QuickPickItemLike[], title: string): Promise<QuickPickItemLike | undefined> => {
		if (options.presetPick !== undefined) {
			const preset = options.presetPick;
			const match = items.find((item) => item.label === preset || item.label === `${preset} (remote)`);
			if (!match) {
				throw new Error(`Branch "${preset}" is not available. Choose one of: ${items.map((i) => i.label).join(', ')}`);
			}
			return match;
		}

		const defaultIndex = items.findIndex((item) => item.picked);
		if (!interactive) {
			if (defaultIndex < 0) {
				throw new Error(`${title}: no default available; pass the branch as an argument.`);
			}
			return items[defaultIndex];
		}

		const index = await prompter.select(
			title,
			items.map((item, value) => ({ value, label: item.label, hint: item.description })),
			defaultIndex >= 0 ? defaultIndex : undefined
		);
		return index === undefined ? undefined : items[index];
	};

	return {
		detail: (line) => (interactive ? prompter.detail(line) : io.stderr(`${pc.dim(line)}\n`)),
		withProgress: (progress, task) => {
			const title = stripProductPrefix(progress.title);
			if (interactive && options.spinners) {
				return prompter.spin(title, task);
			}
			io.stderr(`${pc.cyan('…')} ${title}\n`);
			return task();
		},
		showQuickPick: (items, pickOptions) => pickSingle(items, pickOptions.title),
		pickBranches: async ({ items, title }) => {
			const preselected = items.filter((item) => item.picked).map((item) => item.label);
			if (options.yes || !interactive) {
				return preselected;
			}
			const values = await prompter.multiselect(
				`${stripProductPrefix(title)} ${pc.dim('(space: toggle, a: all, enter: confirm)')}`,
				items.map((item, value) => ({ value, label: item.label })),
				items.flatMap((item, index) => (item.picked ? [index] : []))
			);
			return values?.map((index) => items[index].label);
		},
		showInformationMessage: (message) => {
			const text = stripProductPrefix(message);
			if (interactive) {
				prompter.success(text);
			} else {
				io.stdout(`${text}\n`);
			}
		},
		showErrorMessage: (message) => showError(stripProductPrefix(message)),
		confirm: async (message, confirmLabel) => {
			if (options.yes) {
				return true;
			}
			if (!interactive) {
				io.stderr(`${message}\n`);
				io.stderr(`${pc.yellow('Not confirmed:')} "${confirmLabel}" needs --yes when not running in a terminal.\n`);
				return false;
			}
			return (await prompter.confirm(message, confirmLabel)) === true;
		},
	};
}
