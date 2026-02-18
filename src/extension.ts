import * as vscode from 'vscode';
import { runGitCommand } from './core/git-command';
import { runPostPullRequestWorkflow } from './core/post-pull-request-workflow';
import { resolveSweepModeAction } from './core/sweep-logic';
import { runSweepWorkflow, type SweepWorkflowDeps } from './core/sweep-workflow';
import { resolveWorkspaceRoot } from './core/workspace';

const OUTPUT_CHANNEL_NAME = 'Git Sweep';

function getWorkspaceRoot(): string | undefined {
	return resolveWorkspaceRoot({
		activeEditor: vscode.window.activeTextEditor,
		getWorkspaceFolder: (uri) => vscode.workspace.getWorkspaceFolder(uri as vscode.Uri),
		workspaceFolders: vscode.workspace.workspaceFolders,
	});
}

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);

	const createSweepDeps = (): SweepWorkflowDeps => {
		const runGitCommandForWorkflow: SweepWorkflowDeps['runGitCommand'] = (args, cwd) =>
			runGitCommand(args, cwd, outputChannel);

		return {
			getWorkspaceRoot,
			output: {
				show: (preserveFocus) => outputChannel.show(preserveFocus),
				appendLine: (line) => outputChannel.appendLine(line),
			},
			runGitCommand: runGitCommandForWorkflow,
			ui: {
				withProgress: (options, task) =>
					vscode.window.withProgress(
						{
							location: vscode.ProgressLocation.Notification,
							title: options.title,
							cancellable: false,
						},
						task
					),
				showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
				showInformationMessage: (message) => {
					void vscode.window.showInformationMessage(message);
				},
				showErrorMessage: (message) => {
					void vscode.window.showErrorMessage(message);
				},
			},
		};
	};

	const runCommand = vscode.commands.registerCommand('git-sweep-pro.run', async () => {
		const action = await vscode.window.showInformationMessage(
			'Git Sweep Pro: Choose execution mode',
			{ modal: true },
			'Delete (safe -d)',
			'Delete (force -D)',
			'Dry Run'
		);

		const mode = resolveSweepModeAction(action);
		if (!mode) {
			return;
		}

		await runSweepWorkflow(mode, createSweepDeps());
	});

	const dryRunCommand = vscode.commands.registerCommand('git-sweep-pro.dryRun', async () => {
		await runSweepWorkflow({ dryRun: true, forceDelete: false }, createSweepDeps());
	});

    const postPullRequestCommand = vscode.commands.registerCommand(
        "git-sweep-pro.postPullRequest",
        async () => {
            await runPostPullRequestWorkflow(createSweepDeps());
        },
    );

    context.subscriptions.push(outputChannel, runCommand, dryRunCommand, postPullRequestCommand);
}

export function deactivate() {}
