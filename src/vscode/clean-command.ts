import { EXIT } from '../cli/args';
import type { CleanDocument } from '../core/clean-plan';
import { cleanedRemote, cleanProblems, confirmLocal, confirmRemote, deletedNames, describeCleanResult, expectArgs, type CleanEntry } from './clean-model';
import { reportRunError, SHOW_OUTPUT, UNDO, undoDeletions, type CommandDeps, type NoticeKind } from './command-ui';
import type { JsonRun } from './gsp-client';

export type CleanCommandOptions = {
	readonly root: string;
	/** Preview only: show the plan, delete nothing. */
	readonly readOnly: boolean;
	/** Start with the branches only a forced delete removes on offer. */
	readonly force: boolean;
	/** Also plan the branches on the remote (`--remote`). */
	readonly remote: boolean;
	/** Confirm before deleting proven local branches; forced and remote deletions are always confirmed. */
	readonly confirm: boolean;
};

/** The note shown in the picker when `--remote` could not pick a remote, or undefined. */
export const NO_ORIGIN_NOTE = "Remote branches aren't shown: no remote is named origin.";

/**
 * Sweep Stale Branches: plans with `gsp clean --json` (read-only), lets the
 * user pick, confirms, then applies exactly the picked branches with `--yes`,
 * each held with `--expect` to the tip the picker showed. Forced picks go in
 * their own `--force` run, so proven picks never get `--force`. Remote
 * branches go last, with `--remote` and their qualified names only, so a
 * local pick never deletes a remote branch of the same name.
 */
export async function runCleanCommand(deps: CommandDeps, options: CleanCommandOptions): Promise<void> {
	const { client, ui } = deps;
	// Closing the picker before the plan is read stops it: it writes nothing.
	const abort = new AbortController();
	const planRun = readPlan(client, options, abort.signal);
	const pick = await ui.pickCleanup({
		title: options.readOnly ? 'Preview stale branches' : 'Sweep stale branches',
		readOnly: options.readOnly,
		force: options.force,
		confirm: options.confirm,
		plan: planRun.then(({ run }) => (run.kind === 'document' ? run.document : undefined)),
		note: planRun.then(({ note }) => note),
	});
	if (pick.kind === 'closed') {
		// The plan is read already when it failed, which closed the picker: say why. Otherwise, drop it.
		const settled = await Promise.race([planRun, Promise.resolve(undefined)]);
		if (settled?.run.kind === 'error') {
			await reportRunError(ui, settled.run);
		}
		abort.abort();
		return;
	}
	const { run: plan } = await planRun;
	if (plan.kind === 'error') {
		await reportRunError(ui, plan);
		return;
	}
	if (pick.kind === 'empty') {
		await ui.notify('info', 'Nothing to clean.');
		return;
	}

	const local = pick.entries.filter((entry) => entry.scope === 'local');
	let remote = pick.entries.filter((entry) => entry.scope === 'remote');
	const remoteName = cleanedRemote(plan.document);
	if (local.length + remote.length === 0) {
		await ui.notify('info', 'No branch selected. Nothing was deleted.');
		return;
	}
	// Cancelling the first confirmation cancels the run: it must not lead on to deleting on the remote.
	if (local.length > 0 && (options.confirm || local.some((entry) => entry.forced)) && !(await ui.confirm(confirmLocal(local)))) {
		return;
	}
	if (remote.length > 0 && (remoteName === undefined || !(await ui.confirm(confirmRemote(remote, remoteName))))) {
		remote = [];
	}
	if (local.length + remote.length === 0) {
		return;
	}

	const proven = local.filter((entry) => !entry.forced);
	const forced = local.filter((entry) => entry.forced);
	const runs: JsonRun<CleanDocument>[] = [];
	const clean = (title: string, flags: readonly string[], entries: readonly CleanEntry[]) =>
		ui.withProgress(title, () => client.json<CleanDocument>(options.root, ['clean', '--yes', ...flags, ...expectArgs(entries)]));
	if (proven.length > 0) {
		runs.push(await clean('Deleting branches', [], proven));
	}
	if (forced.length > 0) {
		runs.push(await clean(`Force deleting ${forced.length === 1 ? forced[0].arg : `${forced.length} branches`}`, ['--force'], forced));
	}
	if (remote.length > 0 && remoteName !== undefined) {
		runs.push(await clean(`Deleting branches on ${remoteName}`, [`--remote=${remoteName}`], remote));
	}
	await reportCleanResult(deps, options.root, runs, [...local, ...remote]);
}

/**
 * The plan, read-only. With `--remote` and no remote it can pick (no origin,
 * and not exactly one remote), the local plan, with a note saying why the
 * remote branches are missing.
 */
async function readPlan(client: CommandDeps['client'], options: CleanCommandOptions, signal: AbortSignal): Promise<{ run: JsonRun<CleanDocument>; note?: string }> {
	const run = await client.json<CleanDocument>(options.root, ['clean', ...(options.remote ? ['--remote'] : [])], { signal });
	if (options.remote && run.kind === 'error' && run.code === 'unknown-remote' && !signal.aborted) {
		return { run: await client.json<CleanDocument>(options.root, ['clean'], { signal }), note: NO_ORIGIN_NOTE };
	}
	return { run };
}

/** One notification for every run: what was deleted, what was not and why, with Undo. */
async function reportCleanResult(deps: CommandDeps, root: string, runs: readonly JsonRun<CleanDocument>[], picked: readonly CleanEntry[]): Promise<void> {
	const { ui } = deps;
	const documents = runs.flatMap((run) => (run.kind === 'document' ? [run.document] : []));
	for (const run of runs) {
		if (run.kind === 'error') {
			await reportRunError(ui, run);
		}
	}
	if (documents.length === 0) {
		return;
	}
	const pickedArgs = new Set(picked.map((entry) => entry.arg));
	const deleted = documents.flatMap(deletedNames);
	const worktrees = documents.flatMap((document) => document.branches).filter((branch) => branch.result !== undefined && branch.result !== 'failed' && branch.worktree && !branch.worktree.isMain && !branch.worktree.prunable).length;
	const problems = documents.flatMap((document) => cleanProblems(document, pickedArgs));
	const failed = runs.some((run) => run.exitCode === EXIT.failed);
	const kind: NoticeKind = failed ? 'error' : problems.length > 0 ? 'warning' : 'info';
	const actions = [...(deleted.length > 0 ? [UNDO] : []), ...(problems.length > 0 ? [SHOW_OUTPUT] : [])];
	const remoteName = documents.map(cleanedRemote).find((name) => name !== undefined);
	const remotePrefix = `${remoteName}/`;
	const split = {
		local: documents.flatMap((document) => deletedNames({ branches: document.branches })),
		// A remote deletion reads "feature/x on origin": strip the remote from its name.
		remote: documents.flatMap((document) => deletedNames({ branches: [], remoteBranches: document.remoteBranches })).map((name) => (name.startsWith(remotePrefix) ? name.slice(remotePrefix.length) : name)),
		...(remoteName ? { remoteName } : {}),
	};
	const choice = await ui.notify(kind, describeCleanResult(split, worktrees, problems), actions);
	if (choice === UNDO) {
		await undoDeletions(deps, root, deleted);
	} else if (choice === SHOW_OUTPUT) {
		ui.showOutput();
	}
}
