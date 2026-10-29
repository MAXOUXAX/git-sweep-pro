import * as assert from 'assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { decideActions, formatSummary, type CleanBranch, type PlannedBranch, type RemoteCheck } from '../../core/clean-plan';
import { holdToBase, holdToPlan, runCleanWorkflow, type CleanOptions } from '../../core/clean-workflow';
import { gitFailureReason } from '../../core/errors';
import { isRegenerable } from '../../core/ignored-files';
import { branchExists, commitFile, createRepoFixture, git, makeGoneBranch, type RepoFixture } from '../cli/git-fixture';
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
};

/** Runs real git in `cwd`; a failure is returned as an error carrying Git's stderr, like `runGitCommand`. */
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

suite('clean workflow (real git)', function () {
	this.timeout(60000);
	let fx: RepoFixture;

	setup(() => {
		fx = createRepoFixture();
	});

	teardown(() => {
		fx.cleanup();
	});

	const contextFor = (options: FakeContextOptions = {}) => createFakeContext({ root: fx.repo, gitFallback: realGit(fx.repo), ...options });

	test('a worktree that changes after the analysis is neither removed nor its branch deleted', async () => {
		makeGoneBranch(fx.repo, 'feature/wt');
		const wt = path.join(fx.dir, 'wt');
		git(['worktree', 'add', '-q', wt, 'feature/wt'], fx.repo);
		// The new file is untracked: it must count even when status hides untracked files.
		git(['config', 'status.showUntrackedFiles', 'no'], fx.repo);

		// The last check before deleting reads the branch tip: someone starts working in the worktree meanwhile.
		const { context } = contextFor({
			onGit: (command) => {
				if (command.startsWith('for-each-ref --format=%(refname)%09%(objectname)')) {
					fs.writeFileSync(path.join(wt, 'new.txt'), 'new work\n');
				}
			},
		});
		const { report, outcome } = await runCleanWorkflow(context, APPLY);
		const [branch] = report.branches.filter((entry) => entry.name === 'feature/wt');
		assert.deepStrictEqual([branch.action, branch.reason], ['skip', 'worktree-changed']);
		assert.strictEqual(outcome, 'not-applied');
		assert.ok(fs.existsSync(path.join(wt, 'new.txt')));
		assert.ok(branchExists(fx.repo, 'feature/wt'));
	});

	test('an ignored file that replaces one the plan showed counts as a change, even with --discard-changes', async () => {
		makeGoneBranch(fx.repo, 'feature/wt');
		const wt = path.join(fx.dir, 'wt');
		git(['worktree', 'add', '-q', wt, 'feature/wt'], fx.repo);
		fs.appendFileSync(path.join(fx.repo, '.git', 'info', 'exclude'), '*.local\n');
		fs.writeFileSync(path.join(wt, 'shown.local'), 'seen in the plan\n');

		// Same count after the fetch, but not the file the plan showed.
		const { context } = contextFor({
			onGit: (command) => {
				if (command.startsWith('fetch --prune')) {
					fs.renameSync(path.join(wt, 'shown.local'), path.join(wt, 'other.local'));
				}
			},
		});
		const { report, outcome } = await runCleanWorkflow(context, { ...APPLY, discardChanges: true, patterns: ['feature/wt'] });
		const [branch] = report.branches;
		assert.deepStrictEqual([branch.action, branch.reason, branch.worktree?.ignoredFiles], ['skip', 'worktree-changed', { count: 1, sample: ['other.local'] }]);
		assert.strictEqual(outcome, 'not-applied');
		assert.ok(fs.existsSync(path.join(wt, 'other.local')));
		assert.ok(branchExists(fx.repo, 'feature/wt'));
	});

	test('the picker comes before any write: a cancel leaves no fetch and no prune behind', async () => {
		makeGoneBranch(fx.repo, 'feature/a');
		const fake = contextFor({ pickMany: () => undefined });
		const { outcome } = await runCleanWorkflow(fake.context, { ...APPLY, yes: false, canPrompt: true });
		assert.strictEqual(outcome, 'cancelled');
		assert.strictEqual(fake.pickManyRequests.length, 1);
		assert.ok(!fake.commands.some((command) => /^(.* )?fetch /.test(command) || command.startsWith('worktree prune')), fake.commands.join('\n'));
		assert.ok(branchExists(fx.repo, 'feature/a'));

		// Approved: the fetch only comes after the picker.
		let fetchedBeforePicking = false;
		const approved = contextFor({
			pickMany: (items) => {
				fetchedBeforePicking = approved.commands.some((command) => /^(.* )?fetch /.test(command));
				return items.map((item) => item.label);
			},
		});
		assert.strictEqual((await runCleanWorkflow(approved.context, { ...APPLY, yes: false, canPrompt: true })).outcome, 'done');
		assert.strictEqual(fetchedBeforePicking, false);
		assert.ok(approved.commands.some((command) => command.startsWith('fetch --prune')));
		assert.ok(!branchExists(fx.repo, 'feature/a'));
	});

	test('a branch no commit was made on, picked in the picker, goes with its worktree', async () => {
		const wt = path.join(fx.dir, 'wt');
		git(['worktree', 'add', '-q', '-b', 'agent/task', wt, 'main'], fx.repo);
		const fake = contextFor({ pickMany: (items) => items.filter((item) => item.label === 'agent/task').map((item) => item.label) });
		const { report, outcome } = await runCleanWorkflow(fake.context, { ...APPLY, yes: false, canPrompt: true });
		const offered = fake.pickManyRequests[0].items.find((item) => item.label === 'agent/task');
		assert.strictEqual(offered?.picked, false, 'offered, never pre-selected');
		assert.deepStrictEqual([report.branches.find((branch) => branch.name === 'agent/task')?.result, outcome], ['deleted', 'done']);
		assert.ok(!branchExists(fx.repo, 'agent/task'));
		assert.ok(!fs.existsSync(wt));
	});

	test('when the fetch fails, a branch proven only by its gone upstream is not deleted', async () => {
		// Its commit is on another remote branch: dead, nothing unpushed, but only remote-tracking refs say so.
		git(['checkout', '-q', '-b', 'feature/x'], fx.repo);
		commitFile(fx.repo, 'x.txt', 'x\n', 'x');
		git(['push', '-q', '-u', 'origin', 'feature/x'], fx.repo);
		git(['push', '-q', 'origin', 'feature/x:feature/copy'], fx.repo);
		git(['checkout', '-q', 'main'], fx.repo);
		git(['push', '-q', 'origin', '--delete', 'feature/x'], fx.repo);

		const { context, appendedLines } = contextFor({
			git: { 'fetch --prune --multiple origin': new Error('fatal: unable to access the remote') },
		});
		const { report, outcome } = await runCleanWorkflow(context, APPLY);
		const branch = report.branches.find((entry) => entry.name === 'feature/x');
		assert.deepStrictEqual([branch?.action, branch?.reason, branch?.verdictReason, branch?.hint], ['skip', 'fetch-failed', 'upstream-gone', 'gsp clean feature/x --no-github --yes']);
		assert.deepStrictEqual(report.checks.remote, { source: 'local-refs', reason: 'unreachable', detail: 'unable to access the remote' });
		assert.strictEqual(outcome, 'not-applied');
		assert.ok(branchExists(fx.repo, 'feature/x'));
		assert.strictEqual(appendedLines.filter((line) => line.startsWith('Could not reach the remote')).length, 1);
	});

	test('when the fetch fails, a deletion that only ls-remote proved is reported as fetch-failed', async () => {
		// Deleted on the remote, not pruned here: only ls-remote sees it gone. Its commit is on another remote branch.
		git(['checkout', '-q', '-b', 'feature/x'], fx.repo);
		commitFile(fx.repo, 'x.txt', 'x\n', 'x');
		git(['push', '-q', '-u', 'origin', 'feature/x'], fx.repo);
		git(['push', '-q', 'origin', 'feature/x:feature/copy'], fx.repo);
		git(['checkout', '-q', 'main'], fx.repo);
		git(['branch', '-q', '-D', 'feature/x'], fx.remote);

		const { context } = contextFor({ git: { 'fetch --prune --multiple origin': new Error('fatal: unable to access the remote') } });
		const { report, outcome } = await runCleanWorkflow(context, APPLY);
		const branch = report.branches.find((entry) => entry.name === 'feature/x');
		assert.deepStrictEqual([branch?.action, branch?.reason, branch?.hint], ['skip', 'fetch-failed', 'gsp clean feature/x --no-github --yes']);
		assert.strictEqual(outcome, 'not-applied');
		assert.strictEqual(formatSummary(report), 'Nothing deleted · 1 skipped (1 fetch failed)');
		assert.ok(branchExists(fx.repo, 'feature/x'));
	});

	test('a plan reading ls-remote only turns branches alive for their unmerged commits into upstream-gone', async () => {
		// Both are deleted on the remote, without a prune: only ls-remote can tell.
		for (const name of ['feature/unmerged', 'feature/failed']) {
			git(['checkout', '-q', '-b', name], fx.repo);
			commitFile(fx.repo, `${name.replace('/', '-')}.txt`, `${name}\n`, name);
			git(['push', '-q', '-u', 'origin', name], fx.repo);
			git(['checkout', '-q', 'main'], fx.repo);
			git(['--git-dir', fx.remote, 'branch', '-D', name], fx.dir);
		}
		const failedTip = git(['rev-parse', 'feature/failed'], fx.repo).trim();
		const real = realGit(fx.repo);
		const { context } = contextFor({
			// The analysis cannot count the unpushed commits of one branch: it stays alive, analysis-failed.
			gitFallback: (args) =>
				args.includes('rev-list') && args.includes(failedTip) && !args.some((arg) => arg.startsWith('--exclude'))
					? new Error('fatal: bad object')
					: real(args),
		});
		const { report } = await runCleanWorkflow(context, { ...APPLY, yes: false });
		const byName = new Map(report.branches.map((branch) => [branch.name, branch]));
		assert.deepStrictEqual(
			[byName.get('feature/unmerged')?.verdictReason, byName.get('feature/unmerged')?.reason, byName.get('feature/unmerged')?.unpushedCommits],
			['upstream-gone', 'needs-force', 1]
		);
		assert.deepStrictEqual(
			[byName.get('feature/failed')?.verdictReason, byName.get('feature/failed')?.action, byName.get('feature/failed')?.upstreamState],
			['analysis-failed', 'keep', 'gone']
		);
	});

	test('a squash-merged branch goes with a compare-and-swap, and its configuration with it', async () => {
		git(['checkout', '-q', '-b', 'feature/squashed'], fx.repo);
		commitFile(fx.repo, 'squashed.txt', 'x\n', 'x');
		git(['checkout', '-q', 'main'], fx.repo);
		git(['merge', '-q', '--squash', 'feature/squashed'], fx.repo);
		git(['commit', '-q', '-m', 'squash'], fx.repo);
		git(['push', '-q', 'origin', 'main'], fx.repo);
		git(['config', 'branch.feature/squashed.description', 'kept until deleted'], fx.repo);
		const tip = git(['rev-parse', 'feature/squashed'], fx.repo).trim();

		const fake = contextFor();
		const { report } = await runCleanWorkflow(fake.context, APPLY);
		assert.strictEqual(report.branches.find((branch) => branch.name === 'feature/squashed')?.result, 'deleted');
		assert.ok(fake.commands.includes(`update-ref -m gsp clean -d refs/heads/feature/squashed ${tip}`), fake.commands.join('\n'));
		assert.strictEqual(git(['config', '--list', '--local'], fx.repo).includes('branch.feature/squashed.'), false);
		assert.ok(!branchExists(fx.repo, 'feature/squashed'));
	});
});

suite('clean workflow', () => {
	const branch = (name: string, overrides: Partial<PlannedBranch> = {}): PlannedBranch => ({
		name,
		tip: 'a'.repeat(40),
		current: false,
		upstream: `origin/${name}`,
		upstreamState: 'gone',
		worktree: null,
		verdict: 'dead',
		reason: 'squash-merged',
		evidence: null,
		unpushedCommits: 0,
		protected: null,
		upstreamOf: [],
		...overrides,
	});
	const decide = (branches: PlannedBranch[], picked?: ReadonlySet<string>) =>
		decideActions(branches, { force: false, discardChanges: false, named: new Set(), defaultBranch: 'main', ...(picked ? { picked } : {}) });
	const fetched: RemoteCheck = { source: 'fetch', remotes: ['origin'] };
	const actions = (branches: readonly CleanBranch[]) => Object.fromEntries(branches.map((entry) => [entry.name, [entry.action, entry.reason, entry.hint]]));

	test('applying never goes beyond the plan, and reports what changed in between', () => {
		const planned = decide([branch('kept'), branch('now-alive'), branch('now-dirty'), branch('unpicked'), branch('alive')], new Set(['kept', 'now-alive', 'now-dirty']));
		const current = decide([
			branch('kept'),
			branch('now-alive', { verdict: 'alive', reason: 'unmerged-commits' }),
			branch('now-dirty', { worktree: { path: '/wt', isMain: false, dirty: true, locked: false, prunable: false, inProgress: null } }),
			branch('unpicked'),
			branch('alive'),
			branch('new'),
		]);
		assert.deepStrictEqual(actions(holdToPlan(planned, current, fetched)), {
			kept: ['delete', 'squash-merged', 'gsp clean kept --yes'],
			'now-alive': ['skip', 'plan-changed', 'gsp clean now-alive'],
			'now-dirty': [
				'skip',
				'dirty-worktree',
				'git -C /wt stash --include-untracked && gsp clean now-dirty --yes, or, to delete them for good: gsp worktree remove /wt --discard-changes && gsp clean now-dirty --yes',
			],
			unpicked: ['skip', 'not-selected', 'gsp clean unpicked'],
			alive: ['skip', 'not-selected', 'gsp clean alive'],
			new: ['skip', 'plan-changed', 'gsp clean new'],
		});
	});

	test('with --yes, deletes what the fetch proves, and still reports what it disproves', () => {
		const planned = decide([branch('kept'), branch('now-alive')]);
		const current = decide([branch('kept'), branch('now-alive', { verdict: 'alive', reason: 'unmerged-commits' }), branch('new')]);
		assert.deepStrictEqual(actions(holdToPlan(planned, current, fetched, false)), {
			kept: ['delete', 'squash-merged', 'gsp clean kept --yes'],
			'now-alive': ['skip', 'plan-changed', 'gsp clean now-alive'],
			new: ['delete', 'squash-merged', 'gsp clean new --yes'],
		});
	});

	test('after a failed fetch, only deletions that remote-tracking refs alone prove are held back', () => {
		const branches = [branch('gone', { reason: 'upstream-gone' }), branch('squashed')];
		const unreachable: RemoteCheck = { source: 'local-refs', reason: 'unreachable', detail: 'offline' };
		assert.deepStrictEqual(actions(holdToPlan(decide(branches), decide(branches), unreachable)), {
			gone: ['skip', 'fetch-failed', 'gsp clean gone --yes'],
			squashed: ['delete', 'squash-merged', 'gsp clean squashed --yes'],
		});
		const noFetch: RemoteCheck = { source: 'local-refs', reason: 'no-fetch' };
		assert.strictEqual(holdToPlan(decide(branches), decide(branches), noFetch)[0].action, 'delete', '--no-fetch is a choice');
	});

	test('a default branch that changed holds back every deletion, and the planned one is never deleted', () => {
		const base = (name: string) => ({ name, ref: `refs/remotes/origin/${name}`, remote: 'origin', tip: 'b'.repeat(40), source: 'remote-head' as const });
		const branches = decide([branch('main'), branch('feature/a')]);
		assert.deepStrictEqual(actions(holdToBase(branches, base('main'), base('main')).branches), {
			main: ['skip', 'protected', null],
			'feature/a': ['delete', 'squash-merged', 'gsp clean feature/a --yes'],
		});
		const moved = holdToBase(branches, base('main'), base('develop'));
		assert.deepStrictEqual(actions(moved.branches), { main: ['skip', 'protected', null], 'feature/a': ['skip', 'plan-changed', 'gsp clean --dry-run'] });
		assert.match(moved.message ?? '', /^The default branch changed from origin\/main to origin\/develop during the fetch/);
		assert.strictEqual(holdToBase(branches, null, base('main')).branches[0].reason, 'plan-changed');
		assert.strictEqual(holdToBase(decide([]), base('main'), base('develop')).message, undefined, 'nothing held back, nothing to say');
	});

	test("Git's own reason is kept, not Node's command line", () => {
		const failure = Object.assign(new Error('Command failed: git worktree remove /wt\nfatal: /wt is locked'), { stderr: "fatal: '/wt' contains modified or untracked files, use --force to delete it\n" });
		assert.strictEqual(gitFailureReason(failure), "'/wt' contains modified or untracked files, use --force to delete it");
		assert.strictEqual(gitFailureReason(new Error('Command failed: git branch -d x\nerror: branch x not found')), 'branch x not found');
		assert.strictEqual(gitFailureReason('plain'), 'plain');
		const rejected = Object.assign(new Error('Command failed: git push origin :refs/heads/x'), {
			stderr: [
				'remote: error: GH006: Protected branch update failed for',
				'remote: refs/heads/x.',
				'remote: error: Cannot delete this protected branch',
				'To github.com:acme/widgets.git',
				' ! [remote rejected] x (protected branch hook declined)',
				"error: failed to push some refs to 'github.com:acme/widgets.git'",
			].join('\n'),
		});
		assert.strictEqual(gitFailureReason(rejected), 'GH006: Protected branch update failed for refs/heads/x.');
	});

	test('regenerable folders, at any depth, only as whole entries; secret-like names never', () => {
		for (const regenerable of ['node_modules/', 'packages/app/node_modules/', 'vendor/bundle/', 'dist/', 'web/.next/', 'tsconfig.tsbuildinfo', 'a/.DS_Store', '.venv/', 'target/']) {
			assert.strictEqual(isRegenerable(regenerable), true, regenerable);
		}
		const kept = ['.env', 'notes.md', 'vendor/', 'secrets/', 'distribution/', 'build.log.bak', '.DS_Store/', 'tools/build/credentials.json', 'dist/app.js', 'build/cache/'];
		const secrets = ['dist/.env', '.env.local', 'node_modules/.npmrc', 'certs/server.PEM', 'tls.key', 'aws-credentials.tsbuildinfo', 'my-secret.tsbuildinfo', '.netrc'];
		for (const path of [...kept, ...secrets]) {
			assert.strictEqual(isRegenerable(path), false, path);
		}
	});
});
