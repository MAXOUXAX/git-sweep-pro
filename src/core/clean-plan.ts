import type {
	AliveReason,
	AnalysisChecks,
	BranchAnalysis,
	BranchWorktree,
	DeadReason,
	Evidence,
	Protection,
	RemoteBranchAnalysis,
	UpstreamState,
} from './branch-analysis';
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
 * (the command that lifts it), except `protected` and `delete-merged-false`,
 * which are deliberate.
 */
export type SkipReason =
	/** The default branch, a `--protect` / `git-sweep-pro.protected` pattern, or a long-lived name not named exactly (see `protected`). */
	| 'protected'
	/** `branch.<name>.deleteMerged` is false (the Git 2.56 opt-out). */
	| 'delete-merged-false'
	/** A rebase of the branch is in progress in its worktree: never deleted, even with `--force`. */
	| 'rebase-in-progress'
	/** A bisect of the branch is in progress in its worktree: never deleted, even with `--force`. */
	| 'bisect-in-progress'
	/** Checked out in the worktree gsp runs in. */
	| 'current-branch'
	/** Checked out in the main worktree, while gsp runs in a linked one. */
	| 'main-worktree'
	| 'locked-worktree'
	| 'dirty-worktree'
	/** Its worktree holds submodules, which `git worktree remove` refuses to delete. */
	| 'submodules'
	/** Its worktree holds ignored files that are not regenerable (see `ignoredFiles`): removing it would delete them. `--force` lifts it. */
	| 'ignored-files'
	/** Holds commits found nowhere else, or is alive and named explicitly: only `--force` deletes it. */
	| 'needs-force'
	/** Another local branch that is kept uses it as its upstream. */
	| 'tracked-by-kept-branch'
	/** Left out of the interactive picker. */
	| 'not-selected'
	/** Applying: the analysis after the fetch no longer matches the plan that was shown or picked from, or the default branch changed. */
	| 'plan-changed'
	/** Applying: the fetch failed, and the only proof relies on remote-tracking refs that may be out of date. */
	| 'fetch-failed'
	/** Applying: its worktree changed since the analysis (other branch or commit, new changes, locked, new ignored files). */
	| 'worktree-changed';

/** Ignored files of a worktree that removing it would delete, regenerable ones left out. */
export type IgnoredFiles = {
	readonly count: number;
	/** The first few, relative to the worktree; a trailing `/` marks a whole ignored directory. */
	readonly sample: readonly string[];
};

/** A branch's worktree, with its ignored files and whether it holds submodules, when they were looked for (linked worktrees of candidates). */
export type CleanWorktree = BranchWorktree & { readonly ignoredFiles: IgnoredFiles | null; readonly submodules: boolean | null };

/** An analysed branch, what its worktree holds attached when it was looked for. */
export type PlannedBranch = Omit<BranchAnalysis, 'worktree'> & {
	readonly worktree: (BranchWorktree & { readonly ignoredFiles?: IgnoredFiles | null; readonly submodules?: boolean | null }) | null;
};

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
	readonly worktree: CleanWorktree | null;
	/** Why it is kept whatever its verdict, or null. */
	readonly protected: Protection | null;
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

/**
 * Why a branch on the remote that could be deleted is skipped. Besides the
 * local reasons that apply there:
 * - `remote-default-unknown`: the server did not say which branch is the remote's default (unreachable, `--no-fetch`, no HEAD): nothing can be proven there, every branch is skipped;
 * - `github-unavailable`: the remote is on GitHub, but its open pull requests could not all be read (`gh` missing, failing or unauthenticated, `--no-github`): the branch may be the head or base of one.
 */
export type RemoteSkipReason =
	| Extract<SkipReason, 'protected' | 'tracked-by-kept-branch' | 'plan-changed' | 'fetch-failed'>
	| 'remote-default-unknown'
	| 'github-unavailable';

/** What keeps every branch of the remote, or every one that would be deleted, from going (see {@link RemoteSkipReason}). */
export type RemoteBlocker = { readonly reason: Extract<RemoteSkipReason, 'remote-default-unknown' | 'github-unavailable'>; readonly hint: string | null };

/** What `gsp clean --remote` decides for a branch on the remote. Never forced: only proven branches go. */
export type CleanRemoteBranch = {
	readonly remote: string;
	/** Name on the remote, e.g. "feature/x". */
	readonly name: string;
	readonly tip: string;
	readonly action: CleanAction;
	/** The skip reason for `skip`, otherwise the verdict reason. */
	readonly reason: DeadReason | AliveReason | RemoteSkipReason;
	readonly verdict: 'dead' | 'alive';
	readonly verdictReason: DeadReason | AliveReason;
	readonly evidence: Evidence | null;
	readonly protected: Protection | null;
	/** Local branches whose upstream it is. */
	readonly trackedBy: readonly string[];
	/** The exact command that resolves a skip, or applies a planned deletion; null when there is nothing to do. */
	readonly hint: string | null;
	/** `deleted` on the remote, or `failed` (see `error`). */
	readonly result?: 'deleted' | 'failed';
	readonly error?: string;
};

/** The remote branches part of the summary. */
export type RemoteSummary = {
	readonly remote: string;
	readonly delete: number;
	readonly deleted: number;
	readonly failed: number;
	readonly skipped: number;
	readonly kept: number;
};

export type CleanSummary = {
	/** Branches whose deletion is planned (plan) or was attempted (apply). */
	readonly delete: number;
	readonly deleted: number;
	readonly failed: number;
	readonly skipped: number;
	readonly kept: number;
	/** Skipped branches that `--force` would delete (`needs-force` and `ignored-files`). */
	readonly needsForce: number;
	/** Deleted (apply) or planned (plan) branches per verdict reason, e.g. `{ "squash-merged": 2 }`. */
	readonly reasons: Readonly<Partial<Record<DeadReason | AliveReason, number>>>;
	/** With `--remote`: the same counts for the remote branches. */
	readonly remote?: RemoteSummary;
};

/** The `--json` document of `gsp clean`: the report, and the command to run next (see {@link nextCommand}). */
export type CleanDocument = CleanReport & { readonly next: string | null };

/** The report of `gsp clean`. */
export type CleanReport = {
	readonly schema: typeof CLEAN_SCHEMA;
	readonly mode: CleanMode;
	readonly checks: CleanChecks;
	readonly branches: readonly CleanBranch[];
	/** With `--remote`: the branches on that remote. Absent without it. */
	readonly remoteBranches?: readonly CleanRemoteBranch[];
	/** Worktree registrations whose directory is gone: pruned (apply) or that would be (plan). */
	readonly worktreesPruned: readonly string[];
	/** Undoes the deletions of this run, or null when nothing was deleted. */
	readonly restore: string | null;
	readonly summary: CleanSummary;
};

export type DecideOptions = {
	/** `--force`: branches with unpushed work, and alive branches named explicitly, are deleted too. */
	readonly force: boolean;
	/** `--force` also lifts `ignored-files`. Branch names given exactly on the command line (not globs). */
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
function blockerOf(branch: PlannedBranch, options: DecideOptions): Blocker | undefined {
	const { defaultBranch } = options;
	if (branch.protected?.by === 'default-branch' || branch.protected?.by === 'pattern') {
		return { reason: 'protected', hint: null };
	}
	if (branch.protected?.by === 'default-name') {
		// Naming it exactly lifts the protection, not the proofs.
		return { reason: 'protected', hint: cmd('gsp', 'clean', branch.name) };
	}
	if (branch.protected?.by === 'branch-config') {
		return { reason: 'delete-merged-false', hint: null };
	}
	const worktree = branch.worktree && !branch.worktree.prunable ? branch.worktree : null;
	// During a rebase or a bisect HEAD is detached: the branch is not "current", but it is being worked on.
	if (worktree?.inProgress === 'rebase') {
		return { reason: 'rebase-in-progress', hint: cmd('git', '-C', worktree.path, 'rebase', '--continue') };
	}
	if (worktree?.inProgress === 'bisect') {
		return { reason: 'bisect-in-progress', hint: cmd('git', '-C', worktree.path, 'bisect', 'reset') };
	}
	if (branch.current) {
		// post-pr deletes the branch it leaves: only suggest it when the branch is proven dead.
		const hint =
			defaultBranch === undefined
				? 'git switch <another-branch>'
				: branch.verdict === 'dead'
					? cmd('gsp', 'post-pr', defaultBranch)
					: cmd('git', 'switch', defaultBranch);
		return { reason: 'current-branch', hint };
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
		// Never suggest losing the changes: put them aside first, then clean again.
		return {
			reason: 'dirty-worktree',
			hint: `${cmd('git', '-C', worktree.path, 'stash', '--include-untracked')} && ${cmd('gsp', 'clean', branch.name, '--yes')}`,
		};
	}
	if (worktree?.submodules) {
		// `--force` would delete whatever the submodules hold: let the user check them first.
		return {
			reason: 'submodules',
			hint: `check the submodules of ${quoteShellArg(worktree.path)} (${cmd('git', '-C', worktree.path, 'submodule', 'foreach', '--recursive', 'git', 'status', '--short')}), then: ${cmd('git', 'worktree', 'remove', '--force', worktree.path)} && ${cmd('gsp', 'clean', branch.name, '--yes')}`,
		};
	}
	if (worktree?.ignoredFiles && worktree.ignoredFiles.count > 0 && !options.force) {
		// Removing the worktree deletes them for good: save what matters first.
		return {
			reason: 'ignored-files',
			hint: `move what you need out of ${quoteShellArg(worktree.path)}, then: ${cmd('gsp', 'clean', branch.name, '--yes', '--force')}`,
		};
	}
	return undefined;
}

/**
 * Decides the action of every analysed branch. A branch is deleted only with
 * a proof that its work exists elsewhere (dead, no unpushed commit); `--force`
 * extends that to dead branches with unpushed commits and to alive branches
 * named exactly, and to worktrees holding ignored files. Protected branches,
 * branches being rebased or bisected, the current branch, branches in the
 * main, a locked or a dirty worktree, and the upstream of a kept branch are
 * never deleted, whatever the flags.
 */
export function decideActions(branches: readonly PlannedBranch[], options: DecideOptions): CleanBranch[] {
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
			worktree: branch.worktree && { ...branch.worktree, ignoredFiles: branch.worktree.ignoredFiles ?? null, submodules: branch.worktree.submodules ?? null },
			protected: branch.protected,
			needsForce,
			hint,
		});
		if (!candidate) {
			return make('keep', branch.reason, null);
		}
		const blocker = blockerOf(branch, options);
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

/** `--remote` for origin, `--remote=<name>` for any other remote. */
export function remoteFlag(remote: string): string {
	return remote === 'origin' ? '--remote' : `--remote=${remote}`;
}

/** How the command line names a branch of `remote`: qualified ("origin/x"), so only the remote one is meant. */
export function remoteBranchArg(branch: Pick<CleanRemoteBranch, 'remote' | 'name'>): string {
	return `${branch.remote}/${branch.name}`;
}

/**
 * Decides the action of every branch of the remote. Only a dead branch goes,
 * whatever the flags: never the remote's default branch, a protected one, the
 * head or base of an open pull request (alive), or the upstream of a local
 * branch that is kept. `deletedLocals` are the local branches deleted (or
 * planned for deletion) in the same run: they no longer hold their upstream.
 * A `blocker` skips every branch (`remote-default-unknown`) or every one that
 * would be deleted (`github-unavailable`).
 */
export function decideRemoteActions(
	branches: readonly (RemoteBranchAnalysis & { readonly trackedBy: readonly string[] })[],
	deletedLocals: ReadonlySet<string>,
	blocker?: RemoteBlocker
): CleanRemoteBranch[] {
	return branches.map((branch): CleanRemoteBranch => {
		const decided = decideRemoteAction(branch, deletedLocals);
		if (blocker && (blocker.reason === 'remote-default-unknown' || decided.action === 'delete')) {
			return { ...decided, action: 'skip', reason: blocker.reason, hint: blocker.hint };
		}
		return decided;
	});
}

function decideRemoteAction(branch: RemoteBranchAnalysis & { readonly trackedBy: readonly string[] }, deletedLocals: ReadonlySet<string>): CleanRemoteBranch {
	{
		const make = (action: CleanAction, reason: CleanRemoteBranch['reason'], hint: string | null): CleanRemoteBranch => ({
			remote: branch.remote,
			name: branch.name,
			tip: branch.tip,
			action,
			reason,
			verdict: branch.verdict,
			verdictReason: branch.reason,
			evidence: branch.evidence,
			protected: branch.protected,
			trackedBy: branch.trackedBy,
			hint,
		});
		if (branch.verdict !== 'dead') {
			return make('keep', branch.reason, null);
		}
		if (branch.protected) {
			// Naming a long-lived name exactly, with its remote, lifts its protection, not the proofs.
			return make('skip', 'protected', branch.protected.by === 'default-name' ? cmd('gsp', 'clean', remoteBranchArg(branch), remoteFlag(branch.remote)) : null);
		}
		const kept = branch.trackedBy.filter((name) => !deletedLocals.has(name));
		if (kept.length > 0) {
			return make('skip', 'tracked-by-kept-branch', kept.map((name) => cmd('git', 'branch', '--unset-upstream', name)).join(' && '));
		}
		return make('delete', branch.reason, cmd('gsp', 'clean', remoteBranchArg(branch), remoteFlag(branch.remote), '--yes'));
	}
}

/** Skips that `--force` lifts. */
const FORCE_LIFTS: ReadonlySet<CleanBranch['reason'] | CleanRemoteBranch['reason']> = new Set(['needs-force', 'ignored-files']);

/** Skips of planned deletions that running `gsp clean` again may carry out. */
const RERUN_LIFTS: ReadonlySet<CleanBranch['reason'] | CleanRemoteBranch['reason']> = new Set(['plan-changed', 'fetch-failed', 'worktree-changed']);

/**
 * True when more could be cleaned with the user's approval: planned deletions
 * not carried out, branches that `--force` would delete, or planned ones that
 * changed while applying. Skips that need the user to act elsewhere (current
 * branch, dirty worktree…) do not count.
 */
export function hasPendingDeletions(branches: readonly CleanBranch[], remoteBranches: readonly CleanRemoteBranch[] = []): boolean {
	return [...branches, ...remoteBranches].some(
		(branch) => (branch.action === 'delete' && branch.result === undefined) || FORCE_LIFTS.has(branch.reason) || RERUN_LIFTS.has(branch.reason)
	);
}

/** `cleaned`: with `--remote`, the remote and its branches. */
export function summarize(
	branches: readonly CleanBranch[],
	mode: CleanMode,
	cleaned?: { readonly remote: string; readonly branches: readonly CleanRemoteBranch[] }
): CleanSummary {
	const count = (test: (branch: CleanBranch) => boolean) => branches.filter(test).length;
	const remote = cleaned && summarizeRemote(cleaned.remote, cleaned.branches);
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
		needsForce: count((branch) => FORCE_LIFTS.has(branch.reason)),
		reasons,
		...(remote ? { remote } : {}),
	};
}

function summarizeRemote(remote: string, branches: readonly CleanRemoteBranch[]): RemoteSummary {
	const count = (test: (branch: CleanRemoteBranch) => boolean) => branches.filter(test).length;
	return {
		remote,
		delete: count((branch) => branch.action === 'delete'),
		deleted: count((branch) => branch.result === 'deleted'),
		failed: count((branch) => branch.result === 'failed'),
		skipped: count((branch) => branch.action === 'skip'),
		kept: count((branch) => branch.action === 'keep'),
	};
}

/** What a plan was made on: the CLI options that decide which branches it covers. */
export type CleanScope = {
	/** `-C <path>`, as given. */
	readonly cwd?: string;
	readonly patterns: readonly string[];
	readonly protectedPatterns: readonly string[];
	readonly github: boolean;
	readonly fetch: boolean;
	/** `--remote`: the remote whose branches are cleaned too. */
	readonly remote?: string;
};

/** Up to this many planned deletions, the command to apply a plan names them. */
export const MAX_NAMED_BRANCHES = 10;

/**
 * The command that applies a plan without ever going beyond it: the planned
 * branches by name when there are few, otherwise the patterns the plan was
 * made with; then every option that narrows it. `--force` only when a planned
 * deletion needs it.
 */
export function applyCommand(branches: readonly CleanBranch[], scope: CleanScope, remoteBranches: readonly CleanRemoteBranch[] = []): string {
	const deleting = branches.filter((branch) => branch.action === 'delete' && branch.result === undefined);
	const names = [
		...new Set([
			...deleting.map((branch) => branch.name),
			...remoteBranches.filter((branch) => branch.action === 'delete' && branch.result === undefined).map(remoteBranchArg),
		]),
	];
	const targets = names.length > 0 && names.length <= MAX_NAMED_BRANCHES ? names : scope.patterns;
	return scopedCommand(scope, targets, ['--yes', ...(deleting.some((branch) => branch.needsForce) ? ['--force'] : [])]);
}

/** `gsp clean` on `targets`, with every option of `scope` that narrows it, then `flags`. */
export function scopedCommand(scope: CleanScope, targets: readonly string[], flags: readonly string[]): string {
	return cmd(
		'gsp',
		...(scope.cwd === undefined ? [] : ['-C', scope.cwd]),
		'clean',
		...targets,
		...scope.protectedPatterns.flatMap((pattern) => ['--protect', pattern]),
		...(scope.github ? [] : ['--no-github']),
		...(scope.fetch ? [] : ['--no-fetch']),
		...(scope.remote === undefined ? [] : [remoteFlag(scope.remote)]),
		...flags
	);
}

/**
 * The command to run next, or null when nothing is left that gsp can do on
 * its own: the one that applies the planned deletions not carried out, or,
 * when some changed while applying, the one that plans again (within the
 * same scope) to review them. Branches that only `--force` deletes are left
 * to their own hint, which says what to save first.
 */
export function nextCommand(report: Pick<CleanReport, 'branches' | 'remoteBranches'>, scope: CleanScope): string | null {
	const all = [...report.branches, ...(report.remoteBranches ?? [])];
	if (all.some((branch) => branch.action === 'delete' && branch.result === undefined)) {
		return applyCommand(report.branches, scope, report.remoteBranches);
	}
	if (all.some((branch) => RERUN_LIFTS.has(branch.reason))) {
		return scopedCommand(scope, scope.patterns, ['--dry-run']);
	}
	return null;
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
			// A branch that had an upstream had commits of its own once: they are in the base now.
			if (into && branch.upstream) {
				return `already in ${into}`;
			}
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
		case 'open-pr-base':
			return evidence?.method === 'pull-request' ? `open pull request #${evidence.pullRequest} targets it` : 'an open pull request targets it';
		case 'unmerged-commits':
			return evidence?.method === 'unique-commits' ? `${plural(evidence.commits, 'commit')} not merged into ${into}` : 'commits not merged';
		case 'no-base':
			return 'no default branch to compare with';
		case 'analysis-failed':
			return evidence?.method === 'error' ? `analysis failed: ${evidence.message}` : 'analysis failed';
	}
}

const MAX_SAMPLE = 3;

function describeIgnored({ count, sample }: IgnoredFiles): string {
	const shown = sample.slice(0, MAX_SAMPLE).join(', ');
	return `${plural(count, 'ignored file')} (${shown}${count > MAX_SAMPLE ? ', …' : ''})`;
}

function describeProtection(branch: Pick<CleanBranch, 'verdictReason' | 'protected'>): string {
	if (branch.verdictReason === 'default-branch' || branch.protected?.by === 'default-branch') {
		return 'default branch';
	}
	switch (branch.protected?.by) {
		case 'default-name':
			return 'protected as a long-lived branch name: name it exactly to clean it';
		case 'branch-config':
			return `${branch.protected.key} is false`;
		default:
			return 'protected';
	}
}

/** Why a candidate is skipped, in words. */
function describeSkip(branch: CleanBranch): string {
	const worktree = branch.worktree?.path ?? '';
	switch (branch.reason) {
		case 'protected':
			return describeProtection(branch);
		case 'delete-merged-false':
			return `branch.${branch.name}.deleteMerged is false`;
		case 'rebase-in-progress':
			return `a rebase is in progress in ${worktree}: continue or abort it first`;
		case 'bisect-in-progress':
			return `a bisect is in progress in ${worktree}: reset it first`;
		case 'current-branch':
			return 'current branch';
		case 'main-worktree':
			return `checked out in the main worktree ${worktree}`;
		case 'locked-worktree':
			return `worktree ${worktree} is locked`;
		case 'dirty-worktree':
			return `worktree ${worktree} has uncommitted changes`;
		case 'submodules':
			return `worktree ${worktree} holds submodules, which git worktree remove refuses to delete`;
		case 'ignored-files':
			return `removing worktree ${worktree} would delete ${branch.worktree?.ignoredFiles ? describeIgnored(branch.worktree.ignoredFiles) : 'ignored files'}, needs --force`;
		case 'needs-force':
			// The verdict, shown next to it, says which commits are found nowhere else.
			return branch.verdict === 'alive' ? 'named, but not merged: needs --force' : 'needs --force';
		case 'tracked-by-kept-branch':
			return 'a kept branch tracks it';
		case 'not-selected':
			return 'not selected';
		case 'plan-changed':
			return 'changed since the plan was made';
		case 'fetch-failed':
			return 'the fetch failed, and only the remote-tracking refs prove it';
		case 'worktree-changed':
			return `worktree ${worktree} changed since the analysis`;
		default:
			return branch.reason;
	}
}

const ORDER: Record<CleanAction, number> = { delete: 0, skip: 1, keep: 2 };

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
	const branches = [...report.branches].sort((a, b) => ORDER[a.action] - ORDER[b.action]);
	const nameWidth = Math.max(0, ...branches.map((branch) => branch.name.length));
	return branches.map((branch) => `${actionLabel(branch).padEnd(8)}${branch.name.padEnd(nameWidth)}  ${describeAction(branch)}`);
}

/** What was (or would be) done to a branch, in one word: "delete", "deleted", "skip"… */
export function actionLabel(branch: Pick<CleanBranch, 'action' | 'result'>): string {
	return ACTION_LABEL[branch.result ?? branch.action];
}

/** Why a branch was (or would be) deleted, skipped or kept, with the hint of a skip, e.g. "squash-merged into origin/main". */
export function describeAction(branch: CleanBranch): string {
	const verdict = describeVerdict(branch);
	if (branch.result === 'failed' || branch.result === 'worktree-removed') {
		return `${branch.result === 'worktree-removed' ? 'worktree removed, but the branch was not deleted: ' : ''}${branch.error ?? 'unknown error'}`;
	}
	if (branch.action === 'skip') {
		const skip = describeSkip(branch);
		return `${skip === verdict ? skip : `${skip} (${verdict})`}${branch.hint ? ` → ${branch.hint}` : ''}`;
	}
	const ignored = branch.worktree?.ignoredFiles?.count ? ` and its ${describeIgnored(branch.worktree.ignoredFiles)}` : '';
	const worktree =
		branch.action === 'delete' && branch.worktree && !branch.worktree.prunable
			? `, ${branch.result ? 'removed' : 'removes'} worktree ${branch.worktree.path}${ignored}`
			: '';
	return `${verdict}${branch.needsForce && branch.action === 'delete' ? ', forced' : ''}${worktree}`;
}

/** Why a remote branch is skipped, in words. */
function describeRemoteSkip(branch: CleanRemoteBranch): string {
	switch (branch.reason) {
		case 'protected':
			return describeProtection(branch);
		case 'tracked-by-kept-branch':
			return `tracked by ${branch.trackedBy.join(', ')}, which ${branch.trackedBy.length === 1 ? 'is' : 'are'} kept`;
		case 'plan-changed':
			return `changed on ${branch.remote} since it was analysed`;
		case 'fetch-failed':
			return `the fetch failed: ${branch.remote} could not be checked again`;
		case 'remote-default-unknown':
			return `the default branch of ${branch.remote} is unknown`;
		case 'github-unavailable':
			return 'its open pull requests could not be checked';
		default:
			return branch.reason;
	}
}

/** The "On origin" section: a heading, then one line per remote branch, as {@link formatBranchLines}. Empty without branches. */
export function formatRemoteLines(report: Pick<CleanReport, 'remoteBranches'>): string[] {
	const branches = [...(report.remoteBranches ?? [])].sort((a, b) => ORDER[a.action] - ORDER[b.action]);
	if (branches.length === 0) {
		return [];
	}
	const nameWidth = Math.max(...branches.map((branch) => branch.name.length));
	const lines = branches.map((branch) => {
		const label = actionLabel(branch).padEnd(8);
		const verdict = describeVerdict({ ...branch, unpushedCommits: 0, upstream: null });
		let detail = verdict;
		if (branch.result === 'failed') {
			detail = branch.error ?? 'unknown error';
		} else if (branch.action === 'skip') {
			const skip = describeRemoteSkip(branch);
			detail = `${skip === verdict ? skip : `${skip} (${verdict})`}${branch.hint ? ` → ${branch.hint}` : ''}`;
		}
		return `${label}${branch.name.padEnd(nameWidth)}  ${detail}`;
	});
	return [`On ${branches[0].remote}:`, ...lines];
}

function describeReasons(reasons: CleanSummary['reasons']): string {
	const parts = Object.entries(reasons)
		.sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
		.map(([reason, count]) => `${count} ${reason}`);
	return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** Skips of planned deletions that running `gsp clean` again may carry out, as the summary names them. */
const RERUN_LABEL: Partial<Record<CleanBranch['reason'], string>> = {
	'plan-changed': 'changed since the plan',
	'fetch-failed': 'fetch failed',
	'worktree-changed': 'worktree changed',
};

/** The remote branches' part of the summary, e.g. "on origin: 2 deleted", or undefined when nothing is to be done there. */
function describeRemoteSummary({ mode, summary, remoteBranches = [] }: CleanReport): string | undefined {
	const counts = summary.remote;
	const pending = remoteBranches.filter((branch) => branch.action === 'delete' && branch.result === undefined).length;
	const changed = remoteBranches.filter((branch) => RERUN_LIFTS.has(branch.reason)).length;
	const parts = [
		...(mode === 'plan' && pending > 0 ? [`${pending} to delete`] : []),
		...(counts && counts.deleted > 0 ? [`${counts.deleted} deleted`] : []),
		...(counts && counts.failed > 0 ? [`${counts.failed} failed`] : []),
		...(mode === 'apply' && pending > 0 ? [`${pending} ${pending === 1 ? 'needs' : 'need'} --yes`] : []),
		...(changed > 0 ? [`${changed} changed`] : []),
	];
	return counts && parts.length > 0 ? `on ${counts.remote}: ${parts.join(', ')}` : undefined;
}

/** The one summary line: e.g. "3 deleted (2 squash-merged, 1 empty) · 2 skipped · restore with gsp restore a b c". */
export function formatSummary(report: CleanReport): string {
	const { summary, mode } = report;
	const rerun = Object.entries(RERUN_LABEL)
		.map(([reason, label]) => [report.branches.filter((branch) => branch.reason === reason).length, label] as const)
		.filter(([count]) => count > 0);
	const remote = describeRemoteSummary(report);
	if (summary.delete === 0 && summary.needsForce === 0 && rerun.length === 0 && report.worktreesPruned.length === 0 && !remote) {
		return summary.skipped > 0 ? `Nothing to clean · ${summary.skipped} skipped.` : 'Nothing to clean.';
	}
	const parts: string[] = [];
	// With work on the remote only, the remote part says it all.
	const localWork = summary.delete > 0 || summary.skipped > 0 || !remote;
	if (mode === 'plan') {
		if (localWork) {
			parts.push(`${summary.delete} to delete${describeReasons(summary.reasons)}`);
		}
	} else {
		if (localWork) {
			parts.push(summary.deleted > 0 ? `${summary.deleted} deleted${describeReasons(summary.reasons)}` : 'Nothing deleted');
		}
		if (summary.failed > 0) {
			parts.push(`${summary.failed} failed`);
		}
	}
	if (summary.skipped > 0) {
		const why = [
			...(summary.needsForce > 0 ? [`${summary.needsForce} ${summary.needsForce === 1 ? 'needs' : 'need'} --force`] : []),
			...rerun.map(([count, label]) => `${count} ${label}`),
		];
		parts.push(`${summary.skipped} skipped${why.length > 0 ? ` (${why.join(', ')})` : ''}`);
	}
	if (report.worktreesPruned.length > 0) {
		parts.push(`${plural(report.worktreesPruned.length, 'worktree registration')} ${mode === 'plan' ? 'to prune' : 'pruned'}`);
	}
	if (remote) {
		parts.push(remote);
	}
	if (report.restore) {
		parts.push(`restore with ${report.restore}`);
	}
	return parts.join(' · ');
}
