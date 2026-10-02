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

/** `git for-each-ref` arguments whose output {@link parseLocalBranchRefs} understands. */
export const GONE_REFS_ARGS: readonly string[] = [
	'for-each-ref',
	'--format=%(refname:short)%09%(upstream:track)%09%(HEAD)%09%(worktreepath)',
	'refs/heads',
];

export type LocalBranchRef = {
	readonly name: string;
	/** The upstream tracking branch was deleted (`[gone]`). */
	readonly gone: boolean;
	/** Checked out in the worktree the command runs in. */
	readonly isCurrent: boolean;
	/** Worktree where the branch is checked out (this one or another), if any. */
	readonly worktreePath: string | undefined;
};

/**
 * Parses `git for-each-ref` output produced with {@link GONE_REFS_ARGS}.
 *
 * Each line has the form `<name>\t<track>\t<HEAD>\t<worktreepath>`, where
 * `<track>` is `[gone]` once the upstream has been deleted, `<HEAD>` is `*`
 * for the branch checked out here, and `<worktreepath>` is set for branches
 * checked out in any worktree. This structured output is stable across Git
 * versions and locales, unlike the human-readable `git branch -vv`. Trailing
 * fields may be missing.
 */
export function parseLocalBranchRefs(forEachRefOutput: string): LocalBranchRef[] {
	return forEachRefOutput
		.split('\n')
		.map((line): LocalBranchRef | undefined => {
			const [rawName, track = '', head = '', worktreePath = ''] = line.split('\t');
			const name = rawName.trim();
			if (name.length === 0 || line.indexOf('\t') < 0) {
				return undefined;
			}
			return {
				name,
				gone: track.trim() === '[gone]',
				isCurrent: head.trim() === '*',
				worktreePath: worktreePath.trim() || undefined,
			};
		})
		.filter((ref): ref is LocalBranchRef => ref !== undefined);
}

/** Names of the local branches whose upstream is gone (see {@link parseLocalBranchRefs}). */
export function parseGoneBranchRefs(forEachRefOutput: string): string[] {
	return parseLocalBranchRefs(forEachRefOutput)
		.filter((ref) => ref.gone)
		.map((ref) => ref.name);
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
