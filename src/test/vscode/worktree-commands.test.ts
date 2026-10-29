import * as assert from 'assert';
import type { WorktreeEntry, WorktreeListDocument } from '../../core/worktree-list';
import type { WorktreeRemoveDocument } from '../../core/worktrees';
import { COPY_COMMAND, OPEN_MAIN_CHECKOUT, SHOW_OUTPUT, type PickOption } from '../../vscode/command-ui';
import { describeWorktreeState, removalBlockers, runPruneWorktreesCommand, runRemoveWorktreeCommand, runWorktreeListCommand } from '../../vscode/worktree-commands';
import { createFakeClient, createFakeUi, deps, ok, worktreeEntry } from './fakes';

const main = worktreeEntry({ path: '/repo', branch: 'main', isMain: true, ignoredFiles: null, action: 'keep', reason: 'default-branch', verdict: 'alive', verdictReason: 'default-branch' });
const clean = worktreeEntry({ path: '/work/wt-a', branch: 'feature/a', action: 'delete', reason: 'squash-merged', verdict: 'dead', verdictReason: 'squash-merged' });
const ignored = worktreeEntry({ path: '/work/wt-b', branch: 'feature/b', ignoredFiles: { count: 2, sample: ['.env', 'secrets.json'] } });
const locked = worktreeEntry({ path: '/work/wt-c', branch: 'feature/c', locked: true });
const gone = worktreeEntry({ path: '/work/wt-gone', branch: 'feature/gone', prunable: true, ignoredFiles: null });

const list = (...worktrees: WorktreeEntry[]): WorktreeListDocument => ({ schema: 2, command: 'worktree list', worktrees });
const removal = (worktree: WorktreeEntry, overrides: Partial<WorktreeRemoveDocument> = {}): WorktreeRemoveDocument => ({
	schema: 2,
	command: 'worktree remove',
	worktree: { path: worktree.path, branch: worktree.branch },
	removed: true,
	reason: null,
	ignoredFiles: null,
	changedFiles: null,
	hint: null,
	next: null,
	nextCwd: null,
	...overrides,
});
const byLabel = (label: string) => (items: readonly PickOption<unknown>[]) => items.find((item) => item.label.includes(label))?.value;

suite('worktree commands', () => {
	test('Show Worktrees lists each state, then opens the one picked in a new window', async () => {
		const { client, calls } = createFakeClient([ok(list(main, clean, ignored, gone))]);
		let step = 0;
		const fake = createFakeUi({ pickOne: (items) => (step++ === 0 ? byLabel('feature/a')(items) : byLabel('new window')(items)) });

		await runWorktreeListCommand(deps(client, fake.ui, ['/repo']), '/repo');

		assert.deepStrictEqual(calls.map((call) => call.args), [['worktree', 'list']]);
		assert.deepStrictEqual(fake.picks[0].items.map((item) => [item.label, item.description, item.detail]), [
			['$(home) main', '/repo (this window)', 'Main checkout. Clean'],
			['$(git-branch) feature/a', '/work/wt-a', 'Clean. Sweep Stale Branches would delete its branch and remove it'],
			['$(git-branch) feature/b', '/work/wt-b', '2 ignored files'],
			['$(warning) feature/gone', '/work/wt-gone', 'Its folder is gone: prune it'],
		]);
		assert.deepStrictEqual(fake.picks[1].items.map((item) => item.label), ['$(window) Open in this window', '$(empty-window) Open in a new window', '$(trash) Remove worktree', '$(copy) Copy path']);
		assert.deepStrictEqual(fake.opened, [{ path: '/work/wt-a', newWindow: true }]);
	});

	test('Show Worktrees: the current one offers no open, a prunable one offers prune, copy path copies', async () => {
		const prune = createFakeClient([ok(list(main, gone))]);
		let step = 0;
		const pruneUi = createFakeUi({ pickOne: (items) => (step++ === 0 ? byLabel('feature/gone')(items) : items[0].value) });
		await runWorktreeListCommand(deps(prune.client, pruneUi.ui), '/repo');
		assert.deepStrictEqual(prune.calls.map((call) => call.args), [['worktree', 'list'], ['worktree', 'prune']]);
		assert.deepStrictEqual(pruneUi.notices.map((n) => n.message), ['Pruned 1 worktree whose folder was gone: /work/wt-gone.']);

		const current = createFakeClient([ok(list(main, clean))]);
		let currentStep = 0;
		const currentUi = createFakeUi({ pickOne: (items) => (currentStep++ === 0 ? byLabel('feature/a')(items) : byLabel('Copy path')(items)) });
		await runWorktreeListCommand(deps(current.client, currentUi.ui, ['/work/wt-a']), '/repo');
		assert.deepStrictEqual(currentUi.picks[1].items.map((item) => item.label), ['$(trash) Remove worktree', '$(copy) Copy path']);
		assert.deepStrictEqual(currentUi.copied, ['/work/wt-a']);
	});

	test('Remove Worktree: a clean one after one confirmation, from the main checkout; this window can open the main checkout', async () => {
		const { client, calls } = createFakeClient([ok(list(main, clean)), ok(removal(clean))]);
		const fake = createFakeUi({ pickOne: (items) => items[0].value, notify: () => OPEN_MAIN_CHECKOUT });

		await runRemoveWorktreeCommand(deps(client, fake.ui, ['/work/wt-a']), '/work/wt-a');

		assert.deepStrictEqual(fake.confirms, [{ message: 'Remove the worktree /work/wt-a?', detail: 'The branch feature/a stays. To delete it as well, use Sweep Stale Branches.', confirmLabel: 'Remove worktree' }]);
		assert.deepStrictEqual(calls[1], { cwd: '/repo', args: ['worktree', 'remove', '/work/wt-a'], json: true });
		assert.deepStrictEqual(fake.notices, [{ kind: 'info', message: 'Removed the worktree /work/wt-a.', actions: [OPEN_MAIN_CHECKOUT] }]);
		assert.deepStrictEqual(fake.opened, [{ path: '/repo', newWindow: false }]);
	});

	test('Remove Worktree: ignored files block it; --discard-changes only after a second, explicit confirmation', async () => {
		const forced = createFakeClient([ok(list(main, ignored)), ok(removal(ignored))]);
		const forcedUi = createFakeUi({ pickOne: (items) => items[0].value });
		await runRemoveWorktreeCommand(deps(forced.client, forcedUi.ui), '/repo');
		assert.deepStrictEqual(forcedUi.confirms.map((c) => c.confirmLabel), ['Remove anyway…', 'Delete for good']);
		assert.ok(forcedUi.confirms[0].detail.includes('It holds 2 ignored files a build does not recreate: .env, secrets.json.'), forcedUi.confirms[0].detail);
		assert.deepStrictEqual(forced.calls[1].args, ['worktree', 'remove', '--discard-changes', '/work/wt-b']);

		for (const answers of [[false], [true, false]]) {
			const declined = createFakeClient([ok(list(main, ignored))]);
			const queue = [...answers];
			await runRemoveWorktreeCommand(deps(declined.client, createFakeUi({ pickOne: (items) => items[0].value, confirm: () => queue.shift() ?? false }).ui), '/repo');
			assert.strictEqual(declined.calls.length, 1, `nothing removed after ${JSON.stringify(answers)}`);
		}
	});

	test('Remove Worktree: a locked one is never forced; no linked worktree; a failure shows the output', async () => {
		const lockedRun = createFakeClient([ok(list(main, locked))]);
		const lockedUi = createFakeUi({ pickOne: (items) => items[0].value });
		await runRemoveWorktreeCommand(deps(lockedRun.client, lockedUi.ui), '/repo');
		assert.deepStrictEqual(lockedUi.confirms, []);
		assert.deepStrictEqual(lockedUi.notices, [{ kind: 'warning', message: "/work/wt-c can't be removed. It is locked. Unlock it first: git worktree unlock /work/wt-c", actions: [] }]);

		const none = createFakeClient([ok(list(main, gone))]);
		const noneUi = createFakeUi();
		await runRemoveWorktreeCommand(deps(none.client, noneUi.ui), '/repo');
		assert.deepStrictEqual(noneUi.notices.map((n) => n.message), ['There is no linked worktree to remove.']);

		const failing = createFakeClient([ok(list(main, clean)), { kind: 'error', exitCode: 1, message: 'fatal: could not remove it', code: 'failed', shown: false }]);
		const failingUi = createFakeUi({ pickOne: (items) => items[0].value, notify: () => SHOW_OUTPUT });
		await runRemoveWorktreeCommand(deps(failing.client, failingUi.ui), '/repo');
		assert.deepStrictEqual(failingUi.notices, [{ kind: 'error', message: 'fatal: could not remove it', actions: [SHOW_OUTPUT] }]);
		assert.strictEqual(failingUi.outputShown(), 1);
	});

	test('Remove Worktree: a worktree that changed since the list says why gsp kept it, and offers the command', async () => {
		const next = 'git -C /work/wt-a stash --include-untracked && gsp worktree remove /work/wt-a';
		const kept = removal(clean, { removed: false, reason: 'dirty-worktree', changedFiles: { count: 1, sample: ['wip.txt'] }, hint: `${next}, or …`, next });
		const { client } = createFakeClient([ok(list(main, clean)), ok(kept, 5)]);
		const fake = createFakeUi({ pickOne: (items) => items[0].value, notify: () => COPY_COMMAND });
		await runRemoveWorktreeCommand(deps(client, fake.ui), '/repo');
		assert.deepStrictEqual(fake.notices, [{ kind: 'warning', message: '/work/wt-a was kept: it has uncommitted changes to 1 file: wip.txt.', actions: [COPY_COMMAND] }]);
		assert.deepStrictEqual(fake.copied, [next]);
	});

	test('Remove Worktree: a worktree kept for its submodules also names the ignored files it holds', async () => {
		const kept = removal(clean, { removed: false, reason: 'submodules', ignoredFiles: { count: 1, sample: ['notes.local'] }, hint: 'check the submodules…', next: null });
		const { client } = createFakeClient([ok(list(main, clean)), ok(kept, 5)]);
		const fake = createFakeUi({ pickOne: (items) => items[0].value });
		await runRemoveWorktreeCommand(deps(client, fake.ui), '/repo');
		assert.deepStrictEqual(fake.notices, [
			{ kind: 'warning', message: '/work/wt-a was kept: it holds submodules, and 1 ignored file a build does not recreate: notes.local.', actions: [] },
		]);
	});

	test('Prune Worktrees: nothing to prune, or prunes; a list error is shown', async () => {
		const nothing = createFakeClient([ok(list(main, clean))]);
		const nothingUi = createFakeUi();
		await runPruneWorktreesCommand(deps(nothing.client, nothingUi.ui), '/repo');
		assert.deepStrictEqual(nothingUi.notices.map((n) => n.message), ['Nothing to prune: every worktree folder still exists.']);
		assert.strictEqual(nothing.calls.length, 1);

		const broken = createFakeClient([{ kind: 'error', exitCode: 1, message: 'not a git repository', code: 'not-a-repository', shown: false }]);
		const brokenUi = createFakeUi();
		await runPruneWorktreesCommand(deps(broken.client, brokenUi.ui), '/repo');
		assert.deepStrictEqual(brokenUi.notices.map((n) => n.message), ['not a git repository']);
	});

	test('states and blockers in words', () => {
		assert.deepStrictEqual(describeWorktreeState(worktreeEntry({ path: '/x', dirty: true, inProgress: 'rebase', action: 'skip', reason: 'needs-force' })), [
			'Rebase in progress',
			'Uncommitted changes',
			'Only a forced delete would remove it',
		]);
		assert.deepStrictEqual(removalBlockers(worktreeEntry({ path: '/x', dirty: true })), { blockers: ['It has uncommitted changes. Removing it anyway deletes them.'], canForce: true });
		assert.strictEqual(removalBlockers(worktreeEntry({ path: '/x', inProgress: 'bisect' })).canForce, false);
		assert.deepStrictEqual(removalBlockers(worktreeEntry({ path: '/x', submodules: true })), {
			blockers: ['It holds submodules. Removing it anyway deletes what they hold, including their uncommitted changes.'],
			canForce: true,
		});
		assert.deepStrictEqual(describeWorktreeState(worktreeEntry({ path: '/x', submodules: true })), ['Submodules']);
		assert.deepStrictEqual(describeWorktreeState(worktreeEntry({ path: '/x', action: 'skip', reason: 'never-committed' })), [
			'Clean',
			'No commits yet: Sweep Stale Branches keeps it',
		]);
		assert.deepStrictEqual(describeWorktreeState(worktreeEntry({ path: '/x', action: 'skip', reason: 'worktree-in-use' })), ['Clean', 'In use: Sweep Stale Branches keeps it']);
	});
});
