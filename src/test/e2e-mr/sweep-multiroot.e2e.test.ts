import * as assert from 'assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/*
 * A genuine multi-root end-to-end test. VS Code opens a real .code-workspace
 * referencing two real git repositories. The test drives the real extension
 * command, stubs only the VS Code prompts (repository picker, mode picker,
 * confirmation, branch quick-pick), and verifies that the extension operates on
 * exactly the repository the user selected — leaving the other one untouched.
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

function git(args: string[], cwd: string): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).toString();
}

function branchExists(repo: string, name: string): boolean {
	return git(['branch', '--list', name], repo).trim().length > 0;
}

/** Builds a working repo with a bare remote, then creates a branch whose upstream is gone. */
function setupRepoWithGoneBranch(repo: string, goneBranch: string): void {
	const remote = path.join(path.dirname(repo), `${path.basename(repo)}-remote.git`);

	for (const entry of fs.readdirSync(repo)) {
		fs.rmSync(path.join(repo, entry), { recursive: true, force: true });
	}
	fs.rmSync(remote, { recursive: true, force: true });

	git(['init', '--bare', remote], path.dirname(repo));
	git(['init', repo], path.dirname(repo));
	fs.writeFileSync(path.join(repo, 'README.md'), '# e2e-mr\n');
	git(['add', 'README.md'], repo);
	git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], repo);
	git(['branch', '-M', 'main'], repo);
	git(['remote', 'add', 'origin', remote], repo);
	git(['push', '-u', 'origin', 'main'], repo);

	git(['checkout', '-b', goneBranch], repo);
	git(['push', '-u', 'origin', goneBranch], repo);
	git(['checkout', 'main'], repo);
	git(['push', 'origin', '--delete', goneBranch], repo);
}

suite('E2E (multi-root): sweep targets the selected repository', () => {
	let repoA: string;
	let repoB: string;
	const infoMessages: string[] = [];
	const errorMessages: string[] = [];
	let selectedRepoPath: string;

	let originalShowInformationMessage: typeof vscode.window.showInformationMessage;
	let originalShowErrorMessage: typeof vscode.window.showErrorMessage;
	let originalShowWarningMessage: typeof vscode.window.showWarningMessage;
	let originalShowQuickPick: typeof vscode.window.showQuickPick;

	suiteSetup(async function () {
		this.timeout(120000);

		repoA = process.env.GSP_E2E_MR_A ?? '';
		repoB = process.env.GSP_E2E_MR_B ?? '';
		assert.ok(repoA && repoB, 'GSP_E2E_MR_A and GSP_E2E_MR_B must be provided by the e2e-mr config');
		assert.ok(fs.existsSync(repoA) && fs.existsSync(repoB), 'both repo dirs should exist');

		setupRepoWithGoneBranch(repoA, 'feature/a-stale');
		setupRepoWithGoneBranch(repoB, 'feature/b-stale');

		const ext = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(ext, `extension ${EXTENSION_ID} should be installed in the host`);
		await ext.activate();

		originalShowInformationMessage = vscode.window.showInformationMessage;
		originalShowErrorMessage = vscode.window.showErrorMessage;
		originalShowWarningMessage = vscode.window.showWarningMessage;
		originalShowQuickPick = vscode.window.showQuickPick;
	});

	suiteTeardown(() => {
		(vscode.window as { showInformationMessage: unknown }).showInformationMessage =
			originalShowInformationMessage;
		(vscode.window as { showErrorMessage: unknown }).showErrorMessage = originalShowErrorMessage;
		(vscode.window as { showWarningMessage: unknown }).showWarningMessage = originalShowWarningMessage;
		(vscode.window as { showQuickPick: unknown }).showQuickPick = originalShowQuickPick;
	});

	setup(() => {
		infoMessages.length = 0;
		errorMessages.length = 0;

		// Auto-confirm the modal mode picker with the safe-delete option; record
		// any other informational message.
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
		// Two distinct quick-picks are shown: the repository picker (items carry a
		// `candidate` with a `description` fsPath) and the branch multi-select
		// (items carry `label`/`picked`). Pick the requested repository, and
		// accept all branches for the branch picker.
		(vscode.window as { showQuickPick: unknown }).showQuickPick = (items: unknown) => {
			const arr = items as Array<{ description?: string; candidate?: unknown }>;
			if (arr.length > 0 && arr[0]?.candidate !== undefined) {
				const match = arr.find((item) => item.description === selectedRepoPath);
				return Promise.resolve(match);
			}
			return Promise.resolve(arr);
		};
	});

	test('deletes the stale branch only in the selected repository', async function () {
		this.timeout(120000);

		selectedRepoPath = repoB;

		assert.ok(branchExists(repoA, 'feature/a-stale'), 'repoA stale branch should exist before');
		assert.ok(branchExists(repoB, 'feature/b-stale'), 'repoB stale branch should exist before');

		await vscode.commands.executeCommand('git-sweep-pro.run');

		assert.ok(
			!branchExists(repoB, 'feature/b-stale'),
			'the selected repository (repoB) should have its stale branch deleted'
		);
		assert.ok(
			branchExists(repoA, 'feature/a-stale'),
			'the unselected repository (repoA) must be left untouched'
		);
		assert.ok(
			infoMessages.some((m) => m.includes('Deleted 1 branch')),
			`expected a deletion confirmation; got ${JSON.stringify(infoMessages)}`
		);
		assert.deepStrictEqual(errorMessages, [], 'no error messages expected');
	});

	test('switching the selection targets the other repository', async function () {
		this.timeout(120000);

		selectedRepoPath = repoA;

		assert.ok(branchExists(repoA, 'feature/a-stale'), 'repoA stale branch should still exist');

		await vscode.commands.executeCommand('git-sweep-pro.run');

		assert.ok(
			!branchExists(repoA, 'feature/a-stale'),
			'repoA should have its stale branch deleted once selected'
		);
		assert.deepStrictEqual(errorMessages, []);
	});
});
