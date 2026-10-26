import * as vscode from 'vscode';
import { buildCleanSections, pickerPlaceholder, type CleanEntry, type CleanSection } from './clean-model';
import type { CleanPick, CleanPickerOptions } from './command-ui';

const PRODUCT = 'Git Sweep Pro';

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

type EntryItem = vscode.QuickPickItem & { readonly entry?: CleanEntry };

/**
 * The clean plan in a quick pick: it opens at once, busy while the plan is
 * read, then lists the branches by section. Only planned deletions (and, in
 * force mode, forced ones) can be checked; the others show why they are
 * skipped, with a button that copies the command fixing it.
 */
export function showCleanPicker(options: CleanPickerOptions): Promise<CleanPick> {
	return new Promise((resolve) => {
		const quickPick = vscode.window.createQuickPick<EntryItem>();
		quickPick.title = `${PRODUCT}: ${options.title}`;
		quickPick.canSelectMany = !options.readOnly;
		// Also for a preview: the command palette closing as it opens would otherwise hide it.
		quickPick.ignoreFocusOut = true;
		quickPick.matchOnDescription = true;
		quickPick.matchOnDetail = true;
		quickPick.busy = true;
		quickPick.enabled = false;
		quickPick.placeholder = 'Reading branches…';

		const copyButton = (hint: string): vscode.QuickInputButton => ({ iconPath: new vscode.ThemeIcon('copy'), tooltip: `Copy the fix: ${hint}` });
		const forceButton = (on: boolean): vscode.QuickInputButton => ({
			iconPath: new vscode.ThemeIcon(on ? 'shield' : 'warning'),
			tooltip: on ? 'Hide the branches that need a forced delete' : 'Also offer the branches that need a forced delete',
		});
		const selectAllButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('check-all'), tooltip: 'Select all' };
		const clearAllButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('clear-all'), tooltip: 'Clear all' };

		let force = options.force;
		let sections: CleanSection[] = [];
		let notice: string | undefined;
		let settled = false;
		const finish = (pick: CleanPick): void => {
			if (!settled) {
				settled = true;
				resolve(pick);
			}
			quickPick.hide();
		};

		const entryItems = () => quickPick.items.filter((item): item is EntryItem & { entry: CleanEntry } => item.entry !== undefined);
		const placeholder = () => notice ?? pickerPlaceholder(sections, options.readOnly);

		const render = (keep: ReadonlySet<string> | undefined): void => {
			const items: EntryItem[] = sections.flatMap((section) => [
				{ label: section.title, kind: vscode.QuickPickItemKind.Separator },
				...section.entries.map(
					(entry): EntryItem => ({
						label: entry.label,
						description: entry.description,
						...(entry.detail ? { detail: entry.detail } : {}),
						...(entry.hint && !entry.selectable ? { buttons: [copyButton(entry.hint)] } : {}),
						entry,
					})
				),
			]);
			quickPick.items = items;
			// Start on the first branch, not on the last one selected.
			quickPick.activeItems = entryItems().slice(0, 1);
			// A single-select pick (the preview) would read a selection as accepting it.
			quickPick.selectedItems = options.readOnly ? [] : entryItems().filter(({ entry }) => entry.selectable && (keep ? keep.has(entry.arg) : entry.picked));
			const forceable = !options.readOnly && (force || document?.summary.needsForce);
			quickPick.buttons = options.readOnly ? [] : [...(forceable ? [forceButton(force)] : []), selectAllButton, clearAllButton];
			quickPick.placeholder = placeholder();
		};

		let document: Awaited<CleanPickerOptions['plan']>;
		void options.plan.then((plan) => {
			if (settled) {
				return;
			}
			if (!plan) {
				finish({ kind: 'closed' });
				return;
			}
			document = plan;
			sections = buildCleanSections(plan, { force });
			if (sections.every((section) => section.title === 'Kept')) {
				finish({ kind: 'empty' });
				return;
			}
			quickPick.busy = false;
			quickPick.enabled = true;
			render(undefined);
		});

		// Setting the selection echoes back later as a change: the revert's echo must not clear the notice.
		let reverted: string | undefined;
		const selectionKey = (items: readonly EntryItem[]) => items.map((item) => item.entry?.arg).join('\n');
		quickPick.onDidChangeSelection((selected) => {
			const blocked = selected.find((item) => item.entry && !item.entry.selectable);
			if (blocked?.entry) {
				// A skipped branch can't be checked: undo the click and say why.
				notice = `${blocked.entry.arg} can't be deleted here: ${lowerFirst(blocked.entry.detail ?? blocked.entry.description)}.`;
				const allowed = selected.filter((item) => item.entry?.selectable);
				reverted = selectionKey(allowed);
				quickPick.selectedItems = allowed;
				quickPick.placeholder = placeholder();
			} else if (notice && selectionKey(selected) !== reverted) {
				notice = undefined;
				reverted = undefined;
				quickPick.placeholder = placeholder();
			}
		});

		quickPick.onDidTriggerButton((button) => {
			const selectable = entryItems().filter(({ entry }) => entry.selectable);
			if (button === selectAllButton) {
				// Select all never checks a forced delete: each one is picked on purpose.
				quickPick.selectedItems = [...new Set([...quickPick.selectedItems, ...selectable.filter(({ entry }) => !entry.forced)])];
			} else if (button === clearAllButton) {
				quickPick.selectedItems = [];
			} else if (document) {
				const keep = new Set(quickPick.selectedItems.flatMap((item) => (item.entry ? [item.entry.arg] : [])));
				force = !force;
				sections = buildCleanSections(document, { force });
				render(keep);
			}
		});

		quickPick.onDidTriggerItemButton(async ({ item }) => {
			if (item.entry?.hint) {
				await vscode.env.clipboard.writeText(item.entry.hint);
				vscode.window.setStatusBarMessage(`$(check) Copied: ${item.entry.hint}`, 4000);
			}
		});

		quickPick.onDidAccept(() => {
			if (options.readOnly) {
				finish({ kind: 'closed' });
				return;
			}
			finish({ kind: 'picked', entries: quickPick.selectedItems.flatMap((item) => (item.entry?.selectable ? [item.entry] : [])) });
		});
		quickPick.onDidHide(() => {
			if (!settled) {
				settled = true;
				resolve({ kind: 'closed' });
			}
			quickPick.dispose();
		});

		quickPick.show();
	});
}
