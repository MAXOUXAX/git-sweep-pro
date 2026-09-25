type RunGit = (args: string[]) => Promise<{ stdout: string }>;

export type DefaultBranch = {
	/** Local name, e.g. "main". */
	readonly name: string;
	/** Remote-tracking ref the remote HEAD points to, e.g. "origin/main". */
	readonly remoteRef: string;
};

/**
 * Returns the default branch from the first remote's HEAD ref, or undefined.
 * Discovers the remote dynamically via refs/remotes/<remote>/HEAD; does not assume "origin".
 */
export async function getDefaultBranch(runGit: RunGit): Promise<DefaultBranch | undefined> {
	try {
		const list = await runGit(['for-each-ref', '--format=%(refname)', 'refs/remotes/*/HEAD']);
		const firstRef = list.stdout.trim().split(/\r?\n/)[0];
		const remote = firstRef?.match(/^refs\/remotes\/([^/]+)\/HEAD$/)?.[1];
		if (!remote) {
			return undefined;
		}
		const remoteRef = (await runGit(['rev-parse', '--abbrev-ref', firstRef])).stdout.trim();
		const prefix = `${remote}/`;
		return remoteRef.startsWith(prefix) ? { name: remoteRef.slice(prefix.length), remoteRef } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * How a branch's work reached the default branch:
 * - `merged`: its tip is reachable from it (merge commit or fast-forward);
 * - `rebase-merged`: each of its commits has an equivalent patch there;
 * - `squash-merged`: its combined change was applied there as one commit.
 */
export type MergeKind = 'merged' | 'rebase-merged' | 'squash-merged';

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

const lines = (output: string): string[] =>
	output
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);

/** Every commit `git cherry` lists starts with "-": its patch already exists upstream. */
function allPatchesUpstream(cherryOutput: string): boolean {
	const commits = lines(cherryOutput);
	return commits.length > 0 && commits.every((line) => line.startsWith('-'));
}

// commit-tree needs an identity and must not ask for a signature. The probe
// commit is never referenced, so Git garbage-collects it like any other.
const PROBE_COMMIT_CONFIG = ['-c', 'user.name=git-sweep-pro', '-c', 'user.email=git-sweep-pro@localhost', '-c', 'commit.gpgsign=false'];

async function classify(runGit: RunGit, branch: string, base: string): Promise<MergeKind | undefined> {
	try {
		if (allPatchesUpstream((await runGit(['cherry', base, branch])).stdout)) {
			return 'rebase-merged';
		}
		// Squash merge: rebuild the branch's whole change as one throwaway commit
		// on the merge base, then ask whether the base has an equivalent patch.
		const mergeBase = (await runGit(['merge-base', base, branch])).stdout.trim();
		const [tree, baseTree] = lines((await runGit(['rev-parse', `${branch}^{tree}`, `${mergeBase}^{tree}`])).stdout);
		if (tree === baseTree) {
			// No net change: an empty patch would match any empty commit.
			return undefined;
		}
		const probe = (
			await runGit([...PROBE_COMMIT_CONFIG, 'commit-tree', tree, '-p', mergeBase, '-m', `git-sweep-pro squash probe for ${branch}`])
		).stdout.trim();
		return allPatchesUpstream((await runGit(['cherry', base, probe])).stdout) ? 'squash-merged' : undefined;
	} catch {
		// Unrelated histories (no merge base) and the like: not merged.
		return undefined;
	}
}

/**
 * Finds which of `branches` already landed on the default branch's
 * remote-tracking ref, whatever the merge strategy. Skips the local default
 * branch and branches pointing exactly at the base (typically just created
 * from it): neither holds merged work.
 */
export async function findMergedBranches(runGit: RunGit, branches: readonly string[], base: DefaultBranch): Promise<MergedBranch[]> {
	const into = base.remoteRef;
	const [reachable, atBase] = await Promise.all(
		[`--merged=${into}`, `--points-at=${into}`].map(async (filter) =>
			new Set(lines((await runGit(['for-each-ref', filter, '--format=%(refname:short)', 'refs/heads'])).stdout))
		)
	);

	const result: MergedBranch[] = [];
	for (const name of branches) {
		if (name === base.name || atBase.has(name)) {
			continue;
		}
		const how = reachable.has(name) ? 'merged' : await classify(runGit, name, into);
		if (how) {
			result.push({ name, how, into });
		}
	}
	return result;
}
