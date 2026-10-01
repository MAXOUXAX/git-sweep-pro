import * as vscode from 'vscode';
import type { HostUi } from '../core/rpc-protocol';
import { pickBranchesWithActions } from './branch-picker';

/** Renders the CLI's prompts and notifications with the VS Code UI. */
export function createVscodeHostUi(outputChannel: vscode.OutputChannel): HostUi {
	return {
		log: (line) => outputChannel.appendLine(line),
		showOutput: (preserveFocus) => outputChannel.show(preserveFocus),
		withProgress: (options, task) =>
			vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: options.title, cancellable: false },
				task
			),
		showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
		pickBranches: (options) => pickBranchesWithActions(options),
		showInformationMessage: (message) => {
			void vscode.window.showInformationMessage(message);
		},
		showErrorMessage: (message) => {
			void vscode.window.showErrorMessage(message);
		},
		confirm: async (message, confirmLabel) => {
			const choice = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
			return choice === confirmLabel;
		},
	};
}
