import { analyzeBranches } from './branch-analysis';
import type { DefaultBranch } from './default-branch';
import type { RunGit } from './git-command';


/**
 * How a branch's work reached the default branch:
 * - `merged`: its tip is reachable from it (merge commit or fast-forward);
 * - `rebase-merged`: each of its commits has an equivalent patch there;
 * - `squash-merged`: its combined change was applied there as one commit;
 * - `commits-merged`: each of its commits landed there separately (an integration branch).
 */
export type MergeKind = 'merged' | 'rebase-merged' | 'squash-merged' | 'commits-merged';

export type MergedBranch = {
	readonly name: string;
	readonly how: MergeKind;
	/** The remote-tracking ref it was merged into, e.g. "origin/main". */
	readonly into: string;
};

/** e.g. "squash-merged into origin/main". */
export function describeMergedBranch(branch: MergedBranch): string {
	return `${branch.how} into ${branch.into}`;
}

/**
 * Finds which of `branches` already landed on the default branch's
 * remote-tracking ref, whatever the merge strategy, through the read-only
 * branch analysis (without GitHub). Skips the local default branch and
 * branches pointing exactly at the base (typically just created from it).
 */
export async function findMergedBranches(runGit: RunGit, branches: readonly string[], base: DefaultBranch): Promise<MergedBranch[]> {
	if (branches.length === 0) {
		return [];
	}
	const into = base.remoteRef;
	// Full refs: a local branch named like the remote one ("origin/main") would win otherwise.
	const { checks, branches: analysed } = await analyzeBranches({ git: runGit }, { base: `refs/remotes/${into}`, github: false, branches });
	const howOf = new Map(
		analysed.flatMap((branch): Array<[string, MergeKind]> => {
			if (branch.name === base.name || branch.verdict !== 'dead' || branch.tip === checks.base?.tip) {
				return [];
			}
			switch (branch.reason) {
				case 'empty':
				case 'merged':
					return [[branch.name, 'merged']];
				case 'rebase-merged':
				case 'squash-merged':
				case 'commits-merged':
					return [[branch.name, branch.reason]];
				default:
					return [];
			}
		})
	);
	return branches.flatMap((name) => {
		const how = howOf.get(name);
		return how ? [{ name, how, into }] : [];
	});
}
