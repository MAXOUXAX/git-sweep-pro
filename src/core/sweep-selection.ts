import type { SweepMode } from './sweep-logic';

/** A branch entry in the multi-select picker together with its checked state. */
export type SelectableBranch = {
	readonly label: string;
	readonly picked: boolean;
};

/** Marks every branch as selected. */
export function selectAll(items: readonly SelectableBranch[]): SelectableBranch[] {
	return items.map((item) => ({ ...item, picked: true }));
}

/** Clears the selection so no branch is checked. */
export function clearAll(items: readonly SelectableBranch[]): SelectableBranch[] {
	return items.map((item) => ({ ...item, picked: false }));
}

/** Toggles each branch's checked state. */
export function invertSelection(items: readonly SelectableBranch[]): SelectableBranch[] {
	return items.map((item) => ({ ...item, picked: !item.picked }));
}

/**
 * Human-readable description of the sweep mode, matching the flags the user sees
 * in Git: `dry run`, `safe delete (-d)`, or `force delete (-D)`.
 */
export function describeSweepMode(mode: SweepMode): string {
	if (mode.dryRun) {
		return 'dry run';
	}
	return mode.forceDelete ? 'force delete (-D)' : 'safe delete (-d)';
}

export type SweepSummary = {
	readonly totalDetected: number;
	readonly protectedCount: number;
	readonly selectedCount: number;
	readonly mode: SweepMode;
};

/**
 * Builds the multi-line preview shown before a sweep so the user understands
 * exactly what will happen: how many stale branches were detected, how many are
 * protected, how many are selected, and which mode will run.
 */
export function formatSweepSummary(summary: SweepSummary): string {
	const lines = [`Detected: ${summary.totalDetected} stale branch(es)`];
	if (summary.protectedCount > 0) {
		lines.push(`Protected (skipped): ${summary.protectedCount}`);
	}
	lines.push(`Selected: ${summary.selectedCount}`);
	lines.push(`Mode: ${describeSweepMode(summary.mode)}`);
	return lines.join('\n');
}

export type SweepOutcome = {
	readonly deleted: number;
	readonly skipped: number;
	readonly failed: number;
};

/**
 * Formats the post-run outcome with the counts the user cares about: how many
 * branches were deleted, intentionally skipped, and failed to delete.
 */
export function formatSweepOutcome(outcome: SweepOutcome): string {
	return `Deleted ${outcome.deleted} branch(es); ${outcome.skipped} skipped, ${outcome.failed} failed.`;
}
