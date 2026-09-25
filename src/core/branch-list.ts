export type BranchItem = {
	readonly label: string;
	readonly ref: string;
	readonly isRemote: boolean;
};

/**
 * Parses `git branch -a` output into local and remote branch items.
 * Local branches: "  feature/foo" or "* main"
 * Remote branches: "  remotes/origin/feature/bar"
 */
export function parseBranches(branchOutput: string): BranchItem[] {
	const lines = branchOutput
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith('('));

	const items: BranchItem[] = [];

	for (const line of lines) {
		const isCurrent = line.startsWith('*');
		const name = line.replace(/^\*\s+/, '').trim();
		if (!name || name === 'HEAD') {
			continue;
		}

		if (name.startsWith('remotes/')) {
			const shortName = name.replace(/^remotes\//, '');
			if (shortName.endsWith('/HEAD') || shortName.includes(' -> ')) {
				continue;
			}
			items.push({
				label: shortName,
				ref: shortName,
				isRemote: true,
			});
		} else if (!isCurrent) {
			/* Exclude the current branch (line starting with *) so it cannot be selected for checkout */
			items.push({
				label: name,
				ref: name,
				isRemote: false,
			});
		}
	}

	return items;
}

/**
 * Splits a remote-tracking ref such as "origin/feature/x" into its remote
 * ("origin") and branch ("feature/x") parts. Refs without a slash have no
 * remote part.
 */
export function splitRemoteRef(ref: string): { readonly remote: string | undefined; readonly branch: string } {
	const slashIdx = ref.indexOf('/');
	return slashIdx > 0
		? { remote: ref.slice(0, slashIdx), branch: ref.slice(slashIdx + 1) }
		: { remote: undefined, branch: ref };
}

/** The local branch name a picker entry corresponds to ("origin/main" -> "main"). */
export function localBranchName(item: BranchItem): string {
	return item.isRemote ? splitRemoteRef(item.ref).branch : item.ref;
}

/** Label shown for a branch in single-select pickers; remote refs get a "(remote)" suffix. */
export function branchPickLabel(item: BranchItem): string {
	return item.isRemote ? `${item.label} (remote)` : item.label;
}

/** Finds the branch whose {@link branchPickLabel} matches a picked label. */
export function findBranchByPickLabel(items: readonly BranchItem[], label: string): BranchItem | undefined {
	return items.find((item) => branchPickLabel(item) === label);
}
