import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyzeBranches, type AnalyzeOptions, type BranchAnalysis, type BranchAnalysisResult } from '../../core/branch-analysis';
import { runGitCommand } from '../../core/git-command';
import type { RunGh } from '../../core/github-signal';
import { commitFile, createRepoFixture, git, makeGoneBranch, type RepoFixture } from '../cli/git-fixture';

const GITHUB_URL = 'https://github.com/acme/widgets.git';

/** A pull request as `gh pr list` returns it; `baseRefName` defaults to main. */
type FakePullRequest = { number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefOid: string; baseRefName?: string };

/**
 * A `gh` stub: lists `pullRequests`, answers commit lookups from `commitPulls`
 * and compare calls from `compares` ("<base>...<head>" → status), records every call.
 */
function fakeGh(
	pullRequests: FakePullRequest[],
	commitPulls: Record<string, FakePullRequest[]> = {},
	compares: Record<string, string> = {}
): RunGh & { calls: string[][] } {
	const calls: string[][] = [];
	const run = async (args: readonly string[]) => {
		calls.push([...args]);
		if (args[0] === 'pr') {
			return { stdout: JSON.stringify(pullRequests.map((pr) => ({ baseRefName: 'main', ...pr }))), stderr: '' };
		}
		const compared = /compare\/([0-9a-f]+\.\.\.[0-9a-f]+)$/.exec(args.find((arg) => arg.includes('/compare/')) ?? '')?.[1];
		if (compared) {
			const status = compares[compared];
			if (!status) {
				throw Object.assign(new Error('HTTP 404'), { code: 1, stderr: 'Not Found' });
			}
			return { stdout: `${status}\n`, stderr: '' };
		}
		const sha = /commits\/([0-9a-f]+)\/pulls$/.exec(args.at(-1) ?? '')?.[1] ?? '';
		const found = commitPulls[sha];
		if (!found) {
			throw Object.assign(new Error('HTTP 422'), { code: 1, stderr: 'No commit found for SHA' });
		}
		const api = found.map((pr) => ({
			number: pr.number,
			state: pr.state === 'OPEN' ? 'open' : 'closed',
			merged_at: pr.state === 'MERGED' ? '2026-10-01T00:00:00Z' : null,
			head: { sha: pr.headRefOid },
			base: { ref: pr.baseRefName ?? 'main' },
		}));
		return { stdout: JSON.stringify(api), stderr: '' };
	};
	return Object.assign(run, { calls });
}

suite('branch analysis (real git)', function () {
	this.timeout(60000);
	let fx: RepoFixture;

	setup(() => {
		fx = createRepoFixture();
	});

	teardown(() => {
		fx.cleanup();
	});

	const runGit = (args: readonly string[]) => runGitCommand(args, fx.repo, { appendLine: () => undefined });

	const analyze = (options: AnalyzeOptions = {}, gh?: RunGh): Promise<BranchAnalysisResult> =>
		analyzeBranches({ git: runGit, gh }, { github: gh !== undefined, ...options });

	const byName = (result: BranchAnalysisResult): Record<string, BranchAnalysis> =>
		Object.fromEntries(result.branches.map((branch) => [branch.name, branch]));

	/** name → "verdict reason" for a compact assertion. */
	const verdicts = (result: BranchAnalysisResult): Record<string, string> =>
		Object.fromEntries(result.branches.map((branch) => [branch.name, `${branch.verdict} ${branch.reason}`]));

	const rev = (ref: string, cwd = fx.repo) => git(['rev-parse', ref], cwd).trim();

	/** Local-only branch from `from` with one commit per entry of `commits` ([file, content]), then back on main. */
	const makeBranch = (name: string, commits: Array<[string, string]>, from = 'main'): void => {
		git(['checkout', '-q', '-b', name, from], fx.repo);
		commits.forEach(([file, content], index) => commitFile(fx.repo, file, content, `${name} ${index}`));
		git(['checkout', '-q', 'main'], fx.repo);
	};

	const squashInto = (branch: string, message = `squash ${branch}`): string => {
		git(['merge', '-q', '--squash', branch], fx.repo);
		git(['commit', '-q', '-m', message], fx.repo);
		return rev('HEAD');
	};

	const pushMain = () => git(['push', '-q', 'origin', 'main'], fx.repo);

	/** Points origin at a GitHub URL that Git rewrites to the local bare remote. */
	const pretendGitHub = () => {
		git(['remote', 'set-url', 'origin', GITHUB_URL], fx.repo);
		git(['config', `url.${fx.remote}.insteadOf`, GITHUB_URL], fx.repo);
	};

	test('finds a multi-file squash merge after the default branch moved on, before and after it', async () => {
		makeBranch('feature/squashed', [
			['a.txt', 'a1\n'],
			['b.txt', 'b1\n'],
			['a.txt', 'a1\na2\n'],
		]);
		commitFile(fx.repo, 'other.txt', 'main moves\n', 'unrelated before');
		const squash = squashInto('feature/squashed');
		// Later work on the same files: the base tip no longer matches the branch.
		commitFile(fx.repo, 'a.txt', 'a1\na2\na3\n', 'later change');
		commitFile(fx.repo, 'other.txt', 'main moves again\n', 'unrelated after');
		pushMain();

		const branch = byName(await analyze())['feature/squashed'];
		assert.strictEqual(branch.verdict, 'dead');
		assert.strictEqual(branch.reason, 'squash-merged');
		assert.deepStrictEqual(branch.evidence, {
			method: 'file-state',
			base: 'refs/remotes/origin/main',
			squashCommit: squash,
			files: 2,
			patchIdCommits: 0,
		});
		assert.strictEqual(branch.unpushedCommits, 0);
	});

	test('a squash needs every file: a partial match stays alive', async () => {
		makeBranch('feature/partial', [
			['a.txt', 'a1\n'],
			['b.txt', 'b1\n'],
		]);
		// Only a.txt reaches main.
		commitFile(fx.repo, 'a.txt', 'a1\n', 'half of it');
		pushMain();

		const branch = byName(await analyze())['feature/partial'];
		assert.strictEqual(`${branch.verdict} ${branch.reason}`, 'alive unmerged-commits');
		assert.strictEqual(branch.unpushedCommits, 2);
	});

	test('a squash that reached the default branch through a merge commit', async () => {
		makeBranch('feature/via-release', [['a.txt', 'a1\n'], ['b.txt', 'b1\n']]);
		// The pull request is squashed into a release branch, which main later merges.
		makeBranch('release', []);
		git(['checkout', '-q', 'release'], fx.repo);
		const squash = squashInto('feature/via-release');
		git(['checkout', '-q', 'main'], fx.repo);
		commitFile(fx.repo, 'other.txt', 'main moves\n', 'unrelated');
		git(['merge', '-q', '--no-ff', '-m', 'merge release', 'release'], fx.repo);
		const merge = rev('HEAD');
		commitFile(fx.repo, 'b.txt', 'b1\nlater\n', 'later');
		pushMain();

		const branches = byName(await analyze());
		assert.strictEqual(branches['feature/via-release'].reason, 'squash-merged');
		// Seen on the base's own history: the merge commit, not the release commit behind it.
		assert.ok(branches['feature/via-release'].evidence?.method === 'file-state');
		assert.strictEqual(branches['feature/via-release'].evidence.squashCommit, merge);
		assert.notStrictEqual(merge, squash);
		assert.strictEqual(branches.release.reason, 'merged');
	});

	test('counts unpushed commits on the default branch itself', async () => {
		commitFile(fx.repo, 'local.txt', 'not pushed\n', 'local only');
		const main = byName(await analyze()).main;
		assert.strictEqual(`${main.verdict} ${main.reason}`, 'alive default-branch');
		assert.strictEqual(main.unpushedCommits, 1);
	});

	test('a squash on top of commits already rebase-merged from the branch it started from', async () => {
		// feature/next starts from release, whose commits later land on main by rebase.
		makeBranch('release', [['r.txt', 'r1\n']]);
		makeBranch('feature/next', [['n.txt', 'n1\n'], ['n.txt', 'n1\nn2\n']], 'release');
		commitFile(fx.repo, 'other.txt', 'main moves\n', 'unrelated');
		git(['cherry-pick', 'release'], fx.repo);
		commitFile(fx.repo, 'r.txt', 'r1\nmain edits it\n', 'main edits release work');
		// GitHub squashes only what the pull request adds on top of release.
		git(['checkout', 'feature/next', '--', 'n.txt'], fx.repo);
		git(['commit', '-q', '-m', 'squash feature/next'], fx.repo);
		const squash = rev('HEAD');
		pushMain();

		const branch = byName(await analyze())['feature/next'];
		assert.strictEqual(branch.reason, 'squash-merged');
		assert.deepStrictEqual(branch.evidence, {
			method: 'file-state',
			base: 'refs/remotes/origin/main',
			squashCommit: squash,
			files: 1,
			patchIdCommits: 1,
		});
	});

	test('rebase merges, merge commits, empty branches and real work', async () => {
		makeBranch('feature/rebased', [['r.txt', '1\n'], ['r.txt', '1\n2\n']]);
		commitFile(fx.repo, 'other.txt', 'moves main\n', 'unrelated');
		git(['cherry-pick', 'feature/rebased~1', 'feature/rebased'], fx.repo);

		makeBranch('feature/merged', [['m.txt', 'm\n']]);
		git(['merge', '-q', '--no-ff', '-m', 'merge', 'feature/merged'], fx.repo);
		// A leftover agent branch: created from main, never committed to, main moved on.
		git(['branch', 'agent/leftover', 'main'], fx.repo);
		commitFile(fx.repo, 'later.txt', 'later\n', 'later');
		makeBranch('feature/wip', [['wip.txt', 'todo\n']]);
		pushMain();
		git(['branch', 'agent/at-tip', 'origin/main'], fx.repo);

		const result = await analyze();
		assert.deepStrictEqual(verdicts(result), {
			'agent/at-tip': 'dead empty',
			'agent/leftover': 'dead empty',
			'feature/merged': 'dead merged',
			'feature/rebased': 'dead rebase-merged',
			'feature/wip': 'alive unmerged-commits',
			main: 'alive default-branch',
		});
		const branches = byName(result);
		assert.deepStrictEqual(branches['feature/rebased'].evidence, { method: 'patch-id', base: 'refs/remotes/origin/main', commits: 2 });
		assert.deepStrictEqual(branches['agent/leftover'].evidence, { method: 'ancestor', base: 'refs/remotes/origin/main' });
		assert.deepStrictEqual(branches['feature/wip'].evidence, { method: 'unique-commits', base: 'refs/remotes/origin/main', commits: 1 });
		assert.deepStrictEqual(branches.main.protected, { by: 'default-branch' });
		assert.strictEqual(branches['feature/wip'].unpushedCommits, 1);
	});

	test('no commit ahead: merged when a commit was made on the branch, empty when it never carried one', async () => {
		// Committed on, then fast-forwarded into main: finished work.
		makeBranch('feature/ff', [['ff.txt', 'ff\n']]);
		git(['merge', '-q', '--ff-only', 'feature/ff'], fx.repo);
		// Committed on, rebased onto a newer main, then fast-forwarded: the rebase replayed its own commit.
		makeBranch('feature/rebased-ff', [['rb.txt', 'rb\n']]);
		commitFile(fx.repo, 'moves.txt', 'moves\n', 'moves main');
		git(['rebase', '-q', 'main', 'feature/rebased-ff'], fx.repo);
		git(['checkout', '-q', 'main'], fx.repo);
		git(['merge', '-q', '--ff-only', 'feature/rebased-ff'], fx.repo);
		// An agent's worktree, created before its first commit.
		git(['worktree', 'add', '-q', '-b', 'agent/fresh', path.join(fx.dir, 'wt-fresh'), 'main'], fx.repo);
		// Created at an older main, then fast-forwarded and rebased onto main: still nothing of its own.
		git(['branch', 'agent/old', 'main~1'], fx.repo);
		git(['rebase', '-q', 'main', 'agent/old'], fx.repo);
		git(['checkout', '-q', 'main'], fx.repo);
		// A commit squash-merged, then the branch reset onto main to start over: what it holds now is new.
		makeBranch('agent/reused', [['reused.txt', 'v1\n']]);
		squashInto('agent/reused');
		git(['branch', '-f', 'agent/reused', 'main'], fx.repo);
		// A commit fast-forwarded into main, then the branch reset onto a newer main: its old commit is in the tip, but from a previous life.
		makeBranch('agent/restarted', [['restarted.txt', 'v1\n']]);
		git(['merge', '-q', '--ff-only', 'agent/restarted'], fx.repo);
		commitFile(fx.repo, 'after-restart.txt', 'x\n', 'main moves on');
		git(['branch', '-f', 'agent/restarted', 'main'], fx.repo);
		// Committed on, fast-forwarded into main, then fast-forwarded to a newer main: still finished work.
		makeBranch('feature/caught-up', [['caught-up.txt', 'x\n']]);
		git(['merge', '-q', '--ff-only', 'feature/caught-up'], fx.repo);
		commitFile(fx.repo, 'after-catch-up.txt', 'x\n', 'main moves on');
		git(['checkout', '-q', 'feature/caught-up'], fx.repo);
		git(['merge', '-q', '--ff-only', 'main'], fx.repo);
		git(['checkout', '-q', 'main'], fx.repo);
		// Committed on, rebased by `git pull --rebase`, then fast-forwarded into main.
		makeBranch('feature/pulled', [['pulled.txt', 'x\n']]);
		commitFile(fx.repo, 'before-pull.txt', 'x\n', 'main moves on');
		pushMain();
		git(['checkout', '-q', 'feature/pulled'], fx.repo);
		git(['pull', '-q', '--rebase', 'origin', 'main'], fx.repo);
		git(['checkout', '-q', 'main'], fx.repo);
		git(['merge', '-q', '--ff-only', 'feature/pulled'], fx.repo);
		// No reflog at all: nothing proves a commit was made on it.
		git(['-c', 'core.logAllRefUpdates=false', 'branch', 'agent/no-reflog', 'main'], fx.repo);
		pushMain();

		const result = await analyze();
		assert.deepStrictEqual(verdicts(result), {
			'agent/fresh': 'dead empty',
			'agent/no-reflog': 'dead empty',
			'agent/old': 'dead empty',
			'agent/restarted': 'dead empty',
			'agent/reused': 'dead empty',
			'feature/caught-up': 'dead merged',
			'feature/ff': 'dead merged',
			'feature/pulled': 'dead merged',
			'feature/rebased-ff': 'dead merged',
			main: 'alive default-branch',
		});
		assert.deepStrictEqual(byName(result)['feature/ff'].evidence, { method: 'ancestor', base: 'refs/remotes/origin/main' });
	});

	test('a branch whose patch is larger than 1 MB is still analysed', async () => {
		const large = Array.from({ length: 40000 }, (_, index) => `line ${index} of a generated file`).join('\n');
		makeBranch('feature/large', [['generated.txt', `${large}\n`]]);
		commitFile(fx.repo, 'other.txt', 'main moves\n', 'unrelated');
		git(['cherry-pick', 'feature/large'], fx.repo);
		pushMain();

		const branches = byName(await analyze());
		assert.strictEqual(`${branches['feature/large'].verdict} ${branches['feature/large'].reason}`, 'dead rebase-merged');
	});

	test('a patch that only matches the base ignoring whitespace is not rebase-merged', async () => {
		commitFile(fx.repo, 'a.js', 'a();\nc();\nb();\n', 'add a.js');
		makeBranch('feature/indent', [['a.js', 'a();\nif (x) {\n  c();\n}\nb();\n']]);
		makeBranch('feature/same', [['a.js', 'a();\nif (y) {\n    c();\n}\nb();\n']]);
		// main lands the same lines, indented with a tab, then the exact change of feature/same.
		commitFile(fx.repo, 'other.txt', 'main moves\n', 'unrelated');
		commitFile(fx.repo, 'a.js', 'a();\nif (x) {\n\tc();\n}\nb();\n', 'tab indented');
		git(['revert', '--no-edit', 'HEAD'], fx.repo);
		git(['cherry-pick', 'feature/same'], fx.repo);
		commitFile(fx.repo, 'a.js', 'a();\nif (y) {\n    c();\n}\nb();\nlater();\n', 'later');
		pushMain();
		// Git's own patch ids call it upstream.
		assert.match(git(['cherry', 'origin/main', 'feature/indent'], fx.repo), /^- /);

		const branches = byName(await analyze());
		assert.strictEqual(`${branches['feature/indent'].verdict} ${branches['feature/indent'].reason}`, 'alive unmerged-commits');
		assert.strictEqual(branches['feature/indent'].unpushedCommits, 1);
		assert.strictEqual(`${branches['feature/same'].verdict} ${branches['feature/same'].reason}`, 'dead rebase-merged');
	});

	/** Merges `branch` into the checked-out branch, adding `file` in the merge commit itself (an "evil merge"). */
	const evilMerge = (branch: string, file: string) => {
		git(['merge', '-q', '--no-ff', '--no-commit', branch], fx.repo);
		fs.writeFileSync(path.join(fx.repo, file), 'only in the merge\n');
		git(['add', file], fx.repo);
		git(['commit', '-q', '-m', `merge ${branch}`], fx.repo);
	};

	test('a merge commit adding work of its own keeps the branch alive', async () => {
		// Merges main in, resolving with extra work; its own commit is then cherry-picked onto main.
		makeBranch('feature/merges-main', [['e.txt', 'e\n']]);
		commitFile(fx.repo, 'other.txt', 'main moves\n', 'unrelated');
		git(['checkout', '-q', 'feature/merges-main'], fx.repo);
		evilMerge('main', 'resolution.txt');
		git(['checkout', '-q', 'main'], fx.repo);
		git(['cherry-pick', 'feature/merges-main^1'], fx.repo);

		// Integrates two branches, the second merge adding work; both branches land on main by cherry-pick.
		const integrate = (name: string, branches: string[]) => {
			makeBranch(name, []);
			git(['checkout', '-q', name], fx.repo);
			git(['merge', '-q', '--no-ff', '-m', `merge ${branches[0]}`, branches[0]], fx.repo);
			evilMerge(branches[1], `${name}-glue.txt`);
			git(['checkout', '-q', 'main'], fx.repo);
		};
		makeBranch('feature/a', [['a.txt', 'a\n']]);
		makeBranch('feature/b', [['b.txt', 'b\n']]);
		integrate('integration', ['feature/a', 'feature/b']);
		commitFile(fx.repo, 'other.txt', 'main moves again\n', 'unrelated again');
		git(['cherry-pick', 'feature/a', 'feature/b'], fx.repo);

		// The same with two-commit branches squashed separately, main editing in between.
		makeBranch('feature/c', [['c.txt', 'c1\n'], ['c.txt', 'c1\nc2\n']]);
		makeBranch('feature/d', [['d.txt', 'd1\n'], ['d.txt', 'd1\nd2\n']]);
		integrate('integration-squashed', ['feature/c', 'feature/d']);
		squashInto('feature/c');
		commitFile(fx.repo, 'c.txt', 'c1\nc2\nmain\n', 'main edits c');
		squashInto('feature/d');
		pushMain();

		const branches = byName(await analyze());
		for (const name of ['feature/merges-main', 'integration', 'integration-squashed']) {
			assert.strictEqual(`${branches[name].verdict} ${branches[name].reason}`, 'alive unmerged-commits', name);
			assert.ok(branches[name].unpushedCommits > 0, name);
		}
		// What they merged in is proven on its own.
		assert.strictEqual(branches['feature/a'].reason, 'rebase-merged');
		assert.strictEqual(branches['feature/d'].reason, 'squash-merged');
	});

	test('an integration branch whose two pull requests were squashed separately', async () => {
		makeBranch('feature/a', [['a.txt', 'a1\n'], ['a.txt', 'a1\na2\n']]);
		makeBranch('feature/b', [['b.txt', 'b1\n'], ['b.txt', 'b1\nb2\n']]);
		makeBranch('integration', []);
		git(['checkout', '-q', 'integration'], fx.repo);
		git(['merge', '-q', '--no-ff', '-m', 'merge a', 'feature/a'], fx.repo);
		git(['merge', '-q', '--no-ff', '-m', 'merge b', 'feature/b'], fx.repo);
		git(['checkout', '-q', 'main'], fx.repo);
		const squashA = squashInto('feature/a');
		// main edits a.txt before b lands: no single main commit matches the whole integration branch.
		commitFile(fx.repo, 'a.txt', 'a1\na2\nmain\n', 'main edits a');
		const squashB = squashInto('feature/b');
		pushMain();

		const branch = byName(await analyze()).integration;
		assert.strictEqual(`${branch.verdict} ${branch.reason}`, 'dead commits-merged');
		assert.ok(branch.evidence?.method === 'commits');
		assert.strictEqual(branch.evidence.commits, 4);
		assert.deepStrictEqual(
			branch.evidence.proofs.map((proof) => [proof.method, proof.squashCommit]).sort(),
			[
				['file-state', squashA],
				['file-state', squashA],
				['file-state', squashB],
				['file-state', squashB],
			].sort()
		);
		assert.strictEqual(branch.unpushedCommits, 0);
	});

	test('a linear integration branch: each commit proven on its own, or not at all', async () => {
		makeBranch('integration', [['a.txt', 'a\n'], ['b.txt', 'b\n']]);
		makeBranch('half', [['c.txt', 'c\n'], ['d.txt', 'd\n']]);
		git(['cherry-pick', 'integration~1'], fx.repo);
		commitFile(fx.repo, 'a.txt', 'a\nmain\n', 'main edits a');
		git(['cherry-pick', 'integration'], fx.repo);
		commitFile(fx.repo, 'c.txt', 'c\n', 'only c lands');
		pushMain();

		const result = await analyze();
		// The cherry-picks have the same patch ids: rebase-merged, the strongest proof.
		assert.strictEqual(byName(result).integration.reason, 'rebase-merged');
		assert.strictEqual(`${byName(result).half.verdict} ${byName(result).half.reason}`, 'alive unmerged-commits');
	});

	test('a gone upstream is not a proof: unpushed work is counted', async () => {
		// Pushed then deleted on the remote, never merged: its commits exist nowhere else now.
		makeBranch('feature/abandoned', [['x.txt', 'x\n']]);
		git(['checkout', '-q', 'feature/abandoned'], fx.repo);
		git(['push', '-q', '-u', 'origin', 'feature/abandoned'], fx.repo);
		commitFile(fx.repo, 'x.txt', 'x\nlocal only\n', 'never pushed');
		git(['checkout', '-q', 'main'], fx.repo);
		git(['push', '-q', 'origin', '--delete', 'feature/abandoned'], fx.repo);
		// Gone, but its tip is still on another remote branch.
		makeGoneBranch(fx.repo, 'feature/kept-elsewhere');
		git(['push', '-q', 'origin', 'feature/kept-elsewhere:refs/heads/copy'], fx.repo);
		git(['checkout', '-q', 'feature/kept-elsewhere'], fx.repo);
		commitFile(fx.repo, 'k.txt', 'k\n', 'k');
		git(['push', '-q', 'origin', 'HEAD:refs/heads/copy'], fx.repo);
		git(['checkout', '-q', 'main'], fx.repo);
		git(['fetch', '-q', '-p'], fx.repo);

		const branches = byName(await analyze());
		const abandoned = branches['feature/abandoned'];
		assert.strictEqual(`${abandoned.verdict} ${abandoned.reason}`, 'dead upstream-gone');
		assert.deepStrictEqual(abandoned.evidence, { method: 'upstream-gone', upstream: 'origin/feature/abandoned' });
		assert.strictEqual(abandoned.upstreamState, 'gone');
		assert.strictEqual(abandoned.unpushedCommits, 2);
		assert.strictEqual(branches['feature/kept-elsewhere'].reason, 'upstream-gone');
		assert.strictEqual(branches['feature/kept-elsewhere'].unpushedCommits, 0);
	});

	test('a branch tracking origin/main still goes through the merged proofs', async () => {
		makeBranch('feature/tracks-main', [['t.txt', 't\n'], ['t.txt', 't\nu\n']]);
		git(['branch', '-q', '--set-upstream-to=origin/main', 'feature/tracks-main'], fx.repo);
		squashInto('feature/tracks-main');
		pushMain();

		const branch = byName(await analyze())['feature/tracks-main'];
		assert.strictEqual(branch.upstream, 'origin/main');
		assert.strictEqual(branch.upstreamState, 'tracking');
		assert.strictEqual(branch.reason, 'squash-merged');
	});

	test('reports worktrees (dirty, locked), the current branch, protection and branches tracking another', async () => {
		makeBranch('feature/dirty', [['d.txt', 'd\n']]);
		makeBranch('feature/locked', [['l.txt', 'l\n']]);
		makeBranch('feature/keep', [['k.txt', 'k\n']]);
		makeBranch('release/1', [['r.txt', 'r\n']]);
		const dirty = path.join(fx.dir, 'wt-dirty');
		const locked = path.join(fx.dir, 'wt-locked');
		git(['worktree', 'add', '-q', dirty, 'feature/dirty'], fx.repo);
		git(['worktree', 'add', '-q', '--lock', locked, 'feature/locked'], fx.repo);
		fs.writeFileSync(path.join(dirty, 'untracked.txt'), 'work in progress\n');
		git(['config', 'branch.feature/keep.deleteMerged', 'false'], fx.repo);
		git(['config', '--add', 'git-sweep-pro.protected', 'release/*'], fx.repo);
		git(['branch', '-q', '--track', 'feature/stacked', 'feature/keep'], fx.repo);

		const branches = byName(await analyze({ protectedPatterns: ['hotfix/*'] }));
		const realpath = (p: string) => fs.realpathSync(p);
		const dirtyTree = branches['feature/dirty'].worktree;
		assert.ok(dirtyTree);
		assert.deepStrictEqual({ ...dirtyTree, path: realpath(dirtyTree.path) }, {
			path: realpath(dirty),
			isMain: false,
			dirty: true,
			locked: false,
			prunable: false,
			inProgress: null,
		});
		assert.strictEqual(branches['feature/locked'].worktree?.locked, true);
		assert.strictEqual(branches['feature/locked'].worktree?.dirty, false);
		assert.strictEqual(branches.main.current, true);
		assert.strictEqual(branches.main.worktree?.isMain, true);
		assert.strictEqual(branches['feature/dirty'].current, false);
		assert.deepStrictEqual(branches['feature/keep'].protected, { by: 'branch-config', key: 'branch.feature/keep.deleteMerged' });
		assert.deepStrictEqual(branches['release/1'].protected, { by: 'pattern', pattern: 'release/*' });
		assert.strictEqual(branches['feature/dirty'].protected, null);
		assert.deepStrictEqual(branches['feature/keep'].upstreamOf, ['feature/stacked']);
		assert.strictEqual(branches['feature/stacked'].upstream, 'feature/keep');
		assert.strictEqual(branches['feature/stacked'].upstreamState, 'tracking');
		assert.strictEqual(branches['feature/dirty'].upstreamState, 'none');
	});

	test('a branch being rebased or bisected in a worktree is attached to it, though HEAD is detached', async () => {
		makeBranch('feature/rebasing', [['conflict.txt', 'branch\n']]);
		makeBranch('feature/bisecting', [['b.txt', '1\n'], ['b.txt', '2\n'], ['b.txt', '3\n']]);
		commitFile(fx.repo, 'conflict.txt', 'main\n', 'conflicting');
		const rebasing = path.join(fx.dir, 'rebasing');
		const bisecting = path.join(fx.dir, 'bisecting');
		git(['worktree', 'add', '-q', rebasing, 'feature/rebasing'], fx.repo);
		git(['worktree', 'add', '-q', bisecting, 'feature/bisecting'], fx.repo);
		assert.throws(() => git(['rebase', 'main'], rebasing));
		git(['bisect', 'start', 'feature/bisecting', 'main'], bisecting);
		assert.match(git(['worktree', 'list', '--porcelain'], fx.repo), /detached\n[\s\S]*detached/);

		const branches = byName(await analyze());
		const realpath = (p: string) => fs.realpathSync(p);
		for (const [name, where, inProgress] of [
			['feature/rebasing', rebasing, 'rebase'],
			['feature/bisecting', bisecting, 'bisect'],
		]) {
			const worktree = branches[name].worktree;
			assert.ok(worktree, name);
			assert.strictEqual(realpath(worktree.path), realpath(where));
			assert.strictEqual(worktree.inProgress, inProgress);
		}
		assert.strictEqual(branches.main.worktree?.inProgress, null);
	});

	test('a repository without a remote compares with its local default branch', async () => {
		git(['remote', 'remove', 'origin'], fx.repo);
		makeBranch('feature/local', [['l.txt', 'l\n'], ['l.txt', 'l\nm\n']]);
		commitFile(fx.repo, 'other.txt', 'o\n', 'unrelated');
		squashInto('feature/local');

		const result = await analyze({}, fakeGh([]));
		assert.deepStrictEqual(
			{ ...result.checks.base, tip: undefined },
			{ name: 'main', ref: 'refs/heads/main', remote: null, tip: undefined, source: 'local-branch' }
		);
		assert.deepStrictEqual(result.checks.github, { used: false, reason: 'no-remote' });
		assert.strictEqual(result.checks.fetched, false);
		assert.deepStrictEqual(verdicts(result), { 'feature/local': 'dead squash-merged', main: 'alive default-branch' });
	});

	test('without origin/HEAD, falls back to a usual default branch name on the remote, then init.defaultBranch', async () => {
		git(['remote', 'set-head', 'origin', '--delete'], fx.repo);
		makeBranch('feature/x', [['x.txt', 'x\n']]);
		git(['merge', '-q', '--no-ff', '-m', 'merge', 'feature/x'], fx.repo);
		pushMain();

		const result = await analyze();
		assert.strictEqual(result.checks.base?.ref, 'refs/remotes/origin/main');
		assert.strictEqual(result.checks.base?.source, 'remote-branch');
		assert.strictEqual(byName(result)['feature/x'].reason, 'merged');

		git(['push', '-q', 'origin', 'main:trunk'], fx.repo);
		git(['config', 'init.defaultBranch', 'trunk'], fx.repo);
		assert.strictEqual((await analyze()).checks.base?.ref, 'refs/remotes/origin/trunk');
	});

	test('with no default branch at all, only a gone upstream makes a branch dead', async () => {
		git(['remote', 'remove', 'origin'], fx.repo);
		git(['branch', '-q', '-m', 'main', 'unusual'], fx.repo);
		git(['branch', 'feature/y'], fx.repo);

		const result = await analyze();
		assert.strictEqual(result.checks.base, null);
		assert.deepStrictEqual(verdicts(result), { 'feature/y': 'alive no-base', unusual: 'alive no-base' });
	});

	test('a local branch behind its merged pull request head, proven by GitHub', async () => {
		pretendGitHub();
		makeBranch('feature/review', [['f.txt', 'v1\n']]);
		const localTip = rev('feature/review');
		// Review fixes pushed from another clone to the pull request, then squashed into main.
		const other = path.join(fx.dir, 'other');
		git(['clone', '-q', fx.remote, other], fx.dir);
		git(['fetch', '-q', fx.repo, `feature/review:feature/review`], other);
		git(['checkout', '-q', 'feature/review'], other);
		commitFile(other, 'f.txt', 'v1\nreview fix\n', 'review fix');
		const prHead = rev('HEAD', other);
		git(['push', '-q', 'origin', 'HEAD:refs/pull/7/head'], other);
		git(['checkout', '-q', 'main'], other);
		git(['merge', '-q', '--squash', 'feature/review'], other);
		git(['commit', '-q', '-m', 'squash #7'], other);
		commitFile(other, 'f.txt', 'v1\nreview fix\nlater\n', 'later');
		git(['push', '-q', 'origin', 'main'], other);
		git(['fetch', '-q'], fx.repo);

		const pr = { number: 7, state: 'MERGED' as const, headRefOid: prHead };
		// The head commit is not here: GitHub lists the tip in the PR, but that alone proves nothing.
		const listedOnly = fakeGh([pr], { [localTip]: [pr] }, { [`${localTip}...${prHead}`]: 'diverged' });
		assert.strictEqual(byName(await analyze({}, listedOnly))['feature/review'].reason, 'unmerged-commits');
		const unreachable = fakeGh([pr], { [localTip]: [pr] });
		assert.strictEqual(byName(await analyze({}, unreachable))['feature/review'].reason, 'unmerged-commits');

		// The compare API confirms the final head contains the tip.
		const gh = fakeGh([pr], { [localTip]: [pr] }, { [`${localTip}...${prHead}`]: 'ahead' });
		const result = await analyze({}, gh);
		assert.deepStrictEqual(result.checks.github, { used: true, repo: 'acme/widgets', pullRequests: 1, apiCalls: 2 });
		const branch = byName(result)['feature/review'];
		assert.strictEqual(`${branch.verdict} ${branch.reason}`, 'dead pr-merged');
		assert.deepStrictEqual(branch.evidence, { method: 'pull-request', pullRequest: 7, state: 'merged', headSha: prHead, match: 'api' });
		assert.strictEqual(branch.unpushedCommits, 0);

		// Once the head commit is here, its ancestry is enough: no API call.
		git(['fetch', '-q', 'origin', 'refs/pull/7/head'], fx.repo);
		const local = fakeGh([pr]);
		const again = byName(await analyze({}, local))['feature/review'];
		assert.deepStrictEqual(again.evidence, { method: 'pull-request', pullRequest: 7, state: 'merged', headSha: prHead, match: 'ancestor' });
		assert.deepStrictEqual(local.calls.map((call) => call[0]), ['pr']);

		// Matched by SHA, never by name; without GitHub it stays alive.
		assert.strictEqual(byName(await analyze())['feature/review'].reason, 'unmerged-commits');
	});

	test('a pull request merged into another branch than the default one proves nothing on its own', async () => {
		pretendGitHub();
		makeBranch('feature/into-release', [['r.txt', 'r\n']]);
		makeBranch('feature/stacked', [['s.txt', 's\n'], ['s.txt', 's\ns\n']]);
		const tip = rev('feature/into-release');
		const stacked = { number: 5, state: 'MERGED' as const, headRefOid: rev('feature/stacked'), baseRefName: 'release' };
		const gh = fakeGh(
			[{ number: 4, state: 'MERGED', headRefOid: tip, baseRefName: 'release' }, stacked],
			{ [rev('feature/stacked~1')]: [stacked] },
			{ [`${rev('feature/stacked~1')}...${stacked.headRefOid}`]: 'ahead' }
		);
		const branches = byName(await analyze({}, gh));
		assert.strictEqual(`${branches['feature/into-release'].verdict} ${branches['feature/into-release'].reason}`, 'alive unmerged-commits');
		assert.strictEqual(`${branches['feature/stacked'].verdict} ${branches['feature/stacked'].reason}`, 'alive unmerged-commits');
	});

	test('a tip that is a merged pull request head, and one that is an open pull request head', async () => {
		pretendGitHub();
		makeBranch('feature/done', [['d.txt', 'd\n']]);
		makeBranch('feature/open', [['o.txt', 'o\n']]);
		const gh = fakeGh([
			{ number: 1, state: 'MERGED', headRefOid: rev('feature/done') },
			{ number: 2, state: 'OPEN', headRefOid: rev('feature/open') },
		]);
		const branches = byName(await analyze({}, gh));
		assert.deepStrictEqual(branches['feature/done'].evidence, {
			method: 'pull-request',
			pullRequest: 1,
			state: 'merged',
			headSha: rev('feature/done'),
			match: 'head',
		});
		assert.strictEqual(`${branches['feature/open'].verdict} ${branches['feature/open'].reason}`, 'alive open-pr');
	});

	test('records why GitHub was skipped', async () => {
		makeBranch('feature/z', [['z.txt', 'z\n']]);
		assert.deepStrictEqual((await analyze()).checks.github, { used: false, reason: 'disabled' });
		assert.deepStrictEqual((await analyze({}, fakeGh([]))).checks.github, { used: false, reason: 'not-github', detail: fx.remote });

		pretendGitHub();
		const failing = (error: object): RunGh => async () => {
			throw Object.assign(new Error('gh failed'), error);
		};
		const reasonFor = async (gh?: RunGh) => (await analyzeBranches({ git: runGit, gh }, {})).checks.github;
		assert.deepStrictEqual(await reasonFor(), { used: false, reason: 'gh-missing' });
		assert.deepStrictEqual(await reasonFor(failing({ code: 'ENOENT' })), { used: false, reason: 'gh-missing' });
		assert.deepStrictEqual(await reasonFor(failing({ code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' })), {
			used: false,
			reason: 'gh-unauthenticated',
			detail: 'To get started with GitHub CLI, please run:  gh auth login',
		});
		assert.deepStrictEqual(await reasonFor(failing({ code: 1, stderr: 'error connecting to api.github.com\n' })), {
			used: false,
			reason: 'offline',
			detail: 'error connecting to api.github.com',
		});
		assert.deepStrictEqual(await reasonFor(failing({ killed: true, signal: 'SIGTERM' })), { used: false, reason: 'timeout', detail: 'gh failed' });
		assert.deepStrictEqual(await reasonFor(failing({ code: 1, stderr: 'GraphQL: Could not resolve to a Repository\n' })), {
			used: false,
			reason: 'gh-failed',
			detail: 'GraphQL: Could not resolve to a Repository',
		});
	});

	test('a branch whose analysis fails stays alive without failing the others', async () => {
		makeBranch('feature/rebased', [['r.txt', 'r\n']]);
		makeBranch('feature/broken', [['b.txt', 'b\n']]);
		commitFile(fx.repo, 'other.txt', 'main moves\n', 'unrelated');
		git(['cherry-pick', 'feature/rebased', 'feature/broken'], fx.repo);
		pushMain();
		const broken = rev('feature/broken');
		const failing = (args: readonly string[]) =>
			args.includes('cherry') && args.includes(broken)
				? Promise.reject(Object.assign(new Error('Command failed: git cherry'), { code: 128, stderr: 'fatal: bad object\n' }))
				: runGit(args);

		const branches = byName(await analyzeBranches({ git: failing }, { github: false }));
		assert.strictEqual(`${branches['feature/broken'].verdict} ${branches['feature/broken'].reason}`, 'alive analysis-failed');
		assert.deepStrictEqual(branches['feature/broken'].evidence, { method: 'error', message: 'fatal: bad object' });
		assert.strictEqual(branches['feature/broken'].unpushedCommits, 1);
		assert.strictEqual(branches['feature/rebased'].reason, 'rebase-merged');
	});

	test('never fetches the objects a partial clone lacks: the branch stays alive instead', async function () {
		const [major, minor] = (/(\d+)\.(\d+)/.exec(git(['version'], fx.repo)) ?? []).slice(1).map(Number);
		if (major < 2 || (major === 2 && minor < 44)) {
			this.skip();
		}
		makeBranch('feature/x', [['x.txt', 'x\n']]);
		git(['push', '-q', 'origin', 'feature/x'], fx.repo);
		commitFile(fx.repo, 'other.txt', 'main moves\n', 'unrelated');
		git(['cherry-pick', 'feature/x'], fx.repo);
		pushMain();
		git(['config', 'uploadpack.allowFilter', 'true'], fx.remote);
		const partial = path.join(fx.dir, 'partial');
		git(['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${fx.remote}`, partial], fx.dir);
		git(['branch', '-q', 'feature/x', 'origin/feature/x'], partial);
		const objects = () => git(['count-objects', '-v'], partial);
		const before = objects();

		const result = await analyzeBranches({ git: (args) => runGitCommand(args, partial, { appendLine: () => undefined }) }, { github: false });
		const branch = byName(result)['feature/x'];
		assert.strictEqual(`${branch.verdict} ${branch.reason}`, 'alive analysis-failed');
		assert.strictEqual(objects(), before);
	});

	test('a branch with plain unmerged work costs a handful of git calls', async () => {
		const count = 8;
		for (let index = 0; index < count; index++) {
			makeBranch(`feature/${index}`, [[`${index}.txt`, '1\n'], [`${index}.txt`, '1\n2\n'], [`${index}.txt`, '1\n2\n3\n']]);
		}
		commitFile(fx.repo, 'other.txt', 'main moves\n', 'unrelated');
		pushMain();
		let calls = 0;
		const counting = (args: readonly string[]) => {
			calls++;
			return runGit(args);
		};
		const result = await analyzeBranches({ git: counting }, { github: false });
		assert.ok(result.branches.every((branch) => branch.name === 'main' || branch.reason === 'unmerged-commits'));
		// Merge base, cherry, squash diff and log, unpushed count; plus the shared reads.
		assert.ok(calls <= 5 * count + 10, `${calls} git calls`);
	});

	test('only classifies the requested branches, and accepts a base override', async () => {
		makeBranch('feature/one', [['1.txt', '1\n']]);
		makeBranch('feature/two', [['2.txt', '2\n']]);
		makeBranch('other', [['3.txt', '3\n']]);
		const result = await analyze({ branches: ['feature/*'], base: 'refs/heads/other' });
		assert.deepStrictEqual(
			result.branches.map((branch) => branch.name),
			['feature/one', 'feature/two']
		);
		assert.strictEqual(result.checks.base?.source, 'option');
		assert.strictEqual(result.checks.base?.name, 'other');
		assert.strictEqual((await analyze({ base: 'refs/heads/missing' })).checks.base, null);
	});

	test('analysis writes nothing: objects, refs, config and indexes are unchanged', async () => {
		pretendGitHub();
		makeBranch('feature/squashed', [['a.txt', 'a\n'], ['b.txt', 'b\n']]);
		commitFile(fx.repo, 'other.txt', 'o\n', 'unrelated');
		squashInto('feature/squashed');
		commitFile(fx.repo, 'a.txt', 'a\nlater\n', 'later');
		pushMain();
		makeBranch('feature/wip', [['w.txt', 'w\n'], ['w.txt', 'w\nw\n']]);
		makeGoneBranch(fx.repo, 'feature/gone');
		git(['fetch', '-q', '-p'], fx.repo);
		const worktree = path.join(fx.dir, 'wt');
		git(['worktree', 'add', '-q', worktree, 'feature/wip'], fx.repo);
		fs.writeFileSync(path.join(worktree, 'w.txt'), 'edited\n');
		// Make the indexes stale so that a plain `git status` would rewrite them.
		const later = new Date(Date.now() + 5000);
		fs.utimesSync(path.join(worktree, 'w.txt'), later, later);
		fs.utimesSync(path.join(fx.repo, 'README.md'), later, later);

		const indexes = [git(['rev-parse', '--git-path', 'index'], fx.repo), git(['rev-parse', '--git-path', 'index'], worktree)].map((index, i) =>
			path.resolve(i === 0 ? fx.repo : worktree, index.trim())
		);
		const snapshot = () => ({
			objects: git(['count-objects', '-v'], fx.repo),
			refs: git(['for-each-ref', '--format=%(refname) %(objectname) %(symref)'], fx.repo),
			head: fs.readFileSync(path.join(fx.repo, '.git', 'HEAD'), 'utf8'),
			config: fs.readFileSync(path.join(fx.repo, '.git', 'config'), 'utf8'),
			indexes: indexes.map((index) => fs.statSync(index).mtimeMs),
			gitDir: fs.readdirSync(path.join(fx.repo, '.git')).sort(),
		});
		const before = snapshot();
		const pr = { number: 3, state: 'MERGED' as const, headRefOid: rev('feature/wip') };
		await analyze({}, fakeGh([pr]));
		await analyze();
		assert.deepStrictEqual(snapshot(), before);
	});
});
