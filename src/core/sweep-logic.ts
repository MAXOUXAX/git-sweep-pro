export type SweepMode = {
	readonly dryRun: boolean;
	readonly forceDelete: boolean;
};

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
