import type { SweepMode } from '../core/sweep-logic';

const MODE_ACTION_LABELS: Record<SweepMode, string> = {
	dryRun: 'Dry Run',
	safeDelete: 'Delete (safe -d)',
	forceDelete: 'Delete (force -D)',
};

/**
 * The mode-picker action labels, the configured default first (VS Code
 * renders the first modal button as the primary action).
 */
export function orderModeActions(defaultMode: SweepMode): string[] {
	const order: SweepMode[] = ['safeDelete', 'forceDelete', 'dryRun'];
	return [defaultMode, ...order.filter((mode) => mode !== defaultMode)].map((mode) => MODE_ACTION_LABELS[mode]);
}

/** Maps a label returned by the mode picker back to its {@link SweepMode}. */
export function resolveSweepModeAction(action: string | undefined): SweepMode | undefined {
	return (Object.keys(MODE_ACTION_LABELS) as SweepMode[]).find((mode) => MODE_ACTION_LABELS[mode] === action);
}
