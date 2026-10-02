import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCli } from '../../cli/app';
import { EXIT } from '../../cli/args';
import { stateFilePath } from '../../cli/state-store';
import { DELETION_LOG_KEY } from '../../core/deletion-log';
import { createFakePrompter } from './fake-prompter';
import { branchExists, commitFile, createFakeIo, createRepoFixture, git, type RepoFixture } from './git-fixture';

suite('restore (real git)', function () {
	this.timeout(60000);
	let fx: RepoFixture;

	setup(() => {
		fx = createRepoFixture();
	});

	teardown(() => {
		fx.cleanup();
	});

	/** A pushed branch with its own commit, whose remote is then deleted. */
	const makeGoneBranchWithCommit = (name: string): string => {
		git(['checkout', '-q', '-b', name], fx.repo);
		commitFile(fx.repo, `${name.replace(/\//g, '-')}.txt`, `${name}\n`, `work on ${name}`);
		const sha = git(['rev-parse', 'HEAD'], fx.repo).trim();
		git(['push', '-q', '-u', 'origin', name], fx.repo);
		git(['checkout', '-q', 'main'], fx.repo);
		git(['push', '-q', 'origin', '--delete', name], fx.repo);
		return sha;
	};

	const tipOf = (branch: string) => git(['rev-parse', branch], fx.repo).trim();

	test('a branch force-deleted after a refused safe delete is restored with its commits', async () => {
		const sha = makeGoneBranchWithCommit('feature/unmerged');

		const sweep = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['--no-confirm'], sweep), EXIT.ok, 'the force-delete offer is refused without --yes');
		assert.ok(sweep.err.join('').includes('Force-delete them with git branch -D? You can restore them later.'));
		assert.strictEqual(await runCli(['--yes'], sweep), EXIT.ok);
		assert.ok(!branchExists(fx.repo, 'feature/unmerged'));
		assert.ok(sweep.err.join('').includes('To restore them, run: gsp restore feature/unmerged'));

		const listing = {
			...createFakeIo(fx.repo, { interactive: true }),
			loadPrompter: async () => { throw new Error('JSON must not load widgets'); },
		};
		assert.strictEqual(await runCli(['restore', '--json'], listing), EXIT.ok);
		const recorded = JSON.parse(listing.out.join('')) as Array<{ branch: string; sha: string; source: string }>;
		assert.deepStrictEqual(recorded.map(({ branch, sha: s, source }) => ({ branch, sha: s, source })), [
			{ branch: 'feature/unmerged', sha, source: 'sweep' },
		]);

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['restore', 'feature/unmerged'], io), EXIT.ok);
		assert.strictEqual(tipOf('feature/unmerged'), sha);
		assert.ok(io.out.join('').includes('Restored 1 branch(es): feature/unmerged.'));
		assert.ok(!fs.existsSync(stateFilePath(path.join(fx.repo, '.git'))), 'nothing left to restore: the state file is gone');

		const again = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['restore', 'feature/unmerged'], again), EXIT.failed);
		assert.ok(again.err.join('').includes('No recorded deletion for: feature/unmerged.'));
	});

	test('without anyone to pick, restore lists what can be restored', async () => {
		makeGoneBranchWithCommit('feature/x');
		makeGoneBranchWithCommit('feature/back');
		await runCli(['--yes', '--force'], createFakeIo(fx.repo));
		git(['branch', 'feature/back'], fx.repo);

		for (const args of [['restore'], ['restore', '--yes']]) {
			const io = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(args, io), EXIT.ok);
			assert.match(io.out.join(''), /^feature\/x {2}[0-9a-f]{7} · deleted just now by sweep\n$/, 'a name in use again is not offered');
			assert.ok(!branchExists(fx.repo, 'feature/x'));
		}
	});

	test('the interactive picker restores the selected branches', async () => {
		const sha = makeGoneBranchWithCommit('feature/x');
		await runCli(['--yes', '--force'], createFakeIo(fx.repo));

		const { prompter, calls } = createFakePrompter({ multiselect: [0] });
		const io = { ...createFakeIo(fx.repo, { interactive: true }), loadPrompter: async () => prompter };
		assert.strictEqual(await runCli(['restore'], io), EXIT.ok);
		assert.strictEqual(tipOf('feature/x'), sha);
		assert.ok(calls.includes('success Restored 1 branch(es): feature/x.'));
	});

	test('post-pr records the merged branch it deletes', async () => {
		const sha = makeGoneBranchWithCommit('feature/done');
		git(['checkout', '-q', 'feature/done'], fx.repo);

		assert.strictEqual(await runCli(['post-pr', 'main', '--yes'], createFakeIo(fx.repo)), EXIT.ok);
		assert.strictEqual(await runCli(['restore', 'feature/done'], createFakeIo(fx.repo)), EXIT.ok);
		assert.strictEqual(tipOf('feature/done'), sha);
	});

	test('a branch deleted while its remote branch still exists tracks it again', async () => {
		git(['checkout', '-q', '-b', 'feature/live'], fx.repo);
		commitFile(fx.repo, 'live.txt', 'live\n', 'live work');
		git(['push', '-q', '-u', 'origin', 'feature/live'], fx.repo);

		assert.strictEqual(await runCli(['post-pr', 'main', '--yes'], createFakeIo(fx.repo)), EXIT.ok);
		assert.ok(!branchExists(fx.repo, 'feature/live'));

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['restore', 'feature/live'], io), EXIT.ok);
		assert.strictEqual(git(['rev-parse', '--abbrev-ref', 'feature/live@{upstream}'], fx.repo).trim(), 'origin/feature/live');
		assert.ok(io.err.join('').includes('It tracks origin/feature/live again.'));
	});

	test('the log is shared by all worktrees, and records removed worktrees', async () => {
		const sha = makeGoneBranchWithCommit('feature/wt');
		const linked = path.join(fx.dir, 'linked');
		git(['worktree', 'add', '-q', linked, 'feature/wt'], fx.repo);
		const detached = path.join(fx.dir, 'detached');
		git(['worktree', 'add', '-q', '--detach', detached], fx.repo);

		// Sweep from one linked worktree; the branch lives in another one.
		assert.strictEqual(await runCli(['--force', '--yes'], createFakeIo(detached)), EXIT.ok);
		assert.ok(branchExists(fx.repo, 'feature/wt'), '--yes never selects a branch checked out in a worktree');
		const { prompter } = createFakePrompter({ multiselect: [0], confirm: true });
		const sweep = { ...createFakeIo(detached, { interactive: true }), loadPrompter: async () => prompter };
		assert.strictEqual(await runCli(['--force'], sweep), EXIT.ok);
		assert.ok(!branchExists(fx.repo, 'feature/wt'));
		assert.ok(!fs.existsSync(linked));

		const commonDir = path.resolve(fx.repo, git(['rev-parse', '--git-common-dir'], fx.repo).trim());
		const state = JSON.parse(fs.readFileSync(stateFilePath(commonDir), 'utf8')) as Record<string, Array<{ worktree?: string }>>;
		assert.ok(state[DELETION_LOG_KEY][0].worktree?.endsWith(`${path.sep}linked`));

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['restore', 'feature/wt'], io), EXIT.ok);
		assert.strictEqual(tipOf('feature/wt'), sha);
		assert.ok(io.err.join('').includes('To recreate it, run: git worktree add'));
	});

	test('a deletion whose commit Git garbage-collected is no longer offered', async () => {
		makeGoneBranchWithCommit('feature/old');
		await runCli(['--yes', '--force'], createFakeIo(fx.repo));
		git(['reflog', 'expire', '--expire=now', '--all'], fx.repo);
		git(['gc', '-q', '--prune=now'], fx.repo);

		const listing = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['restore'], listing), EXIT.ok);
		assert.ok(listing.err.join('').includes('No deleted branches to restore.'));

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['restore', 'feature/old'], io), EXIT.failed);
		assert.match(io.err.join(''), /Could not restore feature\/old \(Git has garbage-collected its commit [0-9a-f]{7}\)\./);
		assert.ok(!branchExists(fx.repo, 'feature/old'));
	});

	test('outside a repository restore fails clearly', async () => {
		const io = createFakeIo(fx.dir);
		assert.strictEqual(await runCli(['restore'], io), EXIT.failed);
		assert.ok(io.err.join('').includes('not a Git repository'));
	});
});
