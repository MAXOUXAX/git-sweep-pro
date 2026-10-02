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
		const { stdout } = await runGit(['for-each-ref', '--format=%(refname)%09%(symref)', 'refs/remotes/*/HEAD']);
		const [headRef, target = ''] = stdout.split('\n')[0].split('\t');
		const remote = /^refs\/remotes\/([^/]+)\/HEAD$/.exec(headRef)?.[1];
		const prefix = `refs/remotes/${remote}/`;
		// The full target ref: unlike a short name, it cannot be ambiguous with a local branch.
		const name = remote && target.startsWith(prefix) ? target.slice(prefix.length) : '';
		return name ? { name, remoteRef: `${remote}/${name}` } : undefined;
	} catch {
		return undefined;
	}
}
