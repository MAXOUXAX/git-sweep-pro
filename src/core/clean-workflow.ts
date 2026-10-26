import { analyzeBranches, type AnalysisChecks, type BranchAnalysis, type BranchAnalysisResult } from './branch-analysis';
import {
	CLEAN_SCHEMA,
	decideActions,
	hasPendingDeletions,
	describeVerdict,
	isBranchGlob,
	restoreCommand,
	summarize,
	type CleanBranch,
	type CleanMode,
	type CleanReport,
	type CleanResult,
	type DecideOptions,
	type PlannedBranch,
	type RemoteCheck,
	type SkipReason,
} from './clean-plan';
import { canRecordDeletions, createDeletionRecorder, type DeletionRecorder } from './deletion-log';
import { gitFailureReason, toErrorMessage } from './errors';
import { quoteShellArg, type RunGit } from './git-command';
import type { RunGh } from './github-signal';
import { findIgnoredFiles } from './ignored-files';
import { isNotFullyMergedError } from './sweep-logic';
import type { PickItem, WorkflowContext } from './workflow';
import { listWorktrees, parseWorktrees, pruneWorktrees } from './worktrees';

export type CleanOptions = {
	/** Branch names or globs; only the matching branches are considered. All branches when empty. */
	readonly patterns: readonly string[];
	/** Plan only, whatever the other flags. */
	readonly dryRun: boolean;
	/** Apply the plan without asking. */
	readonly yes: boolean;
	readonly force: boolean;
	/** `git ls-remote` while planning, `git fetch --prune` before applying. */
	readonly fetch: boolean;
	/** Ask GitHub for merged pull requests through `gh`. */
	readonly github: boolean;
	/** Protected-branch globs from the command line, on top of the `git-sweep-pro.protected` config. */
	readonly protectedPatterns: readonly string[];
	/** Someone can answer a picker: show it unless `yes`. */
	readonly canPrompt: boolean;
	/** Confirm before deleting what was picked. */
	readonly confirm: boolean;
};

export type CleanContext = WorkflowContext & {
	/** Runs `gh`; without it, the GitHub signal is skipped. */
	readonly gh?: RunGh;
};

/** How `gsp clean` ended: the CLI maps it to its exit code. */
export type CleanOutcome =
	/** Applied, or nothing to do. */
	| 'done'
	/** The plan holds deletions that were not carried out (no `--yes`, `--dry-run`, or `--force` missing). */
	| 'not-applied'
	/** The user dismissed the picker, picked nothing or refused the confirmation. */
	| 'cancelled'
	/** At least one action failed. */
	| 'failed';

export type CleanRun = { readonly report: CleanReport; readonly outcome: CleanOutcome };

/** Patterns naming branches that do not exist: `gsp clean` refuses them as a usage error. */
export class UnknownBranchError extends Error {
	constructor(readonly branches: readonly string[]) {
		super(`No local branch named ${branches.map((branch) => `"${branch}"`).join(', ')}. Run "gsp clean --dry-run" to see them.`);
	}
}

type Upstream = { readonly ref: string; readonly remote: string; readonly remoteRef: string };

/** The upstream of each local branch tracking a remote: local ref, remote name and the branch on the remote. */
async function readUpstreams(git: RunGit): Promise<Map<string, Upstream>> {
	const { stdout } = await git(['for-each-ref', '--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads']);
	const upstreams = new Map<string, Upstream>();
	for (const line of stdout.split('\n')) {
		const [name, ref, remote, remoteRef] = line.split('\0');
		if (name && ref && remote && remote !== '.' && remoteRef) {
			upstreams.set(name.slice('refs/heads/'.length), { ref, remote, remoteRef });
		}
	}
	return upstreams;
}

/** Remotes worth fetching or reading: those the branches track, and origin. */
async function remotesToCheck(git: RunGit, upstreams: ReadonlyMap<string, Upstream>): Promise<string[]> {
	const configured = (await git(['remote'])).stdout.split('\n').filter(Boolean);
	const tracked = new Set([...upstreams.values()].map((upstream) => upstream.remote).filter((remote) => configured.includes(remote)));
	if (configured.includes('origin')) {
		tracked.add('origin');
	}
	if (tracked.size === 0 && configured.length > 0) {
		tracked.add(configured[0]);
	}
	return [...tracked];
}

/**
 * Plan mode only: finds the upstreams deleted on their remote with
 * `git ls-remote --heads`, which writes nothing, where a fetch would prune
 * them. Each tracked branch whose remote head is missing is marked gone, as
 * the analysis would after a prune: a branch alive only for its unmerged
 * commits becomes `upstream-gone`, and its unpushed commits are counted
 * without the stale remote-tracking ref. Other alive branches (open pull
 * request, no base, failed analysis, default branch) stay alive.
 */
async function markGoneUpstreams(
	git: RunGit,
	analysis: BranchAnalysisResult,
	upstreams: ReadonlyMap<string, Upstream>,
	remotes: readonly string[]
): Promise<{ analysis: BranchAnalysisResult; remote: RemoteCheck }> {
	const heads = new Map<string, Set<string>>();
	try {
		for (const remote of remotes) {
			const { stdout } = await git(['ls-remote', '--heads', remote]);
			heads.set(remote, new Set(stdout.split('\n').map((line) => line.split('\t')[1]).filter(Boolean)));
		}
	} catch (error) {
		return { analysis, remote: { source: 'local-refs', reason: 'unreachable', detail: gitFailureReason(error) } };
	}

	const stale = new Map<string, Upstream>();
	for (const branch of analysis.branches) {
		const upstream = upstreams.get(branch.name);
		const remoteHeads = upstream && heads.get(upstream.remote);
		if (branch.upstreamState === 'tracking' && upstream && remoteHeads && !remoteHeads.has(upstream.remoteRef)) {
			stale.set(branch.name, upstream);
		}
	}
	if (stale.size === 0) {
		return { analysis, remote: { source: 'ls-remote', remotes } };
	}
	// --exclude patterns for --remotes are relative to refs/remotes/.
	const excludes = [...new Set([...stale.values()].map((upstream) => `--exclude=${upstream.ref.replace(/^refs\/remotes\//, '')}`))];
	const baseRef = analysis.checks.base?.ref;
	const branches = await Promise.all(
		analysis.branches.map(async (branch): Promise<BranchAnalysis> => {
			if (!stale.has(branch.name)) {
				return branch;
			}
			if (branch.reason !== 'unmerged-commits') {
				return { ...branch, upstreamState: 'gone' };
			}
			const { stdout } = await git(['rev-list', '--count', branch.tip, '--not', ...excludes, '--remotes', ...(baseRef ? [baseRef] : [])]);
			return {
				...branch,
				upstreamState: 'gone',
				verdict: 'dead',
				reason: 'upstream-gone',
				evidence: { method: 'upstream-gone', upstream: branch.upstream ?? '' },
				unpushedCommits: Number(stdout.trim()),
			};
		})
	);
	return { analysis: { ...analysis, branches }, remote: { source: 'ls-remote', remotes } };
}

/**
 * Applying only: `git fetch --prune`. `remote.<name>.followRemoteHEAD` is
 * the user's: when it moves the remote HEAD, the default branch changes, and
 * the plan no longer holds (see {@link holdToBase}). A failure is not fatal:
 * the local remote-tracking refs are used instead.
 */
async function fetchAndPrune(context: CleanContext, remotes: readonly string[]): Promise<RemoteCheck> {
	try {
		await context.ui.withProgress({ title: 'Fetching and pruning remote references' }, () => context.git(['fetch', '--prune', '--multiple', ...remotes]));
		return { source: 'fetch', remotes };
	} catch (error) {
		return { source: 'local-refs', reason: 'unreachable', detail: gitFailureReason(error) };
	}
}

/**
 * Looks for the ignored files of the linked worktrees that deleting a
 * candidate would remove. Worktrees that are kept anyway (main, locked,
 * dirty, mid-rebase) are not read. A worktree that cannot be read counts as
 * dirty, as in the analysis.
 */
async function withIgnoredFiles(git: RunGit, branches: readonly BranchAnalysis[], named: ReadonlySet<string>): Promise<PlannedBranch[]> {
	return Promise.all(
		branches.map(async (branch): Promise<PlannedBranch> => {
			const { worktree } = branch;
			const candidate = branch.verdict === 'dead' || named.has(branch.name);
			if (!candidate || !worktree || worktree.isMain || worktree.prunable || worktree.locked || worktree.dirty || worktree.inProgress) {
				return branch;
			}
			try {
				return { ...branch, worktree: { ...worktree, ignoredFiles: await findIgnoredFiles(git, worktree.path) } };
			} catch {
				return { ...branch, worktree: { ...worktree, dirty: true } };
			}
		})
	);
}

async function readTip(git: RunGit, branch: string): Promise<{ sha: string; upstream?: string } | undefined> {
	const ref = `refs/heads/${branch}`;
	// A pattern also matches the refs below it ("a" matches "a/b"): keep the exact ref.
	const { stdout } = await git(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(upstream)', ref]);
	const [, sha, upstream] = stdout.split('\n').map((line) => line.split('\t')).find(([name]) => name === ref) ?? [];
	return sha ? { sha, ...(upstream ? { upstream } : {}) } : undefined;
}

/**
 * True when the worktree at `path` is still as analysed: the branch checked
 * out there and nowhere else, not locked, no uncommitted change, and no
 * ignored file that the plan did not show.
 */
async function worktreeUnchanged(git: RunGit, branch: CleanBranch, path: string | undefined): Promise<boolean> {
	const worktrees = parseWorktrees((await git(['worktree', 'list', '--porcelain'])).stdout);
	const holders = worktrees.filter((worktree) => worktree.branch === branch.name && worktree.state !== 'prunable');
	if (path === undefined) {
		return holders.length === 0;
	}
	if (holders.length !== 1 || holders[0].path !== path || holders[0].state !== 'linked') {
		return false;
	}
	const status = await git(['-C', path, '--no-optional-locks', 'status', '--porcelain']);
	if (status.stdout.trim()) {
		return false;
	}
	const ignored = await findIgnoredFiles(git, path);
	return ignored.count <= (branch.worktree?.ignoredFiles?.count ?? 0);
}

type Outcome = { readonly result: CleanResult; readonly error?: string } | { readonly skip: SkipReason };

/**
 * Deletes one planned branch: checks it still points at the analysed commit
 * and that its worktree is still as analysed, removes that worktree (never
 * with --force: Git refuses a dirty or locked one), then deletes the branch.
 * `git branch -d` is tried first, as it also refuses a branch being rebased
 * or bisected; since it cannot see squash merges, a proven branch then goes
 * with `git update-ref -d`, only if it still points at the analysed commit.
 */
async function deleteBranch(git: RunGit, branch: CleanBranch, recorder: DeletionRecorder): Promise<Outcome> {
	const tip = await readTip(git, branch.name);
	if (tip?.sha !== branch.tip) {
		return { result: 'failed', error: tip ? 'it moved since it was analysed; run gsp clean again' : 'it no longer exists' };
	}
	const worktree = branch.worktree && !branch.worktree.prunable ? branch.worktree.path : undefined;
	if (!(await worktreeUnchanged(git, branch, worktree))) {
		return { skip: 'worktree-changed' };
	}
	if (worktree) {
		try {
			await git(['worktree', 'remove', worktree]);
		} catch (error) {
			return { result: 'failed', error: `could not remove worktree ${worktree}: ${gitFailureReason(error)}` };
		}
	}
	try {
		try {
			await git(['branch', '-d', branch.name]);
		} catch (error) {
			if (!isNotFullyMergedError(toErrorMessage(error))) {
				throw error;
			}
			// Compare-and-swap: fails if the branch moved since it was analysed.
			await git(['update-ref', '-m', 'gsp clean', '-d', `refs/heads/${branch.name}`, branch.tip]);
			// What `git branch -D` removes too: its upstream and other settings. None is fine.
			await git(['config', '--remove-section', `branch.${branch.name}`]).catch(() => undefined);
		}
	} catch (error) {
		return { result: worktree ? 'worktree-removed' : 'failed', error: gitFailureReason(error) };
	}
	await recorder.record({ branch: branch.name, ...tip, ...(worktree ? { worktree } : {}) });
	return { result: 'deleted' };
}

/**
 * Picker entries: every planned deletion, pre-selected unless it needs
 * --force. Branches needing --force are only offered with --force, never
 * pre-selected.
 */
function pickItems(branches: readonly CleanBranch[], force: boolean): PickItem[] {
	return branches
		.filter((branch) => branch.action === 'delete' || (force && branch.reason === 'needs-force'))
		.map((branch) => {
			const worktree = branch.worktree && !branch.worktree.prunable ? `, removes worktree ${branch.worktree.path}` : '';
			const unpushed = branch.verdict === 'alive' ? ', not merged' : `, ${branch.unpushedCommits} unpushed`;
			return {
				label: branch.name,
				description: `${describeVerdict(branch)}${branch.needsForce ? unpushed : ''}${worktree}`,
				picked: branch.action === 'delete' && !branch.needsForce,
			};
		});
}

const skipped = (branch: CleanBranch, reason: SkipReason, hint: string | null): CleanBranch => ({ ...branch, action: 'skip', reason, hint });

/**
 * Checks the analysis made after the fetch against the plan made before it.
 * A branch the plan deleted but that is now kept is skipped as
 * `plan-changed`; one that is now skipped keeps its own reason. When the
 * fetch failed, a deletion that only stale remote-tracking refs prove is
 * skipped as `fetch-failed`.
 *
 * With `heldToPlan` (a person could pick from the plan), only branches approved
 * then are deleted: one deleted now but not approved is skipped as
 * `plan-changed`. Without it (`--yes`), a branch only the fetch proves is
 * deleted too.
 */
export function holdToPlan(planned: readonly CleanBranch[], current: readonly CleanBranch[], remote: RemoteCheck, heldToPlan = true): CleanBranch[] {
	const before = new Map(planned.map((branch) => [branch.name, branch]));
	const stale = remote.source === 'local-refs' && remote.reason === 'unreachable';
	const replan = (branch: CleanBranch) => `gsp clean ${quoteShellArg(branch.name)}`;
	return current.map((branch) => {
		const previous = before.get(branch.name);
		const approved = previous?.action === 'delete';
		if (!approved && heldToPlan && branch.action === 'delete') {
			return previous?.reason === 'not-selected' ? skipped(branch, 'not-selected', previous.hint) : skipped(branch, 'plan-changed', replan(branch));
		}
		if (approved && branch.action === 'keep') {
			return skipped(branch, 'plan-changed', replan(branch));
		}
		if (branch.action === 'delete' && stale && branch.verdictReason === 'upstream-gone' && !branch.needsForce) {
			// Its hint, `gsp clean <branch> --yes`, retries once the remote can be reached.
			return skipped(branch, 'fetch-failed', branch.hint);
		}
		return branch;
	});
}

type Base = AnalysisChecks['base'];

const baseLabel = (base: Base) => (base ? base.ref.replace(/^refs\/(heads|remotes)\//, '') : 'none');

/**
 * Checks the default branch found after the fetch against the one the plan
 * was made on. Every proof compares with it: when it changed (the fetch moved
 * the remote HEAD, for instance), no deletion is proven the way the plan said,
 * so every deletion is skipped as `plan-changed`. Whatever happens, the plan's
 * default branch is never deleted. Returns the message explaining a change,
 * if any.
 */
export function holdToBase(branches: readonly CleanBranch[], planned: Base, current: Base): { branches: CleanBranch[]; message?: string } {
	const changed = planned?.name !== current?.name || planned?.ref !== current?.ref;
	const held = branches.map((branch) => {
		if (branch.action !== 'delete') {
			return branch;
		}
		if (planned && branch.name === planned.name) {
			return skipped(branch, 'protected', null);
		}
		return changed ? skipped(branch, 'plan-changed', 'gsp clean --dry-run') : branch;
	});
	if (!changed) {
		return { branches: held };
	}
	return {
		branches: held,
		message: `The default branch changed from ${baseLabel(planned)} to ${baseLabel(current)} during the fetch, so nothing was deleted. Review the new plan with gsp clean --dry-run.`,
	};
}

function buildReport(
	mode: CleanMode,
	analysis: BranchAnalysisResult,
	remote: RemoteCheck,
	branches: readonly CleanBranch[],
	worktreesPruned: readonly string[],
	restored: readonly string[]
): CleanReport {
	return {
		schema: CLEAN_SCHEMA,
		mode,
		checks: { ...analysis.checks, remote },
		branches,
		worktreesPruned,
		restore: restoreCommand(restored),
		summary: summarize(branches, mode),
	};
}

/**
 * `gsp clean`: classifies the local branches (see `analyzeBranches`) and
 * deletes the dead ones and their clean linked worktrees.
 *
 * The plan is always made first, writing nothing: no fetch, no prune, no
 * ref, config or object write; deleted upstreams are found with
 * `git ls-remote`. Without `yes` or someone to answer the picker, it is only
 * reported. Otherwise, once picked and confirmed (or with `yes`), gsp fetches
 * with --prune, prunes the worktree registrations whose directory is gone,
 * analyses again, then deletes only what was approved and is still proven.
 */
export async function runCleanWorkflow(context: CleanContext, options: CleanOptions): Promise<CleanRun> {
	const { git, ui, output } = context;
	const locals = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).stdout.split('\n').filter(Boolean);
	const missing = options.patterns.filter((pattern) => !isBranchGlob(pattern) && !locals.includes(pattern));
	if (missing.length > 0) {
		throw new UnknownBranchError(missing);
	}

	const apply = !options.dryRun && (options.yes || options.canPrompt);
	const mode: CleanMode = apply ? 'apply' : 'plan';
	const upstreams = await readUpstreams(git);
	const remotes = await remotesToCheck(git, upstreams);
	const online = options.fetch && remotes.length > 0;
	const offline: RemoteCheck = { source: 'local-refs', reason: options.fetch ? 'no-remote' : 'no-fetch' };
	const prunable = (await listWorktrees(context)).filter((worktree) => worktree.state === 'prunable').map((worktree) => worktree.path);
	const named = new Set(options.patterns.filter((pattern) => !isBranchGlob(pattern)));
	const analyse = (fetched: boolean) =>
		ui.withProgress({ title: 'Analysing branches' }, () =>
			analyzeBranches(
				{ git, ...(context.gh ? { gh: context.gh } : {}) },
				{
					...(options.patterns.length > 0 ? { branches: options.patterns } : {}),
					protectedPatterns: options.protectedPatterns,
					github: options.github,
					fetched,
				}
			)
		);
	let warned = false;
	const warnIfUnreachable = (remote: RemoteCheck) => {
		if (!warned && remote.source === 'local-refs' && remote.reason === 'unreachable') {
			output.appendLine(`Could not reach the remote (${remote.detail ?? 'unknown error'}); using the local remote-tracking refs.`);
			warned = true;
		}
	};

	// The plan: read-only, whatever the mode.
	let analysis = await analyse(false);
	let remote: RemoteCheck = offline;
	if (online) {
		({ analysis, remote } = await ui.withProgress({ title: 'Checking remote branches' }, () => markGoneUpstreams(git, analysis, upstreams, remotes)));
	}
	warnIfUnreachable(remote);
	const plannedBase = analysis.checks.base;
	const decideOptions: DecideOptions = { force: options.force, named, defaultBranch: plannedBase?.name };
	let planned = await withIgnoredFiles(git, analysis.branches, named);
	let branches = decideActions(planned, decideOptions);
	let worktreesPruned: readonly string[] = apply ? [] : prunable;
	const report = (outcome: CleanOutcome, restored: readonly string[] = []): CleanRun => ({
		report: buildReport(mode, analysis, remote, branches, worktreesPruned, restored),
		outcome,
	});

	if (!apply) {
		return report(hasPendingDeletions(branches) ? 'not-applied' : 'done');
	}

	let picked: ReadonlySet<string> | undefined;
	const offered = pickItems(branches, options.force);
	if (options.canPrompt && !options.yes && offered.length > 0) {
		const answer = await ui.pickMany({ items: offered, title: 'Select branches to delete' });
		if (answer === undefined || answer.length === 0) {
			branches = decideActions(planned, { ...decideOptions, picked: new Set() });
			return report('cancelled');
		}
		picked = new Set(answer);
		branches = decideActions(planned, { ...decideOptions, picked });
		const deleting = branches.filter((branch) => branch.action === 'delete');
		const forced = deleting.filter((branch) => branch.needsForce).length;
		if (options.confirm && deleting.length > 0) {
			const undo = canRecordDeletions(context.deletionLog) ? 'You can restore them later.' : 'This cannot be undone.';
			const work = forced > 0 ? ` ${forced} of them hold work found nowhere else.` : '';
			const confirmed = await ui.confirm(`Delete ${deleting.length} branch(es)?${work} ${undo}`, `Delete ${deleting.length}`);
			if (!confirmed) {
				branches = decideActions(planned, { ...decideOptions, picked: new Set() });
				return report('cancelled');
			}
		}
	}

	// Approved (or nothing to approve): refresh the remote branches and analyse
	// again. A person who picked is held to what they picked: a branch that
	// only the fetch proves is reported as `plan-changed`, for the next run.
	// `--yes` applies whatever is proven now, within the same scope.
	if (online) {
		remote = await fetchAndPrune(context, remotes);
		warnIfUnreachable(remote);
	}
	// Until pruned, a worktree whose directory is gone still holds its branch.
	worktreesPruned = prunable.length > 0 ? (await pruneWorktrees(context)).pruned : [];
	analysis = await analyse(remote.source === 'fetch');
	planned = await withIgnoredFiles(git, analysis.branches, named);
	branches = holdToPlan(branches, decideActions(planned, decideOptions), remote, !options.yes);
	const held = holdToBase(branches, plannedBase, analysis.checks.base);
	branches = held.branches;
	if (held.message) {
		output.appendLine(held.message);
	}

	const recorder = createDeletionRecorder(context.deletionLog, 'sweep', output.appendLine);
	const applied: CleanBranch[] = [];
	for (const branch of branches) {
		if (branch.action !== 'delete') {
			applied.push(branch);
			continue;
		}
		const outcome = await deleteBranch(git, branch, recorder);
		if ('skip' in outcome) {
			applied.push(skipped(branch, outcome.skip, branch.hint));
		} else {
			applied.push({ ...branch, result: outcome.result, hint: outcome.result === 'deleted' ? null : branch.hint, ...(outcome.error ? { error: outcome.error } : {}) });
		}
	}
	branches = applied;
	const failed = branches.some((branch) => branch.result === 'failed' || branch.result === 'worktree-removed');
	return report(failed ? 'failed' : hasPendingDeletions(branches) ? 'not-applied' : 'done', recorder.recorded);
}
