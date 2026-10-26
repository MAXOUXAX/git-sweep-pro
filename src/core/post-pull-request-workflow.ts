import { analyzeBranches, type BranchAnalysis } from './branch-analysis';
import { CLEAN_SCHEMA, decideActions, hasPendingDeletions, restoreCommand, type CleanBranch } from './clean-plan';
import { appliedOutcome, applyDeletions, buildReport, inspectBranches, type CleanContext, type CleanOptions, type CleanOutcome } from './clean-workflow';
import { canRecordDeletions, createDeletionRecorder } from './deletion-log';
import { toErrorMessage } from './errors';
import { quoteShellArg, type RunGit } from './git-command';
import { decideTarget, hasPendingChanges, type DefaultBranchUpdate, type PostPrReport } from './post-pull-request-plan';
import { canonical, listWorktrees, type Worktree } from './worktrees';

export type PostPrOptions = Pick<CleanOptions, 'dryRun' | 'yes' | 'force' | 'fetch' | 'github' | 'protectedPatterns' | 'canPrompt' | 'confirm'> & {
	/** The merged branch; the branch checked out where gsp runs when undefined. */
	readonly branch: string | undefined;
	/** The branch it was merged into; the default branch when undefined. */
	readonly into: string | undefined;
};

export type PostPrContext = CleanContext & {
	/** Runs git in another worktree of the repository: once the one gsp runs in is removed, git cannot start there. */
	readonly gitAt: (dir: string) => RunGit;
};

export type PostPrRun = { readonly report: PostPrReport; readonly outcome: CleanOutcome };

/** Arguments that name no branch: the CLI reports them as a usage error. */
export class PostPrUsageError extends Error {}

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
		throw new PostPrUsageError(`No branch named "${into}" to merge into.`);
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
		return { ...update, reason: 'dirty', hint: ['git', ...(merge ?? [])].map(quoteShellArg).join(' ') };
	}
	if (!options.apply) {
		return { ...update, reason: 'not-applied' };
	}
	try {
		// The old value makes the ref update atomic: it fails if the branch moved meanwhile.
		await context.ui.withProgress({ title: `Updating ${name}` }, () => git(merge ?? ['update-ref', local, to, from]));
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
	if (target?.action === 'delete') {
		const worktree = target.worktree && !target.worktree.prunable ? ` and its worktree ${target.worktree.path}` : '';
		actions.push(`delete ${target.name}${worktree}${target.needsForce ? ' (its work is found nowhere else)' : ''}`);
	}
	if (others > 0) {
		actions.push(`delete ${others} other merged branch(es)`);
	}
	const sentence = actions.join(', then ');
	return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}? ${undo}`;
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
	const mainCheckout = worktrees.find((worktree) => worktree.state === 'main')?.path ?? context.root;
	if (options.branch !== undefined && options.branch !== options.into && !localBranches.includes(options.branch)) {
		// The old form named the default branch: it may exist only on the remote.
		const remoteHead = (await git(['for-each-ref', '--format=%(symref:lstrip=3)', 'refs/remotes/*/HEAD'])).stdout.split('\n');
		if (!remoteHead.includes(options.branch)) {
			throw new PostPrUsageError(
				`No local branch named "${options.branch}": it may already be deleted. Run "gsp post-pr" on the default branch to update it and clean.`
			);
		}
	}

	const apply = !options.dryRun && (options.yes || options.canPrompt);
	const { mode, remote, worktreesPruned, analysis } = await inspectBranches(context, { ...options, patterns: [], apply });
	const base = analysis.checks.base;
	const into = options.into ?? base?.name;
	if (!into) {
		throw new PostPrUsageError('No default branch found: name the branch the pull request was merged into with --into <branch>.');
	}
	const intoRef = into === base?.name ? base.ref : await resolveInto(git, into, base?.remote ?? 'origin');
	const intoRemote = /^refs\/remotes\/([^/]+)\//.exec(intoRef)?.[1];
	const upstreamRef = intoRemote ? intoRef : null;
	const remoteAhead =
		!apply && remote.source === 'ls-remote' && intoRemote !== undefined
			? await isRemoteAhead(git, intoRef, intoRemote, (await readTips(git, [intoRef])).get(intoRef) ?? '')
			: false;

	let requested = options.branch;
	if (requested === into) {
		output.appendLine(
			`note: "gsp post-pr ${into}" is deprecated: run "gsp post-pr" from the merged branch, or "gsp post-pr <branch>". Finishing the current branch.`
		);
		requested = undefined;
	}
	const targetName = requested ?? (current !== 'HEAD' && current !== into ? current : undefined);

	let analysed: BranchAnalysis | undefined;
	if (targetName && into === base?.name) {
		analysed = analysis.branches.find((branch) => branch.name === targetName);
	} else if (targetName) {
		// Compared with --into; the detected default branch stays protected.
		const result = await analyzeBranches(
			{ git, ...(context.gh ? { gh: context.gh } : {}) },
			{
				branches: [targetName],
				base: intoRef,
				protectedPatterns: [...options.protectedPatterns, ...(base ? [base.name] : [])],
				github: options.github,
				fetched: analysis.checks.fetched,
			}
		);
		analysed = result.branches.find((branch) => branch.name === targetName);
	}

	const targetWorktree = analysed?.worktree && !analysed.worktree.prunable ? analysed.worktree : null;
	const inMain = targetWorktree?.isMain === true;
	let target = analysed
		? decideTarget(analysed, {
				force: options.force,
				into,
				mainCheckoutDirty: inMain && targetWorktree ? await hasTrackedChanges(git, targetWorktree.path) : false,
				remoteAhead,
			})
		: null;
	const leaving = targetWorktree !== null && !inMain && canonical(targetWorktree.path) === canonical(context.root);
	// Once the worktree gsp runs in is gone, git can only start from the main checkout.
	const gitAfter = leaving ? context.gitAt(mainCheckout) : git;

	// The clean step: the other branches, with the rules of `gsp clean --yes`.
	const excluded = new Set([targetName, ...(into === base?.name ? [] : [into])]);
	let others = decideActions(
		analysis.branches.filter((branch) => !excluded.has(branch.name)),
		{ force: false, named: new Set(), defaultBranch: base?.name }
	);
	const targetRecorder = createDeletionRecorder(context.deletionLog, 'post-pr', output.appendLine);
	const cleanRecorder = createDeletionRecorder(context.deletionLog, 'sweep', output.appendLine);
	const switching = target?.action === 'delete' && inMain;
	let switched = false;

	const finish = (outcome: CleanOutcome | undefined, defaultBranch: DefaultBranchUpdate): PostPrRun => {
		const removed = !inMain && targetWorktree !== null && (target?.result === 'deleted' || target?.result === 'worktree-removed');
		const report: PostPrReport = {
			schema: CLEAN_SCHEMA,
			command: 'post-pr',
			mode,
			branch: target,
			worktree: { path: targetWorktree?.path ?? null, removed, switched: mode === 'plan' ? switching : switched },
			defaultBranch,
			clean: buildReport(mode, analysis, remote, others, worktreesPruned, cleanRecorder.recorded),
			nextCwd: removed && leaving ? mainCheckout : null,
			restore: restoreCommand([...targetRecorder.recorded, ...cleanRecorder.recorded]),
		};
		return { report, outcome: outcome ?? runOutcome(report) };
	};
	const checkedOutAt = switching ? mainCheckout : undefined;

	if (!apply) {
		return finish(undefined, await updateDefaultBranch(context, git, into, upstreamRef, { apply, checkedOutAt, remoteAhead }));
	}

	const deleting = others.filter((branch) => branch.action === 'delete').length;
	if (options.canPrompt && !options.yes && options.confirm && (target?.action === 'delete' || deleting > 0)) {
		const undo = canRecordDeletions(context.deletionLog) ? 'You can restore them later.' : 'This cannot be undone.';
		if (!(await ui.confirm(confirmMessage(target, deleting, undo), 'Finish'))) {
			return finish(
				'cancelled',
				await updateDefaultBranch(context, git, into, upstreamRef, { apply: false, checkedOutAt })
			);
		}
	}

	if (target && switching && targetWorktree) {
		try {
			await ui.withProgress({ title: `Switching ${targetWorktree.path} to ${into}` }, () =>
				switchMainCheckout(context.gitAt(targetWorktree.path), into, worktrees)
			);
			switched = true;
		} catch (error) {
			target = { ...target, result: 'failed', error: `could not switch ${targetWorktree.path} to ${into}: ${firstLine(toErrorMessage(error))}` };
		}
	}
	if (target?.action === 'delete' && target.result === undefined) {
		const name = target.name;
		[target] = await ui.withProgress({ title: `Deleting ${name}` }, () => applyDeletions(gitAfter, [target as CleanBranch], targetRecorder));
	}
	const defaultBranch = await updateDefaultBranch(context, gitAfter, into, upstreamRef, { apply });
	others = await applyDeletions(gitAfter, others, cleanRecorder);
	return finish(undefined, defaultBranch);
}

/** How a run ended, from its report. */
function runOutcome(report: PostPrReport): CleanOutcome {
	const failed =
		(report.branch !== null && (report.branch.result === 'failed' || report.branch.result === 'worktree-removed')) ||
		report.defaultBranch.reason === 'failed' ||
		appliedOutcome(report.clean.branches) === 'failed';
	if (failed) {
		return 'failed';
	}
	if (report.mode === 'plan') {
		return hasPendingChanges(report) ? 'not-applied' : 'done';
	}
	const targetKept = report.branch !== null && report.branch.result !== 'deleted';
	return targetKept || hasPendingDeletions(report.clean.branches) ? 'not-applied' : 'done';
}
