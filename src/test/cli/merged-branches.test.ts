import * as assert from 'assert';
import { runCli } from '../../cli/app';
import { EXIT, parseArgs, settingsToCliArgs } from '../../cli/args';
import { runGitCommand } from '../../core/git-command';
import { getDefaultBranch } from '../../core/default-branch';
import { describeMergedBranch, findMergedBranches } from '../../core/merged-branches';
import { GONE_REFS_ARGS, parseLocalBranchRefs } from '../../core/sweep-logic';
import { DEFAULT_SETTINGS } from '../fake-context';
import { branchExists, commitFile, createFakeIo, createRepoFixture, git, type RepoFixture } from './git-fixture';

suite('merged branch detection (real git)', function () {
	this.timeout(60000);
	let fx: RepoFixture;

	setup(() => {
		fx = createRepoFixture();
	});

	teardown(() => {
		fx.cleanup();
	});

	const detect = async () => {
		const runGit = (args: readonly string[]) => runGitCommand(args, fx.repo, { appendLine: () => undefined });
		git(['fetch', '-q'], fx.repo);
		const base = await getDefaultBranch(runGit);
		assert.ok(base, 'origin/HEAD is set by the fixture');
		const branches = parseLocalBranchRefs((await runGit(GONE_REFS_ARGS)).stdout).map((ref) => ref.name);
		const merged = await findMergedBranches(runGit, branches, base);
		return Object.fromEntries(merged.map((branch) => [branch.name, describeMergedBranch(branch)]));
	};

	/** Local-only branch with commits touching `file`, then back on main. */
	const makeLocalBranch = (name: string, file: string, commits: string[]): void => {
		git(['checkout', '-q', '-b', name, 'main'], fx.repo);
		commits.forEach((content, index) => commitFile(fx.repo, file, content, `${name} ${index}`));
		git(['checkout', '-q', 'main'], fx.repo);
	};

	const pushMain = () => git(['push', '-q', 'origin', 'main'], fx.repo);

	test('classifies merged, rebase-merged and squash-merged branches; leaves the rest', async () => {
		// Regular merge commit.
		makeLocalBranch('feature/merged', 'merged.txt', ['a\n']);
		git(['merge', '-q', '--no-ff', '-m', 'merge', 'feature/merged'], fx.repo);

		// Rebase merge: the same patches re-applied on main as new commits.
		makeLocalBranch('feature/rebased', 'rebased.txt', ['1\n', '1\n2\n']);
		commitFile(fx.repo, 'other.txt', 'moves main\n', 'unrelated');
		git(['cherry-pick', 'feature/rebased~1', 'feature/rebased'], fx.repo);

		// Squash merge: two commits land on main as one.
		makeLocalBranch('feature/squashed', 'squashed.txt', ['x\n', 'x\ny\n']);
		git(['merge', '-q', '--squash', 'feature/squashed'], fx.repo);
		git(['commit', '-q', '-m', 'squash feature/squashed'], fx.repo);

		// Real unmerged work, and a branch just created from main.
		makeLocalBranch('feature/wip', 'wip.txt', ['todo\n']);
		pushMain();
		git(['branch', 'feature/fresh', 'main'], fx.repo);

		assert.deepStrictEqual(await detect(), {
			'feature/merged': 'merged into origin/main',
			'feature/rebased': 'rebase-merged into origin/main',
			'feature/squashed': 'squash-merged into origin/main',
		});
	});

	test('work not pushed to the remote default branch does not count as merged', async () => {
		makeLocalBranch('feature/local-merge', 'x.txt', ['x\n']);
		git(['merge', '-q', '--no-ff', '-m', 'merge', 'feature/local-merge'], fx.repo);
		// main is not pushed: origin/main does not contain the work yet.
		assert.deepStrictEqual(await detect(), {});
	});

	test('branches whose upstream still exists are detected too', async () => {
		makeLocalBranch('feature/kept-remote', 'k.txt', ['k\n', 'k\nl\n']);
		git(['push', '-q', '-u', 'origin', 'feature/kept-remote'], fx.repo);
		git(['merge', '-q', '--squash', 'feature/kept-remote'], fx.repo);
		git(['commit', '-q', '-m', 'squash'], fx.repo);
		pushMain();

		assert.deepStrictEqual(await detect(), { 'feature/kept-remote': 'squash-merged into origin/main' });
	});

	test('clean --yes deletes a squash-merged branch, keeps unmerged work, and the deletion can be undone', async () => {
		makeLocalBranch('feature/squashed', 'squashed.txt', ['x\n', 'x\ny\n']);
		git(['merge', '-q', '--squash', 'feature/squashed'], fx.repo);
		git(['commit', '-q', '-m', 'squash'], fx.repo);
		pushMain();
		makeLocalBranch('feature/wip', 'wip.txt', ['todo\n']);

		const listed = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['list'], listed), EXIT.notApplied);
		assert.ok(listed.out.join('').includes('delete  feature/squashed  squash-merged into origin/main'));
		assert.ok(branchExists(fx.repo, 'feature/squashed'));

		assert.strictEqual(await runCli(['--yes'], createFakeIo(fx.repo)), EXIT.ok);
		assert.ok(!branchExists(fx.repo, 'feature/squashed'));
		assert.ok(branchExists(fx.repo, 'feature/wip'));

		assert.strictEqual(await runCli(['restore', 'feature/squashed'], createFakeIo(fx.repo)), EXIT.ok);
		assert.ok(branchExists(fx.repo, 'feature/squashed'), 'and it can be undone');
	});

	test('without origin/HEAD, the remote main branch is the base', async () => {
		git(['remote', 'set-head', 'origin', '--delete'], fx.repo);
		// The fetch before applying would recreate it from the server's HEAD.
		git(['config', 'remote.origin.followRemoteHEAD', 'never'], fx.repo);
		makeLocalBranch('feature/x', 'x.txt', ['x\n']);

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['--json', '--yes'], io), EXIT.ok);
		const report = JSON.parse(io.out.join(''));
		assert.deepStrictEqual([report.checks.base.ref, report.checks.base.source], ['refs/remotes/origin/main', 'remote-branch']);
		assert.ok(branchExists(fx.repo, 'feature/x'));
	});

	test('a local branch named like the remote default branch is not taken for it', async () => {
		makeLocalBranch('feature/x', 'x.txt', ['x\n']);
		git(['branch', 'origin/main', 'feature/x'], fx.repo);

		assert.deepStrictEqual(await detect(), {});
	});

	test('a branch with no net change is not taken for a squash merge', async () => {
		makeLocalBranch('feature/reverted', 'r.txt', ['r\n']);
		git(['checkout', '-q', 'feature/reverted'], fx.repo);
		git(['rm', '-q', 'r.txt'], fx.repo);
		git(['commit', '-q', '-m', 'revert'], fx.repo);
		git(['checkout', '-q', 'main'], fx.repo);
		git(['commit', '-q', '--allow-empty', '-m', 'empty'], fx.repo);
		pushMain();

		assert.deepStrictEqual(await detect(), {});
	});

	/** The remote switches its default branch to trunk, which holds main and feature/on-trunk; origin/HEAD still says main. */
	const moveRemoteHeadToTrunk = () => {
		git(['push', '-q', 'origin', 'main:trunk'], fx.repo);
		git(['symbolic-ref', 'HEAD', 'refs/heads/trunk'], fx.remote);
		makeLocalBranch('feature/on-trunk', 't.txt', ['t\n']);
		git(['push', '-q', 'origin', 'feature/on-trunk:trunk'], fx.repo);
	};

	test('the fetch leaves origin/HEAD alone unless remote.<name>.followRemoteHEAD says otherwise', async () => {
		moveRemoteHeadToTrunk();
		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['clean', '--yes', '--json'], io), EXIT.ok);
		const report = JSON.parse(io.out.join(''));
		assert.strictEqual(report.checks.base.ref, 'refs/remotes/origin/main');
		assert.ok(report.branches.every((branch: { result?: string }) => branch.result === undefined));
		assert.strictEqual(git(['symbolic-ref', 'refs/remotes/origin/HEAD'], fx.repo).trim(), 'refs/remotes/origin/main');
	});

	/** As above, for a user who follows the remote HEAD; main is not checked out, and it is all in origin/trunk. */
	const followRemoteHeadToTrunk = (context: Mocha.Context) => {
		const [major, minor] = (/(\d+)\.(\d+)/.exec(git(['version'], fx.repo)) ?? []).slice(1).map(Number);
		if (major < 2 || (major === 2 && minor < 48)) {
			context.skip();
		}
		moveRemoteHeadToTrunk();
		git(['config', 'remote.origin.followRemoteHEAD', 'always'], fx.repo);
		git(['checkout', '-q', '--detach'], fx.repo);
	};

	test('when the fetch moves the default branch, --yes deletes nothing, not even the old default branch (Git 2.48+)', async function () {
		followRemoteHeadToTrunk(this);
		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['clean', '--yes', '--json'], io), EXIT.notApplied);
		const report = JSON.parse(io.out.join(''));
		assert.strictEqual(report.checks.base.ref, 'refs/remotes/origin/trunk');
		const actions = Object.fromEntries(report.branches.map((branch: { name: string; action: string; reason: string }) => [branch.name, [branch.action, branch.reason]]));
		assert.deepStrictEqual(actions, { 'feature/on-trunk': ['skip', 'plan-changed'], main: ['skip', 'protected'] });
		assert.strictEqual(report.next, 'gsp clean --dry-run');
		assert.ok(branchExists(fx.repo, 'main') && branchExists(fx.repo, 'feature/on-trunk'));
		assert.ok(io.err.join('').includes('The default branch changed from origin/main to origin/trunk during the fetch, so nothing was deleted.'), io.err.join(''));
	});

	test('when the fetch moves the default branch, the summary says why nothing was deleted, and what to run (Git 2.48+)', async function () {
		followRemoteHeadToTrunk(this);
		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['clean', '--yes'], io), EXIT.notApplied);
		const out = io.out.join('');
		assert.ok(out.includes('Nothing deleted · 2 skipped (1 changed since the plan)\n'), out);
		assert.ok(out.includes('1 not deleted, as things changed while applying. Review them with: gsp clean --dry-run\n'), out);
	});

	test('with --yes, a squash merge only the fetch reveals is deleted in the same run', async () => {
		makeLocalBranch('feature/squashed', 's.txt', ['s\n', 's\nt\n']);
		// Someone else squash-merges it on the remote; the local remote-tracking refs don't know yet.
		const before = git(['rev-parse', 'origin/main'], fx.repo).trim();
		git(['checkout', '-q', '-b', 'elsewhere', 'main'], fx.repo);
		git(['merge', '-q', '--squash', 'feature/squashed'], fx.repo);
		git(['commit', '-q', '-m', 'squash feature/squashed'], fx.repo);
		git(['push', '-q', 'origin', 'elsewhere:main'], fx.repo);
		git(['checkout', '-q', 'main'], fx.repo);
		git(['branch', '-q', '-D', 'elsewhere'], fx.repo);
		git(['update-ref', 'refs/remotes/origin/main', before], fx.repo);

		const plan = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['clean', '--json', '--no-github'], plan), EXIT.ok);
		assert.strictEqual(JSON.parse(plan.out.join('')).branches.find((branch: { name: string }) => branch.name === 'feature/squashed').action, 'keep');

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['clean', '--yes', '--json', '--no-github'], io), EXIT.ok);
		const branch = JSON.parse(io.out.join('')).branches.find((entry: { name: string }) => entry.name === 'feature/squashed');
		assert.deepStrictEqual([branch.result, branch.reason], ['deleted', 'squash-merged']);
		assert.ok(!branchExists(fx.repo, 'feature/squashed'));
	});

	test('the plan skips protected and current branches, and keeps the default branch', async () => {
		makeLocalBranch('feature/done', 'd.txt', ['d\n']);
		makeLocalBranch('release/1', 'r.txt', ['r\n']);
		makeLocalBranch('feature/here', 'h.txt', ['h\n']);
		for (const branch of ['feature/done', 'release/1', 'feature/here']) {
			git(['merge', '-q', '--no-ff', '-m', `merge ${branch}`, branch], fx.repo);
		}
		pushMain();
		makeLocalBranch('feature/gone', 'g.txt', ['g\n']);
		git(['merge', '-q', '--no-ff', '-m', 'merge gone', 'feature/gone'], fx.repo);
		pushMain();
		git(['push', '-q', '-u', 'origin', 'feature/gone'], fx.repo);
		git(['push', '-q', 'origin', '--delete', 'feature/gone'], fx.repo);
		git(['checkout', '-q', 'feature/here'], fx.repo);

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['list', '--json', '-p', 'release/*'], io), EXIT.notApplied);
		const report = JSON.parse(io.out.join('')) as { branches: Array<{ name: string; action: string; reason: string; upstreamState: string }> };
		assert.deepStrictEqual(
			report.branches.map(({ name, action, reason, upstreamState }) => [name, action, reason, upstreamState]),
			[
				['feature/done', 'delete', 'merged', 'none'],
				['feature/gone', 'delete', 'merged', 'gone'],
				['feature/here', 'skip', 'current-branch', 'none'],
				['main', 'keep', 'default-branch', 'tracking'],
				['release/1', 'skip', 'protected', 'none'],
			]
		);
	});

	test('main, master, trunk and develop are protected by default; naming one exactly lifts it, not the proofs', async () => {
		for (const name of ['master', 'trunk', 'develop']) {
			git(['branch', name, 'main'], fx.repo);
		}
		makeLocalBranch('develop-x', 'x.txt', ['x\n']);
		git(['merge', '-q', '--no-ff', '-m', 'merge develop-x', 'develop-x'], fx.repo);
		pushMain();

		const plan = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['clean', '--json', '--no-github'], plan), EXIT.notApplied);
		const planned = JSON.parse(plan.out.join('')) as { branches: Array<{ name: string; action: string; reason: string; protected: unknown; hint: string | null }> };
		const byName = Object.fromEntries(planned.branches.map((branch) => [branch.name, [branch.action, branch.reason, branch.protected, branch.hint]]));
		assert.deepStrictEqual(byName, {
			'develop-x': ['delete', 'merged', null, 'gsp clean develop-x --yes'],
			develop: ['skip', 'protected', { by: 'default-name' }, 'gsp clean develop'],
			main: ['keep', 'default-branch', { by: 'default-branch' }, null],
			master: ['skip', 'protected', { by: 'default-name' }, 'gsp clean master'],
			trunk: ['skip', 'protected', { by: 'default-name' }, 'gsp clean trunk'],
		});

		const human = createFakeIo(fx.repo);
		await runCli(['clean', '--no-github', 'master'], human);
		assert.ok(human.out.join('').includes('delete  master'), human.out.join(''));

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['clean', 'master', '--yes', '--json', '--no-github'], io), EXIT.ok);
		assert.ok(!branchExists(fx.repo, 'master'));
		assert.ok(branchExists(fx.repo, 'trunk') && branchExists(fx.repo, 'develop') && branchExists(fx.repo, 'develop-x'));

		const listed = createFakeIo(fx.repo);
		await runCli(['clean', '--dry-run', '--no-github', 'trunk'], listed);
		assert.ok(listed.out.join('').includes('delete  trunk'), listed.out.join(''));
	});

	test('works on a detached HEAD, and plans merged branches checked out in a linked worktree', async () => {
		makeLocalBranch('feature/wt', 'w.txt', ['w\n']);
		git(['merge', '-q', '--no-ff', '-m', 'merge', 'feature/wt'], fx.repo);
		pushMain();
		const worktree = `${fx.dir}/wt`;
		git(['worktree', 'add', '-q', worktree, 'feature/wt'], fx.repo);
		git(['checkout', '-q', '--detach', 'main'], fx.repo);

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['list'], io), EXIT.notApplied);
		assert.match(io.out.join(''), /^delete {2}feature\/wt {2}merged into origin\/main, removes worktree .*\/wt$/m);
	});

	test('the merged setting is no longer passed to the CLI', () => {
		assert.strictEqual(parseArgs(['-m']).merged, true);
		assert.strictEqual(parseArgs([]).merged, false);
		assert.deepStrictEqual(settingsToCliArgs({ ...DEFAULT_SETTINGS, includeMergedBranches: true }), []);
	});
});
