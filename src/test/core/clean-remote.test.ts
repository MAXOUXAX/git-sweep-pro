import * as assert from 'assert';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { formatRemoteLines, formatSummary, type CleanRemoteBranch } from '../../core/clean-plan';
import { holdRemoteToFetch, PushUrlMismatchError, runCleanWorkflow, UnknownRemoteError, type CleanOptions } from '../../core/clean-workflow';
import type { RunSsh } from '../../core/forge';
import type { RunGh } from '../../core/github-signal';
import { runRestoreWorkflow } from '../../core/restore-workflow';
import { commitFile, createRepoFixture, git, type RepoFixture } from '../cli/git-fixture';
import { createFakeContext, type FakeContextOptions, type GitEntry } from '../fake-context';

const APPLY: CleanOptions = {
	patterns: [],
	dryRun: false,
	yes: true,
	force: false,
	discardChanges: false,
	fetch: true,
	github: false,
	protectedPatterns: [],
	canPrompt: false,
	confirm: false,
	remote: '',
};

const PLAN: CleanOptions = { ...APPLY, yes: false };

const GITHUB_URL = 'https://github.com/acme/widgets.git';

function realGit(cwd: string): (args: readonly string[]) => GitEntry {
	return (args) => {
		try {
			return { stdout: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }) };
		} catch (error) {
			const failure = error as Error & { stderr?: string };
			return Object.assign(new Error(failure.message), { stderr: failure.stderr });
		}
	};
}

type FakePullRequest = {
	number: number;
	state: 'OPEN' | 'MERGED';
	headRefOid: string;
	baseRefName?: string;
	headRefName?: string;
	/** Owner of the head repository; acme (the repository's own) by default. */
	headOwner?: string;
	/** The repository it is on; acme/widgets by default. */
	repo?: string;
};

type FakeRepo = {
	/** What GitHub names the repository today; acme/widgets by default. */
	canonical?: string;
	/** The repository it is a fork of. */
	parent?: string;
	/** The root of its fork network; the parent by default. */
	source?: string;
	/** Hosts `gh auth status` reports as logged in. */
	loggedIn?: string[];
};

/**
 * A `gh` stub for acme/widgets (a fork of `parent`, when given) listing
 * `pullRequests` (base main) on the repository asked; every other call
 * fails, as for an unknown commit.
 */
function fakeGh(pullRequests: FakePullRequest[], { canonical = 'acme/widgets', parent, source = parent, loggedIn = [] }: FakeRepo = {}): RunGh {
	const named = (repo: string | undefined) => (repo ? { owner: repo.split('/')[0], name: repo.split('/')[1] } : null);
	return async (args) => {
		// "host/owner/name" on a GitHub Enterprise server.
		const repo = args[args.indexOf('--repo') + 1]?.split('/').slice(-2).join('/');
		if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+$/.test(args[3])) {
			return { stdout: JSON.stringify({ ...named(canonical), parent: named(parent), source: named(source) }), stderr: '' };
		}
		if (args[0] === 'auth') {
			const host = args[args.indexOf('--hostname') + 1];
			return { stdout: JSON.stringify({ hosts: loggedIn.includes(host) ? { [host]: [{ state: 'success', host }] } : {} }), stderr: '' };
		}
		if (args[0] === 'pr') {
			const open = args[args.indexOf('--state') + 1] === 'open';
			const listed = pullRequests
				.filter((pr) => (pr.repo ?? 'acme/widgets') === repo && (!open || pr.state === 'OPEN'))
				.map(({ headOwner = 'acme', repo: _repo, ...pr }) => ({ baseRefName: 'main', headRefName: '', headRepositoryOwner: { login: headOwner }, ...pr }));
			return { stdout: JSON.stringify(listed), stderr: '' };
		}
		throw Object.assign(new Error('HTTP 422'), { code: 1, stderr: 'No commit found for SHA' });
	};
}

type Entry = Pick<CleanRemoteBranch, 'name' | 'action' | 'reason' | 'hint'>;

/** name → [action, reason, hint] */
const actions = (branches: readonly Entry[] = []) => Object.fromEntries(branches.map((branch) => [branch.name, [branch.action, branch.reason, branch.hint]]));

suite('clean --remote (real git)', function () {
	this.timeout(60000);
	let fx: RepoFixture;

	setup(() => {
		fx = createRepoFixture();
	});

	teardown(() => {
		fx.cleanup();
	});

	const contextFor = (options: FakeContextOptions = {}) => createFakeContext({ root: fx.repo, gitFallback: realGit(fx.repo), ...options });
	const remoteHeads = () => git(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'], fx.remote);
	const remoteHas = (name: string) => git(['branch', '--list', name], fx.remote).trim().length > 0;

	/** Pushes a branch of `commits` on `file` from main, then deletes it locally (unless `keep`). */
	const pushBranch = (name: string, file: string, commits: string[], { keep = false, track = false } = {}) => {
		git(['checkout', '-q', '-b', name, 'main'], fx.repo);
		commits.forEach((content, index) => commitFile(fx.repo, file, content, `${name} ${index}`));
		git(['push', '-q', ...(track ? ['-u'] : []), 'origin', name], fx.repo);
		git(['checkout', '-q', 'main'], fx.repo);
		if (!keep) {
			git(['branch', '-q', '-D', name], fx.repo);
		}
	};

	const squashIntoMain = (name: string) => {
		git(['merge', '-q', '--squash', `origin/${name}`], fx.repo);
		git(['commit', '-q', '-m', `squash ${name}`], fx.repo);
		git(['push', '-q', 'origin', 'main'], fx.repo);
	};

	test('a squash-merged branch on the remote is deleted with a lease, then restored by gsp restore', async () => {
		pushBranch('feature/sq', 's.txt', ['s\n', 's\nt\n']);
		squashIntoMain('feature/sq');
		pushBranch('feature/wip', 'w.txt', ['w\n']);
		const tip = git(['rev-parse', 'origin/feature/sq'], fx.repo).trim();

		const fake = contextFor();
		const { report, outcome } = await runCleanWorkflow(fake.context, APPLY);
		assert.strictEqual(outcome, 'done');
		assert.deepStrictEqual(actions(report.remoteBranches), {
			'feature/sq': ['delete', 'squash-merged', null],
			'feature/wip': ['keep', 'unmerged-commits', null],
			main: ['keep', 'default-branch', null],
		});
		assert.strictEqual(report.remoteBranches?.find((branch) => branch.name === 'feature/sq')?.result, 'deleted');
		assert.ok(fake.commands.includes(`push --force-with-lease=refs/heads/feature/sq:${tip} origin :refs/heads/feature/sq`), fake.commands.join('\n'));
		assert.ok(!remoteHas('feature/sq') && remoteHas('feature/wip'));
		assert.strictEqual(report.restore, 'gsp restore origin/feature/sq');
		assert.deepStrictEqual(report.summary.remote, { remote: 'origin', delete: 1, deleted: 1, failed: 0, skipped: 0, kept: 2 });
		assert.strictEqual(formatSummary(report), 'on origin: 1 deleted · restore with gsp restore origin/feature/sq');
		assert.deepStrictEqual(formatRemoteLines(report), [
			'On origin:',
			'deleted feature/sq   squash-merged into origin/main',
			'keep    feature/wip  1 commit not merged into origin/main',
			'keep    main         default branch',
		]);

		const restore = contextFor({ deletionLog: fake.context.deletionLog });
		assert.strictEqual(await runRestoreWorkflow(restore.context, ['origin/feature/sq']), 'ok');
		assert.ok(remoteHeads().includes(`feature/sq ${tip}`));
		assert.deepStrictEqual(fake.context.deletionLog.list(), []);
		// Pushed back once: a second restore finds nothing to restore.
		assert.strictEqual(await runRestoreWorkflow(restore.context, ['origin/feature/sq']), 'failed');
	});

	test('restoring never overwrites a branch created on the remote since', async () => {
		pushBranch('feature/sq', 's.txt', ['s\n']);
		squashIntoMain('feature/sq');
		const fake = contextFor();
		await runCleanWorkflow(fake.context, APPLY);
		// Someone pushes another branch under the same name, which this repository has not fetched.
		pushBranch('other', 'o.txt', ['o\n']);
		git(['push', '-q', 'origin', 'origin/other:refs/heads/feature/sq'], fx.repo);
		const other = git(['rev-parse', 'origin/other'], fx.repo).trim();
		git(['update-ref', '-d', 'refs/remotes/origin/feature/sq'], fx.repo);

		const restore = contextFor({ deletionLog: fake.context.deletionLog });
		assert.strictEqual(await runRestoreWorkflow(restore.context, ['origin/feature/sq']), 'failed');
		assert.deepStrictEqual(restore.errorMessages, [
			'Restored 0 of 1 branch(es). Could not restore origin/feature/sq (remote) (a branch named feature/sq exists on origin again; it was not overwritten).',
		]);
		assert.ok(remoteHeads().includes(`feature/sq ${other}`));
		assert.strictEqual(fake.context.deletionLog.list().length, 1, 'still recorded');
	});

	test('the plan reads the remote with ls-remote and changes nothing, here or there', async () => {
		pushBranch('feature/sq', 's.txt', ['s\n']);
		squashIntoMain('feature/sq');
		const before = [remoteHeads(), git(['for-each-ref'], fx.repo)];

		const fake = contextFor();
		const { report, outcome } = await runCleanWorkflow(fake.context, PLAN);
		assert.strictEqual(outcome, 'not-applied');
		assert.strictEqual(report.mode, 'plan');
		assert.deepStrictEqual(actions(report.remoteBranches)['feature/sq'], ['delete', 'rebase-merged', 'gsp clean origin/feature/sq --remote --yes']);
		assert.deepStrictEqual([remoteHeads(), git(['for-each-ref'], fx.repo)], before);
		assert.ok(fake.commands.includes('ls-remote --symref origin HEAD refs/heads/*'));
		assert.ok(!fake.commands.some((command) => /^(push|fetch) /.test(command)), fake.commands.join('\n'));
		assert.strictEqual(formatSummary(report), 'on origin: 1 to delete');
	});

	test('a branch pushed to since the plan is not proven: the plan sees its new tip', async () => {
		pushBranch('feature/sq', 's.txt', ['s\n']);
		squashIntoMain('feature/sq');
		// Pushed from elsewhere: ls-remote sees a tip this repository does not have.
		const clone = path.join(fx.dir, 'clone');
		git(['clone', '-q', fx.remote, clone], fx.dir);
		git(['checkout', '-q', 'feature/sq'], clone);
		commitFile(clone, 'more.txt', 'more\n', 'more work');
		git(['push', '-q', 'origin', 'feature/sq'], clone);

		const { report } = await runCleanWorkflow(contextFor().context, PLAN);
		const [entry] = (report.remoteBranches ?? []).filter((branch) => branch.name === 'feature/sq');
		assert.deepStrictEqual([entry.action, entry.reason], ['keep', 'analysis-failed']);
		assert.match(entry.evidence?.method === 'error' ? entry.evidence.message : '', /is not in this repository yet: fetch origin first/);
	});

	test('a remote branch that moves between the analysis and the push is not deleted', async () => {
		pushBranch('feature/sq', 's.txt', ['s\n']);
		squashIntoMain('feature/sq');
		const clone = path.join(fx.dir, 'clone');
		git(['clone', '-q', fx.remote, clone], fx.dir);
		git(['checkout', '-q', 'feature/sq'], clone);
		commitFile(clone, 'more.txt', 'more\n', 'more work');

		// Someone pushes right before gsp deletes it.
		const fake = contextFor({
			onGit: (command) => {
				if (command.startsWith('push --force-with-lease')) {
					git(['push', '-q', 'origin', 'feature/sq'], clone);
				}
			},
		});
		const { report, outcome } = await runCleanWorkflow(fake.context, APPLY);
		assert.deepStrictEqual(actions(report.remoteBranches)['feature/sq'], ['skip', 'plan-changed', 'gsp clean origin/feature/sq --no-github --remote --dry-run']);
		assert.strictEqual(outcome, 'not-applied');
		assert.ok(remoteHeads().includes(`feature/sq ${git(['rev-parse', 'HEAD'], clone).trim()}`));
		assert.strictEqual(report.restore, null);
	});

	test('a remote branch whose merge commit adds work of its own is kept, with no local branch holding a merge', async () => {
		// Merges main in, resolving with extra work; its own commit is then cherry-picked onto main.
		git(['checkout', '-q', '-b', 'feature/evil', 'main'], fx.repo);
		commitFile(fx.repo, 'e.txt', 'e\n', 'e');
		git(['checkout', '-q', 'main'], fx.repo);
		commitFile(fx.repo, 'other.txt', 'main moves\n', 'unrelated');
		git(['checkout', '-q', 'feature/evil'], fx.repo);
		git(['merge', '-q', '--no-ff', '--no-commit', 'main'], fx.repo);
		commitFile(fx.repo, 'resolution.txt', 'only in the merge\n', 'merge main');
		git(['push', '-q', 'origin', 'feature/evil'], fx.repo);
		git(['checkout', '-q', 'main'], fx.repo);
		git(['cherry-pick', 'feature/evil^1'], fx.repo);
		git(['push', '-q', 'origin', 'main'], fx.repo);
		git(['branch', '-q', '-D', 'feature/evil'], fx.repo);

		const { report } = await runCleanWorkflow(contextFor().context, APPLY);
		assert.deepStrictEqual(actions(report.remoteBranches)['feature/evil'], ['keep', 'unmerged-commits', null]);
		assert.ok(remoteHas('feature/evil'));
	});

	test('--expect <remote>/<name> selects the branch on the remote, never a local branch of that name', async () => {
		pushBranch('feature/sq', 's.txt', ['s\n']);
		squashIntoMain('feature/sq');
		// A dead local branch literally named "origin/feature/sq".
		git(['branch', 'origin/feature/sq', 'main'], fx.repo);
		const tip = git(['rev-parse', 'refs/remotes/origin/feature/sq'], fx.repo).trim();

		const { report } = await runCleanWorkflow(contextFor().context, {
			...APPLY,
			patterns: ['origin/feature/sq'],
			expect: new Map([['origin/feature/sq', tip]]),
		});
		assert.deepStrictEqual(actions(report.remoteBranches)['feature/sq'], ['delete', 'rebase-merged', null]);
		assert.deepStrictEqual(report.branches, []);
		assert.ok(git(['branch', '--list', 'origin/feature/sq'], fx.repo).trim().length > 0);
	});

	test('the head of an open pull request is kept, even when its content is on the default branch', async () => {
		git(['remote', 'set-url', 'origin', GITHUB_URL], fx.repo);
		git(['config', `url.${fx.remote}.insteadOf`, GITHUB_URL], fx.repo);
		pushBranch('feature/sq', 's.txt', ['s\n']);
		pushBranch('feature/pr', 'p.txt', ['p\n']);
		squashIntoMain('feature/sq');
		squashIntoMain('feature/pr');
		const head = git(['rev-parse', 'origin/feature/pr'], fx.repo).trim();

		const fake = contextFor();
		const { report } = await runCleanWorkflow(
			{ ...fake.context, gh: fakeGh([{ number: 7, state: 'OPEN', headRefOid: head }]) },
			{ ...APPLY, github: true }
		);
		assert.deepStrictEqual(actions(report.remoteBranches), {
			'feature/pr': ['keep', 'open-pr', null],
			'feature/sq': ['delete', 'rebase-merged', null],
			main: ['keep', 'default-branch', null],
		});
		assert.ok(remoteHas('feature/pr') && !remoteHas('feature/sq'));
	});

	test('the head of a merged pull request goes, matched by SHA', async () => {
		git(['remote', 'set-url', 'origin', GITHUB_URL], fx.repo);
		git(['config', `url.${fx.remote}.insteadOf`, GITHUB_URL], fx.repo);
		// Merged on GitHub with changes the branch never had: no local proof.
		pushBranch('feature/pr', 'p.txt', ['p\n']);
		commitFile(fx.repo, 'p.txt', 'p, reviewed\n', 'merge #8');
		git(['push', '-q', 'origin', 'main'], fx.repo);
		const head = git(['rev-parse', 'origin/feature/pr'], fx.repo).trim();

		const fake = contextFor();
		const { report } = await runCleanWorkflow({ ...fake.context, gh: fakeGh([{ number: 8, state: 'MERGED', headRefOid: head }]) }, { ...APPLY, github: true });
		assert.deepStrictEqual(actions(report.remoteBranches)['feature/pr'], ['delete', 'pr-merged', null]);
		assert.ok(!remoteHas('feature/pr'));
	});

	test('a remote branch a kept local branch tracks stays; it goes with the local one when that one goes', async () => {
		pushBranch('feature/kept', 'k.txt', ['k\n'], { keep: true, track: true });
		pushBranch('feature/both', 'b.txt', ['b\n'], { keep: true, track: true });
		git(['merge', '-q', '--no-ff', '-m', 'merge', 'feature/kept', 'feature/both'], fx.repo);
		git(['push', '-q', 'origin', 'main'], fx.repo);
		// More work on feature/kept, not pushed yet: the local branch is kept.
		git(['checkout', '-q', 'feature/kept'], fx.repo);
		commitFile(fx.repo, 'k.txt', 'k2\n', 'more');
		git(['checkout', '-q', 'main'], fx.repo);

		const plan = await runCleanWorkflow(contextFor().context, PLAN);
		assert.deepStrictEqual(actions(plan.report.remoteBranches), {
			'feature/both': ['delete', 'merged', 'gsp clean origin/feature/both --remote --yes'],
			'feature/kept': ['skip', 'tracked-by-kept-branch', 'git branch --unset-upstream feature/kept'],
			main: ['keep', 'default-branch', null],
		});
		assert.deepStrictEqual(formatRemoteLines(plan.report)[2], 'skip    feature/kept  tracked by feature/kept, which is kept (merged into origin/main) → git branch --unset-upstream feature/kept');

		const { report, outcome } = await runCleanWorkflow(contextFor().context, APPLY);
		assert.strictEqual(outcome, 'done');
		assert.ok(!remoteHas('feature/both') && remoteHas('feature/kept'));
		assert.strictEqual(report.restore, 'gsp restore feature/both origin/feature/both');
	});

	test('a local branch whose deletion fails keeps its upstream on the remote', async () => {
		pushBranch('feature/both', 'b.txt', ['b\n'], { keep: true, track: true });
		git(['merge', '-q', '--no-ff', '-m', 'merge', 'feature/both'], fx.repo);
		git(['push', '-q', 'origin', 'main'], fx.repo);
		const fake = contextFor({
			git: { 'branch -d feature/both': Object.assign(new Error('boom'), { stderr: 'error: could not lock config file' }) },
		});
		const { report, outcome } = await runCleanWorkflow(fake.context, APPLY);
		assert.strictEqual(outcome, 'failed');
		assert.deepStrictEqual(actions(report.remoteBranches)['feature/both'], ['skip', 'tracked-by-kept-branch', 'git branch --unset-upstream feature/both']);
		assert.ok(remoteHas('feature/both'));
	});

	test('long-lived names are protected on the remote too, and naming one lifts it; patterns apply to remote names', async () => {
		git(['push', '-q', 'origin', 'main:develop', 'main:release/1'], fx.repo);
		pushBranch('feature/a', 'a.txt', ['a\n']);
		pushBranch('fix/b', 'b.txt', ['b\n']);
		squashIntoMain('feature/a');
		squashIntoMain('fix/b');

		const plan = await runCleanWorkflow(contextFor().context, { ...PLAN, protectedPatterns: ['release/*'] });
		assert.deepStrictEqual(actions(plan.report.remoteBranches), {
			develop: ['skip', 'protected', 'gsp clean origin/develop --remote'],
			'feature/a': ['delete', 'rebase-merged', 'gsp clean origin/feature/a --remote --yes'],
			'fix/b': ['delete', 'rebase-merged', 'gsp clean origin/fix/b --remote --yes'],
			main: ['keep', 'default-branch', null],
			'release/1': ['skip', 'protected', null],
		});

		// The bare name lifts the protection of a local branch only: the remote one needs origin/develop.
		git(['branch', 'develop', 'main'], fx.repo);
		const local = await runCleanWorkflow(contextFor().context, { ...APPLY, patterns: ['feature/*', 'develop'] });
		assert.deepStrictEqual(actions(local.report.remoteBranches), {
			develop: ['skip', 'protected', 'gsp clean origin/develop --remote'],
			'feature/a': ['delete', 'rebase-merged', null],
		});
		assert.strictEqual(local.report.branches.find((branch) => branch.name === 'develop')?.result, 'deleted');
		assert.ok(remoteHas('develop') && !remoteHas('feature/a'));

		const qualified = await runCleanWorkflow(contextFor().context, { ...APPLY, patterns: ['origin/develop'] });
		assert.deepStrictEqual(actions(qualified.report.remoteBranches), { develop: ['delete', 'empty', null] });
		assert.ok(!remoteHas('develop') && remoteHas('fix/b') && remoteHas('release/1'));
		assert.strictEqual(qualified.report.restore, 'gsp restore origin/develop');
	});

	test('a named branch must exist locally or on the remote; --remote names an existing remote', async () => {
		pushBranch('feature/a', 'a.txt', ['a\n']);
		await assert.rejects(runCleanWorkflow(contextFor().context, { ...PLAN, patterns: ['feature/nope'] }), /No branch named "feature\/nope"/);
		await assert.doesNotReject(runCleanWorkflow(contextFor().context, { ...PLAN, patterns: ['feature/a'] }));
		await assert.rejects(runCleanWorkflow(contextFor().context, { ...PLAN, remote: 'upstream' }), UnknownRemoteError);
		// `--remote upstream`: the value of a bare --remote is only read inline.
		git(['remote', 'add', 'upstream', fx.remote], fx.repo);
		await assert.rejects(runCleanWorkflow(contextFor().context, { ...PLAN, patterns: ['upstream'] }), /^Error: No branch named "upstream"\. Did you mean --remote=upstream\?$/);
		await assert.rejects(runCleanWorkflow(contextFor().context, { ...PLAN, remote: undefined, patterns: ['upstream'] }), /No branch named "upstream"\. Run/);
		git(['remote', 'remove', 'upstream'], fx.repo);
		git(['remote', 'rename', 'origin', 'upstream'], fx.repo);
		const { report } = await runCleanWorkflow(contextFor().context, PLAN);
		assert.strictEqual(report.summary.remote?.remote, 'upstream', 'the only remote');
	});

	test('from the picker, local branches go and remote ones wait for --yes', async () => {
		pushBranch('feature/both', 'b.txt', ['b\n'], { keep: true, track: true });
		git(['merge', '-q', '--no-ff', '-m', 'merge', 'feature/both'], fx.repo);
		git(['push', '-q', 'origin', 'main'], fx.repo);

		const fake = contextFor({ pickMany: (items) => items.map((item) => item.label) });
		const { report, outcome } = await runCleanWorkflow(fake.context, { ...APPLY, yes: false, canPrompt: true });
		assert.strictEqual(outcome, 'not-applied');
		assert.strictEqual(report.branches.find((branch) => branch.name === 'feature/both')?.result, 'deleted');
		assert.deepStrictEqual(actions(report.remoteBranches)['feature/both'], ['delete', 'merged', 'gsp clean origin/feature/both --remote --yes']);
		assert.ok(remoteHas('feature/both'));
		assert.ok(!fake.commands.some((command) => command.startsWith('push')));
		assert.strictEqual(formatSummary(report), '1 deleted (1 merged) · on origin: 1 needs --yes · restore with gsp restore feature/both');

		// Cancelled: the local branch it tracks stays, so the remote one would too.
		pushBranch('feature/next', 'n.txt', ['n\n'], { keep: true, track: true });
		git(['merge', '-q', '--no-ff', '-m', 'merge', 'feature/next'], fx.repo);
		git(['push', '-q', 'origin', 'main'], fx.repo);
		const cancelled = await runCleanWorkflow(contextFor().context, { ...APPLY, yes: false, canPrompt: true });
		assert.strictEqual(cancelled.outcome, 'cancelled');
		assert.deepStrictEqual(actions(cancelled.report.remoteBranches)['feature/next'][1], 'tracked-by-kept-branch');
	});

	/** A second bare remote, holding `branches` (name → source ref in the repository), its HEAD on `head`, then fetched. */
	const addRemote = (name: string, branches: Record<string, string>, head: string) => {
		const bare = path.join(fx.dir, `${name.replace('/', '-')}.git`);
		git(['init', '-q', '--bare', bare], fx.dir);
		git(['symbolic-ref', 'HEAD', `refs/heads/${head}`], bare);
		// Git refuses to add "team/up" next to "team": only a hand-edited config holds both.
		git(['config', `remote.${name}.url`, bare], fx.repo);
		git(['config', `remote.${name}.fetch`, `+refs/heads/*:refs/remotes/${name}/*`], fx.repo);
		git(['push', '-q', name, ...Object.entries(branches).map(([branch, source]) => `${source}:refs/heads/${branch}`)], fx.repo);
		git(['fetch', '-q', name], fx.repo);
		return { has: (branch: string) => git(['branch', '--list', branch], bare).trim().length > 0 };
	};

	test("--remote=<name> proves that remote's branches against its own default branch, not the local one", async () => {
		const init = git(['rev-parse', 'main'], fx.repo).trim();
		pushBranch('feature/fork-only', 'f.txt', ['f\n'], { keep: true });
		pushBranch('feature/both', 'b.txt', ['b\n'], { keep: true });
		const upstream = addRemote('upstream', { main: init, 'feature/fork-only': 'feature/fork-only', 'feature/both': 'feature/both' }, 'main');
		// Merged into the fork's main only, and into upstream's main for the other.
		squashIntoMain('feature/fork-only');
		git(['branch', '-q', '-D', 'feature/fork-only'], fx.repo);
		git(['checkout', '-q', '-b', 'up', `upstream/main`], fx.repo);
		git(['merge', '-q', '--squash', 'feature/both'], fx.repo);
		git(['commit', '-q', '-m', 'squash feature/both'], fx.repo);
		git(['push', '-q', 'upstream', 'up:main'], fx.repo);
		git(['checkout', '-q', 'main'], fx.repo);
		git(['branch', '-q', '-D', 'up', 'feature/both'], fx.repo);

		const { report } = await runCleanWorkflow(contextFor().context, { ...APPLY, remote: 'upstream' });
		assert.deepStrictEqual(report.checks.cleanedRemote, { remote: 'upstream', defaultBranch: 'main', github: null });
		assert.deepStrictEqual(actions(report.remoteBranches), {
			'feature/both': ['delete', 'rebase-merged', null],
			'feature/fork-only': ['keep', 'unmerged-commits', null],
			main: ['keep', 'default-branch', null],
		});
		assert.match(JSON.stringify(report.remoteBranches?.find((branch) => branch.name === 'feature/both')?.evidence), /refs\/remotes\/upstream\/main/);
		assert.ok(upstream.has('feature/fork-only') && !upstream.has('feature/both'));
	});

	test("the remote's default branch is read from the server, without its local HEAD and whatever the local base", async () => {
		const init = git(['rev-parse', 'main'], fx.repo).trim();
		pushBranch('feature/x', 'x.txt', ['x\n'], { keep: true });
		squashIntoMain('feature/x');
		const upstream = addRemote('upstream', { trunkx: init, 'feature/old': init }, 'trunkx');
		git(['remote', 'set-head', 'upstream', '--delete'], fx.repo);
		git(['config', 'remote.upstream.followRemoteHEAD', 'never'], fx.repo);

		const plan = await runCleanWorkflow(contextFor().context, { ...PLAN, remote: 'upstream' });
		assert.strictEqual(plan.report.checks.cleanedRemote?.defaultBranch, 'trunkx');
		assert.deepStrictEqual(actions(plan.report.remoteBranches), {
			'feature/old': ['delete', 'empty', 'gsp clean upstream/feature/old --remote=upstream --yes'],
			trunkx: ['keep', 'default-branch', null],
		});
		const { report } = await runCleanWorkflow(contextFor().context, { ...APPLY, remote: 'upstream' });
		assert.deepStrictEqual(actions(report.remoteBranches).trunkx, ['keep', 'default-branch', null]);
		assert.ok(upstream.has('trunkx') && !upstream.has('feature/old'));
	});

	test('when the server names no default branch, or is not asked, nothing on that remote is deleted', async () => {
		const init = git(['rev-parse', 'main'], fx.repo).trim();
		const upstream = addRemote('upstream', { trunkx: init, 'feature/old': init, main: init }, 'trunkx');
		git(['symbolic-ref', 'HEAD', 'refs/heads/nope'], path.join(fx.dir, 'upstream.git'));

		const fake = contextFor();
		const { report, outcome } = await runCleanWorkflow(fake.context, { ...APPLY, remote: 'upstream' });
		assert.strictEqual(outcome, 'done');
		assert.deepStrictEqual(report.checks.cleanedRemote?.defaultBranch, null);
		// What is kept for its own reason stays kept.
		assert.deepStrictEqual(actions(report.remoteBranches), {
			'feature/old': ['skip', 'remote-default-unknown', null],
			main: ['keep', 'default-branch', null],
			trunkx: ['skip', 'remote-default-unknown', null],
		});
		assert.ok(upstream.has('trunkx') && upstream.has('feature/old'));
		assert.ok(fake.appendedLines.includes('The default branch of upstream could not be read from the server, so no branch on upstream is deleted.'), fake.appendedLines.join('\n'));
		assert.deepStrictEqual(formatRemoteLines(report).slice(1), [
			'skip    feature/old  the default branch of upstream is unknown (no default branch to compare with)',
			'skip    trunkx       the default branch of upstream is unknown (no default branch to compare with)',
			'keep    main         default branch',
		]);

		// Without --no-fetch, gsp asks the server.
		const offline = await runCleanWorkflow(contextFor().context, { ...PLAN, remote: 'upstream', fetch: false });
		assert.deepStrictEqual(actions(offline.report.remoteBranches)['feature/old'], ['skip', 'remote-default-unknown', 'gsp clean --no-github --remote=upstream']);
	});

	test('on a GitHub remote, nothing is deleted when its open pull requests cannot be checked', async () => {
		git(['remote', 'set-url', 'origin', GITHUB_URL], fx.repo);
		git(['config', `url.${fx.remote}.insteadOf`, GITHUB_URL], fx.repo);
		pushBranch('feature/sq', 's.txt', ['s\n']);
		squashIntoMain('feature/sq');
		pushBranch('feature/wip', 'w.txt', ['w\n']);
		const unauthenticated: RunGh = async () => {
			throw Object.assign(new Error('gh: To get started with GitHub CLI, please run:  gh auth login'), { code: 4 });
		};

		const fake = contextFor();
		const { report, outcome } = await runCleanWorkflow({ ...fake.context, gh: unauthenticated }, { ...APPLY, github: true });
		assert.strictEqual(outcome, 'done');
		assert.deepStrictEqual(report.checks.cleanedRemote?.github, {
			used: false,
			reason: 'gh-unauthenticated',
			detail: 'gh: To get started with GitHub CLI, please run:  gh auth login',
		});
		assert.deepStrictEqual(actions(report.remoteBranches), {
			'feature/sq': ['skip', 'github-unavailable', 'gh auth login'],
			'feature/wip': ['keep', 'unmerged-commits', null],
			main: ['keep', 'default-branch', null],
		});
		assert.ok(remoteHas('feature/sq'));
		assert.ok(fake.appendedLines.some((line) => line.startsWith('The open pull requests on origin could not be checked (gh is not logged in: ')), fake.appendedLines.join('\n'));
		assert.ok(!fake.commands.some((command) => command.startsWith('push')));

		const disabled = await runCleanWorkflow(contextFor().context, { ...APPLY, github: false });
		assert.deepStrictEqual(actions(disabled.report.remoteBranches)['feature/sq'], ['skip', 'github-unavailable', 'gsp clean --remote --dry-run']);
		assert.ok(remoteHas('feature/sq'));

		// A remote elsewhere keeps the proofs alone.
		git(['remote', 'set-url', 'origin', fx.remote], fx.repo);
		const gitlab = await runCleanWorkflow(contextFor().context, { ...APPLY, github: false });
		assert.deepStrictEqual(gitlab.report.checks.cleanedRemote?.github, null);
		assert.ok(!remoteHas('feature/sq'));
	});

	test('in a fork, a branch with an open pull request on the parent is kept; one targeted by an open pull request too', async () => {
		git(['remote', 'set-url', 'origin', GITHUB_URL], fx.repo);
		git(['config', `url.${fx.remote}.insteadOf`, GITHUB_URL], fx.repo);
		pushBranch('feature/upstreamed', 'u.txt', ['u\n']);
		pushBranch('feature/base', 'b.txt', ['b\n']);
		pushBranch('feature/named', 'n.txt', ['n\n']);
		pushBranch('feature/sq', 's.txt', ['s\n']);
		for (const name of ['feature/upstreamed', 'feature/base', 'feature/named', 'feature/sq']) {
			squashIntoMain(name);
		}
		const tip = (name: string) => git(['rev-parse', `origin/${name}`], fx.repo).trim();
		const gh = fakeGh(
			[
				// On the parent, from this fork, matched by SHA.
				{ number: 3, state: 'OPEN', headRefOid: tip('feature/upstreamed'), headRefName: 'feature/upstreamed', repo: 'octo/widgets' },
				// On the parent, from another fork with the same SHA: the SHA alone keeps it, never a name from elsewhere.
				{ number: 4, state: 'OPEN', headRefOid: 'f'.repeat(40), headRefName: 'feature/sq', headOwner: 'someone', repo: 'octo/widgets' },
				// Stacked on feature/base, in the fork itself.
				{ number: 9, state: 'OPEN', headRefOid: 'e'.repeat(40), headRefName: 'feature/next', baseRefName: 'feature/base' },
				// Its head moved on GitHub since the last fetch: matched by name in the fork.
				{ number: 10, state: 'OPEN', headRefOid: 'd'.repeat(40), headRefName: 'feature/named' },
			],
			{ parent: 'octo/widgets' }
		);

		const { report } = await runCleanWorkflow({ ...contextFor().context, gh }, { ...APPLY, github: true });
		assert.deepStrictEqual(report.checks.cleanedRemote?.github, { used: true, repo: 'acme/widgets', parent: 'octo/widgets', source: null, openPullRequests: 4 });
		assert.deepStrictEqual(actions(report.remoteBranches), {
			'feature/base': ['keep', 'open-pr-base', null],
			'feature/named': ['keep', 'open-pr', null],
			'feature/sq': ['delete', 'rebase-merged', null],
			'feature/upstreamed': ['keep', 'open-pr', null],
			main: ['keep', 'default-branch', null],
		});
		assert.deepStrictEqual(formatRemoteLines(report)[2], 'keep    feature/base        open pull request #9 targets it');
		assert.ok(remoteHas('feature/upstreamed') && remoteHas('feature/base') && remoteHas('feature/named') && !remoteHas('feature/sq'));

		// The parent's list failing is as bad as the fork's.
		const failing: RunGh = async (args) => {
			if (args.includes('octo/widgets')) {
				throw Object.assign(new Error('HTTP 502'), { code: 1, stderr: 'HTTP 502: Bad Gateway' });
			}
			return gh(args);
		};
		pushBranch('feature/later', 'l.txt', ['l\n']);
		squashIntoMain('feature/later');
		const failed = await runCleanWorkflow({ ...contextFor().context, gh: failing }, { ...APPLY, github: true });
		assert.deepStrictEqual(actions(failed.report.remoteBranches)['feature/later'], ['skip', 'github-unavailable', 'gsp clean --remote --dry-run']);
		assert.ok(remoteHas('feature/later'));
	});

	/** Makes origin look like `url`, while Git still pushes to the fixture's bare repository. */
	const pretendRemote = (url: string) => {
		git(['remote', 'set-url', 'origin', url], fx.repo);
		git(['config', `url.${fx.remote}.insteadOf`, url], fx.repo);
	};

	/** Records the `gh` calls, as space-joined arguments. */
	const recording = (gh: RunGh) => {
		const asked: string[] = [];
		const run: RunGh = (args, options) => {
			asked.push(args.join(' '));
			return gh(args, options);
		};
		return { run, asked };
	};

	test('a GitHub remote behind an SSH alias keeps its open pull requests, and gh is asked about the real host', async () => {
		pretendRemote('git@work:acme/widgets.git');
		pushBranch('feature/pr', 'p.txt', ['p\n']);
		pushBranch('feature/sq', 's.txt', ['s\n']);
		squashIntoMain('feature/pr');
		squashIntoMain('feature/sq');
		const gh = recording(fakeGh([{ number: 7, state: 'OPEN', headRefOid: git(['rev-parse', 'origin/feature/pr'], fx.repo).trim() }]));
		const ssh: RunSsh = async (args) => ({ stdout: `user git\nhostname ${args[1] === 'work' ? 'github.com' : args[1]}\nport 22\n`, stderr: '' });

		const { report } = await runCleanWorkflow({ ...contextFor().context, gh: gh.run, ssh }, { ...APPLY, github: true });
		assert.deepStrictEqual(report.checks.cleanedRemote?.github, { used: true, repo: 'acme/widgets', parent: null, source: null, openPullRequests: 1 });
		assert.deepStrictEqual(actions(report.remoteBranches), {
			'feature/pr': ['keep', 'open-pr', null],
			'feature/sq': ['delete', 'rebase-merged', null],
			main: ['keep', 'default-branch', null],
		});
		assert.ok(gh.asked.some((command) => command.startsWith('api --hostname github.com repos/acme/widgets ')), gh.asked.join('\n'));
		assert.ok(remoteHas('feature/pr') && !remoteHas('feature/sq'));
	});

	test('on a host nothing identifies, nothing is deleted until gh or git-sweep-pro.forge tells what it is', async () => {
		pretendRemote('git@git.example.com:acme/widgets.git');
		pushBranch('feature/sq', 's.txt', ['s\n']);
		squashIntoMain('feature/sq');
		const tip = git(['rev-parse', 'origin/feature/sq'], fx.repo).trim();

		const fake = contextFor();
		const { report } = await runCleanWorkflow({ ...fake.context, gh: fakeGh([]) }, { ...APPLY, github: true });
		assert.deepStrictEqual(report.checks.cleanedRemote?.github, { used: false, reason: 'unknown-host', detail: 'git.example.com' });
		assert.deepStrictEqual(actions(report.remoteBranches)['feature/sq'], ['skip', 'github-unavailable', 'gh auth login --hostname git.example.com']);
		assert.ok(
			fake.appendedLines.includes(
				"Can't tell whether origin is on GitHub (git.example.com), so no branch on origin is deleted: it may be the head or base of an open pull request. " +
					'If it is on GitHub, run gh auth login --hostname git.example.com. If not, run git config git-sweep-pro.forge none.'
			),
			fake.appendedLines.join('\n')
		);
		const withoutGitHub = await runCleanWorkflow(contextFor().context, { ...APPLY, github: false });
		assert.deepStrictEqual(actions(withoutGitHub.report.remoteBranches)['feature/sq'], ['skip', 'github-unavailable', 'gh auth login --hostname git.example.com']);
		assert.ok(remoteHas('feature/sq'));

		// gh is logged in to it: a GitHub server, whose open pull request keeps the branch.
		const open = [{ number: 5, state: 'OPEN' as const, headRefOid: tip }];
		const loggedIn = await runCleanWorkflow({ ...contextFor().context, gh: fakeGh(open, { loggedIn: ['git.example.com'] }) }, { ...APPLY, github: true });
		assert.deepStrictEqual(actions(loggedIn.report.remoteBranches)['feature/sq'], ['keep', 'open-pr', null]);

		// git-sweep-pro.forge github says so without gh's login.
		git(['config', 'git-sweep-pro.forge', 'github'], fx.repo);
		const gh = recording(fakeGh(open));
		const forced = await runCleanWorkflow({ ...contextFor().context, gh: gh.run }, { ...APPLY, github: true });
		assert.deepStrictEqual(actions(forced.report.remoteBranches)['feature/sq'], ['keep', 'open-pr', null]);
		assert.ok(gh.asked.some((command) => command.startsWith('pr list --repo git.example.com/acme/widgets --state open ')), gh.asked.join('\n'));
		assert.ok(remoteHas('feature/sq'));

		// git-sweep-pro.forge none: not GitHub, the proofs alone decide.
		git(['config', 'git-sweep-pro.forge', 'none'], fx.repo);
		const none = await runCleanWorkflow(contextFor().context, { ...APPLY, github: false });
		assert.strictEqual(none.report.checks.cleanedRemote?.github, null);
		assert.ok(!remoteHas('feature/sq'));
	});

	test('gitlab.com and bitbucket.org are not GitHub', async () => {
		pretendRemote('git@gitlab.com:acme/widgets.git');
		pushBranch('feature/sq', 's.txt', ['s\n']);
		squashIntoMain('feature/sq');
		const { report } = await runCleanWorkflow(contextFor().context, { ...APPLY, github: false });
		assert.strictEqual(report.checks.cleanedRemote?.github, null);
		assert.deepStrictEqual(actions(report.remoteBranches)['feature/sq'], ['delete', 'rebase-merged', null]);
		assert.ok(!remoteHas('feature/sq'));
	});

	test("a fork's open pull requests are found under the owner GitHub uses today, whatever owner the URL still names", async () => {
		pretendRemote(GITHUB_URL);
		for (const name of ['feature/named', 'feature/sha', 'feature/sq']) {
			pushBranch(name, `${name.replace('/', '-')}.txt`, [`${name}\n`]);
			squashIntoMain(name);
		}
		const tip = (name: string) => git(['rev-parse', `origin/${name}`], fx.repo).trim();
		const gh = fakeGh(
			[
				// From the fork, under its new owner: its head moved since the last fetch, matched by name.
				{ number: 1, state: 'OPEN', headRefOid: 'd'.repeat(40), headRefName: 'feature/named', headOwner: 'acme-corp', repo: 'octo/widgets' },
				// From whatever fork, the same SHA.
				{ number: 2, state: 'OPEN', headRefOid: tip('feature/sha'), headRefName: 'other', headOwner: 'someone', repo: 'octo/widgets' },
			],
			{ canonical: 'acme-corp/widgets', parent: 'octo/widgets' }
		);
		const { report } = await runCleanWorkflow({ ...contextFor().context, gh }, { ...APPLY, github: true });
		assert.deepStrictEqual(report.checks.cleanedRemote?.github, { used: true, repo: 'acme-corp/widgets', parent: 'octo/widgets', source: null, openPullRequests: 2 });
		assert.deepStrictEqual(actions(report.remoteBranches), {
			'feature/named': ['keep', 'open-pr', null],
			'feature/sha': ['keep', 'open-pr', null],
			'feature/sq': ['delete', 'rebase-merged', null],
			main: ['keep', 'default-branch', null],
		});
	});

	test('in a fork of a fork, the open pull requests on the root of the network count too', async () => {
		pretendRemote(GITHUB_URL);
		pushBranch('feature/deep', 'd.txt', ['d\n']);
		squashIntoMain('feature/deep');
		const gh = fakeGh(
			[{ number: 3, state: 'OPEN', headRefOid: git(['rev-parse', 'origin/feature/deep'], fx.repo).trim(), headRefName: 'feature/deep', repo: 'root/widgets' }],
			{ parent: 'mid/widgets', source: 'root/widgets' }
		);
		const { report } = await runCleanWorkflow({ ...contextFor().context, gh }, { ...APPLY, github: true });
		assert.deepStrictEqual(report.checks.cleanedRemote?.github, { used: true, repo: 'acme/widgets', parent: 'mid/widgets', source: 'root/widgets', openPullRequests: 1 });
		assert.deepStrictEqual(actions(report.remoteBranches)['feature/deep'], ['keep', 'open-pr', null]);
		assert.ok(remoteHas('feature/deep'));
	});

	test('a remote that pushes elsewhere than it fetches from is not cleaned', async () => {
		const elsewhere = path.join(fx.dir, 'elsewhere.git');
		git(['config', 'remote.origin.pushurl', elsewhere], fx.repo);
		await assert.rejects(
			runCleanWorkflow(contextFor().context, APPLY),
			(error: unknown) =>
				error instanceof PushUrlMismatchError &&
				error.message ===
					`origin fetches from ${fx.remote} but pushes to ${elsewhere}, another repository, so gsp can't check the branches it would delete there. Point both URLs to the same repository.`
		);
		const { outcome } = await runCleanWorkflow(contextFor().context, { ...APPLY, remote: undefined });
		assert.notStrictEqual(outcome, undefined);
	});

	test('a remote that fetches over https and pushes over SSH to the same repository is cleaned', async () => {
		pushBranch('feature/done', 'd.txt', ['d\n']);
		squashIntoMain('feature/done');
		git(['remote', 'set-url', 'origin', 'https://GitHub.com/Acme/Widgets'], fx.repo);
		git(['config', 'url.git@work:.pushInsteadOf', 'https://GitHub.com/'], fx.repo);
		const ssh: RunSsh = async (args) => ({ stdout: `hostname ${args[1] === 'work' ? 'github.com' : args[1]}\n`, stderr: '' });
		assert.strictEqual(git(['remote', 'get-url', '--push', 'origin'], fx.repo).trim(), 'git@work:Acme/Widgets');
		// Read-only and offline: the check comes first, and nothing reaches GitHub.
		const { report } = await runCleanWorkflow({ ...contextFor().context, ssh }, { ...APPLY, dryRun: true, fetch: false, github: false });
		assert.strictEqual(report.mode, 'plan');
		assert.ok(report.remoteBranches?.some((branch) => branch.name === 'feature/done'));
	});

	test('a remote that pushes to another repository on the same server is not cleaned', async () => {
		git(['remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git'], fx.repo);
		git(['config', 'remote.origin.pushurl', 'git@github.com:acme/widgets-fork.git'], fx.repo);
		await assert.rejects(runCleanWorkflow(contextFor().context, { ...APPLY, dryRun: true, fetch: false, github: false }), PushUrlMismatchError);
	});

	test('more open pull requests than gsp lists: nothing is deleted', async () => {
		git(['remote', 'set-url', 'origin', GITHUB_URL], fx.repo);
		git(['config', `url.${fx.remote}.insteadOf`, GITHUB_URL], fx.repo);
		pushBranch('feature/sq', 's.txt', ['s\n']);
		squashIntoMain('feature/sq');
		const many = Array.from({ length: 1000 }, (_, index) => ({ number: index + 1, state: 'OPEN' as const, headRefOid: 'c'.repeat(40) }));
		const { report } = await runCleanWorkflow({ ...contextFor().context, gh: fakeGh(many) }, { ...APPLY, github: true });
		assert.deepStrictEqual(report.checks.cleanedRemote?.github, {
			used: false,
			reason: 'too-many-open-prs',
			detail: 'more than 1000 open pull requests on acme/widgets',
		});
		assert.deepStrictEqual(actions(report.remoteBranches)['feature/sq'], ['skip', 'github-unavailable', 'gsp clean --remote --dry-run']);
		assert.ok(remoteHas('feature/sq'));
	});

	test('branch.<name>.deleteMerged=false keeps the branch and its upstream on the remote', async () => {
		pushBranch('feature/keep', 'k.txt', ['k\n'], { keep: true, track: true });
		git(['merge', '-q', '--no-ff', '-m', 'merge', 'feature/keep'], fx.repo);
		git(['push', '-q', 'origin', 'main'], fx.repo);
		git(['config', 'branch.feature/keep.deleteMerged', 'false'], fx.repo);

		const { report } = await runCleanWorkflow(contextFor().context, APPLY);
		assert.deepStrictEqual(actions(report.remoteBranches)['feature/keep'], ['skip', 'protected', null]);
		assert.deepStrictEqual(report.remoteBranches?.find((branch) => branch.name === 'feature/keep')?.protected, {
			by: 'branch-config',
			key: 'branch.feature/keep.deleteMerged',
		});
		assert.ok(formatRemoteLines(report).includes('skip    feature/keep  branch.feature/keep.deleteMerged is false (merged into origin/main)'));
		assert.ok(remoteHas('feature/keep'));
	});

	test('the branches of a remote nested in its name ("team/up" in "team") are not its own', async () => {
		const init = git(['rev-parse', 'main'], fx.repo).trim();
		addRemote('team', { main: init, 'feature/t': init }, 'main');
		addRemote('team/up', { main: init, 'feature/u': init }, 'main');
		const { report } = await runCleanWorkflow(contextFor().context, { ...PLAN, remote: 'team', fetch: false });
		assert.deepStrictEqual(Object.keys(actions(report.remoteBranches)), ['feature/t', 'main']);
	});

	test('when the fetch fails or the default branch changes, no remote branch is deleted', () => {
		const entry: CleanRemoteBranch = {
			remote: 'origin',
			name: 'feature/a',
			tip: 'a'.repeat(40),
			action: 'delete',
			reason: 'merged',
			verdict: 'dead',
			verdictReason: 'merged',
			evidence: null,
			protected: null,
			trackedBy: [],
			hint: 'gsp clean origin/feature/a --remote --yes',
		};
		const fetched = { source: 'fetch', remotes: ['origin'] } as const;
		const unreachable = { source: 'local-refs', reason: 'unreachable' } as const;
		assert.deepStrictEqual(holdRemoteToFetch([entry], fetched, false), [entry]);
		assert.deepStrictEqual(actions(holdRemoteToFetch([entry], unreachable, false)), { 'feature/a': ['skip', 'fetch-failed', 'gsp clean origin/feature/a --remote --yes'] });
		assert.deepStrictEqual(actions(holdRemoteToFetch([entry], fetched, true)), { 'feature/a': ['skip', 'plan-changed', 'gsp clean --remote --dry-run'] });
	});
});
