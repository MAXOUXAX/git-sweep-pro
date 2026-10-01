import * as assert from 'assert';
import { describeGitFailure, isNoUpstreamError, toErrorMessage } from '../../core/errors';

suite('errors', () => {
	test('toErrorMessage reads Error.message and stringifies anything else', () => {
		assert.strictEqual(toErrorMessage(new Error('boom')), 'boom');
		assert.strictEqual(toErrorMessage('plain'), 'plain');
		assert.strictEqual(toErrorMessage(42), '42');
	});

	test('describeGitFailure explains a missing repository', () => {
		assert.strictEqual(
			describeGitFailure('fatal: not a git repository (or any parent)', 'X:'),
			'Git Sweep Pro: The selected workspace folder is not a Git repository.'
		);
	});

	test('describeGitFailure explains a missing git executable', () => {
		const expected = 'Git Sweep Pro: Git is not installed or not available in PATH.';
		assert.strictEqual(describeGitFailure('spawn git ENOENT', 'X:'), expected);
		assert.strictEqual(describeGitFailure('git: command not found', 'X:'), expected);
	});

	test('describeGitFailure prefixes anything else', () => {
		assert.strictEqual(describeGitFailure('weird', 'Git Sweep Pro failed:'), 'Git Sweep Pro failed: weird');
	});

	test('isNoUpstreamError matches the pull messages for untracked branches', () => {
		assert.ok(isNoUpstreamError('There is no tracking information for the current branch.'));
		assert.ok(isNoUpstreamError('fatal: no upstream configured'));
		assert.ok(isNoUpstreamError('Please specify which branch you want to merge with.'));
		assert.ok(!isNoUpstreamError('CONFLICT (content): Merge conflict in a.txt'));
	});
});
