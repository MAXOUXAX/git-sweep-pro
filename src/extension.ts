import * as vscode from 'vscode';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const OUTPUT_CHANNEL_NAME = 'Git Sweep';

type SweepMode = {
	readonly dryRun: boolean;
	readonly forceDelete: boolean;
};

function getWorkspaceRoot(): string | undefined {
	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor) {
		const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
		if (folder) {
			return folder.uri.fsPath;
		}
	}

	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function runGitCommand(
	command: string,
	cwd: string,
	outputChannel: vscode.OutputChannel
): Promise<{ stdout: string; stderr: string }> {
	outputChannel.appendLine(`$ ${command}`);
	try {
		const result = await execAsync(command, { cwd });
		if (result.stdout.trim()) {
			outputChannel.appendLine(result.stdout.trim());
		}
		if (result.stderr.trim()) {
			outputChannel.appendLine(`[stderr] ${result.stderr.trim()}`);
		}

		return {
			stdout: result.stdout,
			stderr: result.stderr,
		};
	} catch (error) {
		const execError = error as Error & { stdout?: string; stderr?: string };
		if (execError.stdout?.trim()) {
			outputChannel.appendLine(execError.stdout.trim());
		}
		if (execError.stderr?.trim()) {
			outputChannel.appendLine(`[stderr] ${execError.stderr.trim()}`);
		}
		outputChannel.appendLine(`[error] ${execError.message}`);
		throw execError;
	}
}

function parseGoneBranches(branchVvOutput: string): string[] {
	return branchVvOutput
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.includes(': gone]'))
		.map((line) => {
			const sanitized = line.replace(/^\*\s+/, '');
			return sanitized.split(/\s+/)[0];
		})
		.filter((name) => name.length > 0);
}

type BranchItem = {
	name: string;
	description: string;
	isRemote: boolean;
	/** Full remote ref (e.g. origin/foo) when isRemote, used for checkout --track */
	remoteRef?: string;
};

function parseAllBranches(branchAOutput: string): BranchItem[] {
	const lines = branchAOutput.split('\n').map((line) => line.trim()).filter(Boolean);
	const items: BranchItem[] = [];

	for (const line of lines) {
		const isCurrent = line.startsWith('*');
		const sanitized = line.replace(/^\*\s+/, '');

		if (sanitized.startsWith('remotes/')) {
			const match = sanitized.match(/^remotes\/([^/]+)\/(.+?)(?: -> .+)?$/);
			if (match) {
				const remoteName = match[1];
				const name = match[2];
				if (name !== 'HEAD') {
					items.push({
						name,
						description: `remote`,
						isRemote: true,
						remoteRef: `${remoteName}/${name}`,
					});
				}
			}
		} else {
			const name = sanitized.split(/\s+/)[0];
			if (name) {
				items.push({
					name,
					description: isCurrent ? 'current' : 'local',
					isRemote: false,
				});
			}
		}
	}

	const seen = new Set<string>();
	return items.filter((item) => {
		if (seen.has(item.name)) {
			return false;
		}
		seen.add(item.name);
		return true;
	});
}

async function getCurrentBranch(workspaceRoot: string): Promise<string | undefined> {
	const result = await execAsync('git branch --show-current', { cwd: workspaceRoot });
	return result.stdout.trim() || undefined;
}

const PROTECTED_BRANCH_NAMES = ['main', 'master'];

async function getDefaultBranchName(workspaceRoot: string): Promise<string | undefined> {
	try {
		const result = await execAsync('git symbolic-ref refs/remotes/origin/HEAD', {
			cwd: workspaceRoot,
		});
		const ref = result.stdout.trim();
		if (ref && ref.startsWith('refs/remotes/')) {
			const parts = ref.split('/');
			// refs/remotes/origin/main -> main
			return parts[parts.length - 1];
		}
	} catch {
		// No origin/HEAD (e.g. no remote or default not set)
	}
	return undefined;
}

function isProtectedBranch(branchName: string, defaultBranch: string | undefined): boolean {
	if (PROTECTED_BRANCH_NAMES.includes(branchName)) {
		return true;
	}
	if (defaultBranch && branchName === defaultBranch) {
		return true;
	}
	return false;
}

async function runPostPullRequest(outputChannel: vscode.OutputChannel): Promise<void> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage('Git Sweep Pro: No workspace folder is open.');
		return;
	}

	outputChannel.appendLine('--- Git Sweep Pro: Post Pull Request ---');

	try {
		const currentBranch = await getCurrentBranch(workspaceRoot);
		if (!currentBranch) {
			vscode.window.showErrorMessage('Git Sweep Pro: Could not determine current branch.');
			return;
		}

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Git Sweep Pro: Fetching branches...',
				cancellable: false,
			},
			() => runGitCommand('git fetch -p', workspaceRoot, outputChannel)
		);

		const branchResult = await runGitCommand('git branch -a', workspaceRoot, outputChannel);
		const branches = parseAllBranches(branchResult.stdout).filter((b) => b.name !== currentBranch);

		if (branches.length === 0) {
			vscode.window.showInformationMessage('Git Sweep Pro: No other branches to checkout.');
			return;
		}

		const quickPickItems: vscode.QuickPickItem[] = branches
			.map((b) => ({
				label: b.name,
				description: b.description,
				detail: b.isRemote ? 'Remote branch' : 'Local branch',
			}))
			.sort((a, b) => {
				if (a.label === 'main') {
					return -1;
				}
				if (b.label === 'main') {
					return 1;
				}
				if (a.label === 'master') {
					return -1;
				}
				if (b.label === 'master') {
					return 1;
				}
				return a.label.localeCompare(b.label);
			});

		const selected = await vscode.window.showQuickPick(quickPickItems, {
			canPickMany: false,
			ignoreFocusOut: true,
			placeHolder: `Select branch to checkout (currently on ${currentBranch})`,
			title: 'Git Sweep Pro: Checkout branch',
		});

		if (!selected) {
			outputChannel.appendLine('Operation cancelled.');
			return;
		}

		const branchItem = branches.find((b) => b.name === selected.label);
		const targetBranch = branchItem?.name ?? selected.label;
		const checkoutArg =
			branchItem?.isRemote && branchItem?.remoteRef
				? `--track ${JSON.stringify(branchItem.remoteRef)}`
				: JSON.stringify(targetBranch);
		outputChannel.appendLine(`Checkout to ${targetBranch}...`);
		await runGitCommand(`git checkout ${checkoutArg}`, workspaceRoot, outputChannel);

		const defaultBranch = await getDefaultBranchName(workspaceRoot);
		if (isProtectedBranch(currentBranch, defaultBranch)) {
			outputChannel.appendLine(
				`[skip] Not deleting ${currentBranch} (protected/default branch).`
			);
		} else {
			const confirm = await vscode.window.showWarningMessage(
				`Delete branch "${currentBranch}"? This cannot be undone.`,
				{ modal: true },
				'Delete',
				'Keep'
			);
			if (confirm === 'Delete') {
				outputChannel.appendLine(`Deleting previous branch ${currentBranch}...`);
				try {
					await runGitCommand(`git branch -d ${JSON.stringify(currentBranch)}`, workspaceRoot, outputChannel);
				} catch {
					outputChannel.appendLine(`[retry] Safe delete failed, trying force delete (-D)...`);
					try {
						await runGitCommand(`git branch -D ${JSON.stringify(currentBranch)}`, workspaceRoot, outputChannel);
					} catch {
						outputChannel.appendLine(`[warning] Could not delete ${currentBranch}. Skipping.`);
					}
				}
			} else {
				outputChannel.appendLine(`[skip] Branch ${currentBranch} kept (user declined).`);
			}
		}

		outputChannel.appendLine('Pruning remote refs...');
		await runGitCommand('git fetch -p', workspaceRoot, outputChannel);

		outputChannel.appendLine('Running Git Sweep...');
		await runSweep({ dryRun: false, forceDelete: false }, outputChannel);

		outputChannel.appendLine('Pulling latest changes...');
		await runGitCommand('git pull', workspaceRoot, outputChannel);

		vscode.window.showInformationMessage('Git Sweep Pro: Post Pull Request completed.');
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const lowerMessage = message.toLowerCase();

		if (lowerMessage.includes('not a git repository')) {
			vscode.window.showErrorMessage('Git Sweep Pro: The selected workspace folder is not a Git repository.');
		} else if (lowerMessage.includes('command not found') || lowerMessage.includes('enoent')) {
			vscode.window.showErrorMessage('Git Sweep Pro: Git is not installed or not available in PATH.');
		} else {
			vscode.window.showErrorMessage(`Git Sweep Pro failed: ${message}`);
		}
	} finally {
		outputChannel.appendLine('--- Post Pull Request ended ---');
	}
}

async function runSweep(mode: SweepMode, outputChannel: vscode.OutputChannel): Promise<void> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage('Git Sweep Pro: No workspace folder is open.');
		return;
	}

	outputChannel.show(true);
	outputChannel.appendLine('--- Git Sweep session started ---');
	outputChannel.appendLine(`Workspace: ${workspaceRoot}`);
	outputChannel.appendLine(`Mode: ${mode.dryRun ? 'dry-run' : 'delete'}, delete flag: ${mode.forceDelete ? '-D' : '-d'}`);

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Git Sweep Pro: Fetching and pruning remote references...',
				cancellable: false,
			},
			() => runGitCommand('git fetch -p', workspaceRoot, outputChannel)
		);

		const branchResult = await runGitCommand('git branch -vv', workspaceRoot, outputChannel);
		const goneBranches = parseGoneBranches(branchResult.stdout);

		if (goneBranches.length === 0) {
			outputChannel.appendLine('No stale tracked branches found.');
			vscode.window.showInformationMessage('Git Sweep Pro: No stale branches found.');
			return;
		}

		const quickPickItems: vscode.QuickPickItem[] = goneBranches.map((branch) => ({
			label: branch,
			picked: true,
		}));

		const selected = await vscode.window.showQuickPick(quickPickItems, {
			canPickMany: true,
			ignoreFocusOut: true,
			matchOnDescription: true,
			title: mode.dryRun ? 'Git Sweep Pro: Select branches to include in dry run' : 'Git Sweep Pro: Select branches to delete',
			placeHolder: 'All stale tracked branches are pre-selected. Uncheck any you want to keep.',
		});

		if (!selected || selected.length === 0) {
			outputChannel.appendLine('Operation cancelled or no branches selected.');
			vscode.window.showInformationMessage('Git Sweep Pro: No branches selected.');
			return;
		}

		const branchNames = selected.map((item) => item.label);
		outputChannel.appendLine(`${mode.dryRun ? '[DRY RUN]' : '[DELETE]'} Selected branches:`);
		for (const branch of branchNames) {
			outputChannel.appendLine(`- ${branch}`);
		}

		if (mode.dryRun) {
			vscode.window.showInformationMessage(
				`Git Sweep Pro (dry run): ${branchNames.length} branch(es) would be deleted.`
			);
			return;
		}

		let deletedCount = 0;
		const deleteFlag = mode.forceDelete ? '-D' : '-d';

		for (const branch of branchNames) {
			try {
				await runGitCommand(`git branch ${deleteFlag} ${JSON.stringify(branch)}`, workspaceRoot, outputChannel);
				deletedCount += 1;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				outputChannel.appendLine(`[delete-failed] ${branch}: ${message}`);
			}
		}

		if (deletedCount === branchNames.length) {
			vscode.window.showInformationMessage(`Git Sweep Pro: Deleted ${deletedCount} branch(es).`);
		} else {
			vscode.window.showErrorMessage(
				`Git Sweep Pro: Deleted ${deletedCount}/${branchNames.length} branch(es). See "Git Sweep" output for details.`
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const lowerMessage = message.toLowerCase();

		if (lowerMessage.includes('not a git repository')) {
			vscode.window.showErrorMessage('Git Sweep Pro: The selected workspace folder is not a Git repository.');
		} else if (lowerMessage.includes('command not found') || lowerMessage.includes('enoent')) {
			vscode.window.showErrorMessage('Git Sweep Pro: Git is not installed or not available in PATH.');
		} else {
			vscode.window.showErrorMessage(`Git Sweep Pro failed: ${message}`);
		}
	} finally {
		outputChannel.appendLine('--- Git Sweep session ended ---');
	}
}

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);

	const runCommand = vscode.commands.registerCommand('git-sweep-pro.run', async () => {
		const action = await vscode.window.showInformationMessage(
			'Git Sweep Pro: Choose execution mode',
			{ modal: true },
			'Delete (safe -d)',
			'Delete (force -D)',
			'Dry Run'
		);

		if (!action) {
			return;
		}

		if (action === 'Dry Run') {
			await runSweep({ dryRun: true, forceDelete: false }, outputChannel);
			return;
		}

		await runSweep(
			{ dryRun: false, forceDelete: action === 'Delete (force -D)' },
			outputChannel
		);
	});

	const dryRunCommand = vscode.commands.registerCommand('git-sweep-pro.dryRun', async () => {
		await runSweep({ dryRun: true, forceDelete: false }, outputChannel);
	});

	const postPullRequestCommand = vscode.commands.registerCommand('git-sweep-pro.postPullRequest', async () => {
		await runPostPullRequest(outputChannel);
	});

	context.subscriptions.push(outputChannel, runCommand, dryRunCommand, postPullRequestCommand);
}

export function deactivate() {}
