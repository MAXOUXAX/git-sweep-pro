import * as path from 'node:path';
import * as vscode from 'vscode';
import { EXIT, settingsToCliArgs } from './cli/args';
import { runGitCommand } from './core/git-command';
import { orderModeActions, resolveSweepModeAction, type SweepModeSetting, type SweepSettings } from './core/sweep-logic';
import { resolveTargetRepository, resolveWorkspaceRoot, type RepositoryResolution } from './core/workspace';
import { runCliProcess } from './vscode/cli-client';
import { createVscodeHostUi } from './vscode/host-ui';
import { applyTerminalPath } from './vscode/terminal-path';

const OUTPUT_CHANNEL_NAME = 'Git Sweep';
const LAST_REPO_STATE_KEY = 'gitSweepPro.lastSelectedRepo';
const SHOW_OUTPUT = 'Show output';
/** Compiled CLI entry point, next to this file in both out/ and dist/. */
const CLI_PATH = path.join(__dirname, 'cli', 'main.js');

function getSweepSettings(): SweepSettings {
	const config = vscode.workspace.getConfiguration('gitSweepPro');
	return {
		defaultMode: config.get<SweepModeSetting>('defaultMode', 'safeDelete'),
		protectedBranches: config.get<string[]>('protectedBranches', []),
		autoFetchPrune: config.get<boolean>('autoFetchPrune', true),
		confirmBeforeDelete: config.get<boolean>('confirmBeforeDelete', true),
	};
}

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	const hostUi = createVscodeHostUi(outputChannel);
	const silentOutput = { appendLine: () => undefined };

	// Resolves which repository the command should target. In a multi-root
	// workspace with more than one Git repository, the user is prompted; the
	// selection is remembered for the workspace session.
	const resolveRepo = (): Promise<RepositoryResolution> =>
		resolveTargetRepository({
			folders: (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
				fsPath: folder.uri.fsPath,
				name: folder.name,
			})),
			activeRepoRoot: resolveWorkspaceRoot({
				activeEditor: vscode.window.activeTextEditor,
				getWorkspaceFolder: (uri) => vscode.workspace.getWorkspaceFolder(uri as vscode.Uri),
				workspaceFolders: vscode.workspace.workspaceFolders,
			}),
			isGitRepo: async (fsPath) => {
				try {
					const { stdout } = await runGitCommand(['rev-parse', '--is-inside-work-tree'], fsPath, silentOutput);
					return stdout.trim() === 'true';
				} catch {
					return false;
				}
			},
			getLastSelected: () => context.workspaceState.get<string>(LAST_REPO_STATE_KEY),
			setLastSelected: (fsPath) => {
				void context.workspaceState.update(LAST_REPO_STATE_KEY, fsPath);
			},
			promptForRepo: async (candidates) => {
				const picked = await vscode.window.showQuickPick(
					candidates.map((candidate) => ({
						label: candidate.name,
						description: candidate.fsPath,
						candidate,
					})),
					{
						title: 'Git Sweep Pro: Select repository',
						placeHolder: 'Multiple Git repositories are open. Choose the one to operate on.',
						ignoreFocusOut: true,
					}
				);
				return picked?.candidate;
			},
		});

	/** Runs the bundled CLI against `root`, rendering its prompts with the VS Code UI. */
	const runCli = async (root: string | undefined, args: string[]): Promise<void> => {
		if (!root) {
			hostUi.showErrorMessage('No workspace folder is open.');
			return;
		}
		const cliArgs = [...args, ...settingsToCliArgs(getSweepSettings())];
		outputChannel.appendLine(`> git-sweep-pro ${cliArgs.join(' ')}`);
		const { exitCode, errorShown } = await runCliProcess({
			nodePath: process.execPath,
			cliPath: CLI_PATH,
			cwd: root,
			args: cliArgs,
			ui: hostUi,
		});
		// A crash only reaches stderr, which lands in the output channel: point there.
		if (exitCode !== EXIT.ok && exitCode !== EXIT.paused && !errorShown) {
			const choice = await vscode.window.showErrorMessage(
				`Git Sweep Pro: The command stopped unexpectedly (exit code ${exitCode}).`,
				SHOW_OUTPUT
			);
			if (choice === SHOW_OUTPUT) {
				outputChannel.show();
			}
		}
	};

	/** Registers a command that first resolves the target repository, then runs `handler` on it. */
	const registerRepoCommand = (
		command: string,
		handler: (root: string | undefined) => Promise<void>
	): vscode.Disposable =>
		vscode.commands.registerCommand(command, async () => {
			const resolution = await resolveRepo();
			if (resolution.kind === 'resolved') {
				await handler(resolution.fsPath);
			}
		});

	applyTerminalPath(context);

	context.subscriptions.push(
		outputChannel,
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('gitSweepPro.cli.addToTerminalPath')) {
				applyTerminalPath(context);
			}
		}),
		registerRepoCommand('git-sweep-pro.run', async (root) => {
			const action = await vscode.window.showInformationMessage(
				'Git Sweep Pro: Choose execution mode',
				{ modal: true },
				...orderModeActions(getSweepSettings().defaultMode)
			);
			const mode = resolveSweepModeAction(action);
			if (mode) {
				await runCli(root, ['sweep', ...(mode.dryRun ? ['--dry-run'] : mode.forceDelete ? ['--force'] : [])]);
			}
		}),
		registerRepoCommand('git-sweep-pro.dryRun', (root) => runCli(root, ['sweep', '--dry-run'])),
		registerRepoCommand('git-sweep-pro.postPullRequest', (root) => runCli(root, ['post-pr'])),
		registerRepoCommand('git-sweep-pro.syncWithUpstream', (root) => runCli(root, ['sync'])),
		registerRepoCommand('git-sweep-pro.syncWithUpstreamResume', (root) => runCli(root, ['resume']))
	);
}

export function deactivate() {}
