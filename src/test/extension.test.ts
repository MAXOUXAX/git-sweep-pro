import * as assert from 'assert';
import {
	branchMatchesPattern,
	isNotFullyMergedError,
	isProtectedBranch,
} from '../core/sweep-logic';

suite('Extension Test Suite', () => {
	test('branchMatchesPattern matches literals exactly', () => {
		assert.strictEqual(branchMatchesPattern('main', 'main'), true);
		assert.strictEqual(branchMatchesPattern('maintenance', 'main'), false);
		assert.strictEqual(branchMatchesPattern('main', 'develop'), false);
	});

	test('branchMatchesPattern supports * across slashes', () => {
		assert.strictEqual(branchMatchesPattern('release/1.2', 'release/*'), true);
		assert.strictEqual(branchMatchesPattern('release/deep/nested', 'release/*'), true);
		assert.strictEqual(branchMatchesPattern('feature/x', 'release/*'), false);
	});

	test('branchMatchesPattern supports ? single-char wildcard', () => {
		assert.strictEqual(branchMatchesPattern('v1', 'v?'), true);
		assert.strictEqual(branchMatchesPattern('v12', 'v?'), false);
	});

	test('branchMatchesPattern treats regex metacharacters literally', () => {
		assert.strictEqual(branchMatchesPattern('feature.x', 'feature.x'), true);
		assert.strictEqual(branchMatchesPattern('featureax', 'feature.x'), false);
		assert.strictEqual(branchMatchesPattern('a+b', 'a+b'), true);
	});

	test('isProtectedBranch matches any non-empty pattern and ignores blanks', () => {
		assert.strictEqual(isProtectedBranch('main', ['main', 'release/*']), true);
		assert.strictEqual(isProtectedBranch('release/2.0', ['main', 'release/*']), true);
		assert.strictEqual(isProtectedBranch('feature/x', ['main', 'release/*']), false);
		assert.strictEqual(isProtectedBranch('feature/x', []), false);
		assert.strictEqual(isProtectedBranch('feature/x', ['   ', '']), false);
	});

	test('isNotFullyMergedError detects the squash/rebase safe-delete failure', () => {
		assert.strictEqual(
			isNotFullyMergedError("error: the branch 'feat/x' is not fully merged."),
			true
		);
		assert.strictEqual(
			isNotFullyMergedError("Command failed: git branch -d feat/x\nerror: The branch 'feat/x' is not fully merged"),
			true
		);
		assert.strictEqual(isNotFullyMergedError('fatal: not a git repository'), false);
		assert.strictEqual(isNotFullyMergedError('spawn git ENOENT'), false);
	});

});
