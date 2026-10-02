import * as assert from 'assert';
import {
	branchMatchesPattern,
	isNotFullyMergedError,
	isProtectedBranch,
	parseGoneBranchRefs,
} from '../core/sweep-logic';
import { orderModeActions, resolveSweepModeAction } from '../vscode/sweep-mode';

suite('Extension Test Suite', () => {
	test('parseGoneBranchRefs returns empty list for empty output', () => {
		assert.deepStrictEqual(parseGoneBranchRefs(''), []);
	});

	test('parseGoneBranchRefs finds branches with gone upstream', () => {
		const output = [
			'feature/one\t[gone]',
			'feature/two\t[ahead 1]',
			'hotfix/three\t[gone]',
		].join('\n');

		assert.deepStrictEqual(parseGoneBranchRefs(output), ['feature/one', 'hotfix/three']);
	});

	test('parseGoneBranchRefs ignores local-only branches without upstream', () => {
		const output = [
			'local-only\t',
			'feature/tracked\t[ahead 2]',
		].join('\n');

		assert.deepStrictEqual(parseGoneBranchRefs(output), []);
	});

	test('parseGoneBranchRefs keeps parsing robust with surrounding whitespace', () => {
		const output = [
			'  feature/spaced  \t  [gone]  ',
			'feature/tabbed\t[gone]',
		].join('\n');

		assert.deepStrictEqual(parseGoneBranchRefs(output), ['feature/spaced', 'feature/tabbed']);
	});

	test('parseGoneBranchRefs handles unicode branch names', () => {
		const output = 'feat/éxample\t[gone]';
		assert.deepStrictEqual(parseGoneBranchRefs(output), ['feat/éxample']);
	});

	test('parseGoneBranchRefs supports branch names containing dots and dashes', () => {
		const output = 'release/2026.02-rc1\t[gone]';
		assert.deepStrictEqual(parseGoneBranchRefs(output), ['release/2026.02-rc1']);
	});

	test('parseGoneBranchRefs does not match lines without a branch name', () => {
		const output = '\t[gone]';
		assert.deepStrictEqual(parseGoneBranchRefs(output), []);
	});

	test('parseGoneBranchRefs ignores non-gone tracking states', () => {
		const output = [
			'feature/a\t[behind 1]',
			'feature/b\t[ahead 3, behind 2]',
			'feature/c\t',
		].join('\n');

		assert.deepStrictEqual(parseGoneBranchRefs(output), []);
	});

	test('parseGoneBranchRefs ignores empty lines and malformed entries', () => {
		const output = [
			'',
			'   ',
			'not a branch line',
			'valid/branch\t[gone]',
		].join('\n');

		assert.deepStrictEqual(parseGoneBranchRefs(output), ['valid/branch']);
	});

	test('resolveSweepModeAction maps Dry Run action', () => {
		assert.strictEqual(resolveSweepModeAction('Dry Run'), 'dryRun');
	});

	test('resolveSweepModeAction maps safe delete action', () => {
		assert.strictEqual(resolveSweepModeAction('Delete (safe -d)'), 'safeDelete');
	});

	test('resolveSweepModeAction maps force delete action', () => {
		assert.strictEqual(resolveSweepModeAction('Delete (force -D)'), 'forceDelete');
	});

	test('resolveSweepModeAction returns undefined for cancel/unknown values', () => {
		assert.strictEqual(resolveSweepModeAction(undefined), undefined);
		assert.strictEqual(resolveSweepModeAction('Something else'), undefined);
	});

	test('resolveSweepModeAction is strict about exact labels', () => {
		assert.strictEqual(resolveSweepModeAction('dry run'), undefined);
		assert.strictEqual(resolveSweepModeAction(' Delete (safe -d) '), undefined);
	});

	test('orderModeActions puts the configured default first', () => {
		assert.deepStrictEqual(orderModeActions('safeDelete'), [
			'Delete (safe -d)',
			'Delete (force -D)',
			'Dry Run',
		]);
		assert.deepStrictEqual(orderModeActions('forceDelete'), [
			'Delete (force -D)',
			'Delete (safe -d)',
			'Dry Run',
		]);
		assert.deepStrictEqual(orderModeActions('dryRun'), [
			'Dry Run',
			'Delete (safe -d)',
			'Delete (force -D)',
		]);
	});

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
