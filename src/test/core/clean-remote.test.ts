import * as assert from 'assert';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { formatRemoteLines, formatSummary, type CleanRemoteBranch } from '../../core/clean-plan';
import { holdRemoteToFetch, runCleanWorkflow, UnknownRemoteError, type CleanOptions } from '../../core/clean-workflow';
import type { RunGh } from '../../core/github-signal';
import { runRestoreWorkflow } from '../../core/restore-workflow';
import { commitFile, createRepoFixture, git, type RepoFixture } from '../cli/git-fixture';
import { createFakeContext, type FakeContextOptions, type GitEntry } from '../fake-context';

const APPLY: CleanOptions = {
	patterns: [],
	dryRun: false,
	yes: true,
	force: false,
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

/** A `gh` stub listing `pullRequests` (base main); every other call fails, as for an unknown commit. */
function fakeGh(pullRequests: Array<{ number: number; state: 'OPEN' | 'MERGED'; headRefOid: string }>): RunGh {
	return async (args) => {
		if (args[0] === 'pr') {
			return { stdout: JSON.stringify(pullRequests.map((pr) => ({ baseRefName: 'main', ...pr }))), stderr: '' };
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

		const restore = contextFor({ deletionLog: fake.context.deletionLog });
		assert.strictEqual(await runRestoreWorkflow(restore.context, ['origin/feature/sq']), 'failed');
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
		assert.deepStrictEqual(actions(report.remoteBranches)['feature/sq'], ['delete', 'rebase-merged', 'gsp clean feature/sq --remote --yes']);
		assert.deepStrictEqual([remoteHeads(), git(['for-each-ref'], fx.repo)], before);
		assert.ok(fake.commands.includes('ls-remote --heads origin'));
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
		assert.deepStrictEqual(actions(report.remoteBranches)['feature/sq'], ['skip', 'plan-changed', 'gsp clean feature/sq --dry-run --remote']);
		assert.strictEqual(outcome, 'not-applied');
		assert.ok(remoteHeads().includes(`feature/sq ${git(['rev-parse', 'HEAD'], clone).trim()}`));
		assert.strictEqual(report.restore, null);
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
			'feature/both': ['delete', 'merged', 'gsp clean feature/both --remote --yes'],
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
			develop: ['skip', 'protected', 'gsp clean develop --remote'],
			'feature/a': ['delete', 'rebase-merged', 'gsp clean feature/a --remote --yes'],
			'fix/b': ['delete', 'rebase-merged', 'gsp clean fix/b --remote --yes'],
			main: ['keep', 'default-branch', null],
			'release/1': ['skip', 'protected', null],
		});

		const scoped = await runCleanWorkflow(contextFor().context, { ...APPLY, patterns: ['feature/*', 'develop'] });
		assert.deepStrictEqual(Object.keys(actions(scoped.report.remoteBranches)), ['develop', 'feature/a']);
		assert.ok(!remoteHas('develop') && !remoteHas('feature/a') && remoteHas('fix/b') && remoteHas('release/1'));
	});

	test('a named branch must exist locally or on the remote; --remote names an existing remote', async () => {
		pushBranch('feature/a', 'a.txt', ['a\n']);
		await assert.rejects(runCleanWorkflow(contextFor().context, { ...PLAN, patterns: ['feature/nope'] }), /No local branch named "feature\/nope"/);
		await assert.doesNotReject(runCleanWorkflow(contextFor().context, { ...PLAN, patterns: ['feature/a'] }));
		await assert.rejects(runCleanWorkflow(contextFor().context, { ...PLAN, remote: 'upstream' }), UnknownRemoteError);
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
		assert.deepStrictEqual(actions(report.remoteBranches)['feature/both'], ['delete', 'merged', 'gsp clean feature/both --remote --yes']);
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
			hint: 'gsp clean feature/a --remote --yes',
		};
		const fetched = { source: 'fetch', remotes: ['origin'] } as const;
		const unreachable = { source: 'local-refs', reason: 'unreachable' } as const;
		assert.deepStrictEqual(holdRemoteToFetch([entry], fetched, false), [entry]);
		assert.deepStrictEqual(actions(holdRemoteToFetch([entry], unreachable, false)), { 'feature/a': ['skip', 'fetch-failed', 'gsp clean feature/a --remote --yes'] });
		assert.deepStrictEqual(actions(holdRemoteToFetch([entry], fetched, true)), { 'feature/a': ['skip', 'plan-changed', 'gsp clean --dry-run --remote'] });
	});
});
