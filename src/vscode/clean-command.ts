import { EXIT } from '../cli/args';
import type { CleanDocument } from '../core/clean-plan';
import { cleanedRemote, cleanProblems, confirmLocal, confirmRemote, deletedNames, describeCleanResult, type CleanEntry } from './clean-model';
import { reportRunError, SHOW_OUTPUT, UNDO, type CommandDeps, type NoticeKind } from './command-ui';
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

/**
 * Sweep Stale Branches: plans with `gsp clean --json` (read-only), lets the
 * user pick, confirms, then applies exactly the picked branches with `--yes`.
 * Remote branches go in a second run, with `--remote` and their qualified
 * names only, so a local pick never deletes a remote branch of the same name.
 */
export async function runCleanCommand({ client, ui }: CommandDeps, options: CleanCommandOptions): Promise<void> {
	const planRun = client.json<CleanDocument>(options.root, ['clean', ...(options.remote ? ['--remote'] : [])]);
	const pick = await ui.pickCleanup({
		title: options.readOnly ? 'Preview stale branches' : 'Sweep stale branches',
		readOnly: options.readOnly,
		force: options.force,
		plan: planRun.then((run) => (run.kind === 'document' ? run.document : undefined)),
	});
	const plan = await planRun;
	if (plan.kind === 'error') {
		await reportRunError(ui, plan);
		return;
	}
	if (pick.kind === 'empty') {
		await ui.notify('info', 'Nothing to clean.');
		return;
	}
	if (pick.kind === 'closed') {
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

	const runs: JsonRun<CleanDocument>[] = [];
	if (local.length > 0) {
		const force = local.some((entry) => entry.forced) ? ['--force'] : [];
		runs.push(await ui.withProgress('Deleting branches', () => client.json<CleanDocument>(options.root, ['clean', '--yes', ...force, ...local.map((entry) => entry.arg)])));
	}
	if (remote.length > 0 && remoteName !== undefined) {
		runs.push(
			await ui.withProgress(`Deleting branches on ${remoteName}`, () =>
				client.json<CleanDocument>(options.root, ['clean', '--yes', `--remote=${remoteName}`, ...remote.map((entry) => entry.arg)])
			)
		);
	}
	await reportCleanResult({ client, ui }, options.root, runs, [...local, ...remote]);
}

/** One notification for every run: what was deleted, what was not and why, with Undo. */
async function reportCleanResult({ client, ui }: Pick<CommandDeps, 'client' | 'ui'>, root: string, runs: readonly JsonRun<CleanDocument>[], picked: readonly CleanEntry[]): Promise<void> {
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
		await client.run(root, ['restore', ...deleted]);
	} else if (choice === SHOW_OUTPUT) {
		ui.showOutput();
	}
}
