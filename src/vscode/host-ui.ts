import * as vscode from 'vscode';
import type { HostUi } from '../core/rpc-protocol';
import type { NoticeOptions } from '../core/sweep-workflow';
import { pickBranchesWithActions } from './branch-picker';

const PRODUCT = 'Git Sweep Pro';

/** VS Code wording of a notification: the product name, and where to find the details. */
function notice(message: string, options?: NoticeOptions): string {
	const product = options?.dryRun ? `${PRODUCT} (dry run)` : options?.failed ? `${PRODUCT} failed` : PRODUCT;
	const details = options?.seeOutput ? ' See "Git Sweep" output for details.' : '';
	return `${product}: ${message}${details}`;
}

/** Renders the CLI's prompts and notifications with the VS Code UI. */
export function createVscodeHostUi(outputChannel: vscode.OutputChannel): HostUi {
	return {
		log: (line) => outputChannel.appendLine(line),
		showOutput: (preserveFocus) => outputChannel.show(preserveFocus),
		withProgress: (options, task) =>
			vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `${PRODUCT}: ${options.title}...`, cancellable: false },
				task
			),
		showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
		pickBranches: (options) => pickBranchesWithActions({ ...options, title: `${PRODUCT}: ${options.title}` }),
		showInformationMessage: (message, options) => {
			void vscode.window.showInformationMessage(notice(message, options));
		},
		showErrorMessage: (message, options) => {
			void vscode.window.showErrorMessage(notice(message, options));
		},
		confirm: async (message, confirmLabel) => {
			const choice = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
			return choice === confirmLabel;
		},
	};
}
