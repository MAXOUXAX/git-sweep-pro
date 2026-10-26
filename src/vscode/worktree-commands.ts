import { EXIT } from '../cli/args';
import type { WorktreeEntry, WorktreeListDocument } from '../core/worktree-list';
import { describeIgnoredFiles, displayPath } from './clean-model';
import { OPEN_MAIN_CHECKOUT, reportRunError, samePath, SHOW_OUTPUT, type CommandDeps, type Confirmation, type PickOption } from './command-ui';

/*
 * The worktree commands: list (with what Sweep Stale Branches would do with
 * each branch), prune and remove, all from `gsp worktree list --json`.
 */

const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

/** What `gsp clean` would do with a worktree's branch, in words, or undefined when there is nothing to say. */
function describeCleanAction(worktree: WorktreeEntry): string | undefined {
	switch (worktree.action) {
		case 'delete':
			return 'Sweep Stale Branches would delete its branch and remove it';
		case 'skip':
			return worktree.reason === 'needs-force' || worktree.reason === 'ignored-files' ? 'Only a forced delete would remove it' : undefined;
		default:
			return undefined;
	}
}

/** The state of a worktree, in a few words each. */
export function describeWorktreeState(worktree: WorktreeEntry): string[] {
	const states: string[] = [];
	if (worktree.isMain) {
		states.push('Main checkout');
	}
	if (worktree.prunable) {
		states.push('Its folder is gone: prune it');
	}
	if (worktree.locked) {
		states.push('Locked');
	}
	if (worktree.inProgress) {
		states.push(`${worktree.inProgress === 'rebase' ? 'Rebase' : 'Bisect'} in progress`);
	}
	if (worktree.dirty) {
		states.push('Uncommitted changes');
	}
	if (worktree.ignoredFiles?.count) {
		states.push(plural(worktree.ignoredFiles.count, 'ignored file'));
	}
	if (states.length === 0 || (states.length === 1 && worktree.isMain)) {
		states.push('Clean');
	}
	// A worktree whose folder is gone only needs pruning.
	const action = worktree.prunable ? undefined : describeCleanAction(worktree);
	return action ? [...states, action] : states;
}

const branchLabel = (worktree: WorktreeEntry) => worktree.branch ?? `detached at ${worktree.head?.slice(0, 7) ?? 'an unknown commit'}`;

export function worktreeItem(worktree: WorktreeEntry, current: boolean): PickOption<WorktreeEntry> {
	const icon = worktree.isMain ? 'home' : worktree.prunable ? 'warning' : worktree.branch ? 'git-branch' : 'git-commit';
	return {
		label: `$(${icon}) ${branchLabel(worktree)}`,
		description: `${displayPath(worktree.path)}${current ? ' (this window)' : ''}`,
		detail: describeWorktreeState(worktree).join('. '),
		value: worktree,
	};
}

/** What blocks a plain removal of a linked worktree, in words; empty when nothing does. */
export function removalBlockers(worktree: WorktreeEntry): { readonly blockers: readonly string[]; readonly canForce: boolean } {
	const blockers: string[] = [];
	if (worktree.locked) {
		blockers.push(`It is locked. Unlock it first: git worktree unlock ${worktree.path}`);
	}
	if (worktree.inProgress) {
		blockers.push(`A ${worktree.inProgress} is in progress in it. Finish or abort it first.`);
	}
	if (worktree.dirty) {
		blockers.push('It has uncommitted changes. Removing it anyway deletes them.');
	}
	if (worktree.ignoredFiles?.count) {
		const them = worktree.ignoredFiles.count === 1 ? 'it' : 'them';
		blockers.push(`It holds ${plural(worktree.ignoredFiles.count, 'ignored file')} a build does not recreate: ${describeIgnoredFiles(worktree.ignoredFiles)}. Removing the worktree deletes ${them}, and gsp restore can't bring ${them} back.`);
	}
	// A lock and an operation in progress are never forced from here.
	return { blockers, canForce: !worktree.locked && !worktree.inProgress };
}

export function confirmRemoval(worktree: WorktreeEntry): Confirmation {
	return {
		message: `Remove the worktree ${displayPath(worktree.path)}?`,
		detail: worktree.branch ? `The branch ${worktree.branch} stays. To delete it as well, use Sweep Stale Branches.` : 'Its commit stays in the repository.',
		confirmLabel: 'Remove worktree',
	};
}

async function listWorktrees({ client, ui }: Pick<CommandDeps, 'client' | 'ui'>, root: string): Promise<WorktreeListDocument | undefined> {
	const run = await ui.withProgress('Reading worktrees', () => client.json<WorktreeListDocument>(root, ['worktree', 'list']));
	if (run.kind === 'error') {
		await reportRunError(ui, run);
		return undefined;
	}
	return run.document;
}

/** Runs a non-JSON gsp command and shows its failure, unless the CLI already did. */
async function runOrReport(deps: Pick<CommandDeps, 'client' | 'ui'>, cwd: string, args: readonly string[]): Promise<boolean> {
	const result = await deps.client.run(cwd, args);
	if (result.exitCode === EXIT.ok) {
		return true;
	}
	if (!result.errorShown && (await deps.ui.notify('error', `gsp ${args.join(' ')} failed (exit code ${result.exitCode}).`, [SHOW_OUTPUT]))) {
		deps.ui.showOutput();
	}
	return false;
}

const OPEN_HERE = 'open-here';
const OPEN_NEW = 'open-new';
const REMOVE = 'remove';
const PRUNE = 'prune';
const COPY_PATH = 'copy-path';

/** Show Worktrees: every worktree with its state; picking one offers what can be done with it. */
export async function runWorktreeListCommand(deps: CommandDeps, root: string): Promise<void> {
	const document = await listWorktrees(deps, root);
	if (!document) {
		return;
	}
	const isCurrent = (worktree: WorktreeEntry) => deps.windowFolders().some((folder) => samePath(folder, worktree.path));
	const worktree = await deps.ui.pickOne({
		title: 'Worktrees',
		placeholder: `${plural(document.worktrees.length, 'worktree')}. Pick one to open, remove or prune it.`,
		items: document.worktrees.map((entry) => worktreeItem(entry, isCurrent(entry))),
	});
	if (!worktree) {
		return;
	}
	const current = isCurrent(worktree);
	const actions: PickOption<string>[] = worktree.prunable
		? [{ label: '$(trash) Prune', description: 'Forget the worktrees whose folder is gone', value: PRUNE }]
		: [
				...(current ? [] : [{ label: '$(window) Open in this window', value: OPEN_HERE }, { label: '$(empty-window) Open in a new window', value: OPEN_NEW }]),
				...(worktree.isMain ? [] : [{ label: '$(trash) Remove worktree', value: REMOVE }]),
				{ label: '$(copy) Copy path', value: COPY_PATH },
			];
	const action = await deps.ui.pickOne({ title: `Worktree ${branchLabel(worktree)}`, placeholder: displayPath(worktree.path), items: actions });
	switch (action) {
		case OPEN_HERE:
		case OPEN_NEW:
			await deps.ui.openFolder(worktree.path, action === OPEN_NEW);
			return;
		case REMOVE:
			await removeWorktree(deps, document, worktree);
			return;
		case PRUNE:
			await pruneWorktrees(deps, root, document);
			return;
		case COPY_PATH:
			await deps.ui.copy(worktree.path);
			return;
	}
}

/** Prune Worktrees: forgets the worktrees whose folder is gone. Nothing on disk changes. */
export async function runPruneWorktreesCommand(deps: CommandDeps, root: string): Promise<void> {
	const document = await listWorktrees(deps, root);
	if (document) {
		await pruneWorktrees(deps, root, document);
	}
}

async function pruneWorktrees(deps: Pick<CommandDeps, 'client' | 'ui'>, root: string, document: WorktreeListDocument): Promise<void> {
	const prunable = document.worktrees.filter((worktree) => worktree.prunable);
	if (prunable.length === 0) {
		await deps.ui.notify('info', 'Nothing to prune: every worktree folder still exists.');
		return;
	}
	if (await runOrReport(deps, root, ['worktree', 'prune'])) {
		await deps.ui.notify('info', `Pruned ${plural(prunable.length, 'worktree')} whose folder was gone: ${prunable.map((worktree) => displayPath(worktree.path)).join(', ')}.`);
	}
}

/** Remove Worktree: picks a linked worktree, then removes it, forcing only after a second, explicit confirmation. */
export async function runRemoveWorktreeCommand(deps: CommandDeps, root: string): Promise<void> {
	const document = await listWorktrees(deps, root);
	if (!document) {
		return;
	}
	const removable = document.worktrees.filter((worktree) => !worktree.isMain && !worktree.prunable);
	if (removable.length === 0) {
		await deps.ui.notify('info', 'There is no linked worktree to remove.');
		return;
	}
	const isCurrent = (worktree: WorktreeEntry) => deps.windowFolders().some((folder) => samePath(folder, worktree.path));
	const worktree = await deps.ui.pickOne({
		title: 'Remove worktree',
		placeholder: 'Pick the worktree to remove. Its branch stays.',
		items: removable.map((entry) => worktreeItem(entry, isCurrent(entry))),
	});
	if (worktree) {
		await removeWorktree(deps, document, worktree);
	}
}

async function removeWorktree(deps: CommandDeps, document: WorktreeListDocument, worktree: WorktreeEntry): Promise<void> {
	const { ui } = deps;
	const { blockers, canForce } = removalBlockers(worktree);
	let force = false;
	if (blockers.length > 0 && !canForce) {
		await ui.notify('warning', `${displayPath(worktree.path)} can't be removed. ${blockers.join(' ')}`);
		return;
	}
	if (blockers.length > 0) {
		const anyway = await ui.confirm({
			message: `${displayPath(worktree.path)} can't be removed safely`,
			detail: `${blockers.join('\n\n')}\n\nMove what you need out of it first.`,
			confirmLabel: 'Remove anyway…',
		});
		if (!anyway) {
			return;
		}
		force = await ui.confirm({
			message: `Delete ${displayPath(worktree.path)} and everything in it?`,
			detail: `${worktree.branch ? `The branch ${worktree.branch} stays. ` : ''}This can't be undone.`,
			confirmLabel: 'Delete for good',
		});
		if (!force) {
			return;
		}
	} else if (!(await ui.confirm(confirmRemoval(worktree)))) {
		return;
	}
	const main = document.worktrees.find((entry) => entry.isMain)?.path;
	// Run from the main checkout: the worktree being removed may be the one this window has open.
	const current = deps.windowFolders().some((folder) => samePath(folder, worktree.path));
	if (!(await runOrReport(deps, main ?? worktree.path, ['worktree', 'remove', ...(force ? ['--force'] : []), worktree.path]))) {
		return;
	}
	const choice = await ui.notify('info', `Removed the worktree ${displayPath(worktree.path)}.`, current && main ? [OPEN_MAIN_CHECKOUT] : []);
	if (choice === OPEN_MAIN_CHECKOUT && main) {
		await ui.openFolder(main, false);
	}
}
