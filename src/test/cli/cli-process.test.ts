import * as assert from 'assert';
import * as path from 'node:path';
import { runCliProcess, type HostUi } from '../../vscode/cli-client';
import { branchExists, createRepoFixture, makeGoneBranch, type RepoFixture } from './git-fixture';

const CLI_PATH = path.join(__dirname, '..', '..', 'cli', 'main.js');

function createHostUi(confirmAnswer: boolean) {
	const infos: string[] = [];
	const errors: string[] = [];
	const logs: string[] = [];
	const confirms: string[] = [];
	const ui: HostUi = {
		log: (line) => logs.push(line),
		showOutput: () => undefined,
		withProgress: (_options, task) => task(),
		showQuickPick: async () => undefined,
		pickBranches: async ({ items }) => items.filter((item) => item.picked).map((item) => item.label),
		showInformationMessage: (message) => infos.push(message),
		showErrorMessage: (message) => errors.push(message),
		confirm: async (message) => {
			confirms.push(message);
			return confirmAnswer;
		},
	};
	return { ui, infos, errors, logs, confirms };
}

/*
 * Spawns the compiled CLI exactly like the extension does (the current runtime
 * with ELECTRON_RUN_AS_NODE=1) and drives its RPC prompts.
 */
suite('cli process client (real git)', function () {
	this.timeout(60000);
	let fx: RepoFixture;

	setup(() => {
		fx = createRepoFixture();
	});

	teardown(() => {
		fx.cleanup();
	});

	test('runs a sweep over RPC, answering the prompts', async () => {
		makeGoneBranch(fx.repo, 'feature/a');
		const host = createHostUi(true);

		const code = await runCliProcess({ nodePath: process.execPath, cliPath: CLI_PATH, cwd: fx.repo, args: ['sweep'], ui: host.ui });

		assert.strictEqual(code, 0);
		assert.ok(!branchExists(fx.repo, 'feature/a'));
		assert.strictEqual(host.confirms.length, 1);
		assert.ok(host.infos.some((m) => m.includes('Deleted 1 branch(es)')), JSON.stringify(host.infos));
		assert.ok(host.logs.some((line) => line.startsWith('$ git for-each-ref')));
		assert.deepStrictEqual(host.errors, []);
	});

	test('a declined confirmation deletes nothing', async () => {
		makeGoneBranch(fx.repo, 'feature/a');
		const host = createHostUi(false);

		assert.strictEqual(await runCliProcess({ nodePath: process.execPath, cliPath: CLI_PATH, cwd: fx.repo, args: [], ui: host.ui }), 0);
		assert.ok(branchExists(fx.repo, 'feature/a'));
		assert.ok(host.infos.some((m) => m.includes('Deletion cancelled')));
	});

	test('errors are surfaced and give a non-zero exit code', async () => {
		const host = createHostUi(true);
		const code = await runCliProcess({ nodePath: process.execPath, cliPath: CLI_PATH, cwd: fx.dir, args: ['sweep'], ui: host.ui });
		assert.strictEqual(code, 1);
		assert.deepStrictEqual(host.errors, ['Git Sweep Pro: The selected workspace folder is not a Git repository.']);
	});

	test('reports a runtime that cannot be started', async () => {
		const host = createHostUi(true);
		const code = await runCliProcess({ nodePath: path.join(fx.dir, 'no-such-node'), cliPath: CLI_PATH, cwd: fx.repo, args: [], ui: host.ui });
		assert.strictEqual(code, -1);
		assert.ok(host.errors[0]?.startsWith('Git Sweep Pro: Could not start the git-sweep-pro CLI'));
	});
});
