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
