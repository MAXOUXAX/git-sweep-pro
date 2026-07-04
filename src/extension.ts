import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { runGitCommand } from './core/git-command';
import { runPostPullRequestWorkflow } from './core/post-pull-request-workflow';
import { runSyncWithUpstreamResumeWorkflow, runSyncWithUpstreamWorkflow, type SyncWithUpstreamDeps } from './core/sync-with-upstream-workflow';
import { resolveSweepModeAction, orderModeActions, type SweepModeSetting, type SweepSettings } from './core/sweep-logic';
import { clearAll, invertSelection, selectAll, type SelectableBranch } from './core/sweep-selection';
import { runSweepWorkflow, type SweepWorkflowDeps } from './core/sweep-workflow';
import { resolveTargetRepository, resolveWorkspaceRoot, type RepoFolder, type RepositoryResolution } from './core/workspace';

const OUTPUT_CHANNEL_NAME = 'Git Sweep';
const LAST_REPO_STATE_KEY = 'gitSweepPro.lastSelectedRepo';

function getWorkspaceRoot(): string | undefined {
	return resolveWorkspaceRoot({
		activeEditor: vscode.window.activeTextEditor,
		getWorkspaceFolder: (uri) => vscode.workspace.getWorkspaceFolder(uri as vscode.Uri),
		workspaceFolders: vscode.workspace.workspaceFolders,
	});
}

function getSweepSettings(): SweepSettings {
	const config = vscode.workspace.getConfiguration('gitSweepPro');
	return {
		defaultMode: config.get<SweepModeSetting>('defaultMode', 'safeDelete'),
		protectedBranches: config.get<string[]>('protectedBranches', []),
		autoFetchPrune: config.get<boolean>('autoFetchPrune', true),
		confirmBeforeDelete: config.get<boolean>('confirmBeforeDelete', true),
	};
}

/**
 * Presents a multi-select branch picker with title-bar quick actions (select
 * all, clear all, invert selection). Resolves to the labels of the selected
 * branches, or `undefined` when the picker is dismissed without accepting.
 */
function pickBranchesWithActions(options: {
	readonly items: readonly SelectableBranch[];
	readonly title: string;
	readonly placeHolder: string;
}): Promise<readonly string[] | undefined> {
	return new Promise((resolve) => {
		const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>();
		quickPick.canSelectMany = true;
		quickPick.ignoreFocusOut = true;
		quickPick.matchOnDescription = true;
		quickPick.title = options.title;
		quickPick.placeholder = options.placeHolder;

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

		const pickItems: vscode.QuickPickItem[] = options.items.map((item) => ({ label: item.label }));
		quickPick.items = pickItems;
		quickPick.selectedItems = options.items.filter((item) => item.picked).map((item) => {
			return pickItems.find((pick) => pick.label === item.label) as vscode.QuickPickItem;
		});

		const applySelection = (next: readonly SelectableBranch[]): void => {
			const pickedLabels = new Set(next.filter((entry) => entry.picked).map((entry) => entry.label));
			quickPick.selectedItems = quickPick.items.filter((item) => pickedLabels.has(item.label));
		};

		const currentSelection = (): SelectableBranch[] => {
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


export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	const silentOutput = { appendLine: () => undefined };

	// Resolves which repository the command should target. In a multi-root
	// workspace with more than one Git repository, the user is prompted; the
	// selection is remembered for the workspace session.
	const resolveRepo = async (): Promise<RepositoryResolution> => {
		const folders: RepoFolder[] = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
			fsPath: folder.uri.fsPath,
			name: folder.name,
		}));

		return resolveTargetRepository({
			folders,
			activeRepoRoot: getWorkspaceRoot(),
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
	};

	const createSweepDeps = (workspaceRoot: string | undefined): SweepWorkflowDeps => {
		const runGitCommandForWorkflow: SweepWorkflowDeps['runGitCommand'] = (args, cwd) =>
			runGitCommand(args, cwd, outputChannel);

		return {
			getWorkspaceRoot: () => workspaceRoot,
			getSettings: getSweepSettings,
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
				pickBranches: (options) => pickBranchesWithActions(options),
				showInformationMessage: (message) => {
					void vscode.window.showInformationMessage(message);
				},
				showErrorMessage: (message) => {
					void vscode.window.showErrorMessage(message);
				},
				confirm: async (message, confirmLabel) => {
					const choice = await vscode.window.showWarningMessage(
						message,
						{ modal: true },
						confirmLabel
					);
					return choice === confirmLabel;
				},
			},
		};
	};

	const runCommand = vscode.commands.registerCommand('git-sweep-pro.run', async () => {
		const resolution = await resolveRepo();
		if (resolution.kind === 'cancelled') {
			return;
		}

		const [primary, second, third] = orderModeActions(getSweepSettings().defaultMode);
		const action = await vscode.window.showInformationMessage(
			'Git Sweep Pro: Choose execution mode',
			{ modal: true },
			primary,
			second,
			third
		);

		const mode = resolveSweepModeAction(action);
		if (!mode) {
			return;
		}

		await runSweepWorkflow(mode, createSweepDeps(resolution.fsPath));
	});

	const dryRunCommand = vscode.commands.registerCommand('git-sweep-pro.dryRun', async () => {
		const resolution = await resolveRepo();
		if (resolution.kind === 'cancelled') {
			return;
		}
		await runSweepWorkflow({ dryRun: true, forceDelete: false }, createSweepDeps(resolution.fsPath));
	});

	const postPullRequestCommand = vscode.commands.registerCommand(
		'git-sweep-pro.postPullRequest',
		async () => {
			const resolution = await resolveRepo();
			if (resolution.kind === 'cancelled') {
				return;
			}
			await runPostPullRequestWorkflow(createSweepDeps(resolution.fsPath));
		}
	);

	const createSyncDeps = (workspaceRoot: string | undefined): SyncWithUpstreamDeps => ({
		...createSweepDeps(workspaceRoot),
		workspaceState: context.workspaceState,
		fileExists: (p) => fs.existsSync(p),
		readFileUtf8: (p) => fs.readFileSync(p, 'utf8'),
	});

	const syncWithUpstreamCommand = vscode.commands.registerCommand(
		'git-sweep-pro.syncWithUpstream',
		async () => {
			const resolution = await resolveRepo();
			if (resolution.kind === 'cancelled') {
				return;
			}
			await runSyncWithUpstreamWorkflow(createSyncDeps(resolution.fsPath));
		}
	);

	const syncWithUpstreamResumeCommand = vscode.commands.registerCommand(
		'git-sweep-pro.syncWithUpstreamResume',
		async () => {
			const resolution = await resolveRepo();
			if (resolution.kind === 'cancelled') {
				return;
			}
			await runSyncWithUpstreamResumeWorkflow(createSyncDeps(resolution.fsPath));
		}
	);

	context.subscriptions.push(
		outputChannel,
		runCommand,
		dryRunCommand,
		postPullRequestCommand,
		syncWithUpstreamCommand,
		syncWithUpstreamResumeCommand
	);
}

export function deactivate() {}
