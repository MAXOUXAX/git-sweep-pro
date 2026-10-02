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
