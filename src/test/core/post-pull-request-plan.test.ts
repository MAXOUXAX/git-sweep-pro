import * as assert from 'assert';
import type { BranchAnalysis } from '../../core/branch-analysis';
import { CLEAN_SCHEMA, type CleanReport, type PlannedBranch } from '../../core/clean-plan';
import {
	decideTarget,
	formatDefaultBranch,
	formatNextSteps,
	postPrNextCommand,
	formatPostPrLines,
	hasPendingChanges,
	type DecideTargetOptions,
	type DefaultBranchUpdate,
	type PostPrReport,
	type PostPrScope,
} from '../../core/post-pull-request-plan';

const BASE = 'refs/remotes/origin/main';

/** A squash-merged branch with nothing holding it; override what a test needs. */
function branch(overrides: Partial<PlannedBranch> = {}): PlannedBranch {
	return {
		name: 'feature/x',
		tip: 'a'.repeat(40),
		current: false,
		upstream: 'origin/feature/x',
		upstreamState: 'gone',
		worktree: null,
		verdict: 'dead',
		reason: 'squash-merged',
		evidence: { method: 'file-state', base: BASE, squashCommit: 'c'.repeat(40), files: 1, patchIdCommits: 0 },
		unpushedCommits: 0,
		protected: null,
		upstreamOf: [],
		...overrides,
	};
}

const worktree = (overrides: Partial<NonNullable<BranchAnalysis['worktree']>> = {}) => ({
	path: '/wt',
	isMain: false,
	dirty: false,
	locked: false,
	prunable: false,
	inProgress: null,
	...overrides,
});

const SCOPE: PostPrScope = { protectedPatterns: [], github: true, fetch: true };

const OPTIONS: DecideTargetOptions = { force: false, into: 'main', mainCheckoutDirty: false, remoteAhead: false, scope: SCOPE };

const update = (overrides: Partial<DefaultBranchUpdate> = {}): DefaultBranchUpdate => ({
	name: 'main',
	from: '1'.repeat(40),
	to: '2'.repeat(40),
	upstream: 'origin/main',
	where: '/repo',
	updated: true,
	remoteAhead: false,
	reason: null,
	hint: null,
	...overrides,
});

const clean: CleanReport = {
	schema: CLEAN_SCHEMA,
	mode: 'apply',
	checks: { base: null, fetched: true, github: { used: false, reason: 'disabled' }, durationMs: 1, remote: { source: 'fetch', remotes: ['origin'] } },
	branches: [],
	worktreesPruned: [],
	restore: null,
	summary: { delete: 0, deleted: 0, failed: 0, skipped: 0, kept: 0, needsForce: 0, reasons: {} },
};

function report(overrides: Partial<PostPrReport> = {}): PostPrReport {
	return {
		schema: CLEAN_SCHEMA,
		command: 'post-pr',
		mode: 'apply',
		branch: null,
		worktree: { path: null, removed: false, switched: false },
		defaultBranch: update({ updated: false, reason: 'up-to-date' }),
		clean,
		nextCwd: null,
		restore: null,
		...overrides,
	};
}

suite('post-pr plan', () => {
	test('the current branch, in the worktree gsp runs in, is deleted with that worktree', () => {
		const decided = decideTarget(branch({ current: true, worktree: worktree() }), OPTIONS);
		assert.strictEqual(decided.action, 'delete');
		assert.strictEqual(decided.worktree?.path, '/wt');
		assert.strictEqual(decided.hint, 'gsp post-pr feature/x --yes');
	});

	test('a branch in the main checkout is deleted after a switch, never with the checkout', () => {
		const decided = decideTarget(branch({ current: true, worktree: worktree({ path: '/repo', isMain: true }) }), OPTIONS);
		assert.strictEqual(decided.action, 'delete');
		assert.strictEqual(decided.worktree, null);

		const dirty = decideTarget(branch({ worktree: worktree({ path: '/repo', isMain: true }) }), { ...OPTIONS, mainCheckoutDirty: true });
		assert.deepStrictEqual([dirty.action, dirty.reason, dirty.hint], ['skip', 'dirty-worktree', "git -C /repo stash --include-untracked && gsp post-pr feature/x --yes"]);
		assert.strictEqual(dirty.worktree?.isMain, true);
	});

	test('a branch that is not merged needs --force, unless the merge may not be fetched yet', () => {
		const alive = branch({ verdict: 'alive', reason: 'unmerged-commits', evidence: { method: 'unique-commits', base: BASE, commits: 2 } });
		assert.deepStrictEqual(
			[decideTarget(alive, OPTIONS).reason, decideTarget(alive, OPTIONS).hint],
			['needs-force', 'gsp post-pr feature/x --yes --force']
		);
		assert.strictEqual(decideTarget(alive, { ...OPTIONS, remoteAhead: true }).hint, 'gsp post-pr feature/x --yes');
		const forced = decideTarget(alive, { ...OPTIONS, force: true });
		assert.deepStrictEqual([forced.action, forced.hint], ['delete', 'gsp post-pr feature/x --yes --force']);
	});

	test('before --force, hints at what may still prove the branch merged', () => {
		const alive = branch({ verdict: 'alive', reason: 'unmerged-commits', evidence: { method: 'unique-commits', base: BASE, commits: 2 } });
		assert.strictEqual(decideTarget(alive, { ...OPTIONS, mergedElsewhere: 'develop' }).hint, 'gsp post-pr feature/x --into develop --yes');
		const scoped = { ...OPTIONS, scope: { ...SCOPE, cwd: '/my repo', into: 'main', github: false } };
		assert.strictEqual(
			decideTarget(alive, { ...scoped, mergedElsewhere: 'develop' }).hint,
			"gsp -C '/my repo' post-pr feature/x --into develop --no-github --yes"
		);
		assert.strictEqual(decideTarget(alive, scoped).hint, "gsp -C '/my repo' post-pr feature/x --into main --no-github --yes --force");

		// Unpushed commits on top of a merged tip go to the remote first, even when the remote has new commits.
		const unpushed = branch({ unpushedCommits: 1 });
		const pushFirst = decideTarget(unpushed, { ...OPTIONS, remoteAhead: true, mergedElsewhere: 'develop', pushRemote: 'origin' });
		assert.deepStrictEqual([pushFirst.reason, pushFirst.hint], ['needs-force', 'git push -u origin feature/x']);
		assert.strictEqual(decideTarget(unpushed, OPTIONS).hint, 'gsp post-pr feature/x --yes --force');
	});

	test('the skip label matches the hint: "needs --force" only when the hint does', () => {
		const alive = branch({ verdict: 'alive', reason: 'unmerged-commits', evidence: { method: 'unique-commits', base: BASE, commits: 2 } });
		const line = (options: DecideTargetOptions) => formatPostPrLines(report({ branch: decideTarget(alive, options) }))[0];
		assert.strictEqual(
			line({ ...OPTIONS, remoteAhead: true }),
			'skip    feature/x  not proven merged yet (2 commits not merged into origin/main) → gsp post-pr feature/x --yes'
		);
		assert.strictEqual(
			line(OPTIONS),
			'skip    feature/x  named, but not merged: needs --force (2 commits not merged into origin/main) → gsp post-pr feature/x --yes --force'
		);
	});

	test('rules --force never lifts still apply', () => {
		const locked = decideTarget(branch({ worktree: worktree({ locked: true }) }), { ...OPTIONS, force: true });
		assert.deepStrictEqual([locked.action, locked.reason], ['skip', 'locked-worktree']);
		const protectedBranch = decideTarget(branch({ protected: { by: 'pattern', pattern: 'feature/*' } }), { ...OPTIONS, force: true });
		assert.deepStrictEqual([protectedBranch.action, protectedBranch.reason], ['skip', 'protected']);
		const rebasing = decideTarget(branch({ worktree: worktree({ path: '/repo', isMain: true, inProgress: 'rebase' }) }), { ...OPTIONS, force: true });
		assert.deepStrictEqual([rebasing.action, rebasing.reason, rebasing.worktree?.isMain], ['skip', 'rebase-in-progress', true]);
		const ignored = decideTarget(branch({ worktree: { ...worktree(), ignoredFiles: { count: 1, sample: ['.env'] } } }), OPTIONS);
		assert.deepStrictEqual([ignored.action, ignored.reason, ignored.hint], ['skip', 'ignored-files', 'move what you need out of /wt, then: gsp post-pr feature/x --yes --force']);
		const tracked = decideTarget(branch({ upstreamOf: ['feature/y'] }), OPTIONS);
		assert.deepStrictEqual([tracked.action, tracked.reason], ['skip', 'tracked-by-kept-branch']);
	});

	test('the default branch says what happened to it, or nothing when there is no local branch', () => {
		assert.strictEqual(formatDefaultBranch(update()), 'main: fast-forwarded to origin/main (1111111..2222222) in /repo');
		assert.strictEqual(
			formatDefaultBranch(update({ updated: false, reason: 'not-applied', where: null })),
			'main: would fast-forward to origin/main (1111111..2222222)'
		);
		assert.strictEqual(formatDefaultBranch(update({ reason: 'up-to-date' })), 'main: up to date with origin/main');
		assert.strictEqual(formatDefaultBranch(update({ reason: 'no-remote' })), 'main: no remote branch to update it from');
		assert.strictEqual(formatDefaultBranch(update({ reason: 'not-local' })), undefined);
		assert.strictEqual(
			formatDefaultBranch(update({ reason: 'dirty', hint: 'git -C /repo merge --ff-only origin/main' })),
			'main: not updated, /repo has uncommitted changes → commit or stash them, then run git -C /repo merge --ff-only origin/main'
		);
		assert.strictEqual(formatDefaultBranch(update({ reason: 'diverged' })), 'main: not updated, it has commits that are not on origin/main');
		assert.strictEqual(formatDefaultBranch(update({ reason: 'failed', error: 'boom' })), 'main: could not fast-forward to origin/main: boom');
	});

	test('a plan whose remote moved says so once, instead of "up to date"', () => {
		const lines = formatPostPrLines(report({ mode: 'plan', defaultBranch: update({ updated: false, reason: 'up-to-date', remoteAhead: true }) }));
		assert.deepStrictEqual(lines, [
			'No branch to finish: on main.',
			'main: origin/main has new commits that are not fetched yet, so this plan may change: "--yes" fetches them first.',
			'Other branches: nothing to clean.',
		]);
	});

	test('a switched main checkout gets its own line', () => {
		const target = { ...decideTarget(branch({ worktree: worktree({ path: '/repo', isMain: true }) }), OPTIONS), result: 'deleted' as const };
		const lines = formatPostPrLines(report({ branch: target, worktree: { path: '/repo', removed: false, switched: true } }));
		assert.strictEqual(lines[1], 'main: switched /repo from feature/x to main');
	});

	test('next steps: undo, where to continue, and how to apply a plan', () => {
		const scope = SCOPE;
		const steps = (report: PostPrReport) => formatNextSteps(report, postPrNextCommand(report, scope));
		const deleted = { ...decideTarget(branch(), OPTIONS), result: 'deleted' as const };
		assert.deepStrictEqual(steps(report({ branch: deleted, restore: 'gsp restore feature/x', nextCwd: '/my repo' })), [
			'Undo with: gsp restore feature/x',
			"The worktree you ran gsp in was removed. Continue in the main checkout: cd '/my repo'",
		]);

		const planned = report({ mode: 'plan', branch: decideTarget(branch(), OPTIONS) });
		assert.ok(hasPendingChanges(planned));
		assert.deepStrictEqual(steps(planned), ['Nothing was changed. To apply this plan, run: gsp post-pr feature/x --yes']);
		assert.deepStrictEqual(steps(report({ mode: 'plan', defaultBranch: update({ updated: false, reason: 'not-applied' }) })), [
			'Nothing was changed. To apply this plan, run: gsp post-pr --yes',
		]);
		assert.ok(!hasPendingChanges(report({ mode: 'plan' })));
	});

	test('a plan gives a next command exactly when applying it would change something, and then exits 5', () => {
		const remoteAhead = report({ mode: 'plan', defaultBranch: update({ updated: false, reason: 'up-to-date', remoteAhead: true }) });
		assert.strictEqual(postPrNextCommand(remoteAhead, SCOPE), 'gsp post-pr --yes');
		assert.ok(hasPendingChanges(remoteAhead));
		// A kept merged branch is not finished: 5, though only its own hint can lift it.
		const alive = branch({ verdict: 'alive', reason: 'unmerged-commits', evidence: { method: 'unique-commits', base: BASE, commits: 2 } });
		const kept = report({ mode: 'plan', branch: decideTarget(alive, OPTIONS) });
		assert.strictEqual(postPrNextCommand(kept, SCOPE), null);
		assert.ok(hasPendingChanges(kept));
	});

	test('the next command keeps the options of the run, and plans again what changed while applying', () => {
		const scope: PostPrScope = { cwd: '/my repo', into: 'develop', protectedPatterns: ['release/*'], github: false, fetch: false };
		const planned = report({ mode: 'plan', branch: decideTarget(branch(), OPTIONS) });
		assert.strictEqual(
			postPrNextCommand(planned, scope),
			"gsp -C '/my repo' post-pr feature/x --into develop --protect 'release/*' --no-github --no-fetch --yes"
		);
		const held = { ...decideTarget(branch(), OPTIONS), action: 'skip' as const, reason: 'plan-changed' as const };
		const applied = report({ branch: held });
		assert.strictEqual(postPrNextCommand(applied, { protectedPatterns: [], github: true, fetch: true }), 'gsp post-pr feature/x --dry-run');
		assert.deepStrictEqual(formatNextSteps(applied, 'gsp post-pr feature/x --dry-run'), [
			'1 not deleted, as things changed while applying. Review them with: gsp post-pr feature/x --dry-run',
		]);
		assert.strictEqual(postPrNextCommand(report({ branch: { name: 'feature/x', action: 'gone' } }), scope), null);
	});

});
