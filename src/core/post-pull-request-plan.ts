import {
	CLEAN_SCHEMA,
	decideActions,
	formatBranchLines,
	formatSummary,
	RERUN_LIFTS,
	type CleanBranch,
	type CleanMode,
	type CleanReport,
	type PlannedBranch,
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

/** The merged branch, named on the command line, when it no longer exists: `gh pr merge --delete-branch` deletes it, for one. */
export type GoneBranch = { readonly name: string; readonly action: 'gone' };

export const isGone = (branch: PostPrReport['branch']): branch is GoneBranch => branch?.action === 'gone';

/** The `--json` document of `gsp post-pr`. */
export type PostPrReport = {
	readonly schema: typeof CLEAN_SCHEMA;
	readonly command: 'post-pr';
	readonly mode: CleanMode;
	/**
	 * The merged branch, as `gsp clean` reports a branch; `{ name, action: "gone" }` when the branch named is
	 * already deleted; null when there is none to finish (e.g. run on the default branch).
	 */
	readonly branch: CleanBranch | GoneBranch | null;
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

export type DecideTargetOptions = {
	/** `--force`: a branch that is not merged, or holds unpushed commits, is deleted too. */
	readonly force: boolean;
	/** The branch the pull request was merged into. */
	readonly into: string;
	/** For a branch checked out in the main checkout: whether that checkout has uncommitted changes to tracked files. */
	readonly mainCheckoutDirty: boolean;
	/** The default branch has commits on its remote that are not fetched yet: the merge may be among them. */
	readonly remoteAhead: boolean;
};

/**
 * Decides what to do with the merged branch, with the rules of `gsp clean`
 * for a branch named explicitly: deleted only when proven merged, unless
 * `--force`. The worktree gsp runs in is no obstacle, since post-pr leaves
 * it; nor is the main checkout, which it switches to the default branch
 * first, unless it has uncommitted changes. Hints rerun post-pr.
 */
export function decideTarget(branch: PlannedBranch, options: DecideTargetOptions): CleanBranch {
	const worktree = branch.worktree && !branch.worktree.prunable ? branch.worktree : null;
	const inMain = worktree?.isMain === true;
	const [decided] = decideActions(
		[{ ...branch, current: false, worktree: worktree && inMain ? { ...worktree, isMain: false, dirty: options.mainCheckoutDirty } : branch.worktree }],
		{ force: options.force, named: new Set([branch.name]), defaultBranch: options.into }
	);
	const again = (...flags: string[]) => cmd('gsp', 'post-pr', branch.name, '--yes', ...flags);
	// The main checkout is switched, never removed.
	const shown = inMain ? (decided.action === 'delete' || !decided.worktree ? null : { ...decided.worktree, isMain: true }) : decided.worktree;
	if (decided.action === 'delete') {
		return { ...decided, worktree: shown, hint: again(...(decided.needsForce ? ['--force'] : [])) };
	}
	if (decided.reason === 'needs-force') {
		// Fetching may prove the merge: suggest that before forcing.
		return { ...decided, worktree: shown, hint: options.remoteAhead ? again() : again('--force') };
	}
	// Hints that rerun gsp clean on this branch rerun post-pr instead.
	return { ...decided, worktree: shown, hint: decided.hint?.split(cmd('gsp', 'clean', branch.name, '--yes')).join(again()) ?? null };
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

/** True when the report holds changes that were planned but not carried out. */
export function hasPendingChanges(report: PostPrReport): boolean {
	return (
		(report.branch !== null && !isGone(report.branch) && report.branch.result !== 'deleted') ||
		report.defaultBranch.reason === 'not-applied' ||
		report.clean.branches.some((branch) => (branch.action === 'delete' && branch.result === undefined) || branch.reason === 'needs-force')
	);
}

/**
 * The lines of a run, in order: the merged branch, the default branch, the
 * other branches the clean step deleted or skipped, and its summary.
 */
export function formatPostPrLines(report: PostPrReport): string[] {
	const lines: string[] = [];
	if (isGone(report.branch)) {
		lines.push(`${report.branch.name} is already deleted.`);
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

/** The options of the run that the next command keeps. */
export type PostPrScope = {
	/** `-C <path>`, as given. */
	readonly cwd?: string;
	readonly into?: string;
	readonly protectedPatterns: readonly string[];
	readonly github: boolean;
	readonly fetch: boolean;
};

/**
 * The command to run next, or null when nothing is left that gsp can do on
 * its own: in a plan, the one that applies it, when applying would change
 * something; once applied, when some deletions were held back because
 * things changed meanwhile, the one that plans again to review them. A
 * merged branch that only `--force` deletes is left to its own hint.
 */
export function postPrNextCommand(report: PostPrReport, scope: PostPrScope): string | null {
	const target = isGone(report.branch) ? null : report.branch;
	const rerun = (...flags: string[]) =>
		cmd(
			'gsp',
			...(scope.cwd === undefined ? [] : ['-C', scope.cwd]),
			'post-pr',
			...(report.branch ? [report.branch.name] : []),
			...(scope.into === undefined ? [] : ['--into', scope.into]),
			...scope.protectedPatterns.flatMap((pattern) => ['--protect', pattern]),
			...(scope.github ? [] : ['--no-github']),
			...(scope.fetch ? [] : ['--no-fetch']),
			...flags
		);
	if (report.mode === 'plan') {
		const applies =
			target?.action === 'delete' ||
			report.defaultBranch.reason === 'not-applied' ||
			report.defaultBranch.remoteAhead ||
			report.clean.branches.some((branch) => branch.action === 'delete' && branch.result === undefined);
		return applies ? rerun('--yes', ...(target?.action === 'delete' && target.needsForce ? ['--force'] : [])) : null;
	}
	return heldBack(report) > 0 ? rerun('--dry-run') : null;
}

/** How many deletions were held back while applying, as things changed meanwhile. */
function heldBack(report: PostPrReport): number {
	const branches = [...(report.branch && !isGone(report.branch) ? [report.branch] : []), ...report.clean.branches];
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
	if (next && report.mode === 'plan') {
		steps.push(`Nothing was changed. To apply this plan, run: ${next}`);
	}
	const held = heldBack(report);
	if (next && report.mode === 'apply' && held > 0) {
		steps.push(`${held} not deleted, as things changed while applying. Review them with: ${next}`);
	}
	return steps;
}
