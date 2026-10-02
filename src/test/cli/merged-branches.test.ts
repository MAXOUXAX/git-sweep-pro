import * as assert from 'assert';
import { runCli } from '../../cli/app';
import { EXIT, parseArgs, settingsToCliArgs } from '../../cli/args';
import { runGitCommand } from '../../core/git-command';
import { getDefaultBranch } from '../../core/default-branch';
import { describeMergedBranch, findMergedBranches } from '../../core/merged-branches';
import { DEFAULT_SWEEP_SETTINGS, GONE_REFS_ARGS, parseLocalBranchRefs } from '../../core/sweep-logic';
import { createFakePrompter } from './fake-prompter';
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
		const runGit = (args: string[]) => runGitCommand(args, fx.repo, { appendLine: () => undefined });
		git(['fetch', '-q'], fx.repo);
		const base = await getDefaultBranch(runGit);
		assert.ok(base, 'origin/HEAD is set by the fixture');
		const branches = parseLocalBranchRefs((await runGit([...GONE_REFS_ARGS])).stdout).map((ref) => ref.name);
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

	test('sweep --merged offers them unselected and force-deletes a squash-merged one after confirmation', async () => {
		makeLocalBranch('feature/squashed', 'squashed.txt', ['x\n', 'x\ny\n']);
		git(['merge', '-q', '--squash', 'feature/squashed'], fx.repo);
		git(['commit', '-q', '-m', 'squash'], fx.repo);
		pushMain();
		makeLocalBranch('feature/wip', 'wip.txt', ['todo\n']);

		// Without --merged nothing is offered.
		const plain = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['--yes'], plain), EXIT.ok);
		assert.ok(plain.out.join('').includes('No stale branches found.'));
		const listed = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['list', '--merged'], listed), EXIT.ok);
		assert.strictEqual(listed.out.join(''), 'feature/squashed (squash-merged into origin/main)\n');

		// --yes alone never selects merged branches.
		assert.strictEqual(await runCli(['--merged', '--yes'], createFakeIo(fx.repo)), EXIT.ok);
		assert.ok(branchExists(fx.repo, 'feature/squashed'));

		const { prompter, calls } = createFakePrompter({ multiselect: [0], confirm: true });
		const io = { ...createFakeIo(fx.repo, { interactive: true }), loadPrompter: async () => prompter };
		assert.strictEqual(await runCli(['--merged'], io), EXIT.ok);
		assert.ok(!branchExists(fx.repo, 'feature/squashed'), 'deleted after the force-delete confirmation');
		assert.ok(branchExists(fx.repo, 'feature/wip'));
		assert.ok(calls.some((call) => call.startsWith('confirm Force-delete 1')));

		assert.strictEqual(await runCli(['restore', 'feature/squashed'], createFakeIo(fx.repo)), EXIT.ok);
		assert.ok(branchExists(fx.repo, 'feature/squashed'), 'and it can be undone');
	});

	test('explains when there is no remote default branch', async () => {
		git(['remote', 'set-head', 'origin', '--delete'], fx.repo);
		makeLocalBranch('feature/x', 'x.txt', ['x\n']);

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['--merged', '--yes'], io), EXIT.ok);
		assert.ok(io.out.join('').includes('No stale branches found. Merged branches were not checked.'));
		assert.ok(
			io.err.join('').includes(
				'Merged branches were not checked: the default branch of "origin" is unknown. To set it, run: git remote set-head origin --auto'
			)
		);
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

	test('list skips protected, current and stale branches, and keeps the default branch out', async () => {
		makeLocalBranch('feature/done', 'd.txt', ['d\n']);
		makeLocalBranch('release/1', 'r.txt', ['r\n']);
		makeLocalBranch('feature/here', 'h.txt', ['h\n']);
		for (const branch of ['feature/done', 'release/1', 'feature/here']) {
			git(['merge', '-q', '--no-ff', '-m', `merge ${branch}`, branch], fx.repo);
		}
		pushMain();
		// Merged and gone: listed once, as a stale branch.
		makeLocalBranch('feature/gone', 'g.txt', ['g\n']);
		git(['merge', '-q', '--no-ff', '-m', 'merge gone', 'feature/gone'], fx.repo);
		pushMain();
		git(['push', '-q', '-u', 'origin', 'feature/gone'], fx.repo);
		git(['push', '-q', 'origin', '--delete', 'feature/gone'], fx.repo);
		git(['checkout', '-q', 'feature/here'], fx.repo);

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['list', '--merged', '--json', '-p', 'release/*'], io), EXIT.ok);
		const json = JSON.parse(io.out.join('')) as { stale: string[]; merged: { name: string }[] };
		assert.deepStrictEqual(json.stale, ['feature/gone']);
		assert.deepStrictEqual(json.merged, [{ name: 'feature/done', how: 'merged', into: 'origin/main' }]);
	});

	test('works on a detached HEAD, and offers merged branches checked out in a linked worktree', async () => {
		makeLocalBranch('feature/wt', 'w.txt', ['w\n']);
		git(['merge', '-q', '--no-ff', '-m', 'merge', 'feature/wt'], fx.repo);
		pushMain();
		const worktree = `${fx.dir}/wt`;
		git(['worktree', 'add', '-q', worktree, 'feature/wt'], fx.repo);
		git(['checkout', '-q', '--detach', 'main'], fx.repo);

		const io = createFakeIo(fx.repo);
		assert.strictEqual(await runCli(['list', '--merged'], io), EXIT.ok);
		assert.match(io.out.join(''), /^feature\/wt \(merged into origin\/main, worktree .*\/wt\)$/m);
	});

	test('flag and setting wiring', () => {
		assert.strictEqual(parseArgs(['-m']).merged, true);
		assert.strictEqual(parseArgs([]).merged, false);
		assert.strictEqual(parseArgs(['--merged']).merged, true);
		assert.deepStrictEqual(settingsToCliArgs({ ...DEFAULT_SWEEP_SETTINGS, includeMergedBranches: true }), ['--merged']);
		assert.deepStrictEqual(settingsToCliArgs(DEFAULT_SWEEP_SETTINGS), []);
	});
});
