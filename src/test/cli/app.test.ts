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

		const cleanHelp = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['clean', '--help'], cleanHelp), EXIT.ok);
		assert.ok(cleanHelp.out.join('').startsWith('Usage: gsp clean'));
		assert.ok(cleanHelp.out.join('').includes('Common tasks:'));
		assert.ok(!cleanHelp.out.join('').includes('sync [upstream]'), 'only the help of clean');

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

	test('list plans like clean --dry-run: one line per branch, then the summary', async () => {
		makeGoneBranch(fx.repo, 'feature/a');
		makeGoneBranch(fx.repo, 'release/1');

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['list', '--protect', 'release/*'], io), EXIT.notApplied);
		assert.deepStrictEqual(io.out.join('').split('\n').filter(Boolean), [
			'delete  feature/a  already in origin/main',
			'skip    release/1  protected (already in origin/main)',
			'keep    main       default branch',
			'1 to delete (1 empty) · 1 skipped',
			"Nothing was changed. To apply this plan, run: gsp clean feature/a --protect 'release/*' --yes",
		]);
		assert.ok(branchExists(fx.repo, 'feature/a'));

		git(['branch', '-D', 'feature/a', 'release/1'], fx.repo);
		const clean = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['list'], clean), EXIT.ok);
		assert.ok(clean.out.join('').includes('Nothing to clean.'));
	});

	test('clean only plans without a terminal, and applies with --yes', async () => {
		makeGoneBranch(fx.repo, 'feature/a');

		const planned = createFakeIo(fx.repo);
		assert.strictEqual(await runCli([], planned), EXIT.notApplied);
		assert.ok(branchExists(fx.repo, 'feature/a'));
		assert.ok(planned.out.join('').includes('To apply this plan, run: gsp clean feature/a --yes'));

		const json = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['--json'], json), EXIT.notApplied);
		assert.strictEqual(JSON.parse(json.out.join('')).next, 'gsp clean feature/a --yes', 'the same command, for agents');

		const accepted = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['sweep', '--yes'], accepted), EXIT.ok);
		assert.ok(!branchExists(fx.repo, 'feature/a'));
		assert.ok(accepted.out.join('').includes('1 deleted (1 empty) · restore with gsp restore feature/a'));

		const done = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['--json'], done), EXIT.ok);
		assert.strictEqual(JSON.parse(done.out.join('')).next, null);
	});

	test('dry run plans even with --yes, and the deprecated --merged changes nothing', async () => {
		makeGoneBranch(fx.repo, 'feature/a');
		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['--dry-run', '--yes', '--merged'], io), EXIT.notApplied);
		assert.ok(branchExists(fx.repo, 'feature/a'));
		assert.ok(io.out.join('').includes('delete  feature/a'));
		assert.ok(io.err.join('').includes('--merged is deprecated'));
	});

	test('named branches: only those are considered, and an unknown one is a usage error', async () => {
		makeGoneBranch(fx.repo, 'feature/a');
		makeGoneBranch(fx.repo, 'feature/b');
		git(['branch', 'other'], fx.repo);

		const unknown = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['clean', 'feature/a', 'nope', '--yes'], unknown), EXIT.usage);
		assert.ok(unknown.err.join('').includes('No branch named "nope"'));
		assert.ok(branchExists(fx.repo, 'feature/a'));

		assert.strictEqual(await runCli(['clean', 'feature/a', '--yes'], createFakeIo(fx.repo)), EXIT.ok);
		assert.ok(!branchExists(fx.repo, 'feature/a'));
		assert.ok(branchExists(fx.repo, 'feature/b'));
		assert.ok(branchExists(fx.repo, 'other'));

		assert.strictEqual(await runCli(['clean', 'feature/*', '--yes'], createFakeIo(fx.repo)), EXIT.ok);
		assert.ok(!branchExists(fx.repo, 'feature/b'));
		assert.ok(branchExists(fx.repo, 'other'));
	});

	test('a branch with unmerged work needs --force, named exactly', async () => {
		git(['checkout', '-q', '-b', 'feature/wip'], fx.repo);
		commitFile(fx.repo, 'wip.txt', 'wip\n', 'wip');
		git(['checkout', '-q', 'main'], fx.repo);

		assert.strictEqual(await runCli(['--yes'], createFakeIo(fx.repo)), EXIT.ok, 'an alive branch is kept: nothing to do');
		const unforced = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['clean', 'feature/wip', '--yes'], unforced), EXIT.notApplied);
		assert.ok(unforced.out.join('').includes('needs --force'));
		assert.ok(unforced.out.join('').includes('→ gsp clean feature/wip --yes --force'));
		assert.ok(branchExists(fx.repo, 'feature/wip'));

		assert.strictEqual(await runCli(['clean', 'feature/*', '--yes', '--force'], createFakeIo(fx.repo)), EXIT.ok, 'a glob never forces');
		assert.ok(branchExists(fx.repo, 'feature/wip'));

		const forced = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['clean', 'feature/wip', '--yes', '--force'], forced), EXIT.ok);
		assert.ok(!branchExists(fx.repo, 'feature/wip'));
		assert.ok(forced.out.join('').includes('restore with gsp restore feature/wip'));
	});

	test('explicit agent mode plans on a TTY, and applies only with --yes', async () => {
		makeGoneBranch(fx.repo, 'feature/agent');
		const io = {
			...createFakeIo(fx.repo, { interactive: true }),
			loadPrompter: async () => { throw new Error('Widgets must not load'); },
		};
		assert.strictEqual(await runCli(['--non-interactive'], io), EXIT.notApplied);
		assert.ok(branchExists(fx.repo, 'feature/agent'));
		assert.strictEqual(await runCli(['--non-interactive', '--dry-run'], io), EXIT.notApplied);
		assert.ok(branchExists(fx.repo, 'feature/agent'));
		assert.strictEqual(await runCli(['--non-interactive', '--yes'], io), EXIT.ok);
		assert.ok(!branchExists(fx.repo, 'feature/agent'));
		assert.strictEqual(await runCli(['--non-interactive'], io), EXIT.ok, 'nothing to do is success');
	});

	test('JSON stays parseable on a TTY: the plan without --yes, the result with it', async () => {
		makeGoneBranch(fx.repo, 'feature/json');
		const io = {
			...createFakeIo(fx.repo, { interactive: true }),
			loadPrompter: async () => { throw new Error('Widgets must not load'); },
		};
		assert.strictEqual(await runCli(['clean', '--json'], io), EXIT.notApplied);
		const plan = JSON.parse(io.out.join(''));
		assert.strictEqual(plan.mode, 'plan');
		assert.deepStrictEqual(
			plan.branches.map((branch: { name: string; action: string }) => [branch.name, branch.action]),
			[['feature/json', 'delete'], ['main', 'keep']]
		);
		assert.ok(branchExists(fx.repo, 'feature/json'));

		const applied = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['--json', '--yes'], applied), EXIT.ok);
		const result = JSON.parse(applied.out.join(''));
		assert.strictEqual(result.mode, 'apply');
		assert.strictEqual(result.branches[0].result, 'deleted');
		assert.strictEqual(result.restore, 'gsp restore feature/json');
		assert.ok(!branchExists(fx.repo, 'feature/json'));
	});

	test('protected globs come from flags and git config, and deleteMerged=false is honoured', async () => {
		makeGoneBranch(fx.repo, 'release/1');
		makeGoneBranch(fx.repo, 'keep/me');
		makeGoneBranch(fx.repo, 'opted/out');
		git(['config', '--add', PROTECTED_CONFIG_KEY, 'keep/*'], fx.repo);
		git(['config', 'branch.opted/out.deleteMerged', 'false'], fx.repo);

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['-y', '-p', 'release/*'], io), EXIT.ok);
		assert.ok(branchExists(fx.repo, 'release/1'));
		assert.ok(branchExists(fx.repo, 'keep/me'));
		assert.ok(branchExists(fx.repo, 'opted/out'));
		assert.ok(io.out.join('').includes('branch.opted/out.deleteMerged is false'));
		assert.ok(!io.out.join('').includes('→ git config --unset'), 'deliberate: no hint');
		assert.ok(io.out.join('').includes('Nothing to clean · 3 skipped.'));
	});

	test('interactive clean follows the answers given to the widgets', async () => {
		makeGoneBranch(fx.repo, 'feature/a');
		makeGoneBranch(fx.repo, 'feature/b');

		// Keep only feature/b (index 1) selected, then confirm.
		const { prompter, calls, seen } = createFakePrompter({ multiselect: [1], confirm: true });
		const io = { ...createFakeIo(fx.repo, { interactive: true }), loadPrompter: async () => prompter };
		assert.strictEqual(await runCli(['-C', fx.repo], io), EXIT.ok);
		assert.deepStrictEqual(seen.initial, [0, 1], 'every planned deletion is pre-selected');
		assert.ok(branchExists(fx.repo, 'feature/a'));
		assert.ok(!branchExists(fx.repo, 'feature/b'));
		assert.strictEqual(calls[0], 'intro gsp clean');
		assert.ok(calls.includes('success 1 deleted (1 empty) · 1 skipped · restore with gsp restore feature/b'), calls.join('\n'));
		assert.strictEqual(calls.at(-1), 'outro Done.');
	});

	test('an unreachable remote falls back to the local remote-tracking refs, and says so', async () => {
		makeGoneBranch(fx.repo, 'feature/a');
		git(['remote', 'set-url', 'origin', path.join(fx.dir, 'nowhere.git')], fx.repo);

		const plan = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['--json'], plan), EXIT.notApplied);
		const planned = JSON.parse(plan.out.join(''));
		assert.deepStrictEqual([planned.checks.remote.source, planned.checks.remote.reason], ['local-refs', 'unreachable']);
		assert.ok(plan.err.join('').includes('Could not reach the remote'));

		const applied = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['--json', '--yes'], applied), EXIT.ok);
		const result = JSON.parse(applied.out.join(''));
		assert.deepStrictEqual([result.checks.remote.source, result.checks.remote.reason, result.checks.fetched], ['local-refs', 'unreachable', false]);
		assert.ok(!branchExists(fx.repo, 'feature/a'), 'a proven branch is still deleted');
		assert.strictEqual(applied.err.join('').split('Could not reach the remote').length - 1, 1, 'the warning is printed once');
	});

	test('a repository without a remote is cleaned from its local branches', async () => {
		git(['remote', 'remove', 'origin'], fx.repo);
		git(['branch', 'feature/a'], fx.repo);

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['--json', '--yes'], io), EXIT.ok);
		const report = JSON.parse(io.out.join(''));
		assert.deepStrictEqual(report.checks.remote, { source: 'local-refs', reason: 'no-remote' });
		assert.strictEqual(report.checks.base.ref, 'refs/heads/main');
		assert.ok(!branchExists(fx.repo, 'feature/a'));
	});

	test('the picker offers branches needing --force only with --force, never pre-selected', async () => {
		makeGoneBranch(fx.repo, 'feature/a');
		git(['checkout', '-q', '-b', 'feature/gone'], fx.repo);
		commitFile(fx.repo, 'gone.txt', 'gone\n', 'gone');
		git(['push', '-q', '-u', 'origin', 'feature/gone'], fx.repo);
		git(['checkout', '-q', 'main'], fx.repo);
		git(['push', '-q', 'origin', '--delete', 'feature/gone'], fx.repo);

		const safe = createFakePrompter({});
		await runCli([], { ...createFakeIo(fx.repo, { interactive: true }), loadPrompter: async () => safe.prompter });
		assert.deepStrictEqual(safe.seen.options?.map((option) => option.label), ['feature/a'], 'proven branches only');

		const forced = createFakePrompter({});
		await runCli(['--force'], { ...createFakeIo(fx.repo, { interactive: true }), loadPrompter: async () => forced.prompter });
		assert.deepStrictEqual(forced.seen.options?.map((option) => option.label), ['feature/a', 'feature/gone']);
		assert.deepStrictEqual(forced.seen.initial, [0], 'the one needing --force is not pre-selected');
	});

	test('an interactive cancel exits 4 and deletes nothing', async () => {
		makeGoneBranch(fx.repo, 'feature/a');
		const { prompter } = createFakePrompter({ multiselect: [0], confirm: false });
		const io = { ...createFakeIo(fx.repo, { interactive: true }), loadPrompter: async () => prompter };
		assert.strictEqual(await runCli([], io), EXIT.cancelled);
		assert.ok(branchExists(fx.repo, 'feature/a'));

		const dismissed = createFakePrompter({});
		const dismissedIo = { ...createFakeIo(fx.repo, { interactive: true }), loadPrompter: async () => dismissed.prompter };
		assert.strictEqual(await runCli([], dismissedIo), EXIT.cancelled);
		assert.ok(branchExists(fx.repo, 'feature/a'));
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

		test('clean removes a clean worktree before deleting its dead branch', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			const wt = addWorktree('feature/wt');

			const { prompter, seen } = createFakePrompter({ multiselect: [0], confirm: true });
			const io = { ...createFakeIo(fx.repo, { interactive: true }), loadPrompter: async () => prompter };
			assert.strictEqual(await runCli([], io), EXIT.ok);

			assert.deepStrictEqual(seen.initial, [0], 'pre-selected');
			assert.ok(!fs.existsSync(wt), 'worktree directory removed');
			assert.ok(!branchExists(fx.repo, 'feature/wt'));
		});

		test('list shows the worktree of a dead branch and skips the current branch', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			makeGoneBranch(fx.repo, 'feature/here');
			const wt = addWorktree('feature/wt');
			git(['checkout', '-q', 'feature/here'], fx.repo);

			const io = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['list', '--no-fetch'], io), EXIT.notApplied);
			const realWt = fs.realpathSync(wt);
			const lines = io.out.join('').split('\n');
			assert.ok(lines.includes(`delete  feature/wt    already in origin/main, removes worktree ${realWt}`), lines.join('\n'));
			assert.ok(lines.includes('skip    feature/here  current branch (already in origin/main) → gsp post-pr feature/here --yes'), lines.join('\n'));

			const json = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['list', '--json', '--no-fetch'], json), EXIT.notApplied);
			const report = JSON.parse(json.out.join(''));
			assert.deepStrictEqual(report.checks.remote, { source: 'local-refs', reason: 'no-fetch' });
			const byName = new Map(
				(report.branches as Array<{ name: string; worktree: unknown; reason: string }>).map((branch) => [branch.name, branch])
			);
			assert.deepStrictEqual(byName.get('feature/wt')?.worktree, { path: realWt, isMain: false, dirty: false, locked: false, prunable: false, inProgress: null, ignoredFiles: { count: 0, sample: [] }, submodules: false });
			assert.strictEqual(byName.get('feature/here')?.reason, 'current-branch');
		});

		test('--yes removes the clean worktree of a dead branch, never a locked one', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			makeGoneBranch(fx.repo, 'feature/locked');
			const wt = addWorktree('feature/wt');
			const locked = addWorktree('feature/locked');
			git(['worktree', 'lock', locked], fx.repo);

			const io = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['--yes'], io), EXIT.ok);
			assert.ok(!fs.existsSync(wt));
			assert.ok(!branchExists(fx.repo, 'feature/wt'));
			assert.ok(fs.existsSync(locked));
			assert.ok(branchExists(fx.repo, 'feature/locked'));
			assert.ok(io.out.join('').includes(`→ git worktree unlock ${fs.realpathSync(locked)}`));
		});

		test('a worktree with uncommitted changes is kept, and so is its branch, even when status hides untracked files', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			const wt = addWorktree('feature/wt');
			fs.writeFileSync(path.join(wt, 'wip.txt'), 'work in progress\n');
			// Hidden from git status, but still lost with the worktree.
			git(['config', 'status.showUntrackedFiles', 'no'], fx.repo);

			const io = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['--yes'], io), EXIT.ok);
			assert.ok(fs.existsSync(path.join(wt, 'wip.txt')));
			assert.ok(branchExists(fx.repo, 'feature/wt'));
			assert.ok(
				io.out.join('').includes(`has uncommitted changes (already in origin/main) → git -C ${fs.realpathSync(wt)} stash --include-untracked && gsp clean feature/wt --yes`),
				io.out.join('')
			);
		});

		test('a worktree holding ignored files is kept unless they are regenerable; --force removes it', async () => {
			fs.writeFileSync(path.join(fx.repo, '.gitignore'), '.env\nnode_modules/\ndist/\n');
			git(['add', '.gitignore'], fx.repo);
			git(['commit', '-q', '-m', 'ignore'], fx.repo);
			git(['push', '-q', 'origin', 'main'], fx.repo);
			makeGoneBranch(fx.repo, 'feature/env');
			makeGoneBranch(fx.repo, 'feature/deps');
			const env = addWorktree('feature/env');
			const deps = addWorktree('feature/deps');
			fs.writeFileSync(path.join(env, '.env'), 'TOKEN=1\n');
			for (const dir of [deps, env]) {
				fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
				fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), '\n');
				fs.mkdirSync(path.join(dir, 'dist'));
			}

			const plan = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['--json'], plan), EXIT.notApplied);
			const byName = new Map(
				(JSON.parse(plan.out.join('')).branches as Array<{ name: string; reason: string; worktree: { ignoredFiles: unknown } }>).map((branch) => [branch.name, branch])
			);
			assert.strictEqual(byName.get('feature/env')?.reason, 'ignored-files');
			assert.deepStrictEqual(byName.get('feature/env')?.worktree.ignoredFiles, { count: 1, sample: ['.env'] });
			assert.deepStrictEqual(byName.get('feature/deps')?.worktree.ignoredFiles, { count: 0, sample: [] });

			const io = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['--yes'], io), EXIT.notApplied, '--force would delete more');
			assert.ok(!fs.existsSync(deps), 'only regenerable files: removed');
			assert.ok(fs.existsSync(path.join(env, '.env')));
			assert.ok(branchExists(fx.repo, 'feature/env'));
			assert.ok(io.out.join('').includes(`removing worktree ${fs.realpathSync(env)} would delete 1 ignored file (.env), needs --force`), io.out.join(''));

			assert.strictEqual(await runCli(['clean', 'feature/env', '--yes', '--force'], createFakeIo(fx.repo)), EXIT.ok);
			assert.ok(!fs.existsSync(env));
			assert.ok(!branchExists(fx.repo, 'feature/env'));
		});

		test('a folder is regenerable only when Git reports it whole; secret-like files never are', async () => {
			fs.writeFileSync(path.join(fx.repo, '.gitignore'), 'credentials.json\nnode_modules/\ndist/\n/build/\n');
			fs.mkdirSync(path.join(fx.repo, 'tools', 'build'), { recursive: true });
			fs.writeFileSync(path.join(fx.repo, 'tools', 'build', 'run.sh'), 'echo\n');
			git(['add', '.gitignore', 'tools'], fx.repo);
			git(['commit', '-q', '-m', 'tools'], fx.repo);
			git(['push', '-q', 'origin', 'main'], fx.repo);
			const files: Record<string, string[]> = {
				'feature/build': ['tools/build/credentials.json'],
				'feature/dist': ['dist/app.js', 'dist/.env', 'dist/credentials.json', 'dist/auth/credentials.js', 'build/secrets.txt'],
				'feature/deps': ['node_modules/pkg/.env', 'node_modules/pkg/index.js'],
			};
			for (const [branch, paths] of Object.entries(files)) {
				makeGoneBranch(fx.repo, branch);
				const wt = addWorktree(branch);
				for (const file of paths) {
					fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
					fs.writeFileSync(path.join(wt, file), 'x\n');
				}
			}

			const plan = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['--json'], plan), EXIT.notApplied);
			const ignored = Object.fromEntries(
				(JSON.parse(plan.out.join('')).branches as Array<{ name: string; reason: string; worktree: { ignoredFiles: unknown } | null }>)
					.filter((branch) => branch.name !== 'main')
					.map((branch) => [branch.name, [branch.reason, branch.worktree?.ignoredFiles]])
			);
			assert.deepStrictEqual(ignored, {
				'feature/build': ['ignored-files', { count: 1, sample: ['tools/build/credentials.json'] }],
				// Compiled code named after a module (`dist/auth/credentials.js`) is build output, not a secret.
				'feature/dist': ['ignored-files', { count: 3, sample: ['build/secrets.txt', 'dist/.env', 'dist/credentials.json'] }],
				// Packages ship their own `.env` files: dependency folders are not searched.
				'feature/deps': ['empty', { count: 0, sample: [] }],
			});
		});

		test('a worktree holding a checked-out submodule is skipped, not left to fail', async () => {
			const lib = path.join(fx.dir, 'lib');
			git(['init', '-q', lib], fx.dir);
			commitFile(lib, 'lib.txt', 'lib\n', 'lib');
			git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib'], fx.repo);
			git(['commit', '-q', '-m', 'add lib'], fx.repo);
			git(['push', '-q', 'origin', 'main'], fx.repo);
			makeGoneBranch(fx.repo, 'feature/sub');
			makeGoneBranch(fx.repo, 'feature/bare');
			const sub = addWorktree('feature/sub');
			const bare = addWorktree('feature/bare');
			git(['-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init'], sub);

			const io = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['--yes'], io), EXIT.ok);
			assert.ok(fs.existsSync(path.join(sub, 'lib', 'lib.txt')));
			assert.ok(branchExists(fx.repo, 'feature/sub'));
			assert.ok(!fs.existsSync(bare), 'its submodule is not checked out: removed');
			const real = fs.realpathSync(sub);
			assert.ok(
				io.out.join('').includes(
					`skip    feature/sub   worktree ${real} holds submodules, which git worktree remove refuses to delete (already in origin/main) → check the submodules of ${real}`
				),
				io.out.join('')
			);
		});

		test('a clean worktree in the middle of a rebase is never removed, nor its branch deleted, even with --force', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			const wt = addWorktree('feature/wt');
			// Stop the rebase right away on a "break": the worktree stays clean, HEAD detached.
			git(['-c', 'sequence.editor=f() { printf "break\\n" > "$1"; }; f', 'rebase', '-q', '-i', 'main'], wt);
			assert.strictEqual(git(['status', '--porcelain'], wt), '');

			for (const args of [['--yes'], ['clean', 'feature/wt', '--yes', '--force']]) {
				const io = createFakeIo(fx.repo);
				assert.strictEqual(await runCli(args, io), EXIT.ok, args.join(' '));
				assert.ok(fs.existsSync(wt), args.join(' '));
				assert.ok(branchExists(fx.repo, 'feature/wt'), args.join(' '));
				assert.ok(io.out.join('').includes(`a rebase is in progress in ${fs.realpathSync(wt)}`), io.out.join(''));
			}
			git(['rebase', '--abort'], wt);
		});

		test('branches of worktrees whose directory was deleted are cleaned', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			fs.rmSync(addWorktree('feature/wt'), { recursive: true, force: true });

			assert.strictEqual(await runCli(['--yes'], createFakeIo(fx.repo)), EXIT.ok);
			assert.ok(!branchExists(fx.repo, 'feature/wt'));
			assert.strictEqual(git(['worktree', 'list', '--porcelain'], fx.repo).match(/^worktree /gm)?.length, 1);
		});

		test('clean run from a linked worktree skips the stale branch of the main worktree', async () => {
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

		test('clean run from a linked worktree skips the branch checked out there', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			makeGoneBranch(fx.repo, 'feature/other');
			const wt = addWorktree('feature/wt');

			assert.strictEqual(await runCli(['--yes'], createFakeIo(wt)), EXIT.ok);
			assert.ok(branchExists(fx.repo, 'feature/wt'));
			assert.ok(!branchExists(fx.repo, 'feature/other'));
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

		test('clean --remote --json: remote branches in their own array, and the next command keeps --remote', async () => {
			git(['checkout', '-q', '-b', 'feature/r'], fx.repo);
			commitFile(fx.repo, 'r.txt', 'r\n', 'r');
			git(['push', '-q', 'origin', 'feature/r'], fx.repo);
			git(['checkout', '-q', 'main'], fx.repo);
			git(['merge', '-q', '--no-ff', '-m', 'merge r', 'feature/r'], fx.repo);
			git(['push', '-q', 'origin', 'main'], fx.repo);
			git(['branch', '-q', '-D', 'feature/r'], fx.repo);

			const plan = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['clean', '--remote', '--json', '--no-github'], plan), EXIT.notApplied);
			const document = JSON.parse(plan.out.join(''));
			assert.deepStrictEqual(
				document.remoteBranches.map((branch: { name: string; action: string }) => [branch.name, branch.action]),
				[
					['feature/r', 'delete'],
					['main', 'keep'],
				]
			);
			assert.deepStrictEqual(document.summary.remote, { remote: 'origin', delete: 1, deleted: 0, failed: 0, skipped: 0, kept: 1 });
			assert.strictEqual(document.next, 'gsp clean origin/feature/r --no-github --remote --yes');

			const human = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['clean', '--remote', '--no-github'], human), EXIT.notApplied);
			const out = human.out.join('');
			assert.ok(out.includes('\nOn origin:\ndelete  feature/r  merged into origin/main\n'), out);
			assert.ok(out.includes('Nothing was changed. To apply this plan, run: gsp clean origin/feature/r --no-github --remote --yes'), out);

			const unknown = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['clean', '--remote=upstream', '--json'], unknown), EXIT.usage);
			assert.strictEqual(JSON.parse(unknown.out.join('')).error.code, 'unknown-remote');

			git(['config', 'remote.origin.pushurl', `${fx.remote}-elsewhere`], fx.repo);
			const pushElsewhere = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['clean', '--remote', '--json'], pushElsewhere), EXIT.usage);
			assert.strictEqual(JSON.parse(pushElsewhere.out.join('')).error.code, 'push-url-differs');
			git(['config', '--unset', 'remote.origin.pushurl'], fx.repo);

			const applied = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['clean', 'feature/r', '--remote', '--yes', '--no-github'], applied), EXIT.ok);
			assert.ok(applied.out.join('').includes('on origin: 1 deleted · restore with gsp restore origin/feature/r'), applied.out.join(''));
			const listed = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['restore'], listed), EXIT.ok);
			assert.ok(listed.out.join('').startsWith('origin/feature/r (remote)  '), listed.out.join(''));
		});

		test('worktree list --json gives each worktree its state, and what gsp clean would do with its branch', async () => {
			makeGoneBranch(fx.repo, 'feature/clean');
			const clean = addWorktree('feature/clean');
			makeGoneBranch(fx.repo, 'feature/dirty');
			const dirty = addWorktree('feature/dirty');
			fs.writeFileSync(path.join(dirty, 'notes.txt'), 'work in progress\n');
			// A rebase that stops on a conflict: HEAD is detached, the branch is still being worked on.
			git(['checkout', '-q', '-b', 'feature/rebasing'], fx.repo);
			commitFile(fx.repo, 'README.md', '# rebasing\n', 'rebasing');
			git(['checkout', '-q', 'main'], fx.repo);
			commitFile(fx.repo, 'README.md', '# main\n', 'main moves');
			git(['push', '-q', 'origin', 'main'], fx.repo);
			const rebasing = addWorktree('feature/rebasing');
			assert.throws(() => git(['rebase', 'main'], rebasing));
			makeGoneBranch(fx.repo, 'feature/gone');
			const gone = addWorktree('feature/gone');
			fs.rmSync(gone, { recursive: true, force: true });
			const detached = path.join(fx.dir, 'detached');
			git(['worktree', 'add', '-q', '--detach', detached, 'HEAD'], fx.repo);

			const json = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'list', '--json', '--no-github'], json), EXIT.ok);
			const document = JSON.parse(json.out.join(''));
			assert.deepStrictEqual([document.schema, document.command], [2, 'worktree list']);
			const head = (ref: string) => git(['rev-parse', ref], fx.repo).trim();
			const real = (dir: string) => path.join(fs.realpathSync(path.dirname(dir)), path.basename(dir));
			const none = { ignoredFiles: { count: 0, sample: [] } };
			const byPath = Object.fromEntries(document.worktrees.map((entry: { path: string }) => [entry.path, entry]));
			assert.deepStrictEqual(byPath[fs.realpathSync(fx.repo)], {
				path: fs.realpathSync(fx.repo),
				branch: 'main',
				head: head('main'),
				isMain: true,
				locked: false,
				prunable: false,
				dirty: false,
				inProgress: null,
				ignoredFiles: null,
				verdict: 'alive',
				verdictReason: 'default-branch',
				action: 'keep',
				reason: 'default-branch',
				hint: null,
			});
			assert.deepStrictEqual(byPath[real(clean)], {
				path: real(clean),
				branch: 'feature/clean',
				head: head('feature/clean'),
				isMain: false,
				locked: false,
				prunable: false,
				dirty: false,
				inProgress: null,
				...none,
				verdict: 'dead',
				verdictReason: 'empty',
				action: 'delete',
				reason: 'empty',
				hint: 'gsp clean feature/clean --yes',
			});
			const pick = (entry: Record<string, unknown>, keys: string[]) => keys.map((key) => entry[key]);
			const keys = ['branch', 'isMain', 'prunable', 'dirty', 'inProgress', 'action', 'reason', 'hint'];
			assert.deepStrictEqual(pick(byPath[real(dirty)], keys), [
				'feature/dirty',
				false,
				false,
				true,
				null,
				'skip',
				'dirty-worktree',
				`git -C ${real(dirty)} stash --include-untracked && gsp clean feature/dirty --yes`,
			]);
			assert.deepStrictEqual(pick(byPath[real(rebasing)], keys), [
				'feature/rebasing',
				false,
				false,
				true,
				'rebase',
				'keep',
				'unmerged-commits',
				null,
			]);
			assert.deepStrictEqual(pick(byPath[real(gone)], [...keys, 'ignoredFiles']), [
				'feature/gone',
				false,
				true,
				false,
				null,
				'delete',
				'empty',
				'gsp clean feature/gone --yes',
				null,
			]);
			assert.deepStrictEqual(pick(byPath[real(detached)], ['branch', 'head', 'verdict', 'action', 'reason', 'hint']), [null, head('HEAD'), null, 'keep', 'detached', null]);
			assert.strictEqual(document.worktrees[0].path, fs.realpathSync(fx.repo), 'the main worktree first');

			// Read-only: the prunable registration is still there, and so is every branch.
			assert.ok(git(['worktree', 'list', '--porcelain'], fx.repo).includes('prunable'));
			assert.ok(branchExists(fx.repo, 'feature/clean') && branchExists(fx.repo, 'feature/gone'));
		});

		test('worktree list prints one line per worktree, with its state and what gsp clean would do', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			const wt = addWorktree('feature/wt');
			fs.appendFileSync(path.join(fx.repo, '.git', 'info', 'exclude'), '.env\n');
			fs.writeFileSync(path.join(wt, '.env'), 'TOKEN=1\n');
			const root = fs.realpathSync(fx.repo);
			const linked = fs.realpathSync(wt);

			const io = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'list', '--no-github'], io), EXIT.ok);
			const width = linked.length;
			assert.deepStrictEqual(io.out.join('').split('\n').filter(Boolean), [
				`${root.padEnd(width)}  main        [main]       keep    default branch`,
				`${linked}  feature/wt  [1 ignored]  skip    removing worktree ${linked} would delete 1 ignored file (.env), needs --force (already in origin/main) → move what you need out of ${linked}, then: gsp clean feature/wt --yes --force`,
			]);
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
			assert.deepStrictEqual(JSON.parse(after.out.join('')).worktrees.map((entry: { path: string }) => entry.path), [fs.realpathSync(fx.repo)]);
		});

		test('worktree prune reports when there is nothing to forget', async () => {
			const io = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'prune'], io), EXIT.ok);
			assert.deepStrictEqual(io.out, []);
			assert.ok(io.err.join('').includes('No worktree registrations to prune.'));
		});

		test('worktree prune --dry-run reports what would be forgotten without forgetting it', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			const wt = addWorktree('feature/wt');
			const linked = path.join(fs.realpathSync(fx.dir), 'feature-wt');
			fs.rmSync(wt, { recursive: true, force: true });

			const io = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'prune', '--dry-run'], io), EXIT.ok);
			assert.ok(io.out.join('').includes('Would prune 1 worktree registration(s):'));
			assert.ok(io.out.join('').includes(linked));

			const after = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'list', '--json'], after), EXIT.ok);
			assert.strictEqual(JSON.parse(after.out.join('')).worktrees.at(-1).prunable, true, 'the registration is still there');
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

		test('worktree remove refuses a dirty worktree without --force, even when status hides untracked files, and removes it with --force', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			const wt = addWorktree('feature/wt');
			fs.writeFileSync(path.join(wt, 'wip.txt'), 'work in progress\n');
			// Hidden from git status, but still lost with the worktree.
			git(['config', 'status.showUntrackedFiles', 'no'], fx.repo);

			const refused = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'remove', 'feature/wt'], refused), EXIT.failed);
			assert.ok(refused.err.join('').includes('modified or untracked'));
			assert.ok(fs.existsSync(wt));

			const forced = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'remove', 'feature/wt', '--force'], forced), EXIT.ok);
			assert.ok(!fs.existsSync(wt));
		});

		test('worktree remove cannot remove a locked worktree with a single --force, and removes it after unlocking', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			const wt = addWorktree('feature/wt');
			git(['worktree', 'lock', wt], fx.repo);

			// Git needs two --force flags for a locked worktree; gsp passes one.
			const locked = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'remove', 'feature/wt', '--force'], locked), EXIT.failed);
			assert.ok(locked.err.join('').includes('locked'));
			assert.ok(fs.existsSync(wt));

			git(['worktree', 'unlock', wt], fx.repo);
			const unlocked = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'remove', 'feature/wt'], unlocked), EXIT.ok);
			assert.ok(!fs.existsSync(wt));
		});

		test('worktree remove reads a relative path from the directory the command ran in', async () => {
			makeGoneBranch(fx.repo, 'feature/wt');
			const wt = path.join(fx.repo, 'nested', 'wt');
			git(['worktree', 'add', '-q', wt, 'feature/wt'], fx.repo);

			// From repo/nested, "wt" means repo/nested/wt, not repo/wt.
			const io = createFakeIo(path.join(fx.repo, 'nested'));
			assert.strictEqual(await runCli(['worktree', 'remove', 'wt'], io), EXIT.ok, io.err.join(''));
			assert.ok(!fs.existsSync(wt));
		});

		test('worktree remove refuses a target that names two different worktrees', async () => {
			git(['branch', 'other'], fx.repo);
			const byPath = path.join(fx.repo, 'feature', 'x');
			git(['worktree', 'add', '-q', byPath, 'other'], fx.repo);
			const byBranch = path.join(fx.dir, 'wt');
			git(['branch', 'feature/x'], fx.repo);
			git(['worktree', 'add', '-q', byBranch, 'feature/x'], fx.repo);

			const io = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'remove', 'feature/x'], io), EXIT.failed);
			assert.ok(io.err.join('').includes('is both the worktree'));
			assert.ok(fs.existsSync(byPath));
			assert.ok(fs.existsSync(byBranch));
		});

		test('an unknown worktree subcommand is a usage error', async () => {
			const io = createFakeIo(fx.repo);
			assert.strictEqual(await runCli(['worktree', 'frobnicate'], io), EXIT.usage);
			assert.ok(io.err.join('').includes('Unknown worktree subcommand: frobnicate'));
		});
	});
});
