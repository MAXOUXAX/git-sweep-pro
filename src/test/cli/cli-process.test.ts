import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NOT_A_REPOSITORY } from '../../core/errors';
import type { HostUi } from '../../core/rpc-protocol';
import { runCliProcess } from '../../vscode/cli-client';
import { branchExists, createRepoFixture, makeGoneBranch, type RepoFixture } from './git-fixture';

const CLI_PATH = path.join(__dirname, '..', '..', 'cli', 'main.js');

function createHostUi(confirmAnswer: boolean) {
	const infos: string[] = [];
	const errors: string[] = [];
	const logs: string[] = [];
	const confirms: string[] = [];
	const ui: HostUi = {
		log: (line) => logs.push(line),
		withProgress: (_options, task) => task(),
		pickOne: async () => undefined,
		pickMany: async ({ items }) => items.filter((item) => item.picked).map((item) => item.label),
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

		const result = await runCliProcess({ nodePath: process.execPath, cliPath: CLI_PATH, cwd: fx.repo, args: ['sweep'], ui: host.ui });

		assert.deepStrictEqual(result, { exitCode: 0, errorShown: false });
		assert.ok(!branchExists(fx.repo, 'feature/a'));
		assert.strictEqual(host.confirms.length, 1);
		assert.ok(host.infos.some((m) => m.includes('Deleted 1 branch(es)')), JSON.stringify(host.infos));
		assert.ok(host.logs.some((line) => line.startsWith('$ git for-each-ref')));
		assert.deepStrictEqual(host.errors, []);
	});

	test('a declined confirmation deletes nothing', async () => {
		makeGoneBranch(fx.repo, 'feature/a');
		const host = createHostUi(false);

		assert.strictEqual((await runCliProcess({ nodePath: process.execPath, cliPath: CLI_PATH, cwd: fx.repo, args: [], ui: host.ui })).exitCode, 0);
		assert.ok(branchExists(fx.repo, 'feature/a'));
		assert.ok(host.infos.some((m) => m.includes('Deletion cancelled')));
	});

	test('errors are surfaced and give a non-zero exit code', async () => {
		const host = createHostUi(true);
		const result = await runCliProcess({ nodePath: process.execPath, cliPath: CLI_PATH, cwd: fx.dir, args: ['sweep'], ui: host.ui });
		assert.deepStrictEqual(result, { exitCode: 1, errorShown: true });
		assert.deepStrictEqual(host.errors, [NOT_A_REPOSITORY]);
	});

	test('a crash exits non-zero without an error notification, its stderr goes to the log', async () => {
		const crashingCli = path.join(fx.dir, 'crash.js');
		fs.writeFileSync(crashingCli, "process.stderr.write('fatal: boom\\n'); process.exit(1);\n");
		const host = createHostUi(true);
		const result = await runCliProcess({ nodePath: process.execPath, cliPath: crashingCli, cwd: fx.repo, args: [], ui: host.ui });
		assert.deepStrictEqual(result, { exitCode: 1, errorShown: false });
		assert.deepStrictEqual(host.logs, ['[cli] fatal: boom']);
	});

	test('a child crash completes while a host prompt remains unanswered', async function () {
		this.timeout(5000);
		const crashingCli = path.join(fx.dir, 'crash-prompt.js');
		fs.writeFileSync(crashingCli, `
			console.log(JSON.stringify({ type: 'progressStart', id: 1, title: 'Running' }));
			console.log(JSON.stringify({ type: 'request', id: 2, method: 'confirm', params: ['Continue?', 'Continue'] }));
			setTimeout(() => process.exit(1), 100);
		`);
		const host = createHostUi(true);
		let prompted = false;
		let progressClosed = false;
		host.ui.confirm = () => {
			prompted = true;
			return new Promise<boolean>(() => undefined);
		};
		host.ui.withProgress = async (_options, task) => {
			const result = await task();
			progressClosed = true;
			return result;
		};
		const result = await runCliProcess({ nodePath: process.execPath, cliPath: crashingCli, cwd: fx.repo, args: [], ui: host.ui });
		assert.deepStrictEqual(result, { exitCode: 1, errorShown: false });
		assert.strictEqual(prompted, true);
		assert.strictEqual(progressClosed, true);
	});

	test('reports a runtime that cannot be started', async () => {
		const host = createHostUi(true);
		const result = await runCliProcess({ nodePath: path.join(fx.dir, 'no-such-node'), cliPath: CLI_PATH, cwd: fx.repo, args: [], ui: host.ui });
		assert.deepStrictEqual(result, { exitCode: -1, errorShown: true });
		assert.ok(host.errors[0]?.startsWith('Could not start the gsp CLI'));
	});
});
