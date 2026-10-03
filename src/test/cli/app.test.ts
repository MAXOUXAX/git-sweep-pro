import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROTECTED_CONFIG_KEY, runCli } from '../../cli/app';
import { EXIT } from '../../cli/args';
import { stateFilePath } from '../../cli/state-store';
import { createFakePrompter } from './fake-prompter';
import { branchExists, commitFile, createFakeIo, createRepoFixture, git, makeGoneBranch, type RepoFixture } from './git-fixture';

/*
 * Runs the real CLI in-process against real git repositories: only the
 * terminal (stdin/stdout/stderr) is faked.
 */
suite('cli app (real git)', function () {
	this.timeout(60000);
	let fx: RepoFixture;

	setup(() => {
		fx = createRepoFixture();
	});

	teardown(() => {
		fx.cleanup();
	});

	test('help, version and usage errors', async () => {
		const help = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['--help'], help), EXIT.ok);
		assert.ok(help.out.join('').includes('Usage: gsp'));

		const version = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['version'], version), EXIT.ok);
		assert.match(version.out.join(''), /^\d+\.\d+\.\d+\n$/);

		const bad = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['--nope'], bad), EXIT.usage);
		assert.ok(bad.err.join('').includes('Unknown option: --nope'));
	});

	test('fails clearly for a missing directory or a non-repository', async () => {
		const missing = createFakeIo(fx.dir);
		assert.strictEqual(await runCli(['-C', 'does-not-exist'], missing), EXIT.failed);
		assert.ok(missing.err.join('').includes('no such directory'));

		const notRepo = createFakeIo(fx.dir);
		assert.strictEqual(await runCli(['list'], notRepo), EXIT.failed);
		assert.ok(notRepo.err.join('').includes('not a Git repository'));
	});

	test('list prints stale branches, marks protected ones, and supports --json', async () => {
		makeGoneBranch(fx.repo, 'feature/a');
		makeGoneBranch(fx.repo, 'release/1');

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['list', '--protect', 'release/*'], io), EXIT.ok);
		assert.deepStrictEqual(io.out, ['feature/a\n', 'release/1 (protected)\n']);

		const json = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['list', '--json', '--no-fetch'], json), EXIT.ok);
		assert.deepStrictEqual(JSON.parse(json.out.join('')), {
			stale: ['feature/a', 'release/1'],
			protected: [],
			checkedOut: [],
			merged: [],
			worktrees: {},
		});

		const clean = createFakeIo(fx.repo);
		git(['branch', '-D', 'feature/a', 'release/1'], fx.repo);
		assert.strictEqual(await runCli(['list'], clean), EXIT.ok);
		assert.ok(clean.err.join('').includes('No stale branches found.'));
	});

	test('sweep refuses to delete without a terminal unless --yes', async () => {
		makeGoneBranch(fx.repo, 'feature/a');

		const refused = createFakeIo(fx.repo);
		assert.strictEqual(await runCli([], refused), EXIT.ok);
		assert.ok(branchExists(fx.repo, 'feature/a'));
		assert.ok(refused.out.join('').includes('Deletion cancelled.'));

		const accepted = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['--yes'], accepted), EXIT.ok);
		assert.ok(!branchExists(fx.repo, 'feature/a'));
		assert.ok(accepted.out.join('').includes('Deleted 1 branch(es)'));
	});

	test('dry run lists branches without deleting them', async () => {
		makeGoneBranch(fx.repo, 'feature/a');
		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['--dry-run'], io), EXIT.ok);
		assert.ok(branchExists(fx.repo, 'feature/a'));
		assert.ok(io.err.join('').includes('- feature/a'));
		assert.ok(io.out.join('').includes('Dry run: 1 branch(es) would be deleted.'));
	});

	test('explicit agent mode distinguishes refused deletion from success on a TTY', async () => {
		makeGoneBranch(fx.repo, 'feature/agent');
		const io = {
			...createFakeIo(fx.repo, { interactive: true }),
			loadPrompter: async () => { throw new Error('Widgets must not load'); },
		};
		assert.strictEqual(await runCli(['--non-interactive'], io), EXIT.cancelled);
		assert.ok(branchExists(fx.repo, 'feature/agent'));
		assert.strictEqual(await runCli(['--non-interactive', '--dry-run'], io), EXIT.ok);
		assert.ok(branchExists(fx.repo, 'feature/agent'));
		assert.strictEqual(await runCli(['--non-interactive', '--yes'], io), EXIT.ok);
		assert.ok(!branchExists(fx.repo, 'feature/agent'));
		assert.strictEqual(await runCli(['--non-interactive'], io), EXIT.ok, 'nothing to do is success');
	});

	test('JSON discovery stays parseable on a TTY and invalid JSON mutations do nothing', async () => {
		makeGoneBranch(fx.repo, 'feature/json');
		const io = {
			...createFakeIo(fx.repo, { interactive: true }),
			loadPrompter: async () => { throw new Error('Widgets must not load'); },
		};
		assert.strictEqual(await runCli(['list', '--json'], io), EXIT.ok);
		assert.deepStrictEqual(JSON.parse(io.out.join('')).stale, ['feature/json']);
		assert.strictEqual(await runCli(['--json', '--yes'], createFakeIo(fx.repo)), EXIT.usage);
		assert.ok(branchExists(fx.repo, 'feature/json'));
	});

	test('protected globs come from flags and git config', async () => {
		makeGoneBranch(fx.repo, 'release/1');
		makeGoneBranch(fx.repo, 'keep/me');
		git(['config', '--add', PROTECTED_CONFIG_KEY, 'keep/*'], fx.repo);

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['-y', '-p', 'release/*'], io), EXIT.ok);
		assert.ok(branchExists(fx.repo, 'release/1'));
		assert.ok(branchExists(fx.repo, 'keep/me'));
		assert.ok(io.out.join('').includes('All 2 stale branch(es) are protected.'));
	});

	test('interactive sweep follows the answers given to the widgets', async () => {
		makeGoneBranch(fx.repo, 'feature/a');
		makeGoneBranch(fx.repo, 'feature/b');

		// Keep only feature/b (index 1) selected, then confirm.
		const { prompter, calls } = createFakePrompter({ multiselect: [1], confirm: true });
		const io = { ...createFakeIo(fx.repo, { interactive: true }), loadPrompter: async () => prompter };
		assert.strictEqual(await runCli(['-C', fx.repo], io), EXIT.ok);
		assert.ok(branchExists(fx.repo, 'feature/a'));
		assert.ok(!branchExists(fx.repo, 'feature/b'));
		assert.strictEqual(calls[0], 'intro gsp sweep');
		assert.ok(calls.includes('success Deleted 1 branch(es); 0 skipped, 0 failed.'));
		assert.strictEqual(calls.at(-1), 'outro Done.');
	});

	test('post-pr switches to the given branch, deletes the merged one and pulls', async () => {
		git(['checkout', '-q', '-b', 'feature/done'], fx.repo);
		git(['push', '-q', '-u', 'origin', 'feature/done'], fx.repo);
		git(['push', '-q', 'origin', '--delete', 'feature/done'], fx.repo);

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['post-pr', 'main', '--yes'], io), EXIT.ok);
		assert.strictEqual(git(['rev-parse', '--abbrev-ref', 'HEAD'], fx.repo).trim(), 'main');
		assert.ok(!branchExists(fx.repo, 'feature/done'));
		assert.ok(io.out.join('').includes('Switched to main and pulled.'));
	});

	test('post-pr reports an unknown target branch', async () => {
		git(['checkout', '-q', '-b', 'feature/x'], fx.repo);
		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['post-pr', 'nope'], io), EXIT.failed);
		assert.ok(io.err.join('').includes('Branch "nope" is not available'));
		assert.ok(branchExists(fx.repo, 'feature/x'));
	});

	test('sync rebases and force-pushes; a conflict pauses (exit 3) and resume finishes it', async () => {
		git(['checkout', '-q', '-b', 'feature/sync'], fx.repo);
		commitFile(fx.repo, 'shared.txt', 'feature\n', 'feature change');
		git(['push', '-q', '-u', 'origin', 'feature/sync'], fx.repo);

		// main moves on with a conflicting change to the same file.
		git(['checkout', '-q', 'main'], fx.repo);
		commitFile(fx.repo, 'shared.txt', 'main\n', 'main change');
		git(['push', '-q', 'origin', 'main'], fx.repo);
		git(['checkout', '-q', 'feature/sync'], fx.repo);

		const paused = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['sync', 'main'], paused), EXIT.paused);
		const gitDir = git(['rev-parse', '--absolute-git-dir'], fx.repo).trim();
		assert.ok(fs.existsSync(stateFilePath(gitDir)), 'paused sync state is saved in the git dir');

		// Resolve the conflict like a user would, then resume.
		fs.writeFileSync(path.join(fx.repo, 'shared.txt'), 'resolved\n');
		git(['add', 'shared.txt'], fx.repo);
		const resumed = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['sync', '--continue'], resumed), EXIT.ok);
		assert.ok(resumed.out.join('').includes('feature/sync synced successfully.'));
		assert.ok(!fs.existsSync(stateFilePath(gitDir)), 'state is cleared once resumed');
		assert.strictEqual(
			git(['rev-parse', 'feature/sync'], fx.repo).trim(),
			git(['rev-parse', 'origin/feature/sync'], fx.repo).trim(),
			'the rebased branch was force-pushed'
		);
	});

	test('resume with nothing to resume is a no-op', async () => {
		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['resume'], io), EXIT.ok);
		assert.ok(io.out.join('').includes('Nothing to resume.'));
	});

	test('agents writes the instructions at the repository root, even from a subdirectory', async () => {
		fs.mkdirSync(path.join(fx.repo, 'src'));
		const io = createFakeIo(path.join(fx.repo, 'src'));
		assert.strictEqual(await runCli(['agents', 'CLAUDE.md'], io), EXIT.ok);
		assert.ok(fs.readFileSync(path.join(fx.repo, 'CLAUDE.md'), 'utf8').includes('Run `gsp help` to see its commands.'));
		assert.deepStrictEqual(io.out, ['Created CLAUDE.md with the gsp instructions.\n']);
	});

	test('--rpc emits NDJSON events', async () => {
		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['list', '--rpc', '--json'], io), EXIT.ok);
		assert.ok(io.out.some((line) => line.startsWith('{"type":"log","line":"$ git')));
	});

	suite('worktrees', () => {
		const addWorktree = (branch: string): string => {
			const dir = path.join(fx.dir, branch.replace(/\//g, '-'));
			git(['worktree', 'add', '-q', dir, branch], fx.repo);
			return dir;
		};

		test('sweep removes a clean worktree before deleting its stale branch', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			const wt = addWorktree('feature/wt');

			// Not pre-selected: the user explicitly picks it (index 0).
			const { prompter } = createFakePrompter({ multiselect: [0], confirm: true });
			const io = { ...createFakeIo(fx.repo, { interactive: true }), loadPrompter: async () => prompter };
			assert.strictEqual(await runCli([], io), EXIT.ok);

			assert.ok(!fs.existsSync(wt), 'worktree directory removed');
			assert.ok(!branchExists(fx.repo, 'feature/wt'));
		});

		test('list shows the worktree of a stale branch and the stale current branch', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			makeGoneBranch(fx.repo, 'feature/here');
			const wt = addWorktree('feature/wt');
			git(['checkout', '-q', 'feature/here'], fx.repo);

			const io = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['list', '--no-fetch'], io), EXIT.ok);
			const realWt = fs.realpathSync(wt);
			assert.deepStrictEqual(io.out.join('').split('\n').filter(Boolean), [
				`feature/wt (worktree ${realWt})`,
				'feature/here (current branch)',
			]);

			const json = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['list', '--json', '--no-fetch'], json), EXIT.ok);
			assert.deepStrictEqual(JSON.parse(json.out.join('')), {
				stale: ['feature/wt'],
				protected: [],
				checkedOut: [{ name: 'feature/here', where: 'current' }],
				merged: [],
				worktrees: { 'feature/wt': realWt },
			});
		});

		test('--yes never removes a worktree on its own', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			const wt = addWorktree('feature/wt');

			assert.strictEqual(await runCli(['--yes'], createFakeIo(fx.repo)), EXIT.ok);
			assert.ok(fs.existsSync(wt));
			assert.ok(branchExists(fx.repo, 'feature/wt'));
		});

		test('a worktree with uncommitted changes is kept, and so is its branch', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			const wt = addWorktree('feature/wt');
			fs.writeFileSync(path.join(wt, 'wip.txt'), 'work in progress\n');

			const { prompter } = createFakePrompter({ multiselect: [0], confirm: true });
			const io = { ...createFakeIo(fx.repo, { interactive: true }), loadPrompter: async () => prompter };
			assert.strictEqual(await runCli([], io), EXIT.failed);
			assert.ok(fs.existsSync(path.join(wt, 'wip.txt')));
			assert.ok(branchExists(fx.repo, 'feature/wt'));
		});

		test('branches of worktrees whose directory was deleted are swept', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			fs.rmSync(addWorktree('feature/wt'), { recursive: true, force: true });

			assert.strictEqual(await runCli(['--yes'], createFakeIo(fx.repo)), EXIT.ok);
			assert.ok(!branchExists(fx.repo, 'feature/wt'));
			assert.strictEqual(git(['worktree', 'list', '--porcelain'], fx.repo).match(/^worktree /gm)?.length, 1);
		});

		test('sweep run from a linked worktree skips the stale branch of the main worktree', async () => {
			makeGoneBranch(fx.repo, 'feature/main-wt');
			makeGoneBranch(fx.repo, 'feature/wt');
			git(['checkout', '-q', 'feature/main-wt'], fx.repo);
			const wt = addWorktree('feature/wt');
			git(['checkout', '-q', '--detach'], wt);

			const { prompter, seen } = createFakePrompter({ multiselect: [0], confirm: true });
			const io = { ...createFakeIo(wt, { interactive: true }), loadPrompter: async () => prompter };
			assert.strictEqual(await runCli([], io), EXIT.ok, io.err.join(''));
			assert.deepStrictEqual(seen.options?.map((option) => option.label), ['feature/wt'], 'the main worktree branch is not offered');
			assert.ok(branchExists(fx.repo, 'feature/main-wt'));
			assert.ok(!branchExists(fx.repo, 'feature/wt'));
		});

		test('sweep run from a linked worktree skips the branch checked out there', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			makeGoneBranch(fx.repo, 'feature/other');
			const wt = addWorktree('feature/wt');

			assert.strictEqual(await runCli(['--yes'], createFakeIo(wt)), EXIT.ok);
			assert.ok(branchExists(fx.repo, 'feature/wt'));
			assert.ok(!branchExists(fx.repo, 'feature/other'));
		});

		test('post-pr in a linked worktree detaches at the default branch and deletes the merged one', async () => {
			makeGoneBranch(fx.repo, 'feature/done');
			const wt = addWorktree('feature/done');

			const io = createFakeIo(wt);
			assert.strictEqual(await runCli(['post-pr', '--yes'], io), EXIT.ok, io.err.join(''));
			assert.strictEqual(git(['rev-parse', '--abbrev-ref', 'HEAD'], wt).trim(), 'HEAD', 'detached');
			assert.strictEqual(git(['rev-parse', 'HEAD'], wt).trim(), git(['rev-parse', 'origin/main'], fx.repo).trim());
			assert.ok(!branchExists(fx.repo, 'feature/done'));
			assert.strictEqual(git(['rev-parse', '--abbrev-ref', 'HEAD'], fx.repo).trim(), 'main', 'main worktree untouched');
		});

		test('sync in a linked worktree rebases onto main checked out in the main worktree', async () => {
			git(['branch', 'feature/sync'], fx.repo);
			git(['push', '-q', '-u', 'origin', 'feature/sync'], fx.repo);
			commitFile(fx.repo, 'main.txt', 'main\n', 'main moves on');
			const wt = addWorktree('feature/sync');
			commitFile(wt, 'feature.txt', 'feature\n', 'feature work');

			const io = createFakeIo(wt);
			assert.strictEqual(await runCli(['sync', 'main'], io), EXIT.ok, io.err.join(''));
			assert.strictEqual(git(['merge-base', 'main', 'feature/sync'], wt).trim(), git(['rev-parse', 'main'], wt).trim());
			assert.strictEqual(git(['rev-parse', '--abbrev-ref', 'HEAD'], fx.repo).trim(), 'main');
		});

		test('a paused sync is tracked per worktree', async () => {
			git(['branch', 'feature/sync'], fx.repo);
			commitFile(fx.repo, 'shared.txt', 'main\n', 'main change');
			const wt = addWorktree('feature/sync');
			commitFile(wt, 'shared.txt', 'feature\n', 'feature change');
			git(['push', '-q', '-u', 'origin', 'feature/sync'], wt);

			assert.strictEqual(await runCli(['sync', 'main'], createFakeIo(wt)), EXIT.paused);
			const wtGitDir = git(['rev-parse', '--absolute-git-dir'], wt).trim();
			assert.ok(fs.existsSync(stateFilePath(wtGitDir)));
			const mainGitDir = git(['rev-parse', '--absolute-git-dir'], fx.repo).trim();
			assert.ok(!fs.existsSync(stateFilePath(mainGitDir)), 'the main worktree has nothing to resume');

			fs.writeFileSync(path.join(wt, 'shared.txt'), 'resolved\n');
			git(['add', 'shared.txt'], wt);
			assert.strictEqual(await runCli(['resume'], createFakeIo(wt)), EXIT.ok);
			assert.ok(!fs.existsSync(stateFilePath(wtGitDir)));
		});

		test('worktree list prints every worktree and supports --json', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			const wt = addWorktree('feature/wt');
			const root = fs.realpathSync(fx.repo);
			const linked = fs.realpathSync(wt);

			const io = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'list'], io), EXIT.ok);
			assert.deepStrictEqual(io.out.join('').split('\n').filter(Boolean), [`${root}  main (main)`, `${linked}  feature/wt (linked)`]);

			const json = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'list', '--json'], json), EXIT.ok);
			assert.deepStrictEqual(JSON.parse(json.out.join('')), [
				{ path: root, branch: 'main', state: 'main' },
				{ path: linked, branch: 'feature/wt', state: 'linked' },
			]);
		});

		test('worktree list marks a registration whose directory is gone as prunable', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			const wt = addWorktree('feature/wt');
			const linked = path.join(fs.realpathSync(fx.dir), 'feature-wt');
			fs.rmSync(wt, { recursive: true, force: true });

			const json = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'list', '--json'], json), EXIT.ok);
			assert.deepStrictEqual(JSON.parse(json.out.join('')).at(-1), { path: linked, branch: 'feature/wt', state: 'prunable' });
		});

		test('worktree list --json reports a detached worktree with a null branch', async () => {
			const dir = path.join(fx.dir, 'detached');
			git(['worktree', 'add', '-q', '--detach', dir, 'HEAD'], fx.repo);

			const json = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'list', '--json'], json), EXIT.ok);
			assert.deepStrictEqual(JSON.parse(json.out.join('')).at(-1), { path: fs.realpathSync(dir), branch: null, state: 'linked' });
		});

		test('worktree prune forgets the registration of a deleted worktree', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			const wt = addWorktree('feature/wt');
			const linked = path.join(fs.realpathSync(fx.dir), 'feature-wt');
			fs.rmSync(wt, { recursive: true, force: true });

			const io = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'prune'], io), EXIT.ok);
			assert.ok(io.out.join('').includes('Pruned 1 worktree registration(s):'));
			assert.ok(io.out.join('').includes(linked));

			const after = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'list', '--json'], after), EXIT.ok);
			assert.deepStrictEqual(JSON.parse(after.out.join('')).map((entry: { path: string }) => entry.path), [fs.realpathSync(fx.repo)]);
		});

		test('worktree prune reports when there is nothing to forget', async () => {
			const io = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'prune'], io), EXIT.ok);
			assert.deepStrictEqual(io.out, []);
			assert.ok(io.err.join('').includes('No worktree registrations to prune.'));
		});

		test('worktree remove removes a linked worktree, refuses the main one, and reports an unknown one', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			const wt = addWorktree('feature/wt');

			const main = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'remove', 'main'], main), EXIT.failed);
			assert.ok(main.err.join('').includes('Refusing to remove the main worktree'));
			assert.ok(fs.existsSync(fx.repo));

			const unknown = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'remove', 'nope'], unknown), EXIT.failed);
			assert.ok(unknown.err.join('').includes('No worktree found for "nope"'));

			const io = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'remove', 'feature/wt'], io), EXIT.ok);
			assert.ok(!fs.existsSync(wt));
			assert.ok(branchExists(fx.repo, 'feature/wt'), 'the branch is kept');
			assert.ok(io.out.join('').includes('Removed worktree'));
		});

		test('worktree remove refuses a dirty worktree without --force and removes it with --force', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			const wt = addWorktree('feature/wt');
			fs.writeFileSync(path.join(wt, 'wip.txt'), 'work in progress\n');

			const refused = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'remove', 'feature/wt'], refused), EXIT.failed);
			assert.ok(refused.err.join('').includes('modified or untracked'));
			assert.ok(fs.existsSync(wt));

			const forced = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'remove', 'feature/wt', '--force'], forced), EXIT.ok);
			assert.ok(!fs.existsSync(wt));
		});

		test('an unknown worktree subcommand is a usage error', async () => {
			const io = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'frobnicate'], io), EXIT.usage);
			assert.ok(io.err.join('').includes('Unknown worktree subcommand: frobnicate'));
		});
	});
});
