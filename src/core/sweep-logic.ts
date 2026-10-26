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
