import * as assert from 'assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../../cli/args';
import { NOT_A_REPOSITORY } from '../../core/errors';
import type { HostUi } from '../../core/rpc-protocol';
import { runCliProcess } from '../../vscode/cli-client';
import { branchExists, commitFile, createRepoFixture, git, makeGoneBranch, type RepoFixture } from './git-fixture';

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

	const run = (args: string[], cwd = fx.repo) => {
		const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
			cwd,
			encoding: 'utf8',
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
			timeout: 20000,
		});
		assert.ifError(result.error);
		return result;
	};

	/** A branch squash-merged into origin/main, whose remote branch is then deleted. */
	const makeSquashMergedBranch = (name: string): void => {
		git(['checkout', '-q', '-b', name], fx.repo);
		commitFile(fx.repo, 'squash.txt', 'one\n', 'one');
		commitFile(fx.repo, 'squash.txt', 'one\ntwo\n', 'two');
		git(['push', '-q', '-u', 'origin', name], fx.repo);
		git(['checkout', '-q', 'main'], fx.repo);
		git(['merge', '-q', '--squash', name], fx.repo);
		git(['commit', '-q', '-m', `squash ${name}`], fx.repo);
		git(['push', '-q', 'origin', 'main'], fx.repo);
		git(['push', '-q', 'origin', '--delete', name], fx.repo);
	};

	/** Everything plan mode must leave alone: refs, objects, worktree registrations and config. */
	const snapshot = () => ({
		refs: git(['for-each-ref', '--format=%(refname) %(objectname) %(upstream:track)'], fx.repo),
		objects: git(['count-objects', '-v'], fx.repo),
		worktrees: git(['worktree', 'list', '--porcelain'], fx.repo),
		config: git(['config', '--list', '--local'], fx.repo),
	});

	test('an agent can plan, delete and restore through the CLI process without stdin', () => {
		makeGoneBranch(fx.repo, 'feature/agent');

		const plan = run(['clean', '--json']);
		assert.strictEqual(plan.status, EXIT.notApplied, plan.stderr);
		const report = JSON.parse(plan.stdout);
		assert.strictEqual(report.schema, 2);
		assert.deepStrictEqual(report.branches[0], {
			name: 'feature/agent',
			tip: git(['rev-parse', 'main'], fx.repo).trim(),
			action: 'delete',
			reason: 'empty',
			verdict: 'dead',
			verdictReason: 'empty',
			evidence: { method: 'ancestor', base: 'refs/remotes/origin/main' },
			unpushedCommits: 0,
			upstream: 'origin/feature/agent',
			upstreamState: 'gone',
			worktree: null,
			protected: null,
			needsForce: false,
			hint: 'gsp clean feature/agent --yes',
		});
		assert.ok(branchExists(fx.repo, 'feature/agent'));
		assert.strictEqual(run(['--non-interactive', '--yes']).status, EXIT.ok);
		assert.ok(!branchExists(fx.repo, 'feature/agent'));
		const deleted = run(['restore', '--json']);
		assert.strictEqual(deleted.status, 0, deleted.stderr);
		assert.deepStrictEqual(JSON.parse(deleted.stdout).map((entry: { branch: string }) => entry.branch), ['feature/agent']);
		assert.strictEqual(run(['restore', 'feature/agent', '--non-interactive']).status, 0);
		assert.ok(branchExists(fx.repo, 'feature/agent'));
	});

	test('without a terminal, clean prints the plan, changes nothing and exits 5', () => {
		makeSquashMergedBranch('feature/squash');
		// Deleted on the remote by someone else: only ls-remote can tell, as the local ref is not pruned.
		git(['checkout', '-q', '-b', 'feature/elsewhere'], fx.repo);
		git(['push', '-q', '-u', 'origin', 'feature/elsewhere'], fx.repo);
		git(['checkout', '-q', 'main'], fx.repo);
		git(['--git-dir', fx.remote, 'branch', '-D', 'feature/elsewhere'], fx.dir);
		const wt = path.join(fx.dir, 'gone-wt');
		git(['worktree', 'add', '-q', '--detach', wt], fx.repo);
		fs.rmSync(wt, { recursive: true, force: true });
		const before = snapshot();

		const plan = run([]);
		assert.strictEqual(plan.status, EXIT.notApplied, plan.stderr);
		assert.ok(plan.stdout.includes('delete  feature/squash     squash-merged into origin/main'), plan.stdout);
		assert.ok(plan.stdout.includes('delete  feature/elsewhere  already in origin/main'), plan.stdout);
		assert.ok(plan.stdout.includes('2 to delete (1 empty, 1 squash-merged) · 1 worktree registration to prune'), plan.stdout);
		assert.ok(plan.stdout.includes('Nothing was changed. To apply this plan, run: gsp clean feature/elsewhere feature/squash --yes'), plan.stdout);

		const json = run(['--dry-run', '--yes', '--json']);
		assert.strictEqual(json.status, EXIT.notApplied, json.stderr);
		const report = JSON.parse(json.stdout);
		assert.strictEqual(report.mode, 'plan');
		assert.deepStrictEqual(report.checks.remote, { source: 'ls-remote', remotes: ['origin'] });
		assert.strictEqual(report.checks.fetched, false);
		assert.strictEqual(report.branches.find((branch: { name: string }) => branch.name === 'feature/elsewhere').upstreamState, 'gone');
		assert.deepStrictEqual(report.worktreesPruned, [path.join(fs.realpathSync(fx.dir), 'gone-wt')]);

		assert.strictEqual(run(['list']).status, EXIT.notApplied);
		assert.deepStrictEqual(snapshot(), before, 'plan mode writes nothing');
	});

	test('with --json, a fatal error is still one JSON document on stdout', () => {
		const unknown = run(['clean', 'nope', '--json']);
		assert.strictEqual(unknown.status, EXIT.usage);
		assert.deepStrictEqual(JSON.parse(unknown.stdout), {
			schema: 2,
			error: { message: 'No branch named "nope". Run "gsp clean --dry-run" to see them.', code: 'unknown-branch' },
		});

		const outside = run(['--json'], fx.dir);
		assert.strictEqual(outside.status, EXIT.failed);
		assert.deepStrictEqual(JSON.parse(outside.stdout).error, { message: NOT_A_REPOSITORY, code: 'not-a-repository' });

		const usage = run(['--json', '--bogus']);
		assert.strictEqual(usage.status, EXIT.usage);
		assert.deepStrictEqual(JSON.parse(usage.stdout).error, { message: 'Unknown option: --bogus', code: 'usage' });
	});

	test('the help says what exit code 5 means for clean and for the other commands', () => {
		const help = run(['help']);
		assert.strictEqual(help.status, EXIT.ok);
		assert.ok(help.stdout.includes('5  clean, post-pr: some planned deletions were not applied; the output\n     says why and what to run next. For post-pr, 5 also means the branch\n     you asked to finish isn\'t finished.'), help.stdout);
		assert.ok(help.stdout.includes('Other commands: a confirmation\n     was needed but nobody could answer; rerun with --yes'), help.stdout);
		assert.ok(!help.stdout.includes('nothing was changed'));
	});

	test('--yes deletes a squash-merged branch and its clean worktree', () => {
		makeSquashMergedBranch('feature/squash');
		const wt = path.join(fx.dir, 'squash-wt');
		git(['worktree', 'add', '-q', wt, 'feature/squash'], fx.repo);

		const result = run(['--yes', '--json']);
		assert.strictEqual(result.status, EXIT.ok, result.stderr);
		const report = JSON.parse(result.stdout);
		assert.strictEqual(report.mode, 'apply');
		assert.strictEqual(report.checks.fetched, true);
		const [branch] = report.branches;
		assert.deepStrictEqual([branch.name, branch.action, branch.reason, branch.result], ['feature/squash', 'delete', 'squash-merged', 'deleted']);
		assert.strictEqual(report.restore, 'gsp restore feature/squash');
		assert.deepStrictEqual(report.summary.reasons, { 'squash-merged': 1 });
		assert.ok(!branchExists(fx.repo, 'feature/squash'));
		assert.ok(!fs.existsSync(wt));
	});

	test('--yes without --force keeps a gone branch with unpushed commits, exits 5 and says how to delete it', () => {
		git(['checkout', '-q', '-b', 'feature/unpushed'], fx.repo);
		commitFile(fx.repo, 'pushed.txt', 'pushed\n', 'pushed');
		git(['push', '-q', '-u', 'origin', 'feature/unpushed'], fx.repo);
		commitFile(fx.repo, 'local.txt', 'local\n', 'local only');
		git(['checkout', '-q', 'main'], fx.repo);
		git(['push', '-q', 'origin', '--delete', 'feature/unpushed'], fx.repo);

		const result = run(['--yes', '--json']);
		assert.strictEqual(result.status, EXIT.notApplied, result.stderr);
		const [branch] = JSON.parse(result.stdout).branches;
		assert.deepStrictEqual(
			[branch.action, branch.reason, branch.verdictReason, branch.unpushedCommits, branch.needsForce, branch.hint],
			['skip', 'needs-force', 'upstream-gone', 2, true, 'gsp clean feature/unpushed --yes --force']
		);
		assert.ok(branchExists(fx.repo, 'feature/unpushed'));

		const human = run(['--yes']);
		assert.strictEqual(human.status, EXIT.notApplied);
		assert.ok(human.stdout.includes('→ gsp clean feature/unpushed --yes --force'), human.stdout);

		assert.strictEqual(run(['clean', 'feature/unpushed', '--yes', '--force']).status, EXIT.ok);
		assert.ok(!branchExists(fx.repo, 'feature/unpushed'));
	});

	test('runs a clean over RPC through the sweep alias, answering the prompts', async () => {
		makeGoneBranch(fx.repo, 'feature/a');
		const host = createHostUi(true);

		const result = await runCliProcess({ nodePath: process.execPath, cliPath: CLI_PATH, cwd: fx.repo, args: ['sweep'], ui: host.ui });

		assert.deepStrictEqual(result, { exitCode: 0, errorShown: false });
		assert.ok(!branchExists(fx.repo, 'feature/a'));
		assert.strictEqual(host.confirms.length, 1);
		assert.ok(host.infos.some((m) => m.includes('1 deleted (1 empty)')), JSON.stringify(host.infos));
		assert.ok(host.logs.some((line) => line.startsWith('deleted feature/a')), JSON.stringify(host.logs));
		assert.ok(host.logs.some((line) => line.startsWith('$ git for-each-ref')));
		assert.deepStrictEqual(host.errors, []);
	});

	test('with --json, the client returns the document the CLI sent over RPC', async () => {
		makeGoneBranch(fx.repo, 'feature/a');
		const host = createHostUi(true);

		const result = await runCliProcess({ nodePath: process.execPath, cliPath: CLI_PATH, cwd: fx.repo, args: ['clean', '--json'], ui: host.ui });

		assert.strictEqual(result.exitCode, EXIT.notApplied);
		const document = result.document as { mode: string; branches: { name: string; action: string }[] };
		assert.strictEqual(document.mode, 'plan');
		assert.deepStrictEqual(document.branches.map(({ name, action }) => [name, action]), [['feature/a', 'delete'], ['main', 'keep']]);
		assert.ok(branchExists(fx.repo, 'feature/a'), 'a plan changes nothing');
		assert.deepStrictEqual(host.confirms, [], 'with --json, nothing is asked');
	});

	test('a declined confirmation deletes nothing and exits 4', async () => {
		makeGoneBranch(fx.repo, 'feature/a');
		const host = createHostUi(false);

		assert.strictEqual((await runCliProcess({ nodePath: process.execPath, cliPath: CLI_PATH, cwd: fx.repo, args: [], ui: host.ui })).exitCode, EXIT.cancelled);
		assert.ok(branchExists(fx.repo, 'feature/a'));
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
