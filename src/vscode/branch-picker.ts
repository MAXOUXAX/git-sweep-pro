import * as vscode from 'vscode';
import { clearAll, invertSelection, selectAll } from '../core/sweep-selection';
import type { PickItem } from '../core/workflow';

/**
 * Presents a multi-select branch picker with title-bar quick actions (select
 * all, clear all, invert selection). Resolves to the labels of the selected
 * branches, or `undefined` when the picker is dismissed without accepting.
 */
export function pickManyWithActions(options: {
	readonly items: readonly PickItem[];
	readonly title: string;
}): Promise<readonly string[] | undefined> {
	return new Promise((resolve) => {
		const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>();
		quickPick.canSelectMany = true;
		quickPick.ignoreFocusOut = true;
		quickPick.matchOnDescription = true;
		quickPick.title = options.title;
		quickPick.placeholder = 'Use the title-bar actions to select all, clear, or invert.';

		const selectAllButton: vscode.QuickInputButton = {
			iconPath: new vscode.ThemeIcon('check-all'),
			tooltip: 'Select all',
		};
		const clearAllButton: vscode.QuickInputButton = {
			iconPath: new vscode.ThemeIcon('clear-all'),
			tooltip: 'Clear all',
		};
		const invertButton: vscode.QuickInputButton = {
			iconPath: new vscode.ThemeIcon('arrow-swap'),
			tooltip: 'Invert selection',
		};
		quickPick.buttons = [selectAllButton, clearAllButton, invertButton];

		const applySelection = (next: readonly PickItem[]): void => {
			const pickedLabels = new Set(next.filter((entry) => entry.picked).map((entry) => entry.label));
			quickPick.selectedItems = quickPick.items.filter((item) => pickedLabels.has(item.label));
		};

		quickPick.items = options.items.map((item) => ({ label: item.label, description: item.description }));
		applySelection(options.items);

		const currentSelection = (): PickItem[] => {
			const selectedLabels = new Set(quickPick.selectedItems.map((item) => item.label));
			return quickPick.items.map((item) => ({ label: item.label, picked: selectedLabels.has(item.label) }));
		};

		quickPick.onDidTriggerButton((button) => {
			if (button === selectAllButton) {
				applySelection(selectAll(currentSelection()));
			} else if (button === clearAllButton) {
				applySelection(clearAll(currentSelection()));
			} else if (button === invertButton) {
				applySelection(invertSelection(currentSelection()));
			}
		});

		let accepted = false;
		quickPick.onDidAccept(() => {
			accepted = true;
			resolve(quickPick.selectedItems.map((item) => item.label));
			quickPick.hide();
		});
		quickPick.onDidHide(() => {
			if (!accepted) {
				resolve(undefined);
			}
			quickPick.dispose();
		});

		quickPick.show();
	});
}
