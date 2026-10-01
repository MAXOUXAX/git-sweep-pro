import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { runGitCommand } from './core/git-command';
import { runPostPullRequestWorkflow } from './core/post-pull-request-workflow';
import { orderModeActions, resolveSweepModeAction, type SweepModeSetting, type SweepSettings } from './core/sweep-logic';
import { runSweepWorkflow, type SweepWorkflowDeps } from './core/sweep-workflow';
import { runSyncWithUpstreamResumeWorkflow, runSyncWithUpstreamWorkflow, type SyncWithUpstreamDeps } from './core/sync-with-upstream-workflow';
import { resolveTargetRepository, resolveWorkspaceRoot, type RepositoryResolution } from './core/workspace';
import { pickBranchesWithActions } from './vscode/branch-picker';

const OUTPUT_CHANNEL_NAME = 'Git Sweep';
const LAST_REPO_STATE_KEY = 'gitSweepPro.lastSelectedRepo';

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

	const createSweepDeps = (workspaceRoot: string | undefined): SweepWorkflowDeps => ({
		getWorkspaceRoot: () => workspaceRoot,
		getSettings: getSweepSettings,
		output: {
			show: (preserveFocus) => outputChannel.show(preserveFocus),
			appendLine: (line) => outputChannel.appendLine(line),
		},
		runGitCommand: (args, cwd) => runGitCommand(args, cwd, outputChannel),
		ui: {
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
		},
	});

	const createSyncDeps = (workspaceRoot: string | undefined): SyncWithUpstreamDeps => ({
		...createSweepDeps(workspaceRoot),
		workspaceState: context.workspaceState,
		fileExists: (p) => fs.existsSync(p),
		readFileUtf8: (p) => fs.readFileSync(p, 'utf8'),
	});

	/** Registers a command that first resolves the target repository, then runs `handler` on it. */
	const registerRepoCommand = (
		command: string,
		handler: (workspaceRoot: string | undefined) => Promise<void>
	): vscode.Disposable =>
		vscode.commands.registerCommand(command, async () => {
			const resolution = await resolveRepo();
			if (resolution.kind === 'resolved') {
				await handler(resolution.fsPath);
			}
		});

	context.subscriptions.push(
		outputChannel,
		registerRepoCommand('git-sweep-pro.run', async (root) => {
			const action = await vscode.window.showInformationMessage(
				'Git Sweep Pro: Choose execution mode',
				{ modal: true },
				...orderModeActions(getSweepSettings().defaultMode)
			);
			const mode = resolveSweepModeAction(action);
			if (mode) {
				await runSweepWorkflow(mode, createSweepDeps(root));
			}
		}),
		registerRepoCommand('git-sweep-pro.dryRun', (root) =>
			runSweepWorkflow({ dryRun: true, forceDelete: false }, createSweepDeps(root))
		),
		registerRepoCommand('git-sweep-pro.postPullRequest', (root) =>
			runPostPullRequestWorkflow(createSweepDeps(root))
		),
		registerRepoCommand('git-sweep-pro.syncWithUpstream', (root) =>
			runSyncWithUpstreamWorkflow(createSyncDeps(root))
		),
		registerRepoCommand('git-sweep-pro.syncWithUpstreamResume', (root) =>
			runSyncWithUpstreamResumeWorkflow(createSyncDeps(root))
		)
	);
}

export function deactivate() {}
