import type { PickItem } from './workflow';

/** Marks every branch as selected. */
export function selectAll(items: readonly PickItem[]): PickItem[] {
	return items.map((item) => ({ ...item, picked: true }));
}

/** Clears the selection so no branch is checked. */
export function clearAll(items: readonly PickItem[]): PickItem[] {
	return items.map((item) => ({ ...item, picked: false }));
}

/** Toggles each branch's checked state. */
export function invertSelection(items: readonly PickItem[]): PickItem[] {
	return items.map((item) => ({ ...item, picked: !item.picked }));
}
