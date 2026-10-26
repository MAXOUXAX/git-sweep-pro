import * as os from 'node:os';
import type { AliveReason, DeadReason } from '../core/branch-analysis';
import { describeVerdict, remoteBranchArg, type CleanBranch, type CleanDocument, type CleanRemoteBranch, type IgnoredFiles } from '../core/clean-plan';

/*
 * What the extension shows of a `gsp clean --json` document: picker sections,
 * confirmations and the result. Pure, so every wording is tested without VS Code.
 * Reasons come from the document; only their wording lives here.
 */

/** A branch in the clean picker. */
export type CleanEntry = {
	readonly scope: 'local' | 'remote';
	/** The branch as the command line names it: `feature/x`, or `origin/feature/x` on the remote. */
	readonly arg: string;
	/** The tip the plan read: applying passes it with `--expect`, so a branch that moved since is left alone. */
	readonly tip: string;
	readonly label: string;
	readonly description: string;
	readonly detail?: string;
	/** Can be picked: planned deletions, and in force mode the branches only a forced delete removes. */
	readonly selectable: boolean;
	readonly picked: boolean;
	/** Picking it needs `--force`. */
	readonly forced: boolean;
	/** Forced because its work is not proven to exist elsewhere (not only for its ignored files). */
	readonly unproven: boolean;
	/** The command that resolves a skip, if any. */
	readonly hint: string | null;
	/** The worktree deleting it removes, and the ignored files that go with it. */
	readonly worktree?: { readonly path: string; readonly ignoredFiles: IgnoredFiles | null };
	/** On the remote: the local branches whose upstream it is. It goes only if they go too. */
	readonly trackedBy?: readonly string[];
};

/** `--expect <arg>=<tip>`: applying deletes the entry only if it is still at the tip the picker showed. */
export const expectArgs = (entries: readonly CleanEntry[]): string[] => entries.flatMap((entry) => ['--expect', `${entry.arg}=${entry.tip}`]);

export type CleanSection = { readonly title: string; readonly entries: readonly CleanEntry[] };

const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

/** A path as people read it: the home directory as `~`. */
export function displayPath(fsPath: string, home = os.homedir()): string {
	return home && (fsPath === home || fsPath.startsWith(`${home}/`)) ? `~${fsPath.slice(home.length)}` : fsPath;
}

/** The first ignored files, e.g. ".env, secrets/ and 3 more". */
export function describeIgnoredFiles({ count, sample }: IgnoredFiles, shown = 3): string {
	const names = sample.slice(0, shown);
	const rest = count - names.length;
	return rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(', ');
}

/** Why a local branch is skipped, in words. */
export function describeLocalSkip(branch: CleanBranch): string {
	const reason = branch.reason;
	switch (reason) {
		case 'protected':
			return describeProtection(branch);
		case 'delete-merged-false':
			return 'Git is set to keep it (deleteMerged is false)';
		case 'rebase-in-progress':
			return 'A rebase is in progress in its worktree';
		case 'bisect-in-progress':
			return 'A bisect is in progress in its worktree';
		case 'current-branch':
			return 'Current branch';
		case 'main-worktree':
			return 'Checked out in the main checkout';
		case 'locked-worktree':
			return 'Its worktree is locked';
		case 'dirty-worktree':
			return 'Its worktree has uncommitted changes';
		case 'submodules':
			return 'Its worktree holds submodules';
		case 'ignored-files': {
			const ignored = branch.worktree?.ignoredFiles;
			return ignored ? `Its worktree holds ${plural(ignored.count, 'ignored file')}: ${describeIgnoredFiles(ignored)}` : 'Its worktree holds ignored files';
		}
		case 'needs-force':
			return branch.verdict === 'alive' ? 'Not merged: needs a forced delete' : 'Needs a forced delete';
		case 'tracked-by-kept-branch':
			return 'A kept branch tracks it';
		case 'not-selected':
			return 'Not selected';
		case 'plan-changed':
			return 'Changed since the plan';
		case 'fetch-failed':
			return 'The fetch failed, so it could not be checked again';
		case 'worktree-changed':
			return 'Its worktree changed since the plan';
		default: {
			// Only verdicts are left: a new skip reason fails to compile here.
			const verdict: DeadReason | AliveReason = reason;
			return describeVerdict({ ...branch, verdictReason: verdict });
		}
	}
}

/** Why a remote branch is skipped, in words. */
export function describeRemoteSkip(branch: CleanRemoteBranch): string {
	const reason = branch.reason;
	switch (reason) {
		case 'protected':
			return describeProtection(branch);
		case 'tracked-by-kept-branch':
			return `Tracked by ${branch.trackedBy.join(', ')}, which ${branch.trackedBy.length === 1 ? 'is' : 'are'} kept`;
		case 'plan-changed':
			return `Changed on ${branch.remote} since the plan`;
		case 'fetch-failed':
			return `The fetch failed, so ${branch.remote} could not be checked again`;
		case 'remote-default-unknown':
			return `The default branch of ${branch.remote} is unknown`;
		case 'github-unavailable':
			return 'Its open pull requests could not be checked on GitHub';
		default: {
			const verdict: DeadReason | AliveReason = reason;
			return remoteVerdict({ ...branch, verdictReason: verdict });
		}
	}
}

function describeProtection(branch: Pick<CleanBranch, 'verdictReason' | 'protected'>): string {
	const protection = branch.protected;
	if (branch.verdictReason === 'default-branch' || protection?.by === 'default-branch') {
		return 'Default branch';
	}
	switch (protection?.by) {
		case 'pattern':
			return `Protected by "${protection.pattern}"`;
		case 'default-name':
			return 'Protected as a long-lived branch';
		case 'branch-config':
			return `Git is set to keep it (${protection.key} is false)`;
		default:
			return 'Protected';
	}
}

const remoteVerdict = (branch: CleanRemoteBranch) => describeVerdict({ ...branch, unpushedCommits: 0, upstream: null });

/**
 * A local branch only a forced delete removes: picked in force mode only.
 * A worktree holding ignored files is not: forcing lifts the merge proof,
 * never what a worktree would lose (`--discard-changes`).
 */
export const isForceable = (branch: CleanBranch): boolean => branch.reason === 'needs-force';

function localEntry(branch: CleanBranch, kind: 'delete' | 'force' | 'skip' | 'keep'): CleanEntry {
	const worktree = branch.worktree && !branch.worktree.isMain && !branch.worktree.prunable ? branch.worktree : undefined;
	const removes = worktree && (kind === 'delete' || kind === 'force') ? `Removes the worktree ${displayPath(worktree.path)}` : undefined;
	const details: Record<typeof kind, string | undefined> = {
		delete: removes,
		force: removes,
		skip: describeLocalSkip(branch),
		keep: undefined,
	};
	const detail = details[kind];
	return {
		scope: 'local',
		arg: branch.name,
		tip: branch.tip,
		label: `$(${kind === 'force' ? 'warning' : 'git-branch'}) ${branch.name}`,
		description: describeVerdict(branch),
		...(detail ? { detail } : {}),
		selectable: kind === 'delete' || kind === 'force',
		picked: kind === 'delete',
		forced: kind === 'force',
		unproven: kind === 'force' && branch.reason === 'needs-force',
		hint: branch.hint,
		...(worktree ? { worktree: { path: worktree.path, ignoredFiles: worktree.ignoredFiles } } : {}),
	};
}

function remoteEntry(branch: CleanRemoteBranch, kind: 'delete' | 'skip'): CleanEntry {
	return {
		scope: 'remote',
		arg: remoteBranchArg(branch),
		tip: branch.tip,
		label: `$(cloud) ${branch.remote}/${branch.name}`,
		description: remoteVerdict(branch),
		...(kind === 'skip' ? { detail: describeRemoteSkip(branch) } : {}),
		selectable: kind === 'delete',
		picked: kind === 'delete',
		forced: false,
		unproven: false,
		hint: branch.hint,
		trackedBy: branch.trackedBy,
	};
}

/**
 * The picker's sections, in reading order: what will be deleted (here, then
 * on the remote), what needs a forced delete (force mode only, never
 * picked), what is skipped and why, then what is kept. Kept remote branches
 * are left out: a remote holds many.
 */
export function buildCleanSections(document: CleanDocument, options: { readonly force: boolean }): CleanSection[] {
	const branches = document.branches;
	const forceable = (branch: CleanBranch) => branch.action === 'skip' && isForceable(branch);
	const remote = document.checks.cleanedRemote?.remote ?? document.remoteBranches?.[0]?.remote;
	const remoteBranches = document.remoteBranches ?? [];
	const sections: CleanSection[] = [
		{ title: 'To delete', entries: branches.filter((branch) => branch.action === 'delete').map((branch) => localEntry(branch, 'delete')) },
		{ title: `To delete on ${remote}`, entries: remoteBranches.filter((branch) => branch.action === 'delete').map((branch) => remoteEntry(branch, 'delete')) },
		{ title: 'Needs a forced delete', entries: options.force ? branches.filter(forceable).map((branch) => localEntry(branch, 'force')) : [] },
		{
			title: 'Skipped',
			entries: branches.filter((branch) => branch.action === 'skip' && !(options.force && forceable(branch))).map((branch) => localEntry(branch, 'skip')),
		},
		{ title: `Skipped on ${remote}`, entries: remoteBranches.filter((branch) => branch.action === 'skip').map((branch) => remoteEntry(branch, 'skip')) },
		{ title: 'Kept', entries: branches.filter((branch) => branch.action === 'keep').map((branch) => localEntry(branch, 'keep')) },
	];
	return sections.filter((section) => section.entries.length > 0);
}

/** The remote `--remote` cleaned, when the document has one. */
export function cleanedRemote(document: CleanDocument): string | undefined {
	return document.checks.cleanedRemote?.remote ?? document.summary.remote?.remote ?? document.remoteBranches?.[0]?.remote;
}

/** What to confirm before deleting local branches. */
export function confirmLocal(entries: readonly CleanEntry[]): { readonly message: string; readonly detail: string; readonly confirmLabel: string } {
	const names = listNames(entries.map((entry) => entry.arg));
	const worktrees = entries.filter((entry) => entry.worktree);
	const forced = entries.filter((entry) => entry.forced);
	const unproven = entries.filter((entry) => entry.unproven);
	const lines = [
		// One branch is named in the title already.
		...(entries.length > 1 ? [names] : []),
		...(worktrees.length > 0 ? [`This also removes ${plural(worktrees.length, 'worktree')}.`] : []),
		...(unproven.length === 0
			? []
			: [
					`${unproven.length === 1 ? `${unproven[0].arg} is` : `${unproven.length === entries.length ? 'They' : `${unproven.length} of them`} are`} not proven merged: undo brings ${unproven.length === 1 ? 'it' : 'them'} back only until Git cleans up unreachable commits.`,
				]),
		...(unproven.length === 0 ? ['You can undo this from the notification, or with gsp restore.'] : []),
	];
	return {
		message: `Delete ${entries.length === 1 ? entries[0].arg : plural(entries.length, 'branch', 'branches')}?`,
		detail: lines.join('\n\n'),
		confirmLabel: `${forced.length > 0 ? 'Force delete' : 'Delete'} ${entries.length === 1 ? 'branch' : 'branches'}`,
	};
}

/** What to confirm before deleting branches on a remote: they go for everyone. */
export function confirmRemote(entries: readonly CleanEntry[], remote: string): { readonly message: string; readonly detail: string; readonly confirmLabel: string } {
	return {
		message: `Delete ${entries.length === 1 ? entries[0].arg.slice(remote.length + 1) : plural(entries.length, 'branch', 'branches')} on ${remote}?`,
		detail: [...(entries.length > 1 ? [listNames(entries.map((entry) => entry.arg))] : []), `This deletes ${entries.length === 1 ? 'it' : 'them'} for everyone who uses ${remote}. You can push ${entries.length === 1 ? 'it' : 'them'} back from the notification, or with gsp restore.`].join('\n\n'),
		confirmLabel: `Delete on ${remote}`,
	};
}

const MAX_LISTED = 8;

/** The first names, then how many more: a dialog or a notification stays readable. */
function capNames(names: readonly string[]): string[] {
	const shown = names.slice(0, MAX_LISTED);
	return [...shown, ...(names.length > shown.length ? [`and ${names.length - shown.length} more`] : [])];
}

function listNames(names: readonly string[]): string {
	return capNames(names).join('\n');
}

/** Names in a sentence, e.g. "a, b and 3 more". */
export function listInline(names: readonly string[]): string {
	const shown = names.slice(0, MAX_LISTED);
	const rest = names.length - shown.length;
	const last = rest > 0 ? `${rest} more` : shown.pop();
	return shown.length > 0 ? `${shown.join(', ')} and ${last}` : (last ?? '');
}

/** The branches a run deleted, as `gsp restore` names them. */
export function deletedNames(document: Pick<CleanDocument, 'branches' | 'remoteBranches'>): string[] {
	return [
		...document.branches.filter((branch) => branch.result === 'deleted').map((branch) => branch.name),
		...(document.remoteBranches ?? []).filter((branch) => branch.result === 'deleted').map(remoteBranchArg),
	];
}

/** A branch that was meant to go but did not, with why. */
export type CleanProblem = { readonly arg: string; readonly why: string };

/** The planned deletions that failed or were held back while applying. */
export function cleanProblems(document: Pick<CleanDocument, 'branches' | 'remoteBranches'>, picked: ReadonlySet<string>): CleanProblem[] {
	const local = document.branches.flatMap((branch): CleanProblem[] => {
		if (branch.result === 'failed' || branch.result === 'worktree-removed') {
			return [{ arg: branch.name, why: branch.error ?? 'Git refused to delete it' }];
		}
		return picked.has(branch.name) && branch.result === undefined ? [{ arg: branch.name, why: describeLocalSkip(branch) }] : [];
	});
	const remote = (document.remoteBranches ?? []).flatMap((branch): CleanProblem[] => {
		const arg = remoteBranchArg(branch);
		if (branch.result === 'failed') {
			return [{ arg, why: branch.error ?? 'The push was refused' }];
		}
		return picked.has(arg) && branch.result === undefined ? [{ arg, why: describeRemoteSkip(branch) }] : [];
	});
	return [...local, ...remote];
}

/** The notification after applying: what was deleted, here and on the remote, then what was not and why. */
export function describeCleanResult(deleted: { readonly local: readonly string[]; readonly remote: readonly string[]; readonly remoteName?: string }, worktreesRemoved: number, problems: readonly CleanProblem[]): string {
	const parts: string[] = [];
	const local = deleted.local.length === 1 ? deleted.local[0] : plural(deleted.local.length, 'branch', 'branches');
	const remote = `${deleted.remote.length === 1 ? deleted.remote[0] : plural(deleted.remote.length, 'branch', 'branches')} on ${deleted.remoteName ?? 'the remote'}`;
	const worktrees = worktreesRemoved > 0 ? ` and ${plural(worktreesRemoved, 'worktree')}` : '';
	if (deleted.local.length > 0 && deleted.remote.length > 0) {
		parts.push(`Deleted ${local}${worktrees}. Also deleted ${remote}.`);
	} else if (deleted.local.length > 0) {
		parts.push(`Deleted ${local}${worktrees}.`);
	} else if (deleted.remote.length > 0) {
		parts.push(`Deleted ${remote}.`);
	} else {
		parts.push('Nothing was deleted.');
	}
	if (problems.length === 1) {
		parts.push(`${problems[0].arg} wasn't deleted: ${lowerFirst(problems[0].why)}.`);
	} else if (problems.length > 1) {
		parts.push(`${problems.length} branches weren't deleted: ${listInline(problems.map((problem) => `${problem.arg} (${lowerFirst(problem.why)})`))}.`);
	}
	return parts.join(' ');
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** The picker's placeholder: what pressing Enter does. `confirm`: proven deletions are confirmed first. */
export function pickerPlaceholder(sections: readonly CleanSection[], readOnly: boolean, confirm = true): string {
	const entries = sections.flatMap((section) => section.entries);
	const toDelete = entries.filter((entry) => entry.picked).length;
	const skipped = entries.filter((entry) => !entry.selectable && sections.some((section) => section.title.startsWith('Skipped') && section.entries.includes(entry))).length;
	if (readOnly) {
		return toDelete > 0 ? `${plural(toDelete, 'branch', 'branches')} to delete. Nothing changes until you run Sweep Stale Branches.` : 'Nothing to delete.';
	}
	if (!entries.some((entry) => entry.selectable)) {
		return skipped > 0 ? `Nothing to delete. ${plural(skipped, 'branch is', 'branches are')} skipped: see why below.` : 'Nothing to delete.';
	}
	return confirm ? 'Pick the branches to delete, then press Enter to review them.' : 'Pick the branches to delete, then press Enter to delete them.';
}
