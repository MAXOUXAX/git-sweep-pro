import { analyzeBranches, type AnalysisChecks, type BranchAnalysis, type BranchAnalysisResult, type RemoteBranchAnalysis } from './branch-analysis';
import {
	CLEAN_SCHEMA,
	decideActions,
	decideRemoteActions,
	hasPendingDeletions,
	describeVerdict,
	isBranchGlob,
	remoteFlag,
	restoreCommand,
	summarize,
	type CleanBranch,
	type CleanMode,
	type CleanRemoteBranch,
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
import { listIgnoredFiles, summarizeIgnored } from './ignored-files';
import { isNotFullyMergedError } from './sweep-logic';
import type { PickItem, WorkflowContext } from './workflow';
import { hasSubmodules, listWorktrees, parseWorktrees, pruneWorktrees, WORKTREE_REMOVE } from './worktrees';

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
	/**
	 * `--remote`: also clean the branches of this remote; an empty string
	 * picks origin. Deleted there only with `yes`.
	 */
	readonly remote?: string;
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

/** `--remote` names a remote that does not exist, or none was named and there is no origin: a usage error. */
export class UnknownRemoteError extends Error {
	constructor(readonly remote: string | undefined) {
		super(
			remote
				? `No remote named "${remote}". Run "git remote" to see them.`
				: 'No remote named "origin". Name the remote to clean: --remote=<name>.'
		);
	}
}

/** The remote `--remote` names: origin by default, or the only remote. */
async function resolveRemote(git: RunGit, requested: string): Promise<string> {
	const configured = (await git(['remote'])).stdout.split('\n').filter(Boolean);
	const remote = requested || (configured.includes('origin') || configured.length !== 1 ? 'origin' : configured[0]);
	if (!configured.includes(remote)) {
		throw new UnknownRemoteError(requested || undefined);
	}
	return remote;
}

/** Branch tips of a remote, by name, as its remote-tracking refs last saw them. */
async function readTrackingHeads(git: RunGit, remote: string): Promise<Map<string, string>> {
	const prefix = `refs/remotes/${remote}/`;
	const { stdout } = await git(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', prefix]);
	return new Map(
		stdout.split('\n').flatMap((line) => {
			const [ref, sha, symref] = line.split('\0');
			return ref && sha && !symref && ref !== `${prefix}HEAD` ? [[ref.slice(prefix.length), sha] as const] : [];
		})
	);
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

/** Remotes worth fetching or reading: those the branches track, origin, and the one `--remote` cleans. */
async function remotesToCheck(git: RunGit, upstreams: ReadonlyMap<string, Upstream>, cleaned: string | undefined): Promise<string[]> {
	const configured = (await git(['remote'])).stdout.split('\n').filter(Boolean);
	const tracked = new Set([...upstreams.values()].map((upstream) => upstream.remote).filter((remote) => configured.includes(remote)));
	if (configured.includes('origin')) {
		tracked.add('origin');
	}
	if (cleaned !== undefined) {
		tracked.add(cleaned);
	}
	if (tracked.size === 0 && configured.length > 0) {
		tracked.add(configured[0]);
	}
	return [...tracked];
}

/** Branch tips of each remote, by branch name, as `git ls-remote` read them; or why it failed. */
type RemoteHeads = Map<string, Map<string, string>> | { readonly error: string };

/** Plan mode only: `git ls-remote --heads` on each remote, which writes nothing. */
async function lsRemote(git: RunGit, remotes: readonly string[]): Promise<RemoteHeads> {
	const heads = new Map<string, Map<string, string>>();
	try {
		for (const remote of remotes) {
			const { stdout } = await git(['ls-remote', '--heads', remote]);
			heads.set(
				remote,
				new Map(
					stdout.split('\n').flatMap((line) => {
						const [sha, ref] = line.split('\t');
						return sha && ref?.startsWith('refs/heads/') ? [[ref.slice('refs/heads/'.length), sha] as const] : [];
					})
				)
			);
		}
	} catch (error) {
		return { error: gitFailureReason(error) };
	}
	return heads;
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
	remotes: readonly string[],
	heads: RemoteHeads
): Promise<{ analysis: BranchAnalysisResult; remote: RemoteCheck }> {
	if ('error' in heads) {
		return { analysis, remote: { source: 'local-refs', reason: 'unreachable', detail: heads.error } };
	}

	const stale = new Map<string, Upstream>();
	for (const branch of analysis.branches) {
		const upstream = upstreams.get(branch.name);
		const remoteHeads = upstream && heads.get(upstream.remote);
		if (branch.upstreamState === 'tracking' && upstream && remoteHeads && !remoteHeads.has(upstream.remoteRef.slice('refs/heads/'.length))) {
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
 * Looks into the linked worktrees that deleting a candidate would remove:
 * for submodules, which Git refuses to remove, and for ignored files, all of
 * them recorded per branch in `found`. Worktrees that are kept anyway (main,
 * locked, dirty, mid-rebase) are not read. A worktree that cannot be read
 * counts as dirty, as in the analysis.
 */
async function inspectWorktrees(
	git: RunGit,
	branches: readonly BranchAnalysis[],
	named: ReadonlySet<string>,
	found: Map<string, readonly string[]>
): Promise<PlannedBranch[]> {
	return Promise.all(
		branches.map(async (branch): Promise<PlannedBranch> => {
			const { worktree } = branch;
			const candidate = branch.verdict === 'dead' || named.has(branch.name);
			if (!candidate || !worktree || worktree.isMain || worktree.prunable || worktree.locked || worktree.dirty || worktree.inProgress) {
				return branch;
			}
			try {
				const [ignored, submodules] = await Promise.all([listIgnoredFiles(git, worktree.path), hasSubmodules(git, worktree.path)]);
				found.set(branch.name, ignored);
				return { ...branch, worktree: { ...worktree, ignoredFiles: summarizeIgnored(ignored), submodules } };
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

/** The worktree of a branch as the plan saw it: its path (none when it had no worktree) and its ignored files. */
type SeenWorktree = { readonly path: string | undefined; readonly ignored: readonly string[] };

/**
 * True when the worktree of `branch` is still as `seen`: the branch checked
 * out there and nowhere else, not locked, no uncommitted change, and no
 * ignored file that was not seen.
 */
async function worktreeUnchanged(git: RunGit, branch: CleanBranch, seen: SeenWorktree): Promise<boolean> {
	const { path } = seen;
	const worktrees = parseWorktrees((await git(['worktree', 'list', '--porcelain'])).stdout);
	const holders = worktrees.filter((worktree) => worktree.branch === branch.name && worktree.state !== 'prunable');
	if (path === undefined) {
		return holders.length === 0;
	}
	if (holders.length !== 1 || holders[0].path !== path || holders[0].state !== 'linked') {
		return false;
	}
	const status = await git(['-C', path, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal']);
	if (status.stdout.trim()) {
		return false;
	}
	const known = new Set(seen.ignored);
	return (await listIgnoredFiles(git, path)).every((file) => known.has(file));
}

const linkedPath = (branch: Pick<CleanBranch, 'worktree'>) => (branch.worktree && !branch.worktree.prunable ? branch.worktree.path : undefined);

type Outcome = { readonly result: CleanResult; readonly error?: string } | { readonly skip: SkipReason };

/**
 * Deletes one planned branch: checks it still points at the analysed commit
 * and that its worktree is still as analysed, removes that worktree (never
 * with --force: Git refuses a dirty or locked one), then deletes the branch.
 * `git branch -d` is tried first, as it also refuses a branch being rebased
 * or bisected; since it cannot see squash merges, a proven branch then goes
 * with `git update-ref -d`, only if it still points at the analysed commit.
 */
async function deleteBranch(git: RunGit, branch: CleanBranch, seen: SeenWorktree, recorder: DeletionRecorder): Promise<Outcome> {
	const tip = await readTip(git, branch.name);
	if (tip?.sha !== branch.tip) {
		return { result: 'failed', error: tip ? 'it moved since it was analysed; run gsp clean again' : 'it no longer exists' };
	}
	const worktree = linkedPath(branch);
	if (worktree !== seen.path || !(await worktreeUnchanged(git, branch, seen))) {
		return { skip: 'worktree-changed' };
	}
	if (worktree) {
		try {
			await git([...WORKTREE_REMOVE, worktree]);
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
 * skipped as `fetch-failed`, and so is a planned deletion that only
 * `git ls-remote` proved (its upstream gone) and the failed fetch could not
 * confirm.
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
			// Proven by ls-remote, which the failed fetch could not confirm: the remote is the cause, not the branch.
			return stale && previous.verdictReason === 'upstream-gone' ? skipped(branch, 'fetch-failed', previous.hint) : skipped(branch, 'plan-changed', replan(branch));
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
 * default branch is never deleted. Returns the message explaining a change
 * that held a deletion back, if any.
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
	if (!changed || !held.some((branch, index) => branch.reason === 'plan-changed' && branches[index].action === 'delete')) {
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
	cleaned: { readonly remote: string; readonly branches: readonly CleanRemoteBranch[] } | undefined,
	worktreesPruned: readonly string[],
	restored: readonly string[]
): CleanReport {
	return {
		schema: CLEAN_SCHEMA,
		mode,
		checks: { ...analysis.checks, remote },
		branches,
		...(cleaned ? { remoteBranches: cleaned.branches } : {}),
		worktreesPruned,
		restore: restoreCommand(restored),
		summary: summarize(branches, mode, cleaned),
	};
}

const cmd = (...args: string[]) => args.map(quoteShellArg).join(' ');

/** For each branch of `remote`, the local branches whose upstream it is. */
function trackersOf(upstreams: ReadonlyMap<string, Upstream>, remote: string): Map<string, string[]> {
	const trackers = new Map<string, string[]>();
	for (const [local, upstream] of upstreams) {
		if (upstream.remote === remote && upstream.remoteRef.startsWith('refs/heads/')) {
			const name = upstream.remoteRef.slice('refs/heads/'.length);
			trackers.set(name, [...(trackers.get(name) ?? []), local]);
		}
	}
	return trackers;
}

/**
 * Checks the remote deletions decided after the fetch: when the fetch failed,
 * the remote cannot be reached and its branches were not checked again
 * (`fetch-failed`); when the default branch changed, no proof holds the way
 * the plan said (`plan-changed`).
 */
export function holdRemoteToFetch(
	branches: readonly CleanRemoteBranch[] | undefined,
	remote: RemoteCheck,
	baseChanged: boolean
): CleanRemoteBranch[] | undefined {
	const stale = remote.source === 'local-refs' && remote.reason === 'unreachable';
	return branches?.map((branch) => {
		if (branch.action !== 'delete') {
			return branch;
		}
		if (baseChanged) {
			return { ...branch, action: 'skip', reason: 'plan-changed', hint: cmd('gsp', 'clean', '--dry-run', remoteFlag(branch.remote)) };
		}
		return stale ? { ...branch, action: 'skip', reason: 'fetch-failed', hint: branch.hint } : branch;
	});
}

/**
 * Deletes the planned remote branches, one push each, with a lease on the
 * analysed tip: a branch someone pushed to since is not deleted
 * (`plan-changed`). Each deletion is recorded, so `gsp restore` can push it back.
 */
async function deleteRemoteBranches(git: RunGit, branches: readonly CleanRemoteBranch[], recorder: DeletionRecorder): Promise<CleanRemoteBranch[]> {
	const results: CleanRemoteBranch[] = [];
	for (const branch of branches) {
		if (branch.action !== 'delete') {
			results.push(branch);
			continue;
		}
		const ref = `refs/heads/${branch.name}`;
		try {
			await git(['push', `--force-with-lease=${ref}:${branch.tip}`, branch.remote, `:${ref}`]);
		} catch (error) {
			const reason = gitFailureReason(error);
			const stderr = (error as { stderr?: unknown }).stderr;
			results.push(
				/stale info/.test(`${typeof stderr === 'string' ? stderr : ''}${toErrorMessage(error)}`)
					? { ...branch, action: 'skip', reason: 'plan-changed', hint: cmd('gsp', 'clean', branch.name, '--dry-run', remoteFlag(branch.remote)) }
					: { ...branch, result: 'failed', error: reason }
			);
			continue;
		}
		await recorder.record({ branch: branch.name, sha: branch.tip, remote: branch.remote });
		results.push({ ...branch, result: 'deleted', hint: null });
	}
	return results;
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
	const cleaned = options.remote === undefined ? undefined : await resolveRemote(git, options.remote);
	const apply = !options.dryRun && (options.yes || options.canPrompt);
	const mode: CleanMode = apply ? 'apply' : 'plan';
	const upstreams = await readUpstreams(git);
	const remotes = await remotesToCheck(git, upstreams, cleaned);
	const online = options.fetch && remotes.length > 0;
	const heads: RemoteHeads | undefined = online
		? await ui.withProgress({ title: 'Checking remote branches' }, () => lsRemote(git, remotes))
		: undefined;
	// The cleaned remote's branches as ls-remote read them, else as last fetched.
	const plannedHeads = cleaned === undefined ? undefined : heads && !('error' in heads) ? heads.get(cleaned) : await readTrackingHeads(git, cleaned);

	const locals = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).stdout.split('\n').filter(Boolean);
	const missing = options.patterns.filter((pattern) => !isBranchGlob(pattern) && !locals.includes(pattern) && !plannedHeads?.has(pattern));
	if (missing.length > 0) {
		throw new UnknownBranchError(missing);
	}

	const offline: RemoteCheck = { source: 'local-refs', reason: options.fetch ? 'no-remote' : 'no-fetch' };
	const prunable = (await listWorktrees(context)).filter((worktree) => worktree.state === 'prunable').map((worktree) => worktree.path);
	const named = new Set(options.patterns.filter((pattern) => !isBranchGlob(pattern)));
	const analyse = (fetched: boolean, remoteHeads?: ReadonlyMap<string, string>) =>
		ui.withProgress({ title: 'Analysing branches' }, () =>
			analyzeBranches(
				{ git, ...(context.gh ? { gh: context.gh } : {}) },
				{
					...(options.patterns.length > 0 ? { branches: options.patterns } : {}),
					protectedPatterns: options.protectedPatterns,
					github: options.github,
					fetched,
					named: [...named],
					...(cleaned === undefined ? {} : { remote: { name: cleaned, ...(remoteHeads ? { heads: remoteHeads } : {}) } }),
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
	const trackers = cleaned === undefined ? new Map<string, string[]>() : trackersOf(upstreams, cleaned);
	const decideRemote = (remoteBranches: readonly RemoteBranchAnalysis[] | undefined, deletedLocals: Iterable<string>) =>
		remoteBranches &&
		decideRemoteActions(
			remoteBranches.map((branch) => ({ ...branch, trackedBy: trackers.get(branch.name) ?? [] })),
			new Set(deletedLocals)
		);
	const deleting = (list: readonly CleanBranch[]) => list.filter((branch) => branch.action === 'delete').map((branch) => branch.name);

	// The plan: read-only, whatever the mode.
	let analysis = await analyse(false, plannedHeads);
	let remote: RemoteCheck = offline;
	if (heads) {
		({ analysis, remote } = await markGoneUpstreams(git, analysis, upstreams, remotes, heads));
	}
	warnIfUnreachable(remote);
	const plannedBase = analysis.checks.base;
	const decideOptions: DecideOptions = { force: options.force, named, defaultBranch: plannedBase?.name };
	const plannedIgnored = new Map<string, readonly string[]>();
	let planned = await inspectWorktrees(git, analysis.branches, named, plannedIgnored);
	let branches = decideActions(planned, decideOptions);
	let remoteBranches = decideRemote(analysis.remoteBranches, deleting(branches));
	let worktreesPruned: readonly string[] = apply ? [] : prunable;
	const report = (outcome: CleanOutcome, restored: readonly string[] = []): CleanRun => ({
		report: buildReport(mode, analysis, remote, branches, cleaned === undefined ? undefined : { remote: cleaned, branches: remoteBranches ?? [] }, worktreesPruned, restored),
		outcome,
	});
	const pending = () => hasPendingDeletions(branches, remoteBranches);

	if (!apply) {
		return report(pending() ? 'not-applied' : 'done');
	}

	let picked: ReadonlySet<string> | undefined;
	const offered = pickItems(branches, options.force);
	if (options.canPrompt && !options.yes && offered.length > 0) {
		const answer = await ui.pickMany({ items: offered, title: 'Select branches to delete' });
		if (answer === undefined || answer.length === 0) {
			branches = decideActions(planned, { ...decideOptions, picked: new Set() });
			remoteBranches = decideRemote(analysis.remoteBranches, []);
			return report('cancelled');
		}
		picked = new Set(answer);
		branches = decideActions(planned, { ...decideOptions, picked });
		remoteBranches = decideRemote(analysis.remoteBranches, deleting(branches));
		const deletions = branches.filter((branch) => branch.action === 'delete');
		const forced = deletions.filter((branch) => branch.needsForce).length;
		if (options.confirm && deletions.length > 0) {
			const undo = canRecordDeletions(context.deletionLog) ? 'You can restore them later.' : 'This cannot be undone.';
			const work = forced > 0 ? ` ${forced} of them hold work found nowhere else.` : '';
			const confirmed = await ui.confirm(`Delete ${deletions.length} branch(es)?${work} ${undo}`, `Delete ${deletions.length}`);
			if (!confirmed) {
				branches = decideActions(planned, { ...decideOptions, picked: new Set() });
				remoteBranches = decideRemote(analysis.remoteBranches, []);
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
	const plannedRemote = remoteBranches;
	analysis = await analyse(remote.source === 'fetch');
	// The worktrees as the plan showed them, to check them against before removing one.
	const shown = new Map(branches.map((branch) => [branch.name, branch]));
	const fetchedIgnored = new Map<string, readonly string[]>();
	planned = await inspectWorktrees(git, analysis.branches, named, fetchedIgnored);
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
		// A branch the plan did not read the worktree of (`--yes`, proven by the fetch) is checked against the read after it.
		const plan = shown.get(branch.name);
		const seen: SeenWorktree = {
			path: linkedPath(plan ?? branch),
			ignored: plannedIgnored.get(branch.name) ?? fetchedIgnored.get(branch.name) ?? [],
		};
		const outcome = await deleteBranch(git, branch, seen, recorder);
		if ('skip' in outcome) {
			applied.push(skipped(branch, outcome.skip, branch.hint));
		} else {
			applied.push({ ...branch, result: outcome.result, hint: outcome.result === 'deleted' ? null : branch.hint, ...(outcome.error ? { error: outcome.error } : {}) });
		}
	}
	branches = applied;

	// Remote branches go only with --yes, once the local ones they could be the upstream of are gone.
	if (options.yes) {
		const deletedLocals = branches.filter((branch) => branch.result === 'deleted').map((branch) => branch.name);
		const baseChanged = plannedBase?.ref !== analysis.checks.base?.ref;
		remoteBranches = holdRemoteToFetch(decideRemote(analysis.remoteBranches, deletedLocals), remote, baseChanged);
		remoteBranches = remoteBranches && (await deleteRemoteBranches(git, remoteBranches, recorder));
	} else {
		remoteBranches = plannedRemote;
	}
	const failed = [...branches, ...(remoteBranches ?? [])].some((branch) => branch.result === 'failed' || branch.result === 'worktree-removed');
	return report(failed ? 'failed' : pending() ? 'not-applied' : 'done', recorder.recorded);
}
