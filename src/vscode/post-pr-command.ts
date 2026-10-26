import { EXIT } from '../cli/args';
import { describeVerdict, type CleanBranch } from '../core/clean-plan';
import { hasNoLocalBranch, type DefaultBranchUpdate, type PostPrDocument } from '../core/post-pull-request-plan';
import { deletedNames, describeLocalSkip, displayPath, listInline } from './clean-model';
import { COPY_COMMAND, OPEN_MAIN_CHECKOUT, reportRunError, samePath, SHOW_OUTPUT, UNDO, undoDeletions, type CommandDeps, type Confirmation } from './command-ui';

/*
 * Finish Merged Pull Request: previews `gsp post-pr` (read-only), confirms,
 * then applies it for the same branch. When the worktree this window has open
 * goes with the branch, offers to open the main checkout.
 */

const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

/** The merged branch of a report, when it has a local branch. */
const target = (document: PostPrDocument): CleanBranch | null => (document.branch && !hasNoLocalBranch(document.branch) ? document.branch : null);

/** What happens to the default branch, in a plan, or undefined when nothing does. */
function describeUpdatePlan(update: DefaultBranchUpdate): string | undefined {
	const { name, upstream } = update;
	switch (update.reason) {
		case 'not-applied':
			return `Updates ${name} to ${upstream ?? 'its remote branch'}.`;
		case 'up-to-date':
			return update.remoteAhead ? `Fetches ${upstream ?? 'the remote'} and updates ${name}.` : undefined;
		case 'dirty':
			return `Leaves ${name} as it is: ${update.where ? displayPath(update.where) : 'its checkout'} has uncommitted changes.`;
		case 'diverged':
			return `Leaves ${name} as it is: it has commits that are not on ${upstream ?? 'its remote branch'}.`;
		case 'no-remote':
			return `Leaves ${name} as it is: it has no remote branch.`;
		default:
			return undefined;
	}
}

/** The merged branch is not proven yet, but the remote's new commits may prove it: finishing fetches them first. */
const fetchMayProve = (document: PostPrDocument, branch: CleanBranch): boolean => branch.reason === 'needs-force' && document.defaultBranch.remoteAhead;

const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The preview to confirm, or undefined when applying would change nothing. */
export function postPrPreview(document: PostPrDocument, windowInWorktree: boolean): Confirmation | undefined {
	const branch = target(document);
	const deletes = branch?.action === 'delete';
	// Not proven yet: the branch goes only if the fetch proves it, and so do its worktree and this window's folder.
	const fetchFirst = branch !== null && !deletes && fetchMayProve(document, branch);
	const others = document.clean.branches.filter((other) => other.action === 'delete');
	const { defaultBranch } = document;
	const update = fetchFirst && defaultBranch.reason === 'up-to-date' ? `Updates ${defaultBranch.name} too.` : describeUpdatePlan(defaultBranch);
	// Applying fetches, then deletes every other branch proven merged by then, not only the ones listed.
	const fetches = document.clean.checks.remote.source !== 'local-refs';
	const lines: string[] = [];
	if (branch && deletes) {
		lines.push(`Deletes ${branch.name}: ${describeVerdict(branch)}.`);
	} else if (branch && fetchFirst) {
		lines.push(`${upperFirst(describeVerdict(branch))}.`);
		lines.push(`${defaultBranch.upstream ?? 'The remote'} has new commits. Finishing fetches them first, and deletes ${branch.name} only if they prove it merged.`);
	} else if (document.branch && hasNoLocalBranch(document.branch)) {
		lines.push(`${document.branch.name} has no local branch: nothing to delete there.`);
	}
	if (deletes || fetchFirst) {
		const when = fetchFirst ? 'If they do, it also ' : '';
		if (document.worktree.path && !document.worktree.switched) {
			lines.push(fetchFirst ? `${when}removes its worktree ${displayPath(document.worktree.path)}.` : `Removes its worktree ${displayPath(document.worktree.path)}.`);
		}
		if (document.worktree.switched) {
			lines.push(fetchFirst ? `${when}switches the main checkout to ${defaultBranch.name} first.` : `Switches the main checkout to ${defaultBranch.name} first.`);
		}
	}
	if (update) {
		lines.push(update);
	}
	const anyOther = fetches ? ', and any other branch proven merged after fetching' : '';
	if (others.length > 0) {
		lines.push(`Also deletes ${plural(others.length, 'other merged branch', 'other merged branches')}: ${listInline(others.map((other) => other.name))}${anyOther}.`);
	}
	if (lines.length === 0) {
		return undefined;
	}
	if (others.length === 0 && fetches) {
		lines.push('Also deletes any other branch proven merged after fetching.');
	}
	if (windowInWorktree) {
		lines.push(
			fetchFirst
				? 'This window has that worktree open. If it is removed, you can open the main checkout afterwards.'
				: 'This window has that worktree open. You can open the main checkout afterwards.'
		);
	}
	if (branch && fetchFirst) {
		return { message: `${branch.name} is not proven merged yet`, detail: lines.join('\n'), confirmLabel: 'Fetch and finish' };
	}
	return {
		message: branch && deletes ? `Finish ${branch.name}?` : `Update ${defaultBranch.name} and clean merged branches?`,
		detail: lines.join('\n'),
		confirmLabel: deletes ? 'Finish' : 'Update and clean',
	};
}

/** The notification after applying. */
export function describePostPrResult(document: PostPrDocument): string {
	const branch = target(document);
	const parts: string[] = [];
	if (branch?.result === 'deleted') {
		parts.push(`Finished ${branch.name}: deleted it${document.worktree.removed ? ' and its worktree' : ''}.`);
	} else if (branch) {
		parts.push(describeUnfinished(branch));
	}
	const update = document.defaultBranch;
	if (update.updated) {
		parts.push(`Updated ${update.name}.`);
	} else if (update.reason === 'dirty' || update.reason === 'diverged' || update.reason === 'failed') {
		parts.push(`${update.name} was not updated: ${update.reason === 'dirty' ? 'its checkout has uncommitted changes' : update.reason === 'diverged' ? `it has commits that are not on ${update.upstream ?? 'its remote branch'}` : (update.error ?? 'the fast-forward failed')}.`);
	}
	const others = document.clean.branches.filter((other) => other.result === 'deleted').length;
	if (others > 0) {
		parts.push(`Also deleted ${plural(others, 'other merged branch', 'other merged branches')}.`);
	}
	return parts.length > 0 ? parts.join(' ') : 'Nothing to finish.';
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** Why the merged branch was kept, e.g. "feature/x is not proven merged yet: 1 commit not merged into origin/main." */
function describeUnfinished(branch: CleanBranch): string {
	if (branch.result) {
		return `${branch.name} is not finished: ${lowerFirst(branch.error ?? 'Git refused to delete it')}.`;
	}
	return branch.reason === 'needs-force'
		? `${branch.name} is not proven merged yet: ${describeVerdict(branch)}.`
		: `${branch.name} is not finished: ${lowerFirst(describeLocalSkip(branch))}.`;
}

export async function runPostPrCommand(deps: CommandDeps, root: string): Promise<void> {
	const { client, ui, windowFolders } = deps;
	const plan = await ui.withProgress('Checking the merged pull request', () => client.json<PostPrDocument>(root, ['post-pr', '--dry-run']));
	if (plan.kind === 'error') {
		await reportRunError(ui, plan);
		return;
	}
	const branch = target(plan.document);
	if (branch && branch.action !== 'delete' && !fetchMayProve(plan.document, branch)) {
		const choice = await ui.notify('warning', describeUnfinished(branch), branch.hint ? [COPY_COMMAND] : []);
		if (choice === COPY_COMMAND && branch.hint) {
			await ui.copy(branch.hint);
		}
		return;
	}
	const worktree = plan.document.worktree.path;
	const windowInWorktree = worktree !== null && !plan.document.worktree.switched && windowFolders().some((folder) => samePath(folder, worktree));
	const preview = postPrPreview(plan.document, windowInWorktree);
	if (!preview) {
		await ui.notify('info', branch ? 'Nothing to finish.' : `Nothing to finish: you are on ${plan.document.defaultBranch.name}, and no merged branch is left to clean.`);
		return;
	}
	if (!(await ui.confirm(preview))) {
		return;
	}

	const applied = await ui.withProgress('Finishing the merged pull request', () => client.json<PostPrDocument>(root, ['post-pr', '--yes', ...(branch ? [branch.name] : [])]));
	if (applied.kind === 'error') {
		await reportRunError(ui, applied);
		return;
	}
	const { document } = applied;
	// The worktree gsp ran in may be gone: continue from the main checkout.
	const cwd = document.nextCwd ?? root;
	const finishedBranch = target(document);
	const deleted = [...(finishedBranch?.result === 'deleted' ? [finishedBranch.name] : []), ...deletedNames(document.clean)];
	const openMain = document.worktree.removed && document.nextCwd !== null && windowInWorktree;
	const failed = applied.exitCode === EXIT.failed;
	const actions = [...(openMain ? [OPEN_MAIN_CHECKOUT] : []), ...(deleted.length > 0 ? [UNDO] : []), ...(failed ? [SHOW_OUTPUT] : [])];
	// Exit code 5 also covers other branches left for a forced delete: only the merged branch decides the tone.
	const finished = finishedBranch === null || finishedBranch.result === 'deleted';
	const kind = failed ? 'error' : finished ? 'info' : 'warning';
	const choice = await ui.notify(kind, describePostPrResult(document), actions);
	if (choice === OPEN_MAIN_CHECKOUT && document.nextCwd) {
		await ui.openFolder(document.nextCwd, false);
	} else if (choice === UNDO) {
		await undoDeletions(deps, cwd, deleted);
	} else if (choice === SHOW_OUTPUT) {
		ui.showOutput();
	}
}
