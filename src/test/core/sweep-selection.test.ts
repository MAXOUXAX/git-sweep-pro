import * as assert from 'assert';
import {
	clearAll,
	describeSweepMode,
	formatSweepOutcome,
	formatSweepSummary,
	invertSelection,
	selectAll,
	type SelectableBranch,
} from '../../core/sweep-selection';

const items = (): SelectableBranch[] => [
	{ label: 'feature/one', picked: true },
	{ label: 'feature/two', picked: false },
	{ label: 'hotfix/three', picked: true },
];

suite('sweep selection helpers', () => {
	test('selectAll marks every branch as picked', () => {
		assert.deepStrictEqual(selectAll(items()), [
			{ label: 'feature/one', picked: true },
			{ label: 'feature/two', picked: true },
			{ label: 'hotfix/three', picked: true },
		]);
	});

	test('clearAll unpicks every branch', () => {
		assert.deepStrictEqual(clearAll(items()), [
			{ label: 'feature/one', picked: false },
			{ label: 'feature/two', picked: false },
			{ label: 'hotfix/three', picked: false },
		]);
	});

	test('invertSelection toggles each branch', () => {
		assert.deepStrictEqual(invertSelection(items()), [
			{ label: 'feature/one', picked: false },
			{ label: 'feature/two', picked: true },
			{ label: 'hotfix/three', picked: false },
		]);
	});

	test('selection helpers do not mutate the input', () => {
		const original = items();
		selectAll(original);
		clearAll(original);
		invertSelection(original);
		assert.deepStrictEqual(original, items());
	});

	test('selection helpers handle an empty list', () => {
		assert.deepStrictEqual(selectAll([]), []);
		assert.deepStrictEqual(clearAll([]), []);
		assert.deepStrictEqual(invertSelection([]), []);
	});

	test('describeSweepMode reports the git flags the user sees', () => {
		assert.strictEqual(describeSweepMode({ dryRun: true, forceDelete: false }), 'dry run');
		assert.strictEqual(describeSweepMode({ dryRun: false, forceDelete: false }), 'safe delete (-d)');
		assert.strictEqual(describeSweepMode({ dryRun: false, forceDelete: true }), 'force delete (-D)');
		// dryRun wins over forceDelete when both are set.
		assert.strictEqual(describeSweepMode({ dryRun: true, forceDelete: true }), 'dry run');
	});

	test('formatSweepSummary omits the protected line when none are protected', () => {
		const summary = formatSweepSummary({
			totalDetected: 3,
			protectedCount: 0,
			selectedCount: 2,
			mode: { dryRun: false, forceDelete: false },
		});
		assert.strictEqual(
			summary,
			['Detected: 3 stale branch(es)', 'Selected: 2', 'Mode: safe delete (-d)'].join('\n')
		);
	});

	test('formatSweepSummary includes the protected line when some are protected', () => {
		const summary = formatSweepSummary({
			totalDetected: 5,
			protectedCount: 2,
			selectedCount: 3,
			mode: { dryRun: true, forceDelete: false },
		});
		assert.strictEqual(
			summary,
			[
				'Detected: 5 stale branch(es)',
				'Protected (skipped): 2',
				'Selected: 3',
				'Mode: dry run',
			].join('\n')
		);
	});

	test('formatSweepOutcome reports deleted, skipped, and failed counts', () => {
		assert.strictEqual(
			formatSweepOutcome({ deleted: 3, skipped: 1, failed: 0 }),
			'Deleted 3 branch(es); 1 skipped, 0 failed.'
		);
		assert.strictEqual(
			formatSweepOutcome({ deleted: 0, skipped: 0, failed: 2 }),
			'Deleted 0 branch(es); 0 skipped, 2 failed.'
		);
	});
});
