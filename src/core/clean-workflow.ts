import { analyzeBranches, type BranchAnalysis, type BranchAnalysisResult } from './branch-analysis';
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
	type RemoteCheck,
} from './clean-plan';
import { canRecordDeletions, createDeletionRecorder, type DeletionRecorder } from './deletion-log';
import { toErrorMessage } from './errors';
import type { RunGit } from './git-command';
import type { RunGh } from './github-signal';
import { isNotFullyMergedError } from './sweep-logic';
import type { PickItem, WorkflowContext } from './workflow';
import { listWorktrees, pruneWorktrees } from './worktrees';

export type CleanOptions = {
	/** Branch names or globs; only the matching branches are considered. All branches when empty. */
	readonly patterns: readonly string[];
	/** Plan only, whatever the other flags. */
	readonly dryRun: boolean;
	/** Apply the plan without asking. */
	readonly yes: boolean;
	readonly force: boolean;
	/** `git fetch --prune` before applying, `git ls-remote` before planning. */
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

function firstLine(message: string): string {
	return message.split('\n').find((line) => line.trim())?.trim() ?? message;
}

/**
 * Plan mode only: finds the upstreams deleted on their remote with
 * `git ls-remote --heads`, which writes nothing, where a fetch would prune
 * them. Each tracked branch whose remote head is missing is marked gone, as
 * the analysis would after a prune: an alive branch becomes `upstream-gone`,
 * and its unpushed commits are counted without the stale remote-tracking ref.
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
		return { analysis, remote: { source: 'local-refs', reason: 'unreachable', detail: firstLine(toErrorMessage(error)) } };
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
			const proven = branch.verdict === 'dead';
			if (proven || branch.reason === 'default-branch') {
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
 * Apply mode only: `git fetch --prune`, following a renamed remote default
 * branch (Git 2.48+; older versions ignore the setting). A failure is not
 * fatal: the local remote-tracking refs are used instead.
 */
async function fetchAndPrune(context: CleanContext, remotes: readonly string[]): Promise<RemoteCheck> {
	const follow = remotes.flatMap((remote) => ['-c', `remote.${remote}.followRemoteHEAD=always`]);
	try {
		await context.ui.withProgress({ title: 'Fetching and pruning remote references' }, () =>
			context.git([...follow, 'fetch', '--prune', '--multiple', ...remotes])
		);
		return { source: 'fetch', remotes };
	} catch (error) {
		const detail = firstLine(toErrorMessage(error));
		context.output.appendLine(`Could not fetch (${detail}); using the local remote-tracking refs.`);
		return { source: 'local-refs', reason: 'unreachable', detail };
	}
}

async function readTip(git: RunGit, branch: string): Promise<{ sha: string; upstream?: string } | undefined> {
	const ref = `refs/heads/${branch}`;
	// A pattern also matches the refs below it ("a" matches "a/b"): keep the exact ref.
	const { stdout } = await git(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(upstream)', ref]);
	const [, sha, upstream] = stdout.split('\n').map((line) => line.split('\t')).find(([name]) => name === ref) ?? [];
	return sha ? { sha, ...(upstream ? { upstream } : {}) } : undefined;
}

/**
 * Deletes one planned branch: checks it still points at the analysed commit,
 * removes its linked worktree (never with --force: Git refuses a dirty or
 * locked one), then deletes it. `git branch -d` is tried first; `-D` only
 * follows for a branch the plan proved dead or that `--force` covers, since
 * Git cannot see squash merges.
 */
async function deleteBranch(git: RunGit, branch: CleanBranch, recorder: DeletionRecorder): Promise<{ result: CleanResult; error?: string }> {
	const tip = await readTip(git, branch.name);
	if (tip?.sha !== branch.tip) {
		return { result: 'failed', error: tip ? 'it moved since it was analysed; run gsp clean again' : 'it no longer exists' };
	}
	const worktree = branch.worktree && !branch.worktree.prunable ? branch.worktree.path : undefined;
	if (worktree) {
		try {
			await git(['worktree', 'remove', worktree]);
		} catch (error) {
			return { result: 'failed', error: `could not remove worktree ${worktree}: ${firstLine(toErrorMessage(error))}` };
		}
	}
	try {
		try {
			await git(['branch', '-d', branch.name]);
		} catch (error) {
			if (!isNotFullyMergedError(toErrorMessage(error))) {
				throw error;
			}
			await git(['branch', '-D', branch.name]);
		}
	} catch (error) {
		return { result: worktree ? 'worktree-removed' : 'failed', error: firstLine(toErrorMessage(error)) };
	}
	await recorder.record({ branch: branch.name, ...tip, ...(worktree ? { worktree } : {}) });
	return { result: 'deleted' };
}

/** Picker entries: every planned deletion pre-selected, branches needing --force shown unselected. */
function pickItems(branches: readonly CleanBranch[]): PickItem[] {
	return branches
		.filter((branch) => branch.action === 'delete' || branch.reason === 'needs-force')
		.map((branch) => {
			const worktree = branch.worktree && !branch.worktree.prunable ? `, removes worktree ${branch.worktree.path}` : '';
			const force = branch.needsForce ? (branch.verdict === 'alive' ? ', not merged' : `, ${branch.unpushedCommits} unpushed`) : '';
			return { label: branch.name, description: `${describeVerdict(branch)}${force}${worktree}`, picked: branch.action === 'delete' };
		});
}

export function buildReport(
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

/** What `gsp clean` and `gsp post-pr` read before deciding anything. */
export type BranchInspection = {
	readonly mode: CleanMode;
	readonly remote: RemoteCheck;
	/** Worktree registrations whose directory is gone: pruned (apply) or that would be (plan). */
	readonly worktreesPruned: readonly string[];
	readonly analysis: BranchAnalysisResult;
};

export type InspectOptions = Pick<CleanOptions, 'patterns' | 'fetch' | 'github' | 'protectedPatterns'> & {
	/** Fetch and prune first, so the plan can be applied; otherwise read only. */
	readonly apply: boolean;
};

/**
 * Reads the remotes and analyses the local branches. Planning writes nothing:
 * no fetch, no prune, no ref, config or object write; deleted upstreams are
 * found with `git ls-remote`. Applying fetches with --prune and prunes the
 * worktree registrations whose directory is gone before analysing.
 */
export async function inspectBranches(context: CleanContext, options: InspectOptions): Promise<BranchInspection> {
	const { git, ui, output } = context;
	const { apply } = options;
	const mode: CleanMode = apply ? 'apply' : 'plan';
	const upstreams = await readUpstreams(git);
	const remotes = await remotesToCheck(git, upstreams);
	const online = options.fetch && remotes.length > 0;
	let remote: RemoteCheck = online ? { source: 'fetch', remotes } : { source: 'local-refs', reason: options.fetch ? 'no-remote' : 'no-fetch' };
	let worktreesPruned: readonly string[];
	if (apply) {
		if (online) {
			remote = await fetchAndPrune(context, remotes);
		}
		// Until pruned, a worktree whose directory is gone still holds its branch.
		worktreesPruned = (await pruneWorktrees(context)).pruned;
	} else {
		worktreesPruned = (await listWorktrees(context)).filter((worktree) => worktree.state === 'prunable').map((worktree) => worktree.path);
	}

	let analysis = await ui.withProgress({ title: 'Analysing branches' }, () =>
		analyzeBranches(
			{ git, ...(context.gh ? { gh: context.gh } : {}) },
			{
				...(options.patterns.length > 0 ? { branches: options.patterns } : {}),
				protectedPatterns: options.protectedPatterns,
				github: options.github,
				fetched: apply && remote.source === 'fetch',
			}
		)
	);
	if (!apply && online) {
		({ analysis, remote } = await ui.withProgress({ title: 'Checking remote branches' }, () => markGoneUpstreams(git, analysis, upstreams, remotes)));
	}
	if (remote.source === 'local-refs' && remote.reason === 'unreachable') {
		output.appendLine(`Could not reach the remote (${remote.detail ?? 'unknown error'}); using the local remote-tracking refs.`);
	}
	return { mode, remote, worktreesPruned, analysis };
}

/** Deletes every branch planned for deletion, in order, and records each deletion. */
export async function applyDeletions(git: RunGit, branches: readonly CleanBranch[], recorder: DeletionRecorder): Promise<CleanBranch[]> {
	const applied: CleanBranch[] = [];
	for (const branch of branches) {
		if (branch.action !== 'delete') {
			applied.push(branch);
			continue;
		}
		const { result, error } = await deleteBranch(git, branch, recorder);
		applied.push({ ...branch, result, hint: result === 'deleted' ? null : branch.hint, ...(error ? { error } : {}) });
	}
	return applied;
}

/** How applying `branches` ended. */
export function appliedOutcome(branches: readonly CleanBranch[]): CleanOutcome {
	if (branches.some((branch) => branch.result === 'failed' || branch.result === 'worktree-removed')) {
		return 'failed';
	}
	return hasPendingDeletions(branches) ? 'not-applied' : 'done';
}

/**
 * `gsp clean`: classifies the local branches (see `analyzeBranches`) and
 * deletes the dead ones and their clean linked worktrees.
 *
 * See {@link inspectBranches} for what planning and applying read and write.
 * The plan is applied with `yes`, or after the picker when someone can answer
 * it; otherwise it is only reported.
 */
export async function runCleanWorkflow(context: CleanContext, options: CleanOptions): Promise<CleanRun> {
	const { git, ui, output } = context;
	const locals = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).stdout.split('\n').filter(Boolean);
	const missing = options.patterns.filter((pattern) => !isBranchGlob(pattern) && !locals.includes(pattern));
	if (missing.length > 0) {
		throw new UnknownBranchError(missing);
	}

	const apply = !options.dryRun && (options.yes || options.canPrompt);
	const { mode, remote, worktreesPruned, analysis } = await inspectBranches(context, { ...options, apply });

	const decideOptions = {
		force: options.force,
		named: new Set(options.patterns.filter((pattern) => !isBranchGlob(pattern))),
		defaultBranch: analysis.checks.base?.name,
	};
	let branches = decideActions(analysis.branches, decideOptions);
	const report = (outcome: CleanOutcome, restored: readonly string[] = []): CleanRun => ({
		report: buildReport(mode, analysis, remote, branches, worktreesPruned, restored),
		outcome,
	});
	const offered = pickItems(branches);
	const planned = branches.some((branch) => branch.action === 'delete');

	if (!apply) {
		return report(hasPendingDeletions(branches) ? 'not-applied' : 'done');
	}

	if (options.canPrompt && !options.yes && offered.length > 0) {
		const picked = await ui.pickMany({ items: offered, title: 'Select branches to delete' });
		if (picked === undefined || picked.length === 0) {
			branches = decideActions(analysis.branches, { ...decideOptions, picked: new Set() });
			return report('cancelled');
		}
		branches = decideActions(analysis.branches, { ...decideOptions, picked: new Set(picked) });
		const deleting = branches.filter((branch) => branch.action === 'delete');
		const forced = deleting.filter((branch) => branch.needsForce).length;
		if (options.confirm && deleting.length > 0) {
			const undo = canRecordDeletions(context.deletionLog) ? 'You can restore them later.' : 'This cannot be undone.';
			const work = forced > 0 ? ` ${forced} of them hold work found nowhere else.` : '';
			const confirmed = await ui.confirm(`Delete ${deleting.length} branch(es)?${work} ${undo}`, `Delete ${deleting.length}`);
			if (!confirmed) {
				branches = decideActions(analysis.branches, { ...decideOptions, picked: new Set() });
				return report('cancelled');
			}
		}
	} else if (!planned) {
		return report(hasPendingDeletions(branches) ? 'not-applied' : 'done');
	}

	const recorder = createDeletionRecorder(context.deletionLog, 'sweep', output.appendLine);
	branches = await applyDeletions(git, branches, recorder);
	return report(appliedOutcome(branches), recorder.recorded);
}
