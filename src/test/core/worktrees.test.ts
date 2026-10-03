import * as assert from 'assert';
import { describeWorktree, listWorktrees, parseWorktrees, pruneWorktrees, removeWorktree, resolveWorktree } from '../../core/worktrees';
import { createFakeContext } from '../fake-context';

const PORCELAIN = [
	'worktree /repo',
	'HEAD aaaa',
	'branch refs/heads/main',
	'',
	'worktree /repo/wt',
	'HEAD bbbb',
	'branch refs/heads/feature/x',
	'',
	'worktree /repo/detached',
	'HEAD cccc',
	'detached',
	'',
	'worktree /repo/locked',
	'HEAD dddd',
	'branch refs/heads/locked-branch',
	'locked in use',
	'',
	'worktree /repo/prunable',
	'HEAD eeee',
	'branch refs/heads/gone-branch',
	'prunable gitdir file points to non-existent location',
	'',
].join('\n');

const LINKED = { path: '/repo/wt', branch: 'feature/x', state: 'linked' } as const;

/** The same listing once Git has forgotten the prunable registration. */
const AFTER_PRUNE = PORCELAIN.slice(0, PORCELAIN.indexOf('worktree /repo/prunable')).trimEnd();

suite('worktrees', () => {
	test('parses the porcelain listing into path, branch and state', () => {
		assert.deepStrictEqual(parseWorktrees(PORCELAIN), [
			{ path: '/repo', branch: 'main', state: 'main' },
			{ path: '/repo/wt', branch: 'feature/x', state: 'linked' },
			{ path: '/repo/detached', branch: undefined, state: 'linked' },
			{ path: '/repo/locked', branch: 'locked-branch', state: 'locked' },
			{ path: '/repo/prunable', branch: 'gone-branch', state: 'prunable' },
		]);
	});

	test('a locked worktree is reported as locked even when it is also prunable', () => {
		const porcelain = ['worktree /repo', 'branch refs/heads/main', '', 'worktree /repo/both', 'branch refs/heads/x', 'locked', 'prunable gone', ''].join('\n');
		assert.strictEqual(parseWorktrees(porcelain)[1].state, 'locked');
	});

	test('an empty listing parses to no worktree', () => {
		assert.deepStrictEqual(parseWorktrees(''), []);
	});

	test('describeWorktree names the branch, or detached, and the state', () => {
		assert.strictEqual(describeWorktree({ path: '/repo', branch: 'main', state: 'main' }), '/repo  main (main)\n');
		assert.strictEqual(describeWorktree({ path: '/repo/wt', branch: undefined, state: 'linked' }), '/repo/wt  detached (linked)\n');
	});

	test('resolveWorktree matches a path, a path relative to the base, or a branch', () => {
		const worktrees = parseWorktrees(PORCELAIN);
		assert.deepStrictEqual(resolveWorktree(worktrees, '/repo/wt', '/repo'), { kind: 'found', worktree: LINKED });
		assert.deepStrictEqual(resolveWorktree(worktrees, 'wt', '/repo'), { kind: 'found', worktree: LINKED });
		assert.deepStrictEqual(resolveWorktree(worktrees, 'feature/x', '/repo'), { kind: 'found', worktree: LINKED });
		assert.deepStrictEqual(resolveWorktree(worktrees, 'nope', '/repo'), { kind: 'not-found', target: 'nope' });
	});

	test('resolveWorktree reads a relative path from the invocation directory, not the repository root', () => {
		const porcelain = ['worktree /repo', 'branch refs/heads/main', '', 'worktree /repo/nested/wt', 'branch refs/heads/feature/x', ''].join('\n');
		const linked = { path: '/repo/nested/wt', branch: 'feature/x', state: 'linked' };
		assert.deepStrictEqual(resolveWorktree(parseWorktrees(porcelain), 'wt', '/repo/nested'), { kind: 'found', worktree: linked });
		assert.deepStrictEqual(resolveWorktree(parseWorktrees(porcelain), 'wt', '/repo'), { kind: 'not-found', target: 'wt' });
	});

	test('resolveWorktree reports a path and a branch that name different worktrees', () => {
		const porcelain = [
			'worktree /repo',
			'branch refs/heads/main',
			'',
			'worktree /repo/feature/x',
			'branch refs/heads/other',
			'',
			'worktree /elsewhere',
			'branch refs/heads/feature/x',
			'',
		].join('\n');
		const resolution = resolveWorktree(parseWorktrees(porcelain), 'feature/x', '/repo');
		assert.strictEqual(resolution.kind, 'ambiguous');
		if (resolution.kind === 'ambiguous') {
			assert.deepStrictEqual(
				resolution.worktrees.map((worktree) => worktree.path),
				['/repo/feature/x', '/elsewhere']
			);
		}
	});

	test('listWorktrees reads the porcelain listing', async () => {
		const { context, commands } = createFakeContext({ git: { 'worktree list --porcelain': { stdout: PORCELAIN } } });
		assert.strictEqual((await listWorktrees(context)).length, 5);
		assert.deepStrictEqual(commands, ['worktree list --porcelain']);
	});

	test('pruneWorktrees diffs the registrations before and after the prune', async () => {
		const { context, commands } = createFakeContext({ git: { 'worktree list --porcelain': [{ stdout: PORCELAIN }, { stdout: AFTER_PRUNE }] } });
		assert.deepStrictEqual(await pruneWorktrees(context), { pruned: ['/repo/prunable'] });
		assert.deepStrictEqual(commands, ['worktree list --porcelain', 'worktree prune', 'worktree list --porcelain']);
	});

	test('pruneWorktrees with dryRun reports the prunable registrations without running git prune', async () => {
		const { context, commands } = createFakeContext({ git: { 'worktree list --porcelain': { stdout: PORCELAIN } } });
		assert.deepStrictEqual(await pruneWorktrees(context, true), { pruned: ['/repo/prunable'] });
		assert.deepStrictEqual(commands, ['worktree list --porcelain']);
	});

	test('removeWorktree resolves a branch to its path and removes it', async () => {
		const { context, commands } = createFakeContext({ git: { 'worktree list --porcelain': { stdout: PORCELAIN } } });
		assert.deepStrictEqual(await removeWorktree(context, 'feature/x', false), { kind: 'removed', worktree: LINKED });
		assert.deepStrictEqual(commands, ['worktree list --porcelain', 'worktree remove /repo/wt']);
	});

	test('removeWorktree passes --force when asked', async () => {
		const { context, commands } = createFakeContext({ git: { 'worktree list --porcelain': { stdout: PORCELAIN } } });
		assert.strictEqual((await removeWorktree(context, '/repo/wt', true)).kind, 'removed');
		assert.deepStrictEqual(commands, ['worktree list --porcelain', 'worktree remove --force /repo/wt']);
	});

	test('removeWorktree refuses the main worktree without running git', async () => {
		const { context, commands } = createFakeContext({ git: { 'worktree list --porcelain': { stdout: PORCELAIN } } });
		const result = await removeWorktree(context, 'main', false);
		assert.deepStrictEqual(result, { kind: 'main', worktree: { path: '/repo', branch: 'main', state: 'main' } });
		assert.deepStrictEqual(commands, ['worktree list --porcelain']);
	});

	test('removeWorktree reports an unknown target', async () => {
		const { context, commands } = createFakeContext({ git: { 'worktree list --porcelain': { stdout: PORCELAIN } } });
		assert.deepStrictEqual(await removeWorktree(context, 'nope', false), { kind: 'not-found', target: 'nope' });
		assert.deepStrictEqual(commands, ['worktree list --porcelain']);
	});

	test('removeWorktree resolves a relative target from the invocation directory', async () => {
		const porcelain = ['worktree /repo', 'branch refs/heads/main', '', 'worktree /repo/nested/wt', 'branch refs/heads/feature/x', ''].join('\n');
		const { context, commands } = createFakeContext({ git: { 'worktree list --porcelain': { stdout: porcelain } } });
		assert.strictEqual((await removeWorktree(context, 'wt', false, '/repo/nested')).kind, 'removed');
		assert.deepStrictEqual(commands, ['worktree list --porcelain', 'worktree remove /repo/nested/wt']);
	});

	test('removeWorktree refuses an ambiguous target instead of picking one silently', async () => {
		const porcelain = [
			'worktree /repo',
			'branch refs/heads/main',
			'',
			'worktree /repo/feature/x',
			'branch refs/heads/other',
			'',
			'worktree /elsewhere',
			'branch refs/heads/feature/x',
			'',
		].join('\n');
		const { context, commands } = createFakeContext({ git: { 'worktree list --porcelain': { stdout: porcelain } } });
		assert.strictEqual((await removeWorktree(context, 'feature/x', false, '/repo')).kind, 'ambiguous');
		assert.deepStrictEqual(commands, ['worktree list --porcelain']);
	});

	test("removeWorktree surfaces git's refusal for a dirty or locked worktree", async () => {
		const { context } = createFakeContext({
			git: {
				'worktree list --porcelain': { stdout: PORCELAIN },
				'worktree remove /repo/wt': new Error("fatal: '/repo/wt' contains modified or untracked files, use --force to delete it"),
			},
		});
		await assert.rejects(() => removeWorktree(context, 'feature/x', false), /contains modified or untracked files/);
	});
});
