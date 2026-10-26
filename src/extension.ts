import * as path from 'node:path';
import * as vscode from 'vscode';
import { EXIT, settingsToCliArgs } from './cli/args';
import { runGitCommand } from './core/git-command';
import type { HostUi } from './core/rpc-protocol';
import type { SweepMode, SweepSettings } from './core/sweep-logic';
import { runCleanCommand } from './vscode/clean-command';
import { runCliProcess } from './vscode/cli-client';
import type { CommandDeps } from './vscode/command-ui';
import { createGspClient } from './vscode/gsp-client';
import { createVscodeHostUi } from './vscode/host-ui';
import { applyTerminalPath } from './vscode/terminal-path';
import { createVscodeCommandUi } from './vscode/vscode-command-ui';
import { resolveTargetRepository, resolveWorkspaceRoot, type RepositoryResolution } from './vscode/workspace';

const OUTPUT_CHANNEL_NAME = 'Git Sweep';
const LAST_REPO_STATE_KEY = 'gitSweepPro.lastSelectedRepo';
const SHOW_OUTPUT = 'Show output';
/** Compiled CLI entry point, next to this file in both out/ and dist/. */
const CLI_PATH = path.join(__dirname, 'cli', 'main.js');

const config = () => vscode.workspace.getConfiguration('gitSweepPro');

function getSweepSettings(): SweepSettings {
	const settings = config();
	return {
		protectedBranches: settings.get<string[]>('protectedBranches', []),
		autoFetchPrune: settings.get<boolean>('autoFetchPrune', true),
		confirmBeforeDelete: settings.get<boolean>('confirmBeforeDelete', true),
		includeMergedBranches: settings.get<boolean>('includeMergedBranches', false),
	};
}

/** The CLI flags every run gets from the settings. */
function settingsArgs(): string[] {
	return [...settingsToCliArgs(getSweepSettings()), ...(config().get<boolean>('github', true) ? [] : ['--no-github'])];
}

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	const hostUi = createVscodeHostUi(outputChannel);
	// A --json run has its own UI (picker, progress): the CLI's steps only show in the status bar.
	const jsonHostUi: HostUi = {
		...hostUi,
		withProgress: (options, task) => vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Git Sweep Pro: ${options.title}` }, task),
	};
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
		const cliArgs = [...args, ...settingsArgs()];
		outputChannel.show(true);
		outputChannel.appendLine(`> gsp ${cliArgs.join(' ')}`);
		const { exitCode, errorShown } = await runCliProcess({
			nodePath: process.execPath,
			cliPath: CLI_PATH,
			cwd: root,
			args: cliArgs,
			ui: hostUi,
		});
		// A crash only reaches stderr, which lands in the output channel: point there.
		// A paused sync, a cancelled prompt and a dry run are expected endings.
		const expected: readonly number[] = [EXIT.ok, EXIT.paused, EXIT.cancelled, EXIT.notApplied];
		if (!expected.includes(exitCode) && !errorShown) {
			const choice = await vscode.window.showErrorMessage(
				`Git Sweep Pro: The command stopped unexpectedly (exit code ${exitCode}).`,
				SHOW_OUTPUT
			);
			if (choice === SHOW_OUTPUT) {
				outputChannel.show();
			}
		}
	};

	const runQuiet = (root: string, args: readonly string[]) => {
		outputChannel.appendLine(`> gsp ${args.join(' ')}`);
		return runCliProcess({ nodePath: process.execPath, cliPath: CLI_PATH, cwd: root, args, ui: args.includes('--json') ? jsonHostUi : hostUi });
	};
	const deps: CommandDeps = {
		client: createGspClient(runQuiet, settingsArgs),
		ui: createVscodeCommandUi(outputChannel),
		windowFolders: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
	};
	const cleanOptions = (root: string, readOnly: boolean) => ({
		root,
		readOnly: readOnly || config().get<SweepMode>('defaultMode', 'safeDelete') === 'dryRun',
		force: config().get<SweepMode>('defaultMode', 'safeDelete') === 'forceDelete',
		remote: config().get<boolean>('cleanRemoteBranches', false),
		confirm: config().get<boolean>('confirmBeforeDelete', true),
	});

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

	/** Runs `handler` on the repository, or says no folder is open. */
	const withRoot =
		(handler: (root: string) => Promise<void>) =>
		async (root: string | undefined): Promise<void> => {
			if (!root) {
				hostUi.showErrorMessage('No workspace folder is open.');
				return;
			}
			await handler(root);
		};

	applyTerminalPath(context);

	context.subscriptions.push(
		outputChannel,
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('gitSweepPro.cli.addToTerminalPath')) {
				applyTerminalPath(context);
			}
		}),
		registerRepoCommand('git-sweep-pro.run', withRoot((root) => runCleanCommand(deps, cleanOptions(root, false)))),
		registerRepoCommand('git-sweep-pro.dryRun', withRoot((root) => runCleanCommand(deps, cleanOptions(root, true)))),
		registerRepoCommand('git-sweep-pro.postPullRequest', (root) => runCli(root, ['post-pr'])),
		registerRepoCommand('git-sweep-pro.syncWithUpstream', (root) => runCli(root, ['sync'])),
		registerRepoCommand('git-sweep-pro.syncWithUpstreamResume', (root) => runCli(root, ['resume'])),
		registerRepoCommand('git-sweep-pro.restore', (root) => runCli(root, ['restore'])),
		registerRepoCommand('git-sweep-pro.agents', (root) => runCli(root, ['agents']))
	);
}

export function deactivate() {}
