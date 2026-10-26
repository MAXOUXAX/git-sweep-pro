import type { AliveReason, AnalysisChecks, BranchAnalysis, BranchWorktree, DeadReason, Evidence, UpstreamState } from './branch-analysis';
import { quoteShellArg } from './git-command';

/*
 * What `gsp clean` decides for each branch, and how it reports it. Pure:
 * no Git, no I/O, so every safety rule can be tested on plain analyses.
 */

/** Version of the `--json` document. Bumped on any incompatible change. */
export const CLEAN_SCHEMA = 2;

/**
 * - `delete`: its work is proven to exist elsewhere and nothing holds it;
 * - `keep`: its work exists nowhere else (or it is the default branch);
 * - `skip`: it could be deleted, but a rule or a missing flag stops it (see {@link SkipReason}).
 */
export type CleanAction = 'delete' | 'keep' | 'skip';

/**
 * Why a branch that could be deleted is skipped. Each one comes with a hint
 * (the command that lifts it), except `protected`, which is deliberate.
 */
export type SkipReason =
	/** The default branch, or a `--protect` / `git-sweep-pro.protected` pattern. */
	| 'protected'
	/** `branch.<name>.deleteMerged` is false (the Git 2.56 opt-out). */
	| 'delete-merged-false'
	/** Checked out in the worktree gsp runs in. */
	| 'current-branch'
	/** Checked out in the main worktree, while gsp runs in a linked one. */
	| 'main-worktree'
	| 'locked-worktree'
	| 'dirty-worktree'
	/** Holds commits found nowhere else, or is alive and named explicitly: only `--force` deletes it. */
	| 'needs-force'
	/** Another local branch that is kept uses it as its upstream. */
	| 'tracked-by-kept-branch'
	/** Left out of the interactive picker. */
	| 'not-selected';

/** What happened to a branch when the plan was applied. */
export type CleanResult =
	/** Deleted, after removing its worktree when it had one. */
	| 'deleted'
	/** Its worktree was removed, then deleting the branch failed (see `error`). */
	| 'worktree-removed'
	/** Nothing was changed (see `error`). */
	| 'failed';

export type CleanBranch = {
	readonly name: string;
	readonly tip: string;
	readonly action: CleanAction;
	/** The skip reason for `skip`, otherwise the verdict reason. */
	readonly reason: DeadReason | AliveReason | SkipReason;
	readonly verdict: 'dead' | 'alive';
	/** Why the analysis found the branch dead or alive, whatever the action. */
	readonly verdictReason: DeadReason | AliveReason;
	readonly evidence: Evidence | null;
	readonly unpushedCommits: number;
	readonly upstream: string | null;
	readonly upstreamState: UpstreamState;
	readonly worktree: BranchWorktree | null;
	/** Deleting it needs `--force` (it is deleted with `--force`, or when picked interactively). */
	readonly needsForce: boolean;
	/** The exact command that resolves a skip, or applies a planned deletion; null when there is nothing to do. */
	readonly hint: string | null;
	readonly result?: CleanResult;
	readonly error?: string;
};

export type CleanMode = 'plan' | 'apply';

/** Where the state of the remote branches came from. */
export type RemoteCheck =
	/** `git fetch --prune` ran first (apply mode). */
	| { readonly source: 'fetch'; readonly remotes: readonly string[] }
	/** `git ls-remote --heads` was read, without writing anything (plan mode). */
	| { readonly source: 'ls-remote'; readonly remotes: readonly string[] }
	/** Only the local remote-tracking refs were read: they may be out of date. */
	| { readonly source: 'local-refs'; readonly reason: 'no-fetch' | 'no-remote' | 'unreachable'; readonly detail?: string };

export type CleanChecks = AnalysisChecks & { readonly remote: RemoteCheck };

export type CleanSummary = {
	/** Branches whose deletion is planned (plan) or was attempted (apply). */
	readonly delete: number;
	readonly deleted: number;
	readonly failed: number;
	readonly skipped: number;
	readonly kept: number;
	/** Skipped branches that `--force` would delete. */
	readonly needsForce: number;
	/** Deleted (apply) or planned (plan) branches per verdict reason, e.g. `{ "squash-merged": 2 }`. */
	readonly reasons: Readonly<Partial<Record<DeadReason | AliveReason, number>>>;
};

/** The `--json` document of `gsp clean`. */
export type CleanReport = {
	readonly schema: typeof CLEAN_SCHEMA;
	readonly mode: CleanMode;
	readonly checks: CleanChecks;
	readonly branches: readonly CleanBranch[];
	/** Worktree registrations whose directory is gone: pruned (apply) or that would be (plan). */
	readonly worktreesPruned: readonly string[];
	/** Undoes the deletions of this run, or null when nothing was deleted. */
	readonly restore: string | null;
	readonly summary: CleanSummary;
};

export type DecideOptions = {
	/** `--force`: branches with unpushed work, and alive branches named explicitly, are deleted too. */
	readonly force: boolean;
	/** Branch names given exactly on the command line (not globs). */
	readonly named: ReadonlySet<string>;
	/** Name of the default branch, for hints. */
	readonly defaultBranch: string | undefined;
	/** Branches picked interactively; the other candidates are skipped as `not-selected`. Undefined: no picker. */
	readonly picked?: ReadonlySet<string>;
};

/** True when `pattern` is a glob rather than a branch name: Git forbids `*` and `?` in branch names. */
export function isBranchGlob(pattern: string): boolean {
	return /[*?]/.test(pattern);
}

function cmd(...args: string[]): string {
	return args.map(quoteShellArg).join(' ');
}

type Blocker = { readonly reason: SkipReason; readonly hint: string | null };

/** The first rule that stops a candidate, in order of precedence, ignoring `--force` and upstreams. */
function blockerOf(branch: BranchAnalysis, defaultBranch: string | undefined): Blocker | undefined {
	if (branch.protected?.by === 'default-branch' || branch.protected?.by === 'pattern') {
		return { reason: 'protected', hint: null };
	}
	if (branch.protected?.by === 'branch-config') {
		return { reason: 'delete-merged-false', hint: cmd('git', 'config', '--unset', branch.protected.key) };
	}
	const worktree = branch.worktree && !branch.worktree.prunable ? branch.worktree : null;
	if (branch.current) {
		return { reason: 'current-branch', hint: defaultBranch ? cmd('gsp', 'post-pr', defaultBranch) : 'git switch <another-branch>' };
	}
	if (worktree?.isMain) {
		return {
			reason: 'main-worktree',
			hint: `${cmd('git', '-C', worktree.path, 'switch')} ${defaultBranch ? quoteShellArg(defaultBranch) : '<another-branch>'}`,
		};
	}
	if (worktree?.locked) {
		return { reason: 'locked-worktree', hint: cmd('git', 'worktree', 'unlock', worktree.path) };
	}
	if (worktree?.dirty) {
		return { reason: 'dirty-worktree', hint: cmd('gsp', 'worktree', 'remove', worktree.path, '--force') };
	}
	return undefined;
}

/**
 * Decides the action of every analysed branch. A branch is deleted only with
 * a proof that its work exists elsewhere (dead, no unpushed commit); `--force`
 * extends that to dead branches with unpushed commits and to alive branches
 * named exactly. Protected branches, the current branch, branches in the main,
 * a locked or a dirty worktree, and the upstream of a kept branch are never
 * deleted, whatever the flags.
 */
export function decideActions(branches: readonly BranchAnalysis[], options: DecideOptions): CleanBranch[] {
	const decided = branches.map((branch): CleanBranch => {
		const named = options.named.has(branch.name);
		const candidate = branch.verdict === 'dead' || named;
		const needsForce = candidate && (branch.verdict === 'alive' || branch.unpushedCommits > 0);
		const make = (action: CleanAction, reason: CleanBranch['reason'], hint: string | null): CleanBranch => ({
			name: branch.name,
			tip: branch.tip,
			action,
			reason,
			verdict: branch.verdict,
			verdictReason: branch.reason,
			evidence: branch.evidence,
			unpushedCommits: branch.unpushedCommits,
			upstream: branch.upstream,
			upstreamState: branch.upstreamState,
			worktree: branch.worktree,
			needsForce,
			hint,
		});
		if (!candidate) {
			return make('keep', branch.reason, null);
		}
		const blocker = blockerOf(branch, options.defaultBranch);
		if (blocker) {
			return make('skip', blocker.reason, blocker.hint);
		}
		if (needsForce && !options.force && !options.picked?.has(branch.name)) {
			return make('skip', 'needs-force', cmd('gsp', 'clean', branch.name, '--yes', '--force'));
		}
		if (options.picked && !options.picked.has(branch.name)) {
			return make('skip', 'not-selected', cmd('gsp', 'clean', branch.name));
		}
		return make('delete', branch.reason, cmd('gsp', 'clean', branch.name, '--yes', ...(needsForce ? ['--force'] : [])));
	});

	// A branch another kept branch tracks stays, so that branch keeps its upstream.
	// Skipping one can strand the branch it tracks in turn: repeat until stable.
	const upstreamOf = new Map(branches.map((branch) => [branch.name, branch.upstreamOf]));
	for (let changed = true; changed; ) {
		changed = false;
		const deleting = new Set(decided.filter((branch) => branch.action === 'delete').map((branch) => branch.name));
		for (const [index, branch] of decided.entries()) {
			const kept = (upstreamOf.get(branch.name) ?? []).filter((name) => !deleting.has(name));
			if (branch.action === 'delete' && kept.length > 0) {
				decided[index] = {
					...branch,
					action: 'skip',
					reason: 'tracked-by-kept-branch',
					hint: kept.map((name) => cmd('git', 'branch', '--unset-upstream', name)).join(' && '),
				};
				changed = true;
			}
		}
	}
	return decided;
}

/** True when the plan holds deletions that applying it, or adding `--force`, would carry out. */
export function hasPendingDeletions(branches: readonly CleanBranch[]): boolean {
	return branches.some((branch) => (branch.action === 'delete' && branch.result === undefined) || branch.reason === 'needs-force');
}

export function summarize(branches: readonly CleanBranch[], mode: CleanMode): CleanSummary {
	const count = (test: (branch: CleanBranch) => boolean) => branches.filter(test).length;
	const counted = branches.filter((branch) => (mode === 'apply' ? branch.result === 'deleted' : branch.action === 'delete'));
	const reasons: Partial<Record<DeadReason | AliveReason, number>> = {};
	for (const branch of counted) {
		reasons[branch.verdictReason] = (reasons[branch.verdictReason] ?? 0) + 1;
	}
	return {
		delete: count((branch) => branch.action === 'delete'),
		deleted: count((branch) => branch.result === 'deleted'),
		failed: count((branch) => branch.result === 'failed' || branch.result === 'worktree-removed'),
		skipped: count((branch) => branch.action === 'skip'),
		kept: count((branch) => branch.action === 'keep'),
		needsForce: count((branch) => branch.reason === 'needs-force'),
		reasons,
	};
}

/** The command that restores `branches`, or null when there are none. */
export function restoreCommand(branches: readonly string[]): string | null {
	return branches.length > 0 ? cmd('gsp', 'restore', ...branches) : null;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Where the analysis compared the branch, e.g. "origin/main". */
function baseName(evidence: Evidence | null): string {
	const base = evidence && 'base' in evidence ? evidence.base : '';
	return base.replace(/^refs\/(heads|remotes)\//, '');
}

/** Why the analysis found a branch dead or alive, in words. */
export function describeVerdict(branch: Pick<CleanBranch, 'verdictReason' | 'evidence' | 'unpushedCommits' | 'upstream'>): string {
	const { evidence } = branch;
	const into = baseName(evidence);
	switch (branch.verdictReason) {
		case 'empty':
			return into ? `no commits beyond ${into}` : 'no commits of its own';
		case 'merged':
		case 'rebase-merged':
		case 'squash-merged':
			return `${branch.verdictReason} into ${into}`;
		case 'pr-merged':
			return evidence?.method === 'pull-request' ? `pull request #${evidence.pullRequest} merged` : 'pull request merged';
		case 'commits-merged':
			return `every commit merged into ${into}`;
		case 'upstream-gone':
			return branch.unpushedCommits > 0
				? `upstream ${branch.upstream ?? ''} is gone, ${plural(branch.unpushedCommits, 'commit')} found nowhere else`
				: `upstream ${branch.upstream ?? ''} is gone, every commit is on a remote`;
		case 'default-branch':
			return 'default branch';
		case 'open-pr':
			return evidence?.method === 'pull-request' ? `pull request #${evidence.pullRequest} is open` : 'pull request is open';
		case 'unmerged-commits':
			return evidence?.method === 'unique-commits' ? `${plural(evidence.commits, 'commit')} not merged into ${into}` : 'commits not merged';
		case 'no-base':
			return 'no default branch to compare with';
	}
}

/** Why a candidate is skipped, in words. */
function describeSkip(branch: CleanBranch): string {
	const worktree = branch.worktree?.path ?? '';
	switch (branch.reason) {
		case 'protected':
			return branch.verdictReason === 'default-branch' ? 'default branch' : 'protected';
		case 'delete-merged-false':
			return `branch.${branch.name}.deleteMerged is false`;
		case 'current-branch':
			return 'current branch';
		case 'main-worktree':
			return `checked out in the main worktree ${worktree}`;
		case 'locked-worktree':
			return `worktree ${worktree} is locked`;
		case 'dirty-worktree':
			return `worktree ${worktree} has uncommitted changes`;
		case 'needs-force':
			return 'needs --force';
		case 'tracked-by-kept-branch':
			return 'a kept branch tracks it';
		case 'not-selected':
			return 'not selected';
		default:
			return branch.reason;
	}
}

const ACTION_LABEL: Record<CleanAction | CleanResult, string> = {
	delete: 'delete',
	keep: 'keep',
	skip: 'skip',
	deleted: 'deleted',
	failed: 'failed',
	'worktree-removed': 'failed',
};

/** One line per branch: what was (or would be) done and why, e.g. "deleted  feature/x  squash-merged into origin/main". */
export function formatBranchLines(report: Pick<CleanReport, 'branches' | 'mode'>): string[] {
	const order: Record<CleanAction, number> = { delete: 0, skip: 1, keep: 2 };
	const branches = [...report.branches].sort((a, b) => order[a.action] - order[b.action]);
	const nameWidth = Math.max(0, ...branches.map((branch) => branch.name.length));
	return branches.map((branch) => {
		const label = ACTION_LABEL[branch.result ?? branch.action].padEnd(8);
		const verdict = describeVerdict(branch);
		let detail: string;
		if (branch.result === 'failed' || branch.result === 'worktree-removed') {
			detail = `${branch.result === 'worktree-removed' ? 'worktree removed, but the branch was not deleted: ' : ''}${branch.error ?? 'unknown error'}`;
		} else if (branch.action === 'skip') {
			const skip = describeSkip(branch);
			detail = `${skip === verdict ? skip : `${skip} (${verdict})`}${branch.hint ? ` → ${branch.hint}` : ''}`;
		} else {
			const worktree = branch.action === 'delete' && branch.worktree && !branch.worktree.prunable ? `, ${branch.result ? 'removed' : 'removes'} worktree ${branch.worktree.path}` : '';
			detail = `${verdict}${branch.needsForce && branch.action === 'delete' ? ', forced' : ''}${worktree}`;
		}
		return `${label}${branch.name.padEnd(nameWidth)}  ${detail}`;
	});
}

function describeReasons(reasons: CleanSummary['reasons']): string {
	const parts = Object.entries(reasons)
		.sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
		.map(([reason, count]) => `${count} ${reason}`);
	return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** The one summary line: e.g. "3 deleted (2 squash-merged, 1 empty) · 2 skipped · restore with gsp restore a b c". */
export function formatSummary(report: CleanReport): string {
	const { summary, mode } = report;
	if (summary.delete === 0 && summary.needsForce === 0 && report.worktreesPruned.length === 0) {
		return summary.skipped > 0 ? `Nothing to clean · ${summary.skipped} skipped.` : 'Nothing to clean.';
	}
	const parts: string[] = [];
	if (mode === 'plan') {
		parts.push(`${summary.delete} to delete${describeReasons(summary.reasons)}`);
	} else {
		parts.push(`${summary.deleted} deleted${describeReasons(summary.reasons)}`);
		if (summary.failed > 0) {
			parts.push(`${summary.failed} failed`);
		}
	}
	if (summary.skipped > 0) {
		const force = summary.needsForce > 0 ? ` (${summary.needsForce} ${summary.needsForce === 1 ? 'needs' : 'need'} --force)` : '';
		parts.push(`${summary.skipped} skipped${force}`);
	}
	if (report.worktreesPruned.length > 0) {
		parts.push(`${plural(report.worktreesPruned.length, 'worktree registration')} ${mode === 'plan' ? 'to prune' : 'pruned'}`);
	}
	if (report.restore) {
		parts.push(`restore with ${report.restore}`);
	}
	return parts.join(' · ');
}
