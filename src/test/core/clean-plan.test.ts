import * as assert from 'assert';
import type { BranchAnalysis } from '../../core/branch-analysis';
import {
	applyCommand,
	nextCommand,
	CLEAN_SCHEMA,
	decideActions,
	describeVerdict,
	formatBranchLines,
	formatSummary,
	hasPendingDeletions,
	isBranchGlob,
	restoreCommand,
	summarize,
	type CleanBranch,
	type CleanRemoteBranch,
	type CleanReport,
	type DecideOptions,
	type PlannedBranch,
} from '../../core/clean-plan';

const BASE = 'refs/remotes/origin/main';

/** A dead, squash-merged branch with nothing holding it; override what a test needs. */
function branch(name: string, overrides: Partial<PlannedBranch> = {}): PlannedBranch {
	return {
		name,
		tip: `${name.length}`.padStart(40, '0'),
		current: false,
		upstream: `origin/${name}`,
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

const OPTIONS: DecideOptions = { force: false, discardChanges: false, named: new Set(), defaultBranch: 'main' };

function decide(branches: PlannedBranch[], options: Partial<DecideOptions> = {}) {
	return decideActions(branches, { ...OPTIONS, ...options });
}

/** name → [action, reason, hint] */
function actions(decided: readonly CleanBranch[]) {
	return Object.fromEntries(decided.map((entry) => [entry.name, [entry.action, entry.reason, entry.hint]]));
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

suite('clean plan', () => {
	test('a proven dead branch is deleted, an alive one is kept', () => {
		const decided = decide([
			branch('feature/done'),
			branch('feature/wip', { verdict: 'alive', reason: 'unmerged-commits', evidence: { method: 'unique-commits', base: BASE, commits: 2 } }),
		]);
		assert.deepStrictEqual(actions(decided), {
			'feature/done': ['delete', 'squash-merged', 'gsp clean feature/done --yes'],
			'feature/wip': ['keep', 'unmerged-commits', null],
		});
		assert.strictEqual(decided[0].needsForce, false);
	});

	test('a dead branch with unpushed commits, or an alive branch named exactly, needs --force', () => {
		const gone = branch('feature/gone', { reason: 'upstream-gone', evidence: { method: 'upstream-gone', upstream: 'origin/feature/gone' }, unpushedCommits: 2 });
		const wip = branch('feature/wip', { verdict: 'alive', reason: 'unmerged-commits', unpushedCommits: 1 });
		const named = new Set(['feature/wip']);

		assert.deepStrictEqual(actions(decide([gone, wip], { named })), {
			'feature/gone': ['skip', 'needs-force', 'gsp clean feature/gone --yes --force'],
			'feature/wip': ['skip', 'needs-force', 'gsp clean feature/wip --yes --force'],
		});
		assert.deepStrictEqual(actions(decide([gone, wip], { named, force: true })), {
			'feature/gone': ['delete', 'upstream-gone', 'gsp clean feature/gone --yes --force'],
			'feature/wip': ['delete', 'unmerged-commits', 'gsp clean feature/wip --yes --force'],
		});
		assert.deepStrictEqual(actions(decide([wip], { force: true })), { 'feature/wip': ['keep', 'unmerged-commits', null] }, 'never forced unless named');
	});

	test('protected, opted-out, current and main-worktree branches are skipped, whatever the flags', () => {
		const decided = decide(
			[
				branch('main', { verdict: 'alive', reason: 'default-branch', protected: { by: 'default-branch' } }),
				branch('release/1', { protected: { by: 'pattern', pattern: 'release/*' } }),
				branch('keep/me', { protected: { by: 'branch-config', key: 'branch.keep/me.deleteMerged' } }),
				branch('feature/here', { current: true }),
				branch('feature/main', { worktree: worktree({ path: '/repo', isMain: true }) }),
			],
			{ force: true, named: new Set(['main']) }
		);
		assert.deepStrictEqual(actions(decided), {
			main: ['skip', 'protected', null],
			'release/1': ['skip', 'protected', null],
			'keep/me': ['skip', 'delete-merged-false', null],
			'feature/here': ['skip', 'current-branch', 'gsp post-pr feature/here --yes'],
			'feature/main': ['skip', 'main-worktree', 'gsp post-pr feature/main --yes'],
		});
	});

	test('the current branch: post-pr only when it is proven dead, git switch otherwise', () => {
		const decided = decide([branch('feature/wip', { current: true, verdict: 'alive', reason: 'unmerged-commits' })], { named: new Set(['feature/wip']) });
		assert.deepStrictEqual(actions(decided), { 'feature/wip': ['skip', 'current-branch', 'git switch main'] });
	});

	test('a branch being rebased or bisected is never deleted, not even with --force or --discard-changes', () => {
		const branches = [
			branch('feature/rebase', { worktree: worktree({ path: '/wt/r', inProgress: 'rebase' }) }),
			branch('feature/bisect', { worktree: worktree({ path: '/repo', isMain: true, inProgress: 'bisect' }) }),
		];
		for (const force of [false, true]) {
			assert.deepStrictEqual(actions(decide(branches, { force, discardChanges: force, named: new Set(['feature/rebase']) })), {
				'feature/rebase': ['skip', 'rebase-in-progress', 'git -C /wt/r rebase --continue, or, to drop the rebase with the worktree: gsp worktree remove /wt/r --discard-changes && gsp clean feature/rebase --yes'],
				'feature/bisect': ['skip', 'bisect-in-progress', 'git -C /repo bisect reset'],
			});
		}
		assert.deepStrictEqual(formatBranchLines(report(decide(branches), 'plan')), [
			'skip    feature/rebase  a rebase is in progress in /wt/r: continue or abort it first (squash-merged into origin/main) → git -C /wt/r rebase --continue, or, to drop the rebase with the worktree: gsp worktree remove /wt/r --discard-changes && gsp clean feature/rebase --yes',
			'skip    feature/bisect  a bisect is in progress in /repo: reset it first (squash-merged into origin/main) → git -C /repo bisect reset',
		]);
		assert.strictEqual(hasPendingDeletions(decide(branches)), false, 'the user acts elsewhere: no exit 5');
	});

	test('a worktree holding ignored files is kept, and the plan lists them; --discard-changes lifts it, --force does not', () => {
		const ignoredFiles = { count: 4, sample: ['.env', 'notes.md', 'secrets/', 'x.db'] };
		const held = branch('feature/env', { worktree: { ...worktree({ path: '/wt/env' }), ignoredFiles } });
		const unforced = decide([held]);
		assert.deepStrictEqual(actions(unforced), { 'feature/env': ['skip', 'ignored-files', 'move what you need out of /wt/env, then: gsp clean feature/env --yes --discard-changes'] });
		assert.deepStrictEqual(formatBranchLines(report(unforced, 'plan')), [
			'skip    feature/env  removing worktree /wt/env would delete 4 ignored files (.env, notes.md, secrets/, …), needs --discard-changes (squash-merged into origin/main) → move what you need out of /wt/env, then: gsp clean feature/env --yes --discard-changes',
		]);
		assert.strictEqual(hasPendingDeletions(unforced), true, '--discard-changes would delete it: exit 5');
		assert.deepStrictEqual([summarize(unforced, 'plan').needsForce, summarize(unforced, 'plan').needsDiscardChanges], [0, 1]);
		assert.strictEqual(decide([held], { force: true })[0].reason, 'ignored-files');
		const unpushed = branch('feature/env', { unpushedCommits: 1, worktree: { ...worktree({ path: '/wt/env' }), ignoredFiles } });
		assert.strictEqual(decide([unpushed])[0].hint, 'move what you need out of /wt/env, then: gsp clean feature/env --yes --force --discard-changes');

		const forced = decide([held], { discardChanges: true });
		assert.deepStrictEqual(actions(forced), { 'feature/env': ['delete', 'squash-merged', 'gsp clean feature/env --yes --discard-changes'] });
		assert.deepStrictEqual(forced[0].worktree?.ignoredFiles, ignoredFiles);
		assert.deepStrictEqual(formatBranchLines(report(forced, 'plan')), [
			'delete  feature/env  squash-merged into origin/main, removes worktree /wt/env and its 4 ignored files (.env, notes.md, secrets/, …)',
		]);
		const none = decide([branch('feature/clean', { worktree: { ...worktree(), ignoredFiles: { count: 0, sample: [] } } })]);
		assert.strictEqual(none[0].action, 'delete');
	});

	test('a worktree with submodules names its ignored files too, since removing it deletes them', () => {
		const sub = (ignoredFiles: { count: number; sample: string[] }) =>
			branch('feature/sub', { worktree: { ...worktree({ path: '/wt/sub' }), ignoredFiles, submodules: true } });
		const status = 'git -C /wt/sub submodule foreach --recursive git status --short';
		assert.deepStrictEqual(actions(decide([sub({ count: 1, sample: ['notes.md'] })])), {
			'feature/sub': ['skip', 'submodules', `check the submodules of /wt/sub (${status}) and move what you need out of its 1 ignored file (notes.md), then: gsp worktree remove /wt/sub --discard-changes && gsp clean feature/sub --yes`],
		});
		assert.deepStrictEqual(actions(decide([sub({ count: 0, sample: [] })])), {
			'feature/sub': ['skip', 'submodules', `check the submodules of /wt/sub (${status}), then: gsp worktree remove /wt/sub --discard-changes && gsp clean feature/sub --yes`],
		});
	});

	test('the needs-force reason says whether the work is unpushed or not merged', () => {
		const decided = decide(
			[branch('feature/gone', { reason: 'upstream-gone', unpushedCommits: 2 }), branch('feature/wip', { verdict: 'alive', reason: 'unmerged-commits', evidence: null })],
			{ named: new Set(['feature/wip']) }
		);
		assert.deepStrictEqual(formatBranchLines(report(decided, 'plan')), [
			'skip    feature/gone  needs --force (upstream origin/feature/gone is gone, 2 commits found nowhere else) → gsp clean feature/gone --yes --force',
			'skip    feature/wip   named, but not merged: needs --force (commits not merged) → gsp clean feature/wip --yes --force',
		]);
	});

	test('the command to apply a plan never goes beyond it', () => {
		const scope = { patterns: [], protectedPatterns: [], github: true, fetch: true };
		const planned = decide([branch('feature/a'), branch("it's"), branch('feature/gone', { reason: 'upstream-gone', unpushedCommits: 1 })]);
		assert.strictEqual(applyCommand(planned, scope), "gsp clean feature/a 'it'\\''s' --yes", 'the planned branches by name, quoted');
		assert.strictEqual(
			applyCommand(planned, { cwd: '../my repo', patterns: ['feature/*'], protectedPatterns: ['release/*'], github: false, fetch: false }),
			"gsp -C '../my repo' clean feature/a 'it'\\''s' --protect 'release/*' --no-github --no-fetch --yes"
		);
		const forced = decide([branch('feature/gone', { reason: 'upstream-gone', unpushedCommits: 1 })], { force: true });
		assert.strictEqual(applyCommand(forced, scope), 'gsp clean feature/gone --yes --force');

		const many = decide(Array.from({ length: 11 }, (_, index) => branch(`feature/${index}`)));
		const named = `gsp clean ${Array.from({ length: 11 }, (_, index) => `feature/${index}`).join(' ')} --yes`;
		assert.strictEqual(applyCommand(many, { ...scope, patterns: ['feature/*'] }), named, 'never the patterns, which could match more later');
		assert.strictEqual(applyCommand(many, scope), named);
	});

	test('the command to apply a plan names every remote branch too, qualified', () => {
		const scope = { patterns: ['feature/*'], protectedPatterns: [], github: true, fetch: true, remote: 'upstream' };
		const remoteBranch = (name: string, overrides: Partial<CleanRemoteBranch> = {}): CleanRemoteBranch => ({
			remote: 'upstream',
			name,
			tip: 'a'.repeat(40),
			action: 'delete',
			reason: 'merged',
			verdict: 'dead',
			verdictReason: 'merged',
			evidence: null,
			protected: null,
			trackedBy: [],
			hint: null,
			...overrides,
		});
		const remoteBranches = [
			...Array.from({ length: 11 }, (_, index) => remoteBranch(`feature/${index}`)),
			remoteBranch('feature/done', { result: 'deleted' }),
			remoteBranch('feature/kept', { action: 'keep' }),
		];
		const remotes = Array.from({ length: 11 }, (_, index) => `upstream/feature/${index}`).join(' ');
		assert.strictEqual(
			applyCommand(decide([branch('feature/a')]), scope, remoteBranches),
			`gsp clean feature/a ${remotes} --remote=upstream --yes`,
			'never the patterns, and only what is left to delete'
		);
		assert.strictEqual(nextCommand({ branches: [], remoteBranches }, scope), `gsp clean ${remotes} --remote=upstream --yes`);
	});

	test('the next command applies what is left, or plans again when it changed', () => {
		const scope = { patterns: ['feature/*'], protectedPatterns: [], github: true, fetch: true };
		const planned = decide([branch('feature/a'), branch('feature/gone', { reason: 'upstream-gone', unpushedCommits: 1 })]);
		assert.strictEqual(nextCommand({ branches: planned }, scope), 'gsp clean feature/a --yes');
		const changed = planned.map((entry): CleanBranch => (entry.name === 'feature/a' ? { ...entry, action: 'skip', reason: 'fetch-failed' } : entry));
		assert.strictEqual(nextCommand({ branches: changed }, scope), "gsp clean 'feature/*' --dry-run");
		const deleted = planned.map((entry): CleanBranch => (entry.name === 'feature/a' ? { ...entry, result: 'deleted' } : entry));
		assert.strictEqual(nextCommand({ branches: deleted }, scope), null, 'what needs --force is left to its own hint');
	});

	test('without a default branch, the hints still say what to do', () => {
		const decided = decideActions(
			[branch('feature/here', { current: true }), branch('feature/main', { worktree: worktree({ path: '/repo', isMain: true }) })],
			{ ...OPTIONS, defaultBranch: undefined }
		);
		assert.deepStrictEqual(actions(decided), {
			'feature/here': ['skip', 'current-branch', 'git switch <another-branch>'],
			'feature/main': ['skip', 'main-worktree', 'git -C /repo switch <another-branch>'],
		});
	});

	test('a dirty or locked worktree is kept with its branch; a clean or prunable one is not in the way', () => {
		const decided = decide([
			branch('feature/dirty', { worktree: worktree({ path: '/wt/dirty', dirty: true }) }),
			branch('feature/locked', { worktree: worktree({ path: '/wt/locked', locked: true }) }),
			branch('feature/clean', { worktree: worktree({ path: '/wt/clean' }) }),
			branch('feature/gone-dir', { worktree: worktree({ path: '/wt/gone', prunable: true, dirty: true }) }),
		]);
		assert.deepStrictEqual(actions(decided), {
			'feature/dirty': [
				'skip',
				'dirty-worktree',
				'git -C /wt/dirty stash --include-untracked && gsp clean feature/dirty --yes, or, to delete them for good: gsp worktree remove /wt/dirty --discard-changes && gsp clean feature/dirty --yes',
			],
			'feature/locked': ['skip', 'locked-worktree', 'git worktree unlock /wt/locked'],
			'feature/clean': ['delete', 'squash-merged', 'gsp clean feature/clean --yes'],
			'feature/gone-dir': ['delete', 'squash-merged', 'gsp clean feature/gone-dir --yes'],
		});
	});

	test('the upstream of a kept branch is skipped, in turn, until nothing changes', () => {
		// stack/1 <- stack/2 <- stack/3 (alive): each tracks the previous one.
		const decided = decide([
			branch('stack/1', { upstreamOf: ['stack/2'] }),
			branch('stack/2', { upstreamOf: ['stack/3'] }),
			branch('stack/3', { verdict: 'alive', reason: 'unmerged-commits' }),
			branch('pair/base', { upstreamOf: ['pair/top'] }),
			branch('pair/top'),
		]);
		assert.deepStrictEqual(actions(decided), {
			'stack/1': ['skip', 'tracked-by-kept-branch', 'git branch --unset-upstream stack/2'],
			'stack/2': ['skip', 'tracked-by-kept-branch', 'git branch --unset-upstream stack/3'],
			'stack/3': ['keep', 'unmerged-commits', null],
			'pair/base': ['delete', 'squash-merged', 'gsp clean pair/base --yes'],
			'pair/top': ['delete', 'squash-merged', 'gsp clean pair/top --yes'],
		});
	});

	test('the picker decides among the candidates, and picking a branch that needs --force grants it', () => {
		const decided = decide(
			[
				branch('feature/a'),
				branch('feature/b'),
				branch('feature/gone', { reason: 'upstream-gone', unpushedCommits: 1 }),
				branch('feature/left', { reason: 'upstream-gone', unpushedCommits: 1 }),
			],
			{ picked: new Set(['feature/a', 'feature/gone']) }
		);
		assert.deepStrictEqual(actions(decided), {
			'feature/a': ['delete', 'squash-merged', 'gsp clean feature/a --yes'],
			'feature/b': ['skip', 'not-selected', 'gsp clean feature/b'],
			'feature/gone': ['delete', 'upstream-gone', 'gsp clean feature/gone --yes --force'],
			'feature/left': ['skip', 'needs-force', 'gsp clean feature/left --yes --force'],
		});
	});

	test('pending deletions: planned ones, and the ones --force would add', () => {
		assert.strictEqual(hasPendingDeletions(decide([branch('a')])), true);
		assert.strictEqual(hasPendingDeletions(decide([branch('a', { unpushedCommits: 1 })])), true);
		assert.strictEqual(hasPendingDeletions(decide([branch('a', { current: true })])), false);
		assert.strictEqual(hasPendingDeletions([{ ...decide([branch('a')])[0], result: 'deleted' }]), false);
		for (const reason of ['plan-changed', 'fetch-failed', 'worktree-changed'] as const) {
			assert.strictEqual(hasPendingDeletions([{ ...decide([branch('a')])[0], action: 'skip', reason }]), true, reason);
		}
		assert.strictEqual(hasPendingDeletions(decide([branch('a', { worktree: worktree({ dirty: true }) })])), false);
	});

	test('globs and restore commands', () => {
		assert.strictEqual(isBranchGlob('feature/*'), true);
		assert.strictEqual(isBranchGlob('fix-?'), true);
		assert.strictEqual(isBranchGlob('feature/x'), false);
		assert.strictEqual(restoreCommand([]), null);
		assert.strictEqual(restoreCommand(['a', "it's"]), "gsp restore a 'it'\\''s'");
	});

	test('every verdict reads as a short sentence', () => {
		const describe = (overrides: Partial<BranchAnalysis>) => {
			const { reason, evidence, unpushedCommits, upstream } = branch('x', overrides);
			return describeVerdict({ verdictReason: reason, evidence, unpushedCommits, upstream });
		};
		const ancestor = { method: 'ancestor', base: BASE } as const;
		assert.strictEqual(describe({ reason: 'empty', evidence: ancestor }), 'already in origin/main', 'it had an upstream: it had commits once');
		assert.strictEqual(describe({ reason: 'empty', evidence: ancestor, upstream: null }), 'no commits beyond origin/main');
		assert.strictEqual(
			describe({ verdict: 'alive', reason: 'analysis-failed', evidence: { method: 'error', message: 'fatal: bad object' } }),
			'analysis failed: fatal: bad object'
		);
		assert.strictEqual(describe({ reason: 'empty', evidence: null }), 'no commits of its own');
		assert.strictEqual(describe({ reason: 'merged', evidence: ancestor }), 'merged into origin/main');
		assert.strictEqual(describe({ reason: 'rebase-merged', evidence: { method: 'patch-id', base: BASE, commits: 2 } }), 'rebase-merged into origin/main');
		const pr = { method: 'pull-request', pullRequest: 12, state: 'merged', headSha: 'a', match: 'head' } as const;
		assert.strictEqual(describe({ reason: 'pr-merged', evidence: pr }), 'pull request #12 merged');
		assert.strictEqual(describe({ reason: 'pr-merged', evidence: null }), 'pull request merged');
		assert.strictEqual(describe({ reason: 'commits-merged', evidence: { method: 'commits', base: BASE, commits: 2, proofs: [] } }), 'every commit merged into origin/main');
		assert.strictEqual(describe({ reason: 'upstream-gone' }), 'upstream origin/x is gone, every commit is on a remote');
		assert.strictEqual(describe({ reason: 'upstream-gone', unpushedCommits: 1 }), 'upstream origin/x is gone, 1 commit found nowhere else');
		assert.strictEqual(describe({ verdict: 'alive', reason: 'default-branch' }), 'default branch');
		assert.strictEqual(describe({ verdict: 'alive', reason: 'open-pr', evidence: { ...pr, state: 'open' } }), 'pull request #12 is open');
		assert.strictEqual(describe({ verdict: 'alive', reason: 'open-pr', evidence: null }), 'pull request is open');
		assert.strictEqual(
			describe({ verdict: 'alive', reason: 'unmerged-commits', evidence: { method: 'unique-commits', base: BASE, commits: 3 } }),
			'3 commits not merged into origin/main'
		);
		assert.strictEqual(describe({ verdict: 'alive', reason: 'unmerged-commits', evidence: null }), 'commits not merged');
		assert.strictEqual(describe({ verdict: 'alive', reason: 'no-base', evidence: null }), 'no default branch to compare with');
	});

	const report = (branches: readonly CleanBranch[], mode: CleanReport['mode'], restored: string[] = [], worktreesPruned: string[] = []): CleanReport => ({
		schema: CLEAN_SCHEMA,
		mode,
		checks: {
			base: { name: 'main', ref: BASE, remote: 'origin', tip: 'f'.repeat(40), source: 'remote-head' },
			fetched: mode === 'apply',
			github: { used: false, reason: 'disabled' },
			durationMs: 0,
			remote: mode === 'apply' ? { source: 'fetch', remotes: ['origin'] } : { source: 'ls-remote', remotes: ['origin'] },
		},
		branches,
		worktreesPruned,
		restore: restoreCommand(restored),
		summary: summarize(branches, mode),
	});

	test('human output: one line per branch, then one honest summary line', () => {
		const decided = decide(
			[
				branch('feature/b', { reason: 'empty', evidence: { method: 'ancestor', base: BASE } }),
				branch('feature/a', { worktree: worktree({ path: '/wt/a' }) }),
				branch('main', { verdict: 'alive', reason: 'default-branch', protected: { by: 'default-branch' }, evidence: null }),
				branch('feature/here', { current: true }),
				branch('feature/gone', { reason: 'upstream-gone', unpushedCommits: 2 }),
			],
			{ named: new Set(['main']) }
		);
		const plan = report(decided, 'plan', [], ['/wt/old']);
		assert.deepStrictEqual(formatBranchLines(plan), [
			'delete  feature/b     already in origin/main',
			'delete  feature/a     squash-merged into origin/main, removes worktree /wt/a',
			'skip    main          default branch',
			'skip    feature/here  current branch (squash-merged into origin/main) → gsp post-pr feature/here --yes',
			'skip    feature/gone  needs --force (upstream origin/feature/gone is gone, 2 commits found nowhere else) → gsp clean feature/gone --yes --force',
		]);
		assert.strictEqual(formatSummary(plan), '2 to delete (1 empty, 1 squash-merged) · 3 skipped (1 needs --force) · 1 worktree registration to prune');

		const applied = decided.map((entry): CleanBranch => {
			if (entry.name === 'feature/a') {
				return { ...entry, result: 'deleted', hint: null };
			}
			return entry.name === 'feature/b' ? { ...entry, result: 'failed', error: 'it no longer exists' } : entry;
		});
		const done = report(applied, 'apply', ['feature/a'], ['/wt/old']);
		assert.deepStrictEqual(formatBranchLines(done).slice(0, 2), [
			'failed  feature/b     it no longer exists',
			'deleted feature/a     squash-merged into origin/main, removed worktree /wt/a',
		]);
		assert.strictEqual(
			formatSummary(done),
			'1 deleted (1 squash-merged) · 1 failed · 3 skipped (1 needs --force) · 1 worktree registration pruned · restore with gsp restore feature/a'
		);
	});

	test('hints keep -C, --no-github and --no-fetch, as next does', () => {
		const scope = { cwd: '/my repo', github: false, fetch: false };
		const hints = decide(
			[branch('feature/gone', { reason: 'upstream-gone', unpushedCommits: 1 }), branch('feature/dirty', { worktree: worktree({ path: '/wt/d', dirty: true }) })],
			{ scope }
		).map((entry) => entry.hint);
		assert.deepStrictEqual(hints, [
			"gsp -C '/my repo' clean feature/gone --no-github --no-fetch --yes --force",
			"git -C /wt/d stash --include-untracked && gsp -C '/my repo' clean feature/dirty --no-github --no-fetch --yes, or, to delete them for good: gsp -C '/my repo' worktree remove /wt/d --discard-changes && gsp -C '/my repo' clean feature/dirty --no-github --no-fetch --yes",
		]);
	});

	test('a forced deletion says so, and a half-done one says what is left', () => {
		const [forced] = decide([branch('feature/gone', { reason: 'upstream-gone', unpushedCommits: 1 })], { force: true });
		const halfDone: CleanBranch = { ...forced, worktree: { ...worktree({ path: '/wt/g' }), ignoredFiles: null, submodules: null, changedFiles: null }, result: 'worktree-removed', error: 'boom' };
		assert.deepStrictEqual(formatBranchLines(report([forced], 'plan')), [
			'delete  feature/gone  upstream origin/feature/gone is gone, 1 commit found nowhere else, forced',
		]);
		assert.deepStrictEqual(formatBranchLines(report([halfDone], 'apply')), [
			'failed  feature/gone  worktree removed, but the branch was not deleted: boom',
		]);
	});

	test('nothing to clean is said once', () => {
		assert.strictEqual(formatSummary(report([], 'plan')), 'Nothing to clean.');
		assert.strictEqual(formatSummary(report(decide([branch('a', { current: true })]), 'apply')), 'Nothing to clean · 1 skipped.');
		assert.deepStrictEqual(formatBranchLines(report([], 'plan')), []);
	});

	test('JSON document: stable keys, in a stable order', () => {
		const decided = decide([
			branch('feature/a', { worktree: worktree({ path: '/wt/a' }) }),
			branch('feature/gone', { reason: 'upstream-gone', evidence: { method: 'upstream-gone', upstream: 'origin/feature/gone' }, unpushedCommits: 1 }),
		]);
		const json = JSON.parse(JSON.stringify(report([{ ...decided[0], result: 'deleted', hint: null }, decided[1]], 'apply', ['feature/a'])));
		assert.deepStrictEqual(Object.keys(json), ['schema', 'mode', 'checks', 'branches', 'worktreesPruned', 'restore', 'summary']);
		assert.deepStrictEqual(json.branches, [
			{
				name: 'feature/a',
				tip: '0000000000000000000000000000000000000009',
				action: 'delete',
				reason: 'squash-merged',
				verdict: 'dead',
				verdictReason: 'squash-merged',
				evidence: { method: 'file-state', base: BASE, squashCommit: 'c'.repeat(40), files: 1, patchIdCommits: 0 },
				unpushedCommits: 0,
				upstream: 'origin/feature/a',
				upstreamState: 'gone',
				worktree: { path: '/wt/a', isMain: false, dirty: false, locked: false, prunable: false, inProgress: null, ignoredFiles: null, submodules: null, changedFiles: null },
				protected: null,
				needsForce: false,
				hint: null,
				result: 'deleted',
			},
			{
				name: 'feature/gone',
				tip: '0000000000000000000000000000000000000012',
				action: 'skip',
				reason: 'needs-force',
				verdict: 'dead',
				verdictReason: 'upstream-gone',
				evidence: { method: 'upstream-gone', upstream: 'origin/feature/gone' },
				unpushedCommits: 1,
				upstream: 'origin/feature/gone',
				upstreamState: 'gone',
				worktree: null,
				protected: null,
				needsForce: true,
				hint: 'gsp clean feature/gone --yes --force',
			},
		]);
		assert.deepStrictEqual(json.summary, { delete: 1, deleted: 1, failed: 0, skipped: 1, kept: 0, needsForce: 1, needsDiscardChanges: 0, reasons: { 'squash-merged': 1 } });
		assert.strictEqual(json.restore, 'gsp restore feature/a');
		assert.deepStrictEqual(json.checks.remote, { source: 'fetch', remotes: ['origin'] });
	});
});
