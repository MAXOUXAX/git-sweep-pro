import * as assert from 'assert';
import { runSyncWithUpstreamWorkflow } from '../../core/sync-with-upstream-workflow';
import { syncMessages } from '../../core/sync-with-upstream-messages';
import type { SyncMemento } from '../../core/sync-with-upstream-state';
import { MEMENTO_KEY } from '../../core/sync-with-upstream-state';
import {
	baseGitForSync,
	createHarness,
	fileExistsNoRebase,
} from './sync-with-upstream.harness';

suite('sync-with-upstream workflow', () => {
	suite('runSyncWithUpstreamWorkflow', () => {
		test('fails fast when no workspace is open', async () => {
			const h = createHarness();
			await runSyncWithUpstreamWorkflow(h.deps);

			assert.deepStrictEqual(h.errorMessages, [syncMessages.noWorkspace]);
			assert.strictEqual(h.commands.length, 0);
		});

		test('reports error when workspace has no .git directory', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				git: { 'rev-parse --absolute-git-dir': new Error('fatal: not a git repository') },
			});
			await runSyncWithUpstreamWorkflow(h.deps);

			assert.deepStrictEqual(h.errorMessages, [syncMessages.notGitRepo]);
			assert.ok(h.commands.includes('rev-parse --absolute-git-dir'));
			assert.ok(h.commands.length >= 1);
		});

		test('maps git-not-installed errors from rev-parse to friendly message', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				git: { 'rev-parse --absolute-git-dir': new Error('spawn git ENOENT') },
			});
			await runSyncWithUpstreamWorkflow(h.deps);

			assert.deepStrictEqual(h.errorMessages, [syncMessages.gitNotInstalled]);
			assert.strictEqual(h.commands.length, 1);
		});

		test('fails fast when rebase already in progress', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: (p) => p.includes('rebase-merge') || p.includes('rebase-apply'),
				git: { 'rev-parse --absolute-git-dir': { stdout: '/repo/.git' } },
			});
			await runSyncWithUpstreamWorkflow(h.deps);

			assert.deepStrictEqual(h.infoMessages, [syncMessages.rebaseAlreadyInProgress]);
			assert.ok(!h.commands.includes('fetch -p'));
		});

		test('handles detached HEAD (could not determine branch)', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				git: {
					...baseGitForSync,
					'rev-parse --abbrev-ref HEAD': { stdout: 'HEAD' },
				},
			});
			await runSyncWithUpstreamWorkflow(h.deps);

			assert.deepStrictEqual(h.errorMessages, [syncMessages.couldNotDetermineBranch]);
			assert.ok(h.commands.includes('fetch -p'));
			assert.strictEqual(h.quickPickRequests.length, 0);
		});

		test('shows info when no branches available for sync', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				git: {
					...baseGitForSync,
					'branch -a': { stdout: '* feature/my-branch\n  remotes/origin/HEAD -> origin/main' },
				},
			});
			await runSyncWithUpstreamWorkflow(h.deps);

			assert.deepStrictEqual(h.infoMessages, [syncMessages.noBranchesForSync]);
			assert.strictEqual(h.quickPickRequests.length, 0);
		});

		test('handles quick-pick cancellation', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				quickPickSelection: undefined,
				git: baseGitForSync,
			});
			await runSyncWithUpstreamWorkflow(h.deps);

			assert.ok(h.outputLines.includes(syncMessages.operationCancelled));
			assert.strictEqual(h.quickPickRequests.length, 1);
			assert.strictEqual(h.quickPickRequests[0]?.title, syncMessages.pickBranchTitle);
		});

		test('success path with local branch: fetch, checkout, pull, rebase, force-push', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				quickPickSelection: { label: 'main' },
				git: {
					...baseGitForSync,
					'status --porcelain -u': { stdout: '' },
					'checkout main': { stdout: '' },
					'pull': { stdout: '' },
					'checkout feature/my-branch': { stdout: '' },
					'rebase main': { stdout: '' },
					'push --force-with-lease': { stdout: '' },
				},
			});
			await runSyncWithUpstreamWorkflow(h.deps);

			assert.deepStrictEqual(h.infoMessages, [syncMessages.syncedWith('feature/my-branch', 'main')]);
			assert.deepStrictEqual(h.errorMessages, []);
			assert.ok(h.commands.includes('fetch -p'));
			assert.ok(h.commands.includes('status --porcelain -u'));
			assert.ok(!h.commands.includes('stash push -u -m gsp-sync-with-upstream'));
			assert.ok(!h.commands.includes('stash pop'));
			assert.ok(h.commands.includes('checkout main'));
			assert.ok(h.commands.includes('pull'));
			assert.ok(h.commands.includes('checkout feature/my-branch'));
			assert.ok(h.commands.includes('rebase main'));
			assert.ok(h.commands.includes('push --force-with-lease'));
			assert.ok(h.outputLines.includes(syncMessages.outputComplete));
		});

		test('success path with stash: stashes local changes, then pops after rebase', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				quickPickSelection: { label: 'main' },
				git: {
					...baseGitForSync,
					'status --porcelain -u': { stdout: ' M foo.txt' },
					'stash push -u -m gsp-sync-with-upstream': { stdout: '' },
					'checkout main': { stdout: '' },
					'pull': { stdout: '' },
					'checkout feature/my-branch': { stdout: '' },
					'rebase main': { stdout: '' },
					'push --force-with-lease': { stdout: '' },
					'stash pop': { stdout: '' },
				},
			});
			await runSyncWithUpstreamWorkflow(h.deps);

			assert.deepStrictEqual(h.infoMessages, [syncMessages.syncedWith('feature/my-branch', 'main')]);
			assert.ok(h.commands.includes('status --porcelain -u'));
			assert.ok(h.commands.includes('stash push -u -m gsp-sync-with-upstream'));
			assert.ok(h.commands.includes('stash pop'));
			assert.ok(h.outputLines.includes(syncMessages.outputComplete));
		});

		test('success path with remote branch: creates temp branch, pulls, rebases, skips local update when main exists', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				quickPickSelection: { label: 'origin/main (remote)' },
				git: {
					...baseGitForSync,
					'status --porcelain -u': { stdout: '' },
					'checkout -B __gsp_sync_origin_main origin/main': { stdout: '' },
					'pull origin main': { stdout: '' },
					'checkout feature/my-branch': { stdout: '' },
					'rebase __gsp_sync_origin_main': { stdout: '' },
					'push --force-with-lease': { stdout: '' },
					'branch -D __gsp_sync_origin_main': { stdout: '' },
					'rev-parse --verify refs/heads/main': { stdout: 'abc123' },
				},
			});
			await runSyncWithUpstreamWorkflow(h.deps);

			assert.ok(h.commands.includes('checkout -B __gsp_sync_origin_main origin/main'));
			assert.ok(h.commands.includes('pull origin main'));
			assert.ok(h.commands.includes('rebase __gsp_sync_origin_main'));
			assert.ok(h.commands.includes('branch -D __gsp_sync_origin_main'));
			assert.ok(h.commands.includes('rev-parse --verify refs/heads/main'));
			assert.ok(!h.commands.some((c) => c.includes('branch -f')), 'should not force-update local branch');
			assert.ok(h.outputLines.some((l) => l.includes(syncMessages.infoUpdateSkippedExisting('main'))));
		});

		test('success path with remote branch: creates local branch when it does not exist', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				quickPickSelection: { label: 'origin/main (remote)' },
				git: {
					...baseGitForSync,
					'status --porcelain -u': { stdout: '' },
					'checkout -B __gsp_sync_origin_main origin/main': { stdout: '' },
					'pull origin main': { stdout: '' },
					'checkout feature/my-branch': { stdout: '' },
					'rebase __gsp_sync_origin_main': { stdout: '' },
					'push --force-with-lease': { stdout: '' },
					'branch -D __gsp_sync_origin_main': { stdout: '' },
					'rev-parse --verify refs/heads/main': new Error('not a valid ref'),
					'branch main origin/main': { stdout: '' },
				},
			});
			await runSyncWithUpstreamWorkflow(h.deps);

			assert.ok(h.commands.includes('branch main origin/main'));
			assert.ok(!h.commands.some((c) => c.includes('branch -f')), 'should not force-update');
			assert.ok(h.outputLines.some((l) => l.includes(syncMessages.infoLocalBranchSynced('main', 'origin/main'))));
		});

		test('success path with remote branch: skips update when syncing branch equals local upstream', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				quickPickSelection: { label: 'origin/main (remote)' },
				git: {
					...baseGitForSync,
					'rev-parse --abbrev-ref HEAD': { stdout: 'main' },
					'status --porcelain -u': { stdout: '' },
					'checkout -B __gsp_sync_origin_main origin/main': { stdout: '' },
					'pull origin main': { stdout: '' },
					'checkout main': { stdout: '' },
					'rebase __gsp_sync_origin_main': { stdout: '' },
					'push --force-with-lease': { stdout: '' },
					'branch -D __gsp_sync_origin_main': { stdout: '' },
				},
			});
			await runSyncWithUpstreamWorkflow(h.deps);

			assert.ok(!h.commands.some((c) => c.includes('rev-parse --verify refs/heads/main')));
			assert.ok(!h.commands.some((c) => c.includes('branch main') || c.includes('branch -f')));
			assert.ok(h.outputLines.some((l) => l.includes(syncMessages.infoUpdateSkippedSameBranch('main'))));
		});

		test('conflict path: rebase fails with conflict, saves memento and pauses', async () => {
			const rebaseAttemptedRef = { current: false };
			const h = createHarness({
				workspaceRoot: '/repo',
				rebaseAttemptedRef,
				fileExists: (p) =>
					fileExistsNoRebase(p) || (rebaseAttemptedRef.current && (p.includes('rebase-merge') || p.includes('rebase-apply'))),
				quickPickSelection: { label: 'main' },
				git: {
					...baseGitForSync,
					'status --porcelain -u': { stdout: '' },
					'checkout main': { stdout: '' },
					'pull': { stdout: '' },
					'checkout feature/my-branch': { stdout: '' },
					'rebase main': new Error('CONFLICT (content): Merge conflict in foo.ts'),
				},
			});
			await runSyncWithUpstreamWorkflow(h.deps);

			assert.deepStrictEqual(h.infoMessages, [syncMessages.rebaseConflicts]);
			assert.ok(h.outputLines.includes(syncMessages.outputRebasePaused));
			const saveUpdate = h.mementoUpdates.find((u) => u.key === MEMENTO_KEY && u.value !== undefined);
			assert.ok(saveUpdate, 'Memento should be saved on conflict');
			const memento = saveUpdate?.value as SyncMemento;
			assert.strictEqual(memento.featureBranch, 'feature/my-branch');
			assert.strictEqual(memento.upstreamRef, 'main');
			assert.strictEqual(memento.hasStash, false);
		});

		test('push failure path: saves memento and shows resume message', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				quickPickSelection: { label: 'main' },
				git: {
					...baseGitForSync,
					'status --porcelain -u': { stdout: '' },
					'checkout main': { stdout: '' },
					'pull': { stdout: '' },
					'checkout feature/my-branch': { stdout: '' },
					'rebase main': { stdout: '' },
					'push --force-with-lease': new Error('rejected: non-fast-forward'),
				},
			});

			await runSyncWithUpstreamWorkflow(h.deps);

			assert.ok(h.errorMessages.some((m) => m.includes('non-fast-forward')));
			assert.ok(h.outputLines.includes(syncMessages.infoStateSavedForResume));
			const saveUpdate = h.mementoUpdates.find((u) => u.key === MEMENTO_KEY && u.value !== undefined);
			assert.ok(saveUpdate, 'Memento should be saved on push failure');
			assert.ok(h.outputLines.includes(syncMessages.outputFailed));
		});

		test('maps not-a-git-repository errors to friendly message', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
					'fetch -p': new Error('fatal: not a git repository (or any of the parent directories): .git'),
				},
			});
			await runSyncWithUpstreamWorkflow(h.deps);

			assert.deepStrictEqual(h.errorMessages, [syncMessages.notGitRepo]);
			assert.ok(h.outputLines.includes(syncMessages.outputFailed));
		});

		test('maps git-not-installed / ENOENT errors to friendly message', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
					'fetch -p': new Error('spawn git ENOENT'),
				},
			});
			await runSyncWithUpstreamWorkflow(h.deps);

			assert.deepStrictEqual(h.errorMessages, [syncMessages.gitNotInstalled]);
		});

		test('maps unknown errors to generic failure message', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
					'fetch -p': new Error('mysterious failure'),
				},
			});
			await runSyncWithUpstreamWorkflow(h.deps);

			assert.deepStrictEqual(h.errorMessages, [syncMessages.errorGeneric('mysterious failure')]);
		});
	});
});
