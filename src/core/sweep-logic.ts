/** How a sweep deletes: not at all, with `git branch -d`, or with `git branch -D`. */
export type SweepMode = 'dryRun' | 'safeDelete' | 'forceDelete';

/** Repository-wide sweep preferences (VS Code settings, or CLI flags and git config). */
export type SweepSettings = {
	readonly protectedBranches: readonly string[];
	readonly autoFetchPrune: boolean;
	readonly confirmBeforeDelete: boolean;
	/** Also offer branches already merged into the default branch whose upstream is not gone. */
	readonly includeMergedBranches: boolean;
};

/**
 * Names of the local branches whose upstream is gone, from `git for-each-ref`
 * output whose lines start with `<name>\t<track>`, where `<track>` is
 * `[gone]` once the upstream has been deleted. This structured output is
 * stable across Git versions and locales, unlike the human-readable
 * `git branch -vv`. Fields after `<track>` are ignored.
 */
export function parseGoneBranchRefs(forEachRefOutput: string): string[] {
	return forEachRefOutput
		.split('\n')
		.filter((line) => line.indexOf('\t') >= 0)
		.map((line) => line.split('\t'))
		.filter(([name, track]) => name.trim().length > 0 && track.trim() === '[gone]')
		.map(([name]) => name.trim());
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

/**
 * Detects the `git branch -d` failure that means "this branch's commits are not
 * reachable from HEAD" (Git: `error: the branch 'X' is not fully merged`).
 *
 * This is the signature of a branch whose pull request was merged with a
 * **squash** or **rebase** strategy: the remote branch is gone, but the local
 * branch's commits were rewritten, so a safe delete refuses to remove it.
 */
export function isNotFullyMergedError(message: string): boolean {
	return /not fully merged/i.test(message);
}
