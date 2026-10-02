import * as assert from 'assert';
import { describeGitFailure, isNoUpstreamError, toErrorMessage } from '../../core/errors';

suite('errors', () => {
	test('toErrorMessage reads Error.message and stringifies anything else', () => {
		assert.strictEqual(toErrorMessage(new Error('boom')), 'boom');
		assert.strictEqual(toErrorMessage('plain'), 'plain');
		assert.strictEqual(toErrorMessage(42), '42');
	});

	test('describeGitFailure explains a missing repository', () => {
		assert.deepStrictEqual(
			describeGitFailure('fatal: not a git repository (or any parent)', { failed: true }),
			['This folder is not a Git repository.']
		);
	});

	test('describeGitFailure explains a missing git executable', () => {
		const expected = ['Git is not installed or not available in PATH.'];
		assert.deepStrictEqual(describeGitFailure('spawn git ENOENT', { failed: true }), expected);
		assert.deepStrictEqual(describeGitFailure('git: command not found'), expected);
	});

	test('describeGitFailure passes anything else through with the given options', () => {
		assert.deepStrictEqual(describeGitFailure('weird', { failed: true }), ['weird', { failed: true }]);
		assert.deepStrictEqual(describeGitFailure('weird'), ['weird']);
	});

	test('isNoUpstreamError matches the pull messages for untracked branches', () => {
		assert.ok(isNoUpstreamError('There is no tracking information for the current branch.'));
		assert.ok(isNoUpstreamError('fatal: no upstream configured'));
		assert.ok(isNoUpstreamError('Please specify which branch you want to merge with.'));
		assert.ok(!isNoUpstreamError('CONFLICT (content): Merge conflict in a.txt'));
	});
});
