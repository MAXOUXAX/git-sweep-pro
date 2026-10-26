import { analyzeBranches } from './branch-analysis';
import { CLEAN_SCHEMA, decideActions, hasPendingDeletions, restoreCommand, type CleanBranch, type PlannedBranch } from './clean-plan';
import {
	appliedOutcome,
	applyDeletions,
	buildReport,
	holdToBase,
	holdToPlan,
	planBranches,
	inspectWorktrees,
	refreshBranches,
	type BranchPlan,
	type CleanContext,
	type CleanOptions,
	type CleanOutcome,
} from './clean-workflow';
import { canRecordDeletions, createDeletionRecorder } from './deletion-log';
import { toErrorMessage } from './errors';
import { quoteShellArg, type RunGit } from './git-command';
import type { RunGh } from './github-signal';
import {
	decideTarget,
	hasPendingChanges,
	hasNoLocalBranch,
	postPrCommand,
	withPlannedOthers,
	type DefaultBranchUpdate,
	type PostPrReport,
	type PostPrScope,
} from './post-pull-request-plan';
import { canonical, listWorktrees, type Worktree } from './worktrees';

export type PostPrOptions = Pick<CleanOptions, 'dryRun' | 'yes' | 'force' | 'fetch' | 'github' | 'protectedPatterns' | 'canPrompt' | 'confirm'> & {
	/** The merged branch; the branch checked out where gsp runs when undefined. */
	readonly branch: string | undefined;
	/** The branch it was merged into; the default branch when undefined. */
	readonly into: string | undefined;
	/** `-C <path>`, as given: the commands gsp suggests keep it. */
	readonly cwd?: string;
	/** The only other branches the clean step may delete (`--clean`, none with `--no-clean`); every proven one when undefined. */
	readonly others?: readonly string[];
};

export type PostPrContext = CleanContext & {
	/** Runs git in another worktree of the repository: once the one gsp runs in is removed, git cannot start there. */
	readonly gitAt: (dir: string) => RunGit;
};

export type PostPrRun = { readonly report: PostPrReport; readonly outcome: CleanOutcome };

/** Arguments that name no branch, or none post-pr can finish: the CLI reports them as a usage error. */
export class PostPrUsageError extends Error {
	/** `unknown-branch`: the branch named does not exist, and nothing knows it did. */
	readonly code: 'usage' | 'unknown-branch';

	constructor(message: string, code: 'usage' | 'unknown-branch' = 'usage') {
		super(message);
		this.code = code;
	}
}

function firstLine(message: string): string {
	return message.split('\n').find((line) => line.trim())?.trim() ?? message;
}

/** Tips of the exact refs given, by full ref name. */
async function readTips(git: RunGit, refs: readonly string[]): Promise<Map<string, string>> {
	const { stdout } = await git(['for-each-ref', '--format=%(refname)%09%(objectname)', ...refs]);
	const wanted = new Set(refs);
	const tips = new Map<string, string>();
	for (const line of stdout.split('\n')) {
		const [ref, sha] = line.split('\t');
		// A pattern also matches the refs below it ("a" matches "a/b"): keep the exact ones.
		if (ref && sha && wanted.has(ref)) {
			tips.set(ref, sha);
		}
	}
	return tips;
}

/** Whether a worktree has uncommitted changes to tracked files. Read-only: no index refresh is written. */
async function hasTrackedChanges(git: RunGit, worktree: string): Promise<boolean> {
	const { stdout } = await git(['-C', worktree, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=no']);
	return stdout.trim().length > 0;
}

/** The full ref `--into` names: its remote branch when there is one, else the local branch. */
async function resolveInto(git: RunGit, into: string, remote: string | null): Promise<string> {
	const candidates = [...(remote ? [`refs/remotes/${remote}/${into}`] : []), `refs/heads/${into}`];
	const tips = await readTips(git, candidates);
	const ref = candidates.find((candidate) => tips.has(candidate));
	if (!ref) {
		throw new PostPrUsageError(`No branch named "${into}" to merge into.`, 'unknown-branch');
	}
	return ref;
}

/**
 * Fast-forwards the default branch to its remote branch: with
 * `git merge --ff-only` in the worktree it is checked out in, when that one
 * is clean, or by moving the ref when it is checked out nowhere. Never
 * fails the run: what stopped it is reported instead.
 */
async function updateDefaultBranch(
	context: PostPrContext,
	git: RunGit,
	name: string,
	upstreamRef: string | null,
	options: { readonly apply: boolean; readonly checkedOutAt?: string; readonly remoteAhead?: boolean }
): Promise<DefaultBranchUpdate> {
	const local = `refs/heads/${name}`;
	const tips = await readTips(git, [local, ...(upstreamRef ? [upstreamRef] : [])]);
	const from = tips.get(local) ?? null;
	const to = upstreamRef ? (tips.get(upstreamRef) ?? null) : null;
	const upstream = upstreamRef?.replace(/^refs\/remotes\//, '') ?? null;
	const where =
		options.checkedOutAt ??
		(await listWorktrees({ ...context, git })).find((worktree) => worktree.branch === name && worktree.state !== 'prunable')?.path ??
		null;
	const update: DefaultBranchUpdate = {
		name,
		from,
		to,
		upstream,
		where,
		updated: false,
		remoteAhead: options.remoteAhead ?? false,
		reason: null,
		hint: null,
	};
	if (!from) {
		return { ...update, reason: 'not-local' };
	}
	if (!to || !upstreamRef) {
		return { ...update, reason: 'no-remote' };
	}
	if (from === to) {
		return { ...update, reason: 'up-to-date' };
	}
	const ahead = Number((await git(['rev-list', '--count', from, '--not', to])).stdout.trim());
	if (ahead > 0) {
		return { ...update, reason: 'diverged' };
	}
	const merge = where ? ['-C', where, 'merge', '--ff-only', upstreamRef] : undefined;
	if (where && !options.checkedOutAt && (await hasTrackedChanges(git, where))) {
		return { ...update, reason: 'dirty', hint: ['git', '-C', where, 'merge', '--ff-only', upstream ?? upstreamRef].map(quoteShellArg).join(' ') };
	}
	if (!options.apply) {
		return { ...update, reason: 'not-applied' };
	}
	try {
		// The old value makes the ref update atomic: it fails if the branch moved meanwhile.
		await context.ui.withProgress({ title: `Updating ${name}` }, () => git(merge ?? ['update-ref', '-m', 'gsp post-pr', local, to, from]));
		return { ...update, updated: true };
	} catch (error) {
		return { ...update, reason: 'failed', error: firstLine(toErrorMessage(error)) };
	}
}

/**
 * Plan mode: whether the remote branch `ref` follows has moved since the last
 * fetch, read with `git ls-remote`, which writes nothing.
 */
async function isRemoteAhead(git: RunGit, ref: string, remote: string, tip: string): Promise<boolean> {
	try {
		const { stdout } = await git(['ls-remote', remote, ref.replace(/^refs\/remotes\/[^/]+\//, 'refs/heads/')]);
		const sha = stdout.split('\t')[0]?.trim();
		return Boolean(sha) && sha !== tip;
	} catch {
		return false;
	}
}

/**
 * Switches the main checkout from the merged branch to `into`. When `into`
 * is checked out in another worktree, the main checkout is left detached at it.
 */
async function switchMainCheckout(git: RunGit, into: string, worktrees: readonly Worktree[]): Promise<void> {
	const elsewhere = worktrees.some((worktree) => worktree.state !== 'main' && worktree.state !== 'prunable' && worktree.branch === into);
	await git(elsewhere ? ['switch', '--detach', into] : ['switch', into]);
}

function confirmMessage(target: CleanBranch | null, others: number, undo: string): string {
	const actions: string[] = [];
	if (target) {
		const worktree = target.worktree && !target.worktree.prunable && !target.worktree.isMain ? ` and its worktree ${target.worktree.path}` : '';
		const proof = target.action === 'delete' ? (target.needsForce ? ' (its work is found nowhere else)' : '') : ', if fetching proves it merged';
		actions.push(`delete ${target.name}${worktree}${proof}`);
	}
	if (others > 0) {
		actions.push(`delete ${others} other merged branch(es)`);
	}
	const sentence = actions.join(', then ');
	return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}? ${undo}`;
}

type MergedPullRequest = { readonly number: number; readonly baseRefName: string; readonly headRefOid: string };

/** The merged pull requests whose head branch is `branch`, as GitHub lists them; none without `gh` or when it fails. */
async function mergedPullRequestsOf(gh: RunGh | undefined, branch: string): Promise<readonly MergedPullRequest[]> {
	if (!gh) {
		return [];
	}
	try {
		const { stdout } = await gh(['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number,baseRefName,headRefOid']);
		return JSON.parse(stdout) as MergedPullRequest[];
	} catch {
		return [];
	}
}

/**
 * Another branch that holds the work of a branch not proven merged into
 * `intoRef`: the base of its merged pull request, matched by its tip, else a
 * branch of `remote` whose tip contains it.
 */
async function findMergedElsewhere(
	context: PostPrContext,
	branch: PlannedBranch,
	into: string,
	intoRef: string,
	remote: string | null
): Promise<string | undefined> {
	const pullRequest = (await mergedPullRequestsOf(context.gh, branch.name)).find(
		(candidate) => candidate.headRefOid === branch.tip && candidate.baseRefName !== into
	);
	if (pullRequest) {
		return pullRequest.baseRefName;
	}
	if (!remote) {
		return undefined;
	}
	const prefix = `refs/remotes/${remote}/`;
	const { stdout } = await context.git(['for-each-ref', '--contains', branch.tip, '--format=%(refname)', `refs/remotes/${remote}`]);
	const own = new Set([intoRef, `${prefix}HEAD`, `${prefix}${branch.name}`, ...(branch.upstream ? [`refs/remotes/${branch.upstream}`] : [])]);
	return stdout
		.split('\n')
		.find((ref) => ref.startsWith(prefix) && !own.has(ref))
		?.slice(prefix.length);
}

/** The remote a branch's unpushed commits go to: its own, else `fallback`. */
async function pushRemoteOf(git: RunGit, branch: string, fallback: string | null): Promise<string | undefined> {
	const configured = await git(['config', '--get', `branch.${branch}.remote`]).then(
		(result) => result.stdout.trim(),
		() => ''
	);
	// "." is the repository itself: nothing to push to.
	return configured && configured !== '.' ? configured : (fallback ?? undefined);
}

/** Levenshtein distance, to suggest the branch a typo meant. */
function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			row.push(Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
		}
		previous = row;
	}
	return previous[b.length];
}

/** " Did you mean …?" with the closest local branches, or "" when none is close. */
function suggest(name: string, branches: readonly string[]): string {
	const close = branches
		.map((branch) => ({ branch, distance: editDistance(name, branch) }))
		.filter(({ distance }) => distance <= Math.max(2, Math.floor(name.length / 4)))
		.sort((a, b) => a.distance - b.distance)
		.slice(0, 3)
		.map(({ branch }) => branch);
	return close.length === 0 ? '' : ` Did you mean ${close.join(' or ')}?`;
}

type Positional = {
	/** The branch to finish, when the positional names one that exists. */
	readonly requested?: string;
	/** The positional names a branch that has no local branch, but that something knows. */
	readonly noLocal?: string;
};

type PositionalFacts = {
	readonly name: string | undefined;
	readonly current: string;
	readonly into: string;
	readonly intoRemote: string | undefined;
	readonly base: { readonly name: string; readonly remote: string | null } | null;
	readonly plan: BranchPlan;
	readonly localBranches: readonly string[];
};

/**
 * What the branch named on the command line asks for. The positional never
 * lifts protection: the old form named the branch to go back to
 * (`gsp post-pr main`), so the default branch or a protected branch is read
 * as that form, and the current branch is finished. Any other branch named is
 * the one to finish, wherever it is checked out. A branch missing locally is
 * reported as having no local branch only when something knows it existed:
 * otherwise it is a typo.
 */
async function readPositional(context: PostPrContext, options: PostPrOptions, facts: PositionalFacts): Promise<Positional> {
	const { name, current, into, intoRemote, base, plan } = facts;
	if (name === undefined) {
		return {};
	}
	const deprecated = (reason: string) => {
		context.output.appendLine(`note: ${reason}. Finishing the current branch.`);
		return {};
	};
	const defaultForms = new Set([
		into,
		...(intoRemote ? [`${intoRemote}/${into}`] : []),
		...(base ? [base.name, ...(base.remote ? [`${base.remote}/${base.name}`] : [])] : []),
	]);
	if (defaultForms.has(name)) {
		return deprecated(`"gsp post-pr ${name}" is deprecated: run "gsp post-pr" from the merged branch, or "gsp post-pr <branch>"`);
	}
	const protection = (branch: string) => plan.planned.find((planned) => planned.name === branch)?.protected ?? null;
	const canFinishCurrent = current !== 'HEAD' && current !== name && !defaultForms.has(current) && protection(current) === null;
	const oldForm = `so "gsp post-pr ${name}" is read as the deprecated "gsp post-pr <default branch>"`;
	if (protection(name)) {
		if (canFinishCurrent) {
			return deprecated(`${name} is protected, ${oldForm}. If the pull request was merged into ${name}, run "gsp post-pr --into ${name}"`);
		}
		throw new PostPrUsageError(`${name} is protected: gsp post-pr never deletes it. To finish a branch merged into ${name}, run "gsp post-pr <branch> --into ${name}".`);
	}
	if (facts.localBranches.includes(name)) {
		return { requested: name };
	}
	const remoteRefs = plan.remotes.map((remote) => `refs/remotes/${remote}/${name}`);
	const known =
		context.deletionLog.list().some((entry) => entry.branch === name) ||
		(await readTips(context.git, remoteRefs)).size > 0 ||
		(options.github && (await mergedPullRequestsOf(context.gh, name)).length > 0);
	if (!known) {
		throw new PostPrUsageError(`No branch named "${name}".${suggest(name, facts.localBranches)}`, 'unknown-branch');
	}
	return { noLocal: name };
}

/**
 * `gsp post-pr`: once a pull request is merged, deletes its branch (and the
 * linked worktree it is checked out in), fast-forwards the default branch,
 * then runs the clean step with proof-only rules.
 *
 * The merged branch is deleted only when the analysis proves its work is in
 * the default branch, or with `force`. It works from any worktree: when it
 * runs in the worktree it removes, git runs from the main checkout from then
 * on and the report says where to continue (`nextCwd`); when the branch is
 * checked out in the main checkout, that checkout is switched to the default
 * branch first. Planning writes nothing, as with `gsp clean`.
 */
export async function runPostPullRequestWorkflow(context: PostPrContext, options: PostPrOptions): Promise<PostPrRun> {
	const { git, ui, output } = context;
	const [head, worktrees, locals] = await Promise.all([
		git(['rev-parse', '--abbrev-ref', 'HEAD']),
		listWorktrees(context),
		git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
	]);
	const current = head.stdout.trim();
	const localBranches = locals.stdout.split('\n').filter(Boolean);
	const main = worktrees.find((worktree) => worktree.state === 'main');
	const mainCheckout = main?.path ?? context.root;

	const apply = !options.dryRun && (options.yes || options.canPrompt);
	const mode = apply ? 'apply' : 'plan';
	const read = { ...options, patterns: [] };
	// Ignored files are read for the branch to finish even when it is not proven merged, as for a branch named to gsp clean.
	const named = new Set([options.branch, current].filter((name): name is string => name !== undefined && name !== 'HEAD'));
	const plan = await planBranches(context, read, named);
	const base = plan.analysis.checks.base;
	const into = options.into ?? base?.name;
	if (!into) {
		throw new PostPrUsageError('No default branch found: name the branch the pull request was merged into with --into <branch>.');
	}
	const intoRef = into === base?.name ? base.ref : await resolveInto(git, into, base?.remote ?? 'origin');
	const intoRemote = /^refs\/remotes\/([^/]+)\//.exec(intoRef)?.[1];
	const upstreamRef = intoRemote ? intoRef : null;
	const scope: PostPrScope = {
		...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		...(options.into === undefined ? {} : { into: options.into }),
		protectedPatterns: options.protectedPatterns,
		github: options.github,
		fetch: options.fetch,
		...(options.others === undefined ? {} : { others: options.others }),
	};

	const { requested, noLocal } = await readPositional(context, options, {
		name: options.branch,
		current,
		into,
		intoRemote,
		base,
		plan,
		localBranches,
	});
	const targetName = noLocal ? undefined : (requested ?? (current !== 'HEAD' && current !== into ? current : undefined));

	/** The branch to finish, compared with --into; the detected default branch stays protected. */
	const analyseTarget = async (
		planned: readonly PlannedBranch[],
		ignored: Map<string, readonly string[]>,
		fetched: boolean
	): Promise<PlannedBranch | undefined> => {
		if (!targetName || into === base?.name) {
			return planned.find((branch) => branch.name === targetName);
		}
		const result = await analyzeBranches(
			{ git, ...(context.gh ? { gh: context.gh } : {}) },
			{
				branches: [targetName],
				base: intoRef,
				protectedPatterns: [...options.protectedPatterns, ...(base ? [base.name] : [])],
				github: options.github,
				fetched,
			}
		);
		return (await inspectWorktrees(git, result.branches, named, ignored)).find((branch) => branch.name === targetName);
	};
	const decide = async (branch: PlannedBranch | undefined, remoteAhead: boolean): Promise<CleanBranch | null> => {
		if (!branch) {
			return null;
		}
		const worktree = branch.worktree && !branch.worktree.prunable ? branch.worktree : null;
		// Only for a branch that is not proven merged: what may prove it without --force.
		const unproven = !options.force && branch.verdict === 'alive';
		const pushRemote = branch.unpushedCommits > 0 ? await pushRemoteOf(git, branch.name, intoRemote ?? null) : undefined;
		const mergedElsewhere =
			unproven && branch.unpushedCommits === 0 && !remoteAhead ? await findMergedElsewhere(context, branch, into, intoRef, intoRemote ?? null) : undefined;
		return decideTarget(branch, {
			force: options.force,
			into,
			mainCheckoutDirty: worktree?.isMain ? await hasTrackedChanges(git, worktree.path) : false,
			remoteAhead,
			// Its hints finish it along with the other branches the plan deletes, named.
			scope: withPlannedOthers(scope, others),
			...(mergedElsewhere === undefined ? {} : { mergedElsewhere }),
			...(pushRemote === undefined ? {} : { pushRemote }),
		});
	};

	const remoteAhead =
		plan.remote.source === 'ls-remote' && intoRemote !== undefined
			? await isRemoteAhead(git, intoRef, intoRemote, (await readTips(git, [intoRef])).get(intoRef) ?? '')
			: false;
	// The clean step: the other branches, with the rules of `gsp clean --yes`, limited to those named with --clean.
	const excluded = new Set([targetName, ...(into === base?.name ? [] : [into])]);
	const decideOthers = (planned: readonly PlannedBranch[]) =>
		decideActions(
			planned.filter((branch) => !excluded.has(branch.name) && (options.others === undefined || options.others.includes(branch.name))),
			{ force: false, named: new Set(), defaultBranch: base?.name }
		);
	let others = decideOthers(plan.planned);
	const plannedIgnored = new Map(plan.ignored);
	let analysed = await analyseTarget(plan.planned, plannedIgnored, false);
	let target = await decide(analysed, remoteAhead);
	let { analysis, remote } = plan;
	let worktreesPruned = apply ? [] : plan.prunable;

	const targetRecorder = createDeletionRecorder(context.deletionLog, 'post-pr', output.appendLine);
	const cleanRecorder = createDeletionRecorder(context.deletionLog, 'sweep', output.appendLine);
	let switched = false;
	/** Where to continue once the worktree gsp runs in is removed: the main checkout, or another worktree when it is bare. */
	let continueIn: string | null = mainCheckout;
	const targetWorktree = () => (analysed?.worktree && !analysed.worktree.prunable ? analysed.worktree : null);
	const inMain = () => targetWorktree()?.isMain === true;
	// Once the worktree gsp runs in is gone, git can only start from the main checkout.
	const leaving = () => {
		const worktree = targetWorktree();
		return worktree !== null && !worktree.isMain && canonical(worktree.path) === canonical(context.root);
	};

	const finish = (outcome: CleanOutcome | undefined, defaultBranch: DefaultBranchUpdate): PostPrRun => {
		const worktree = targetWorktree();
		const removed = worktree !== null && !worktree.isMain && (target?.result === 'deleted' || target?.result === 'worktree-removed');
		if (removed && leaving() && continueIn === null) {
			output.appendLine('The worktree you ran gsp in was removed, and the repository has no other worktree to continue in: cd to another directory.');
		}
		const report: PostPrReport = {
			schema: CLEAN_SCHEMA,
			command: 'post-pr',
			mode,
			branch: noLocal ? { name: noLocal, action: 'no-local-branch' } : target,
			worktree: { path: worktree?.path ?? null, removed, switched: mode === 'plan' ? target?.action === 'delete' && inMain() : switched },
			defaultBranch,
			clean: buildReport(mode, analysis, remote, others, worktreesPruned, cleanRecorder.recorded),
			nextCwd: removed && leaving() ? continueIn : null,
			restore: restoreCommand([...targetRecorder.recorded, ...cleanRecorder.recorded]),
		};
		return { report, outcome: outcome ?? runOutcome(report) };
	};
	const checkedOutAt = () => (target?.action === 'delete' && inMain() ? mainCheckout : undefined);

	if (!apply) {
		return finish(undefined, await updateDefaultBranch(context, git, into, upstreamRef, { apply, checkedOutAt: checkedOutAt(), remoteAhead }));
	}

	const deleting = others.filter((branch) => branch.action === 'delete').length;
	const finishing = target?.action === 'delete' || (target?.reason === 'needs-force' && remoteAhead);
	if (options.canPrompt && !options.yes && options.confirm && (finishing || deleting > 0)) {
		const undo = canRecordDeletions(context.deletionLog) ? 'You can restore them later.' : 'This cannot be undone.';
		if (!(await ui.confirm(confirmMessage(finishing ? target : null, deleting, undo), 'Finish'))) {
			return finish('cancelled', await updateDefaultBranch(context, git, into, upstreamRef, { apply: false, checkedOutAt: checkedOutAt() }));
		}
	}

	// Approved: fetch, analyse again. The merged branch is decided on what the
	// fetch shows, since the merge is often what was not fetched yet; the
	// other branches are held to the plan, as with gsp clean.
	const refreshed = await refreshBranches(context, read, plan, named);
	({ analysis, remote, worktreesPruned } = refreshed);
	const fetchedIgnored = new Map(refreshed.ignored);
	analysed = await analyseTarget(refreshed.planned, fetchedIgnored, remote.source === 'fetch');
	// The worktrees as the plan showed them, to check them against before removing one. The merged
	// branch is decided again after the fetch: its worktree is checked against the ignored files only.
	const shown = { branches: others, ignored: [plannedIgnored, fetchedIgnored] };
	others = holdToPlan(others, decideOthers(refreshed.planned), remote, !options.yes);
	const review = postPrCommand(scope, targetName ?? noLocal, '--dry-run');
	const fresh = await decide(analysed, false);
	// Asked in a terminal, it is deleted only when the question named it: one the fetch alone proves is planned again.
	const approved = target && finishing ? [{ ...target, action: 'delete' as const }] : [];
	target = fresh && holdToPlan(approved, [fresh], remote, !options.yes)[0];
	if (target?.reason === 'plan-changed') {
		target = { ...target, hint: review };
	}
	// Every proof compares with the default branch: when the fetch changed it, nothing is deleted.
	const held = holdToBase([...(target ? [target] : []), ...others], base, analysis.checks.base, review);
	[target, others] = target ? [held.branches[0], held.branches.slice(1)] : [null, held.branches];
	if (held.message) {
		output.appendLine(held.message);
	}
	const gitAfter = leaving() ? context.gitAt(mainCheckout) : git;
	if (leaving() && (await gitAfter(['rev-parse', '--is-bare-repository'])).stdout.trim() === 'true') {
		continueIn =
			worktrees.find((other) => other.state !== 'main' && other.state !== 'prunable' && canonical(other.path) !== canonical(context.root))?.path ?? null;
	}

	const worktree = targetWorktree();
	if (target?.action === 'delete' && worktree?.isMain) {
		// The branch may have moved since the analysis: switching the checkout away from it must not be for nothing.
		const tip = (await readTips(git, [`refs/heads/${target.name}`])).get(`refs/heads/${target.name}`);
		if (tip !== target.tip) {
			target = { ...target, action: 'skip', reason: 'plan-changed', hint: review };
		}
	}
	if (target?.action === 'delete' && worktree?.isMain) {
		try {
			await ui.withProgress({ title: `Switching ${worktree.path} to ${into}` }, () => switchMainCheckout(context.gitAt(worktree.path), into, worktrees));
			switched = true;
		} catch (error) {
			target = { ...target, result: 'failed', error: `could not switch ${worktree.path} to ${into}: ${firstLine(toErrorMessage(error))}` };
		}
	}
	if (target?.action === 'delete' && target.result === undefined) {
		const deleting = target;
		[target] = await ui.withProgress({ title: `Deleting ${deleting.name}` }, () => applyDeletions(gitAfter, [deleting], shown, targetRecorder));
	}
	const defaultBranch = await updateDefaultBranch(context, gitAfter, into, upstreamRef, { apply });
	others = await applyDeletions(gitAfter, others, shown, cleanRecorder);
	return finish(undefined, defaultBranch);
}

/** How a run ended, from its report. */
function runOutcome(report: PostPrReport): CleanOutcome {
	const failed =
		(report.branch !== null && !hasNoLocalBranch(report.branch) && (report.branch.result === 'failed' || report.branch.result === 'worktree-removed')) ||
		report.defaultBranch.reason === 'failed' ||
		appliedOutcome(report.clean.branches) === 'failed';
	if (failed) {
		return 'failed';
	}
	if (report.mode === 'plan') {
		return hasPendingChanges(report) ? 'not-applied' : 'done';
	}
	const targetKept = report.branch !== null && !hasNoLocalBranch(report.branch) && report.branch.result !== 'deleted';
	return targetKept || hasPendingDeletions(report.clean.branches) ? 'not-applied' : 'done';
}
