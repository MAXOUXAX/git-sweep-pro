import {
	CLEAN_SCHEMA,
	approvalFlags,
	decideActions,
	formatBranchLines,
	formatSummary,
	RERUN_LIFTS,
	type CleanBranch,
	type CleanMode,
	type CleanReport,
	type PlannedBranch,
	withCommand,
} from './clean-plan';
import { quoteShellArg } from './git-command';

/*
 * What `gsp post-pr` decides for the branch whose pull request was merged,
 * and how it reports it. Pure: no Git, no I/O.
 */

/** Why the default branch was not fast-forwarded. */
export type DefaultBranchSkip =
	/** Already at its remote branch. */
	| 'up-to-date'
	/** Plan mode: it would be fast-forwarded. */
	| 'not-applied'
	/** It has no remote branch to follow. */
	| 'no-remote'
	/** There is no local branch to update. */
	| 'not-local'
	/** The worktree it is checked out in has uncommitted changes. */
	| 'dirty'
	/** It holds commits that are not on its remote branch: it cannot be fast-forwarded. */
	| 'diverged'
	/** The fast-forward failed (see `error`). */
	| 'failed';

export type DefaultBranchUpdate = {
	readonly name: string;
	/** Its local tip before the update, or null without a local branch. */
	readonly from: string | null;
	/** The tip of its remote branch, or null without one. */
	readonly to: string | null;
	/** Its remote branch, e.g. "origin/main". */
	readonly upstream: string | null;
	/** The worktree it is checked out in, fast-forwarded with `git merge --ff-only`; null when only the ref moves. */
	readonly where: string | null;
	readonly updated: boolean;
	/** Plan mode: its remote branch has commits that are not fetched yet, so the plan may change once they are. */
	readonly remoteAhead: boolean;
	/** Why it was not updated; null when it was. */
	readonly reason: DefaultBranchSkip | null;
	/** The command that finishes the update by hand, when it was skipped. */
	readonly hint: string | null;
	readonly error?: string;
};

export type PostPrWorktree = {
	/** Where the merged branch was checked out, or null. */
	readonly path: string | null;
	/** That linked worktree was removed with the branch. */
	readonly removed: boolean;
	/** That worktree is the main checkout: it was (apply) or would be (plan) switched to the default branch. */
	readonly switched: boolean;
};

/**
 * The merged branch, named on the command line, when it has no local branch but a remote branch, a merged pull
 * request or the deletion log knows it: `gh pr merge --delete-branch` deletes it, for one.
 */
export type NoLocalBranch = { readonly name: string; readonly action: 'no-local-branch' };

export const hasNoLocalBranch = (branch: PostPrReport['branch']): branch is NoLocalBranch => branch?.action === 'no-local-branch';

/** The `--json` document of `gsp post-pr`. */
export type PostPrReport = {
	readonly schema: typeof CLEAN_SCHEMA;
	readonly command: 'post-pr';
	readonly mode: CleanMode;
	/**
	 * The merged branch, as `gsp clean` reports a branch; `{ name, action: "no-local-branch" }` when the branch
	 * named has no local branch; null when there is none to finish (e.g. run on the default branch).
	 */
	readonly branch: CleanBranch | NoLocalBranch | null;
	readonly worktree: PostPrWorktree;
	readonly defaultBranch: DefaultBranchUpdate;
	/** The clean step that follows, run with proof-only rules (`gsp clean --yes`). */
	readonly clean: CleanReport;
	/** The directory to continue in, when the worktree gsp ran in was removed; otherwise null. */
	readonly nextCwd: string | null;
	/** Undoes every deletion of this run, or null when nothing was deleted. */
	readonly restore: string | null;
};

function cmd(...args: string[]): string {
	return args.map(quoteShellArg).join(' ');
}

/** The options of the run that the commands gsp suggests keep. */
export type PostPrScope = {
	/** `-C <path>`, as given. */
	readonly cwd?: string;
	readonly into?: string;
	readonly protectedPatterns: readonly string[];
	readonly github: boolean;
	readonly fetch: boolean;
	/** The only other branches the clean step may delete (`--clean`, or `--no-clean` when empty); every proven one when undefined. */
	readonly others?: readonly string[];
};

/** `gsp post-pr`, on `branch` when given, with the options of the run, then `flags`. */
export function postPrCommand(scope: PostPrScope, branch: string | undefined, ...flags: string[]): string {
	return cmd(
		'gsp',
		...(scope.cwd === undefined ? [] : ['-C', scope.cwd]),
		'post-pr',
		...(branch === undefined ? [] : [branch]),
		...(scope.into === undefined ? [] : ['--into', scope.into]),
		...scope.protectedPatterns.flatMap((pattern) => ['--protect', pattern]),
		...(scope.github ? [] : ['--no-github']),
		...(scope.fetch ? [] : ['--no-fetch']),
		...(scope.others === undefined ? [] : scope.others.length === 0 ? ['--no-clean'] : scope.others.flatMap((name) => ['--clean', name])),
		...flags
	);
}

/**
 * `scope`, for a command that applies a plan without going beyond it: the
 * clean step limited to the other branches the plan deletes, by name, as
 * with gsp clean. Never every proven branch, which could include one that
 * became deletable since.
 */
export function withPlannedOthers(scope: PostPrScope, others: readonly CleanBranch[]): PostPrScope {
	return { ...scope, others: others.filter((branch) => branch.action === 'delete' && branch.result === undefined).map((branch) => branch.name) };
}

export type DecideTargetOptions = {
	/** `--force`: a branch that is not merged, or holds unpushed commits, is deleted too. */
	readonly force: boolean;
	/** `--discard-changes`: its worktree goes even with ignored files a build does not recreate. */
	readonly discardChanges: boolean;
	/** The branch the pull request was merged into. */
	readonly into: string;
	/** For a branch checked out in the main checkout: whether that checkout has uncommitted changes to tracked files. */
	readonly mainCheckoutDirty: boolean;
	/** The default branch has commits on its remote that are not fetched yet: the merge may be among them. */
	readonly remoteAhead: boolean;
	/** The options of the run, kept by the hints. */
	readonly scope: PostPrScope;
	/** Another branch known to hold its work: the base of its merged pull request, or a remote branch that contains its tip. */
	readonly mergedElsewhere?: string;
	/** The remote its unpushed commits go to. */
	readonly pushRemote?: string;
};

/**
 * Decides what to do with the merged branch, with the rules of `gsp clean`
 * for a branch named explicitly: deleted only when proven merged, unless
 * `--force`. The worktree gsp runs in is no obstacle, since post-pr leaves
 * it; nor is the main checkout, which it switches to the default branch
 * first, unless it has uncommitted changes. Nor are the processes running in
 * its worktree: the person finishing the branch is often still in it. Hints
 * rerun post-pr, and suggest `--force` only when nothing else can prove the
 * branch merged.
 */
export function decideTarget(branch: PlannedBranch, options: DecideTargetOptions): CleanBranch {
	const worktree = branch.worktree && !branch.worktree.prunable ? { ...branch.worktree, processes: null } : null;
	const inMain = worktree?.isMain === true;
	const [decided] = decideActions(
		[{ ...branch, current: false, worktree: worktree && inMain ? { ...worktree, isMain: false, dirty: options.mainCheckoutDirty } : (worktree ?? branch.worktree) }],
		{ force: options.force, discardChanges: options.discardChanges, named: new Set([branch.name]), defaultBranch: options.into }
	);
	const again = (...flags: string[]) => postPrCommand(options.scope, branch.name, '--yes', ...flags);
	// The main checkout is switched, never removed.
	const shown = inMain ? (decided.action === 'delete' || !decided.worktree ? null : { ...decided.worktree, isMain: true }) : decided.worktree;
	if (decided.action === 'delete') {
		return { ...decided, worktree: shown, hint: again(...approvalFlags([decided])) };
	}
	if (decided.reason === 'needs-force') {
		return { ...decided, worktree: shown, hint: proveFirst(branch, options) ?? again('--force') };
	}
	if (inMain && decided.reason === 'dirty-worktree' && worktree) {
		// The main checkout is only switched: its changes are put aside, never removed with it.
		return { ...decided, worktree: shown, hint: `${cmd('git', '-C', worktree.path, 'stash', '--include-untracked')} && ${again()}` };
	}
	// Hints that rerun gsp clean on this branch rerun post-pr instead.
	return { ...decided, worktree: shown, hint: decided.hint?.split(cmd('gsp', 'clean', branch.name, '--yes')).join(again()) ?? null };
}

/** What may still prove a branch merged without `--force`, as a command, or undefined when nothing can. */
function proveFirst(branch: PlannedBranch, options: DecideTargetOptions): string | undefined {
	// Fetching may prove the merge: right after it, the commits of a branch whose upstream is pruned are found nowhere else yet.
	if (options.remoteAhead) {
		return postPrCommand(options.scope, branch.name, '--yes');
	}
	// Commits found nowhere else are lost on deletion: they go to the remote first.
	if (branch.unpushedCommits > 0) {
		return options.pushRemote === undefined ? undefined : cmd('git', 'push', '-u', options.pushRemote, branch.name);
	}
	if (options.mergedElsewhere !== undefined) {
		return postPrCommand({ ...options.scope, into: options.mergedElsewhere }, branch.name, '--yes');
	}
	return undefined;
}

const short = (sha: string | null) => sha?.slice(0, 7) ?? '';

/** What happened to the default branch, in one line, or undefined when there is nothing to say. */
export function formatDefaultBranch(update: DefaultBranchUpdate): string | undefined {
	const { name, upstream, where } = update;
	const range = `${short(update.from)}..${short(update.to)}`;
	const place = where ? ` in ${where}` : '';
	switch (update.reason) {
		case null:
			return `${name}: fast-forwarded to ${upstream ?? ''} (${range})${place}`;
		case 'not-applied':
			return `${name}: would fast-forward to ${upstream ?? ''} (${range})${place}`;
		case 'up-to-date':
			return `${name}: up to date with ${upstream ?? ''}`;
		case 'no-remote':
			return `${name}: no remote branch to update it from`;
		case 'not-local':
			return undefined;
		case 'dirty':
			return `${name}: not updated, ${where ?? ''} has uncommitted changes → commit or stash them, then run ${update.hint ?? ''}`;
		case 'diverged':
			return `${name}: not updated, it has commits that are not on ${upstream ?? ''}`;
		case 'failed':
			return `${name}: could not fast-forward to ${upstream ?? ''}: ${update.error ?? 'unknown error'}`;
	}
}

/** Plan mode: whether applying the plan would change something. */
function wouldChange(report: PostPrReport): boolean {
	const target = hasNoLocalBranch(report.branch) ? null : report.branch;
	return (
		target?.action === 'delete' ||
		report.defaultBranch.reason === 'not-applied' ||
		// Fetching updates the default branch, and may prove the merged branch.
		report.defaultBranch.remoteAhead ||
		report.clean.branches.some((branch) => branch.action === 'delete' && branch.result === undefined)
	);
}

/**
 * True when the report holds changes that were planned but not carried out:
 * whatever applying the plan would change (then `next` says how), the merged
 * branch kept, or other branches that need `--force`.
 */
export function hasPendingChanges(report: PostPrReport): boolean {
	return (
		(report.mode === 'plan' && wouldChange(report)) ||
		(report.branch !== null && !hasNoLocalBranch(report.branch) && report.branch.result !== 'deleted') ||
		report.clean.branches.some((branch) => (branch.action === 'delete' && branch.result === undefined) || branch.reason === 'needs-force')
	);
}

/**
 * The lines of a run, in order: the merged branch, the default branch, the
 * other branches the clean step deleted or skipped, and its summary.
 */
export function formatPostPrLines(report: PostPrReport): string[] {
	const lines: string[] = [];
	if (hasNoLocalBranch(report.branch)) {
		lines.push(`${report.branch.name} has no local branch; nothing to delete here.`);
	} else if (report.branch) {
		lines.push(...formatBranchLines({ branches: [report.branch], mode: report.mode }));
		if (report.worktree.switched && report.worktree.path) {
			const switched = report.mode === 'apply' ? 'switched' : 'switches';
			lines.push(`${report.defaultBranch.name}: ${switched} ${report.worktree.path} from ${report.branch.name} to ${report.defaultBranch.name}`);
		}
	} else {
		lines.push(`No branch to finish: on ${report.defaultBranch.name}.`);
	}
	const { defaultBranch } = report;
	const update = formatDefaultBranch(defaultBranch);
	if (update && !(defaultBranch.remoteAhead && defaultBranch.reason === 'up-to-date')) {
		lines.push(update);
	}
	if (defaultBranch.remoteAhead) {
		lines.push(
			`${defaultBranch.name}: ${defaultBranch.upstream ?? ''} has new commits that are not fetched yet, so this plan may change: "--yes" fetches them first.`
		);
	}
	const others = report.clean.branches.filter((branch) => branch.action !== 'keep');
	if (others.length > 0) {
		lines.push(...formatBranchLines({ branches: others, mode: report.mode }));
	}
	// The run's restore command is printed once, at the end.
	const summary = formatSummary({ ...report.clean, restore: null });
	lines.push(`Other branches: ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`);
	return lines;
}

/** The `--json` document of `gsp post-pr`: the report, and the command to run next (see {@link postPrNextCommand}). */
export type PostPrDocument = PostPrReport & { readonly next: string | null };

/**
 * The command to run next, or null when nothing is left that gsp can do on
 * its own: in a plan, the one that applies it, when applying would change
 * something; once applied, when some deletions were held back because
 * things changed meanwhile, the one that plans again to review them.
 * Otherwise, for a merged branch that is kept, the step of its hint that
 * loses nothing; one that only `--force` or `--discard-changes` deletes is
 * left to its own hint.
 */
export function postPrNextCommand(report: PostPrReport, scope: PostPrScope): string | null {
	const target = hasNoLocalBranch(report.branch) ? null : report.branch;
	if (report.mode === 'plan' && wouldChange(report)) {
		return postPrCommand(withPlannedOthers(scope, report.clean.branches), report.branch?.name, '--yes', ...(target?.action === 'delete' ? approvalFlags([target]) : []));
	}
	if (report.mode === 'apply' && heldBack(report) > 0) {
		return postPrCommand(scope, report.branch?.name, '--dry-run');
	}
	return target?.action === 'skip' ? safeStep(target) : null;
}

/**
 * The part of a kept branch's hint that loses nothing and needs no approval
 * (stash the changes, push, fetch, continue the rebase), or null when the
 * hint needs `--force`, `--discard-changes` or a person's hand first.
 */
function safeStep(branch: CleanBranch): string | null {
	const first = branch.hint?.split(', or, ')[0];
	if (!first || /(^| )--(force|discard-changes)( |$)/.test(first)) {
		return null;
	}
	switch (branch.reason) {
		case 'dirty-worktree':
		case 'rebase-in-progress':
		case 'bisect-in-progress':
		case 'needs-force':
			return first;
		default:
			return null;
	}
}

/** How many deletions were held back while applying, as things changed meanwhile. */
function heldBack(report: PostPrReport): number {
	const branches = [...(report.branch && !hasNoLocalBranch(report.branch) ? [report.branch] : []), ...report.clean.branches];
	return branches.filter((branch) => RERUN_LIFTS.has(branch.reason)).length;
}

/** What to do next, or undefined when there is nothing to say. */
export function formatNextSteps(report: PostPrReport, next: string | null): string[] {
	const steps: string[] = [];
	if (report.restore) {
		steps.push(`Undo with: ${report.restore}`);
	}
	if (report.nextCwd) {
		steps.push(`The worktree you ran gsp in was removed. Continue in the main checkout: cd ${quoteShellArg(report.nextCwd)}`);
	}
	if (next && report.mode === 'plan' && wouldChange(report)) {
		steps.push(withCommand('Nothing was changed. To apply this plan, run', next));
	}
	const held = heldBack(report);
	if (next && report.mode === 'apply' && held > 0) {
		steps.push(withCommand(`${held} not deleted, as things changed while applying. Review them with`, next));
	}
	return steps;
}
