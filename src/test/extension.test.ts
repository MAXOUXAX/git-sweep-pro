import * as assert from 'assert';
import { parseGoneBranchRefs, resolveSweepModeAction } from '../core/sweep-logic';

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
		assert.deepStrictEqual(resolveSweepModeAction('Dry Run'), {
			dryRun: true,
			forceDelete: false,
		});
	});

	test('resolveSweepModeAction maps safe delete action', () => {
		assert.deepStrictEqual(resolveSweepModeAction('Delete (safe -d)'), {
			dryRun: false,
			forceDelete: false,
		});
	});

	test('resolveSweepModeAction maps force delete action', () => {
		assert.deepStrictEqual(resolveSweepModeAction('Delete (force -D)'), {
			dryRun: false,
			forceDelete: true,
		});
	});

	test('resolveSweepModeAction returns undefined for cancel/unknown values', () => {
		assert.strictEqual(resolveSweepModeAction(undefined), undefined);
		assert.strictEqual(resolveSweepModeAction('Something else'), undefined);
	});

	test('resolveSweepModeAction is strict about exact labels', () => {
		assert.strictEqual(resolveSweepModeAction('dry run'), undefined);
		assert.strictEqual(resolveSweepModeAction(' Delete (safe -d) '), undefined);
	});

});
