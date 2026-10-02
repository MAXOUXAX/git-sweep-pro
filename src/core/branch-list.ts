import type { WorkflowUi } from './workflow';

export type BranchItem = {
	readonly label: string;
	readonly ref: string;
	readonly isRemote: boolean;
	/** Local branch checked out in another worktree (it cannot be checked out here). */
	readonly inOtherWorktree?: boolean;
};

/**
 * Parses `git branch -a` output into local and remote branch items.
 * Local branches: "  feature/foo", "* main" (current, excluded) or
 * "+ feature/bar" (checked out in another worktree).
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
		const inOtherWorktree = line.startsWith('+');
		const name = line.replace(/^[*+]\s+/, '').trim();
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
				...(inOtherWorktree && { inOtherWorktree: true }),
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

export type ChooseBranchOptions = {
	/** Branch named on the command line: a local branch, or a remote-tracking ref such as "origin/main". */
	readonly requested: string | undefined;
	readonly title: string;
	readonly placeholder: string;
	readonly describe: (branch: BranchItem) => string | undefined;
	/** The default choice. */
	readonly preferred?: BranchItem;
};

/**
 * The branch to switch to or sync with: the one requested, otherwise the one
 * picked. Resolves to `undefined` when the picker is dismissed, and throws
 * when the requested branch does not exist.
 */
export async function chooseBranch(
	ui: WorkflowUi,
	branches: readonly BranchItem[],
	{ requested, title, placeholder, describe, preferred }: ChooseBranchOptions
): Promise<BranchItem | undefined> {
	if (requested !== undefined) {
		const named = branches.find((branch) => branch.ref === requested);
		if (!named) {
			throw new Error(`Branch "${requested}" is not available. Choose one of: ${branches.map(branchPickLabel).join(', ')}`);
		}
		return named;
	}

	const items = branches.map((branch) => {
		const description = describe(branch);
		return { label: branchPickLabel(branch), ...(description && { description }), ...(branch === preferred && { picked: true }) };
	});
	const label = await ui.pickBranch({ items, title, placeholder });
	if (label === undefined) {
		return undefined;
	}
	const picked = branches.find((branch) => branchPickLabel(branch) === label);
	if (!picked) {
		throw new Error(`Unknown branch picked: ${label}`);
	}
	return picked;
}

/**
 * The local branch in another worktree that `item` resolves to, if any: the
 * item itself, or for a remote ref ("origin/main") the local branch of the
 * same name. Such a branch cannot be checked out here.
 */
export function findOtherWorktreeBranch(items: readonly BranchItem[], item: BranchItem): BranchItem | undefined {
	const local = localBranchName(item);
	return items.find((candidate) => !candidate.isRemote && candidate.inOtherWorktree && candidate.ref === local);
}
