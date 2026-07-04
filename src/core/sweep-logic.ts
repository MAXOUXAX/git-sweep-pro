export type SweepMode = {
	readonly dryRun: boolean;
	readonly forceDelete: boolean;
};

export type SweepModeSetting = 'dryRun' | 'safeDelete' | 'forceDelete';

export type SweepSettings = {
	readonly defaultMode: SweepModeSetting;
	readonly protectedBranches: readonly string[];
	readonly autoFetchPrune: boolean;
	readonly confirmBeforeDelete: boolean;
};

export const DEFAULT_SWEEP_SETTINGS: SweepSettings = {
	defaultMode: 'safeDelete',
	protectedBranches: [],
	autoFetchPrune: true,
	confirmBeforeDelete: true,
};

/** Maps a configured default-mode setting to a concrete {@link SweepMode}. */
export function resolveModeFromSetting(setting: SweepModeSetting): SweepMode {
	switch (setting) {
		case 'dryRun':
			return { dryRun: true, forceDelete: false };
		case 'forceDelete':
			return { dryRun: false, forceDelete: true };
		case 'safeDelete':
		default:
			return { dryRun: false, forceDelete: false };
	}
}

const MODE_ACTION_LABELS: Record<SweepModeSetting, string> = {
	dryRun: 'Dry Run',
	safeDelete: 'Delete (safe -d)',
	forceDelete: 'Delete (force -D)',
};

/**
 * Returns the three mode-picker action labels ordered so the configured default
 * appears first (VS Code renders the first modal button as the primary action).
 */
export function orderModeActions(defaultMode: SweepModeSetting): string[] {
	const order: SweepModeSetting[] = ['safeDelete', 'forceDelete', 'dryRun'];
	const ordered = [defaultMode, ...order.filter((m) => m !== defaultMode)];
	return ordered.map((m) => MODE_ACTION_LABELS[m]);
}

export function resolveSweepModeAction(action: string | undefined): SweepMode | undefined {
	if (!action) {
		return undefined;
	}

	if (action === 'Dry Run') {
		return { dryRun: true, forceDelete: false };
	}

	if (action === 'Delete (safe -d)') {
		return { dryRun: false, forceDelete: false };
	}

	if (action === 'Delete (force -D)') {
		return { dryRun: false, forceDelete: true };
	}

	return undefined;
}

/**
 * Parses `git for-each-ref --format="%(refname:short)%09%(upstream:track)" refs/heads`
 * output into the list of local branch names whose upstream is gone.
 *
 * Each line has the form `<branch-name>\t<track>`, where `<track>` is `[gone]`
 * when the upstream has been deleted and empty or another state (e.g. `[ahead 1]`)
 * otherwise. This structured output is stable across Git versions and locales,
 * unlike the human-readable `git branch -vv`.
 */
export function parseGoneBranchRefs(forEachRefOutput: string): string[] {
	return forEachRefOutput
		.split('\n')
		.map((line) => {
			const tabIndex = line.indexOf('\t');
			if (tabIndex < 0) {
				return undefined;
			}
			const name = line.slice(0, tabIndex).trim();
			const track = line.slice(tabIndex + 1).trim();
			if (name.length === 0 || track !== '[gone]') {
				return undefined;
			}
			return name;
		})
		.filter((name): name is string => name !== undefined);
}

/**
 * Tests a branch name against a single glob-style pattern.
 *
 * Supported wildcards: `*` matches any sequence of characters (including `/`)
 * and `?` matches a single character. All other characters are matched
 * literally. Matching is anchored (the whole branch name must match).
 */
export function branchMatchesPattern(branch: string, pattern: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	const regexBody = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
	return new RegExp(`^${regexBody}$`).test(branch);
}

/**
 * Returns true when the branch matches any non-empty protected pattern.
 * Empty/whitespace-only patterns are ignored.
 */
export function isProtectedBranch(branch: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => {
		const trimmed = pattern.trim();
		return trimmed.length > 0 && branchMatchesPattern(branch, trimmed);
	});
}
