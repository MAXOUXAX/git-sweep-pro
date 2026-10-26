import * as fs from 'node:fs';
import type { CleanDocument } from '../core/clean-plan';
import type { CleanEntry } from './clean-model';
import type { GspClient, JsonRun } from './gsp-client';

export type NoticeKind = 'info' | 'warning' | 'error';

export type Confirmation = { readonly message: string; readonly detail: string; readonly confirmLabel: string };

export type PickOption<T> = { readonly label: string; readonly description?: string; readonly detail?: string; readonly value: T };

export type CleanPickerOptions = {
	readonly title: string;
	/** A preview: nothing can be picked, accepting closes it. */
	readonly readOnly: boolean;
	/** Start with the branches only a forced delete removes on offer. */
	readonly force: boolean;
	/** The plan; `undefined` when it failed, which closes the picker. */
	readonly plan: Promise<CleanDocument | undefined>;
};

export type CleanPick =
	| { readonly kind: 'picked'; readonly entries: readonly CleanEntry[] }
	/** The plan has nothing to delete and nothing skipped: there was nothing to show. */
	| { readonly kind: 'empty' }
	| { readonly kind: 'closed' };

/** The VS Code UI the extension's commands use. Faked in tests. */
export type CommandUi = {
	readonly pickCleanup: (options: CleanPickerOptions) => Promise<CleanPick>;
	readonly pickOne: <T>(options: { readonly title: string; readonly placeholder: string; readonly items: readonly PickOption<T>[] }) => Promise<T | undefined>;
	/** A modal confirmation; resolves to true only when the confirm button was pressed. */
	readonly confirm: (confirmation: Confirmation) => Promise<boolean>;
	/** A notification with action buttons; resolves to the action picked. */
	readonly notify: (kind: NoticeKind, message: string, actions?: readonly string[]) => Promise<string | undefined>;
	readonly withProgress: <T>(title: string, task: () => Promise<T>) => Promise<T>;
	readonly copy: (text: string) => Promise<void>;
	readonly openFolder: (fsPath: string, newWindow: boolean) => Promise<void>;
	readonly showOutput: () => void;
};

export type CommandDeps = {
	readonly client: GspClient;
	readonly ui: CommandUi;
	/** The folders open in this window, to tell when a removed worktree is one of them. */
	readonly windowFolders: () => readonly string[];
};

export const SHOW_OUTPUT = 'Show output';
export const UNDO = 'Undo';
export const OPEN_MAIN_CHECKOUT = 'Open main checkout';
export const COPY_COMMAND = 'Copy command';

/** Shows why a `--json` run gave no document, unless the CLI already did. */
export async function reportRunError(ui: CommandUi, run: Extract<JsonRun<unknown>, { kind: 'error' }>): Promise<void> {
	if (run.shown) {
		return;
	}
	if (await ui.notify('error', run.message, [SHOW_OUTPUT])) {
		ui.showOutput();
	}
}

function realPath(fsPath: string): string {
	try {
		return fs.realpathSync.native(fsPath);
	} catch {
		// A removed worktree no longer resolves: compare it as given.
		return fsPath;
	}
}

/** Whether two paths name the same folder, through symlinks such as macOS's /var → /private/var. */
export function samePath(a: string, b: string): boolean {
	return a === b || realPath(a) === realPath(b);
}
