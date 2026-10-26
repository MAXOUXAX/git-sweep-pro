import * as vscode from 'vscode';
import { showCleanPicker } from './clean-picker';
import type { CommandUi } from './command-ui';

const PRODUCT = 'Git Sweep Pro';

/** The {@link CommandUi} of the extension: notifications, modals and quick picks. */
export function createVscodeCommandUi(outputChannel: vscode.OutputChannel): CommandUi {
	return {
		pickCleanup: showCleanPicker,
		pickOne: async ({ title, placeholder, items }) => {
			const picked = await vscode.window.showQuickPick(
				items.map((item) => ({ label: item.label, description: item.description, detail: item.detail, value: item.value })),
				{ title: `${PRODUCT}: ${title}`, placeHolder: placeholder, matchOnDescription: true, matchOnDetail: true }
			);
			return picked?.value;
		},
		confirm: async ({ message, detail, confirmLabel }) =>
			(await vscode.window.showWarningMessage(message, { modal: true, detail }, confirmLabel)) === confirmLabel,
		notify: (kind, message, actions = []) => {
			const show = { info: vscode.window.showInformationMessage, warning: vscode.window.showWarningMessage, error: vscode.window.showErrorMessage }[kind];
			return Promise.resolve(show(`${PRODUCT}: ${message}`, ...actions));
		},
		withProgress: (title, task) =>
			Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${PRODUCT}: ${title}…` }, task)),
		copy: (text) => Promise.resolve(vscode.env.clipboard.writeText(text)),
		openFolder: async (fsPath, newWindow) => {
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(fsPath), { forceNewWindow: newWindow });
		},
		showOutput: () => outputChannel.show(),
	};
}
