import * as assert from 'assert';
import { parseBranches } from '../../core/branch-list';

suite('branch-list parseBranches', () => {
	test('parses local branches', () => {
		const output = [
			'  main',
			'  feature/login',
			'  develop',
		].join('\n');

		const result = parseBranches(output);

		assert.deepStrictEqual(result, [
			{ label: 'main', ref: 'main', isRemote: false },
			{ label: 'feature/login', ref: 'feature/login', isRemote: false },
			{ label: 'develop', ref: 'develop', isRemote: false },
		]);
	});

	test('parses remote branches', () => {
		const output = [
			'  remotes/origin/main',
			'  remotes/origin/feature/bar',
			'  remotes/upstream/develop',
		].join('\n');

		const result = parseBranches(output);

		assert.deepStrictEqual(result, [
			{ label: 'origin/main', ref: 'origin/main', isRemote: true },
			{ label: 'origin/feature/bar', ref: 'origin/feature/bar', isRemote: true },
			{ label: 'upstream/develop', ref: 'upstream/develop', isRemote: true },
		]);
	});

	test('filters out the current branch (marked with asterisk)', () => {
		const output = [
			'* main',
			'  feature/login',
			'  develop',
		].join('\n');

		const result = parseBranches(output);

		assert.deepStrictEqual(result, [
			{ label: 'feature/login', ref: 'feature/login', isRemote: false },
			{ label: 'develop', ref: 'develop', isRemote: false },
		]);
		assert.ok(!result.some((r) => r.label === 'main'));
	});

	test('handles HEAD symbolic reference (remotes/.../HEAD -> ...)', () => {
		const output = [
			'  remotes/origin/HEAD -> origin/main',
			'  remotes/origin/main',
			'  remotes/origin/feature/foo',
		].join('\n');

		const result = parseBranches(output);

		assert.ok(!result.some((r) => r.ref.includes('HEAD') || r.ref.includes('->')));
		assert.deepStrictEqual(result, [
			{ label: 'origin/main', ref: 'origin/main', isRemote: true },
			{ label: 'origin/feature/foo', ref: 'origin/feature/foo', isRemote: true },
		]);
	});

	test('handles standalone HEAD line (local detached state)', () => {
		const output = [
			'  HEAD',
			'  main',
			'  feature/foo',
		].join('\n');

		const result = parseBranches(output);

		assert.ok(!result.some((r) => r.label === 'HEAD' || r.ref === 'HEAD'));
		assert.deepStrictEqual(result, [
			{ label: 'main', ref: 'main', isRemote: false },
			{ label: 'feature/foo', ref: 'feature/foo', isRemote: false },
		]);
	});

	test('filters detached HEAD lines (in parentheses)', () => {
		const output = [
			'(HEAD detached at abc1234)',
			'  main',
			'  feature/foo',
		].join('\n');

		const result = parseBranches(output);

		assert.ok(!result.some((r) => r.label.includes('detached') || r.label.includes('abc1234')));
		assert.deepStrictEqual(result, [
			{ label: 'main', ref: 'main', isRemote: false },
			{ label: 'feature/foo', ref: 'feature/foo', isRemote: false },
		]);
	});

	test('filters detached HEAD line prefixed with current-branch asterisk', () => {
		const output = [
			'* (HEAD detached at abc1234)',
			'  main',
			'  feature/foo',
		].join('\n');

		const result = parseBranches(output);

		assert.ok(!result.some((r) => r.label.includes('detached') || r.label.includes('abc1234')));
		assert.deepStrictEqual(result, [
			{ label: 'main', ref: 'main', isRemote: false },
			{ label: 'feature/foo', ref: 'feature/foo', isRemote: false },
		]);
	});

	test('handles branches with slashes in names', () => {
		const output = [
			'  feature/auth/oauth',
			'  release/v1.0.0',
			'  remotes/origin/team/subteam/project',
		].join('\n');

		const result = parseBranches(output);

		assert.deepStrictEqual(result, [
			{ label: 'feature/auth/oauth', ref: 'feature/auth/oauth', isRemote: false },
			{ label: 'release/v1.0.0', ref: 'release/v1.0.0', isRemote: false },
			{ label: 'origin/team/subteam/project', ref: 'origin/team/subteam/project', isRemote: true },
		]);
	});

	test('handles branches with hyphens and underscores', () => {
		const output = [
			'  feature_fix-123',
			'  my-branch_name',
		].join('\n');

		const result = parseBranches(output);

		assert.deepStrictEqual(result, [
			{ label: 'feature_fix-123', ref: 'feature_fix-123', isRemote: false },
			{ label: 'my-branch_name', ref: 'my-branch_name', isRemote: false },
		]);
	});

	test('parses mixed output like git branch -a', () => {
		const output = [
			'* main',
			'  feature/login',
			'  remotes/origin/HEAD -> origin/main',
			'  remotes/origin/main',
			'  remotes/origin/feature/login',
		].join('\n');

		const result = parseBranches(output);

		assert.deepStrictEqual(result, [
			{ label: 'feature/login', ref: 'feature/login', isRemote: false },
			{ label: 'origin/main', ref: 'origin/main', isRemote: true },
			{ label: 'origin/feature/login', ref: 'origin/feature/login', isRemote: true },
		]);
	});

	test('returns empty array for empty or whitespace-only input', () => {
		assert.deepStrictEqual(parseBranches(''), []);
		assert.deepStrictEqual(parseBranches('\n\n  \n'), []);
	});

	test('ignores empty lines and trims leading/trailing whitespace on lines', () => {
		const output = [
			'',
			'  feature/foo  ',
			'  ',
			'  main',
		].join('\n');

		const result = parseBranches(output);

		assert.deepStrictEqual(result, [
			{ label: 'feature/foo', ref: 'feature/foo', isRemote: false },
			{ label: 'main', ref: 'main', isRemote: false },
		]);
	});
});
