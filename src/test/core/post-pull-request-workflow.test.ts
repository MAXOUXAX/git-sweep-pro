import * as assert from 'assert';
import { runPostPullRequestWorkflow } from '../../core/post-pull-request-workflow';
import { syncMessages } from '../../core/sync-with-upstream-messages';
import { MEMENTO_KEY } from '../../core/sync-with-upstream-state';
import {
	baseGitForSync,
	createHarness,
	fileExistsNoRebase,
} from './sync-with-upstream.harness';

// Post Pull Request keeps the current branch and rebases it onto the selected branch
// (after pulling it), then force-pushes — it must never delete the current branch. It
// delegates to the Sync With Upstream flow, pre-selecting the default branch.

// Lets the default-branch detection resolve "main" from refs/remotes/origin/HEAD.
const defaultDetectGit = {
	'for-each-ref --format=%(refname) refs/remotes/*/HEAD': { stdout: 'refs/remotes/origin/HEAD' },
	'rev-parse --abbrev-ref refs/remotes/origin/HEAD': { stdout: 'origin/main' },
};

// Happy path: rebase the current branch (feature/my-branch) onto a local target (main).
const happyGit = {
	...baseGitForSync,
	...defaultDetectGit,
	'status --porcelain -u': { stdout: '' },
	'checkout main': { stdout: '' },
	'pull': { stdout: '' },
	'checkout feature/my-branch': { stdout: '' },
	'rebase main': { stdout: '' },
	'push --force-with-lease': { stdout: '' },
};

suite('post-pull-request workflow', () => {
	test('fails fast when no workspace is open', async () => {
		const h = createHarness();

		await runPostPullRequestWorkflow(h.deps);

		assert.deepStrictEqual(h.errorMessages, [syncMessages.noWorkspace]);
		assert.strictEqual(h.commands.length, 0);
	});

	test('rebases the current branch onto the selected one and force-pushes (no delete)', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: { label: 'main' },
			fileExists: fileExistsNoRebase,
			git: happyGit,
		});

		await runPostPullRequestWorkflow(h.deps);

		// Pull the target, then rebase the current branch onto it, then force-push.
		assert.ok(h.commands.includes('checkout main'), 'Should check out the target to update it');
		assert.ok(h.commands.includes('pull'), 'Should pull the target before rebasing');
		assert.ok(h.commands.includes('checkout feature/my-branch'), 'Should return to the current branch');
		assert.ok(h.commands.includes('rebase main'), 'Should rebase the current branch onto the target');
		assert.ok(h.commands.includes('push --force-with-lease'), 'Should force-push the current branch');

		// The current branch must never be deleted.
		assert.ok(
			!h.commands.some((c) => c.startsWith('branch -D feature/my-branch') || c.startsWith('branch -d feature/my-branch')),
			'Should not delete the current branch'
		);

		assert.deepStrictEqual(h.infoMessages, [syncMessages.syncedWith('feature/my-branch', 'main')]);
	});

	test('uses post-PR title and pre-selects the default branch', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: undefined,
			fileExists: fileExistsNoRebase,
			git: happyGit,
		});

		await runPostPullRequestWorkflow(h.deps);

		const quickPick = h.quickPickRequests[0];
		assert.ok(quickPick);
		assert.strictEqual(quickPick.title, 'Post Pull Request: Branch to rebase onto');
		const mainItem = quickPick.items.find((i) => i.label === 'main');
		assert.ok(mainItem?.picked, 'Default branch (main) should be pre-selected');
		assert.ok(h.outputLines.includes(syncMessages.operationCancelled));
	});

	test('rebase conflicts pause and save a memento without deleting the current branch', async () => {
		const rebaseAttemptedRef = { current: false };
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: { label: 'main' },
			rebaseAttemptedRef,
			fileExists: (p) =>
				fileExistsNoRebase(p) ||
				(rebaseAttemptedRef.current && (p.includes('rebase-merge') || p.includes('rebase-apply'))),
			git: {
				...happyGit,
				'rebase main': new Error('CONFLICT (content): Merge conflict in foo.ts'),
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		assert.deepStrictEqual(h.infoMessages, [syncMessages.rebaseConflicts]);
		const saveUpdate = h.mementoUpdates.find((u) => u.key === MEMENTO_KEY && u.value !== undefined);
		assert.ok(saveUpdate, 'Memento should be saved on conflict so Resume can continue');
		assert.ok(!h.commands.includes('push --force-with-lease'), 'Should not force-push on conflict');
		assert.ok(
			!h.commands.some((c) => c.startsWith('branch -D feature/my-branch')),
			'Should not delete the current branch on conflict'
		);
	});

	test('rebases onto the remote ref when a remote branch is selected (no current-branch delete)', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: { label: 'origin/develop (remote)' },
			fileExists: fileExistsNoRebase,
			git: {
				...baseGitForSync,
				...defaultDetectGit,
				'status --porcelain -u': { stdout: '' },
				'push --force-with-lease': { stdout: '' },
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		assert.ok(h.commands.includes('rebase __gsp_sync_origin_develop'), 'Should rebase onto the prepared upstream branch');
		assert.ok(h.commands.includes('push --force-with-lease'), 'Should force-push the current branch');
		assert.ok(
			!h.commands.some((c) => c.startsWith('branch -D feature/my-branch')),
			'Should not delete the current branch'
		);
	});

	test('exits early when a rebase is already in progress', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			git: happyGit,
			fileExists: (p) => p.includes('rebase-merge') || p.includes('rebase-apply'),
		});

		await runPostPullRequestWorkflow(h.deps);

		assert.deepStrictEqual(h.infoMessages, [syncMessages.rebaseAlreadyInProgress]);
		assert.ok(!h.commands.includes('push --force-with-lease'));
	});
});
