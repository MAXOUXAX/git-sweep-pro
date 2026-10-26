import * as assert from 'assert';
import { clearAll, invertSelection, selectAll } from '../../core/sweep-selection';
import type { PickItem } from '../../core/workflow';

const items = (): PickItem[] => [
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
});
