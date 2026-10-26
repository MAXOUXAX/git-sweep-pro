import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyzeBranches, type AnalyzeOptions, type BranchAnalysis, type BranchAnalysisResult } from '../../core/branch-analysis';
import { runGitCommand } from '../../core/git-command';
import type { RunGh } from '../../core/github-signal';
import { commitFile, createRepoFixture, git, makeGoneBranch, type RepoFixture } from '../cli/git-fixture';

const GITHUB_URL = 'https://github.com/acme/widgets.git';

type FakePullRequest = { number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefOid: string };

/** A `gh` stub: lists `pullRequests`, answers commit lookups from `commitPulls`, records every call. */
function fakeGh(pullRequests: FakePullRequest[], commitPulls: Record<string, FakePullRequest[]> = {}): RunGh & { calls: string[][] } {
	const calls: string[][] = [];
	const run = async (args: readonly string[]) => {
		calls.push([...args]);
		if (args[0] === 'pr') {
			return { stdout: JSON.stringify(pullRequests), stderr: '' };
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
		assert.deepStrictEqual({ ...dirtyTree, path: realpath(dirtyTree.path) }, { path: realpath(dirty), isMain: false, dirty: true, locked: false, prunable: false });
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
		// The head commit is not here: only the API can tell.
		const gh = fakeGh([pr], { [localTip]: [pr] });
		const result = await analyze({}, gh);
		assert.deepStrictEqual(result.checks.github, { used: true, repo: 'acme/widgets', pullRequests: 1, apiCalls: 1 });
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
		assert.deepStrictEqual(await reasonFor(failing({ killed: true, signal: 'SIGTERM' })), { used: false, reason: 'offline', detail: 'gh failed' });
		assert.deepStrictEqual(await reasonFor(failing({ code: 1, stderr: 'GraphQL: Could not resolve to a Repository\n' })), {
			used: false,
			reason: 'gh-failed',
			detail: 'GraphQL: Could not resolve to a Repository',
		});
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
