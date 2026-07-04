import * as assert from 'assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/*
 * A genuine end-to-end test: it drives the *real* extension commands inside a
 * *real* VS Code extension host, operating on a *real* git repository via the
 * *real* git CLI. Nothing about git is mocked. The only things stubbed are the
 * VS Code UI prompts (mode picker and branch quick-pick), because a headless
 * run cannot click them — exactly like a QA engineer confirming the dialogs.
 */

const EXTENSION_ID = 'MAXOUXAX.git-sweep-pro';

const gitEnv: NodeJS.ProcessEnv = {
	...process.env,
	GIT_AUTHOR_NAME: 'E2E',
	GIT_AUTHOR_EMAIL: 'e2e@example.com',
	GIT_COMMITTER_NAME: 'E2E',
	GIT_COMMITTER_EMAIL: 'e2e@example.com',
	GIT_CONFIG_NOSYSTEM: '1',
};

/**
 * How the fake branch quick-pick behaves when the extension shows it:
 * accept the pre-selected branches, drive a quick-action button first, or
 * dismiss without accepting.
 */
type QuickPickAction = 'acceptAll' | 'clearThenAccept' | 'dismiss';

/**
 * Builds a minimal stand-in for vscode.window.createQuickPick that a headless
 * run can drive. It exercises the real button/accept wiring in the extension:
 * `clearThenAccept` clicks the "clear all" title button before accepting, so
 * the extension's own selection logic runs.
 */
function makeFakeQuickPick(getAction: () => QuickPickAction) {
	const acceptListeners: Array<() => void> = [];
	const hideListeners: Array<() => void> = [];
	const buttonListeners: Array<(button: unknown) => void> = [];
	const noopDisposable = { dispose: () => undefined };

	const quickPick = {
		canSelectMany: false,
		ignoreFocusOut: false,
		matchOnDescription: false,
		title: '',
		placeholder: '',
		value: '',
		buttons: [] as unknown[],
		items: [] as unknown[],
		selectedItems: [] as unknown[],
		activeItems: [] as unknown[],
		busy: false,
		enabled: true,
		step: undefined as number | undefined,
		totalSteps: undefined as number | undefined,
		onDidAccept: (cb: () => void) => {
			acceptListeners.push(cb);
			return noopDisposable;
		},
		onDidHide: (cb: () => void) => {
			hideListeners.push(cb);
			return noopDisposable;
		},
		onDidTriggerButton: (cb: (button: unknown) => void) => {
			buttonListeners.push(cb);
			return noopDisposable;
		},
		onDidChangeSelection: () => noopDisposable,
		onDidChangeActive: () => noopDisposable,
		onDidTriggerItemButton: () => noopDisposable,
		onDidChangeValue: () => noopDisposable,
		show() {
			// Defer so the extension finishes registering its listeners first.
			setTimeout(() => {
				const action = getAction();
				if (action === 'dismiss') {
					hideListeners.forEach((cb) => cb());
					return;
				}
				if (action === 'clearThenAccept') {
					// buttons[1] is the "Clear all" title-bar action.
					buttonListeners.forEach((cb) => cb(quickPick.buttons[1]));
				}
				acceptListeners.forEach((cb) => cb());
			}, 0);
		},
		hide() {
			hideListeners.forEach((cb) => cb());
		},
		dispose: () => undefined,
	};

	return quickPick;
}

function git(args: string[], cwd: string): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).toString();
}

function branchExists(repo: string, name: string): boolean {
	return git(['branch', '--list', name], repo).trim().length > 0;
}

/** Creates a local branch, pushes it, then deletes it on the remote so its upstream is gone. */
function makeGoneBranch(repo: string, name: string): void {
	git(['checkout', '-b', name], repo);
	git(['push', '-u', 'origin', name], repo);
	git(['checkout', 'main'], repo);
	git(['push', 'origin', '--delete', name], repo);
}

/**
 * Simulates a squash/rebase merge: the branch gains its own commit (a different
 * SHA from anything on main), main advances separately, then the remote branch
 * is deleted. The local branch's commits are therefore NOT reachable from main,
 * so a safe delete (-d) refuses it — exactly the squash/rebase scenario.
 */
function makeSquashMergedGoneBranch(repo: string, name: string, file: string): void {
	git(['checkout', '-b', name], repo);
	fs.writeFileSync(path.join(repo, file), `work on ${name}\n`);
	git(['add', file], repo);
	git(['-c', 'commit.gpgsign=false', 'commit', '-m', `work on ${name}`], repo);
	git(['push', '-u', 'origin', name], repo);
	git(['checkout', 'main'], repo);
	// The "squashed" result lands on main as an unrelated commit.
	fs.writeFileSync(path.join(repo, file), `squashed ${name}\n`);
	git(['add', file], repo);
	git(['-c', 'commit.gpgsign=false', 'commit', '-m', `squash-merge ${name}`], repo);
	git(['push', 'origin', 'main'], repo);
	git(['push', 'origin', '--delete', name], repo);
}

suite('E2E: sweep against a real git repository', () => {
	let repoDir: string;
	let remoteDir: string;
	const infoMessages: string[] = [];
	const errorMessages: string[] = [];
	let quickPickAction: QuickPickAction = 'acceptAll';

	let originalShowInformationMessage: typeof vscode.window.showInformationMessage;
	let originalShowErrorMessage: typeof vscode.window.showErrorMessage;
	let originalShowWarningMessage: typeof vscode.window.showWarningMessage;
	let originalShowQuickPick: typeof vscode.window.showQuickPick;
	let originalCreateQuickPick: typeof vscode.window.createQuickPick;

	suiteSetup(async function () {
		this.timeout(120000);

		repoDir = process.env.GSP_E2E_REPO ?? '';
		assert.ok(repoDir, 'GSP_E2E_REPO must be provided by the e2e test config');
		assert.ok(fs.existsSync(repoDir), `e2e repo dir should exist: ${repoDir}`);

		remoteDir = path.join(path.dirname(repoDir), 'remote.git');

		// Start from a clean slate without deleting the folder VS Code has open.
		for (const entry of fs.readdirSync(repoDir)) {
			fs.rmSync(path.join(repoDir, entry), { recursive: true, force: true });
		}
		fs.rmSync(remoteDir, { recursive: true, force: true });

		// Build a real bare remote + working clone.
		git(['init', '--bare', remoteDir], path.dirname(repoDir));
		git(['init', repoDir], path.dirname(repoDir));
		fs.writeFileSync(path.join(repoDir, 'README.md'), '# e2e\n');
		git(['add', 'README.md'], repoDir);
		git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], repoDir);
		git(['branch', '-M', 'main'], repoDir);
		git(['remote', 'add', 'origin', remoteDir], repoDir);
		git(['push', '-u', 'origin', 'main'], repoDir);

		// A branch whose upstream will be gone after fetch -p.
		makeGoneBranch(repoDir, 'feature/stale');

		const ext = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(ext, `extension ${EXTENSION_ID} should be installed in the host`);
		await ext.activate();

		originalShowInformationMessage = vscode.window.showInformationMessage;
		originalShowErrorMessage = vscode.window.showErrorMessage;
		originalShowWarningMessage = vscode.window.showWarningMessage;
		originalShowQuickPick = vscode.window.showQuickPick;
		originalCreateQuickPick = vscode.window.createQuickPick;
	});

	suiteTeardown(() => {
		if (originalShowInformationMessage) {
			(vscode.window as { showInformationMessage: unknown }).showInformationMessage =
				originalShowInformationMessage;
		}
		if (originalShowErrorMessage) {
			(vscode.window as { showErrorMessage: unknown }).showErrorMessage = originalShowErrorMessage;
		}
		if (originalShowWarningMessage) {
			(vscode.window as { showWarningMessage: unknown }).showWarningMessage = originalShowWarningMessage;
		}
		if (originalShowQuickPick) {
			(vscode.window as { showQuickPick: unknown }).showQuickPick = originalShowQuickPick;
		}
		if (originalCreateQuickPick) {
			(vscode.window as { createQuickPick: unknown }).createQuickPick = originalCreateQuickPick;
		}
	});

	setup(() => {
		infoMessages.length = 0;
		errorMessages.length = 0;
		quickPickAction = 'acceptAll';

		// Auto-confirm the modal mode picker with the safe-delete option, record
		// every other informational message, and auto-select all quick-pick items.
		(vscode.window as { showInformationMessage: unknown }).showInformationMessage = (
			message: string,
			...rest: unknown[]
		) => {
			const items = rest.filter((r): r is string => typeof r === 'string');
			if (items.includes('Delete (safe -d)')) {
				return Promise.resolve('Delete (safe -d)');
			}
			infoMessages.push(message);
			return Promise.resolve(undefined);
		};
		(vscode.window as { showErrorMessage: unknown }).showErrorMessage = (message: string) => {
			errorMessages.push(message);
			return Promise.resolve(undefined);
		};
		// Auto-confirm the delete confirmation modal by returning its confirm button.
		(vscode.window as { showWarningMessage: unknown }).showWarningMessage = (
			_message: string,
			...rest: unknown[]
		) => {
			const items = rest.filter((r): r is string => typeof r === 'string');
			return Promise.resolve(items[0]);
		};
		(vscode.window as { showQuickPick: unknown }).showQuickPick = (items: unknown) =>
			Promise.resolve(items);
		// The branch multi-select now uses createQuickPick with quick-action
		// buttons; drive a fake so the real accept/button wiring runs headless.
		(vscode.window as { createQuickPick: unknown }).createQuickPick = () =>
			makeFakeQuickPick(() => quickPickAction);
	});

	test('detects and safe-deletes a branch whose upstream is gone', async function () {
		this.timeout(120000);

		assert.ok(branchExists(repoDir, 'feature/stale'), 'feature/stale should exist before the sweep');

		await vscode.commands.executeCommand('git-sweep-pro.run');

		assert.ok(
			!branchExists(repoDir, 'feature/stale'),
			'feature/stale should be deleted from the real repo after the sweep'
		);
		assert.ok(
			infoMessages.some((m) => m.includes('Deleted 1 branch')),
			`expected a deletion confirmation; got ${JSON.stringify(infoMessages)}`
		);
		assert.deepStrictEqual(errorMessages, [], 'no error messages expected');
	});

	test('dry run reports the gone branch without deleting it', async function () {
		this.timeout(120000);

		makeGoneBranch(repoDir, 'feature/stale2');

		await vscode.commands.executeCommand('git-sweep-pro.dryRun');

		assert.ok(
			branchExists(repoDir, 'feature/stale2'),
			'dry run must not delete the branch'
		);
		assert.ok(
			infoMessages.some((m) => m.includes('would be deleted')),
			`expected a dry-run summary; got ${JSON.stringify(infoMessages)}`
		);

		git(['branch', '-D', 'feature/stale2'], repoDir);
	});

	test('clearing the selection via the picker action deletes nothing', async function () {
		this.timeout(120000);

		makeGoneBranch(repoDir, 'feature/keep-me');
		quickPickAction = 'clearThenAccept';

		await vscode.commands.executeCommand('git-sweep-pro.run');

		assert.ok(
			branchExists(repoDir, 'feature/keep-me'),
			'clearing the selection must leave the branch in place'
		);
		assert.ok(
			infoMessages.some((m) => m.includes('No branches selected')),
			`expected a no-selection message; got ${JSON.stringify(infoMessages)}`
		);
		assert.deepStrictEqual(errorMessages, []);

		git(['branch', '-D', 'feature/keep-me'], repoDir);
	});

	test('reports no stale branches when the repo is clean', async function () {
		this.timeout(120000);

		// Only main remains, and its upstream is healthy.
		assert.ok(!branchExists(repoDir, 'feature/stale'));
		assert.ok(!branchExists(repoDir, 'feature/stale2'));

		await vscode.commands.executeCommand('git-sweep-pro.dryRun');

		assert.ok(
			infoMessages.some((m) => m.includes('No stale branches found')),
			`expected a no-stale-branches message; got ${JSON.stringify(infoMessages)}`
		);
		assert.deepStrictEqual(errorMessages, []);
	});

	test('never deletes a branch protected by gitSweepPro.protectedBranches', async function () {
		this.timeout(120000);

		makeGoneBranch(repoDir, 'release/1.0');

		const config = vscode.workspace.getConfiguration('gitSweepPro');
		await config.update('protectedBranches', ['release/*'], vscode.ConfigurationTarget.Workspace);
		try {
			await vscode.commands.executeCommand('git-sweep-pro.run');

			assert.ok(
				branchExists(repoDir, 'release/1.0'),
				'a protected branch must never be deleted'
			);
			assert.ok(
				infoMessages.some((m) => m.includes('protected')),
				`expected a protected-branch notice; got ${JSON.stringify(infoMessages)}`
			);
			assert.deepStrictEqual(errorMessages, []);
		} finally {
			await config.update('protectedBranches', undefined, vscode.ConfigurationTarget.Workspace);
			git(['branch', '-D', 'release/1.0'], repoDir);
		}
	});

	test('force-deletes a squash/rebase-merged branch that safe delete refuses', async function () {
		this.timeout(120000);

		makeSquashMergedGoneBranch(repoDir, 'feature/squashed', 'squashed.txt');
		assert.ok(branchExists(repoDir, 'feature/squashed'), 'branch should exist before the sweep');

		// The setup() stub auto-confirms the force-delete escalation modal.
		await vscode.commands.executeCommand('git-sweep-pro.run');

		assert.ok(
			!branchExists(repoDir, 'feature/squashed'),
			'a squash-merged branch should be force-deleted after confirmation'
		);
		assert.ok(
			infoMessages.some((m) => m.includes('Deleted 1 branch')),
			`expected a deletion confirmation; got ${JSON.stringify(infoMessages)}`
		);
		assert.deepStrictEqual(errorMessages, [], 'no error messages expected');
	});
});
