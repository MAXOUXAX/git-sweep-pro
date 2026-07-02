import * as assert from 'assert';
import { runSyncWithUpstreamResumeWorkflow } from '../../core/sync-with-upstream-workflow';
import { syncMessages } from '../../core/sync-with-upstream-messages';
import { MEMENTO_KEY } from '../../core/sync-with-upstream-state';
import { createHarness, fileExistsNoRebase } from './sync-with-upstream.harness';

suite('sync-with-upstream resume workflow', () => {
	suite('runSyncWithUpstreamResumeWorkflow', () => {
		test('fails fast when no workspace is open', async () => {
			const h = createHarness();
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.deepStrictEqual(h.errorMessages, [syncMessages.noWorkspace]);
			assert.strictEqual(h.commands.length, 0);
		});

		test('shows info when no rebase and no memento', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				git: { 'rev-parse --absolute-git-dir': { stdout: '/repo/.git' } },
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.deepStrictEqual(h.infoMessages, [syncMessages.noRebaseNothingToResume]);
			assert.ok(h.outputLines.includes(syncMessages.nothingToResume));
			assert.ok(h.mementoGets.includes(MEMENTO_KEY));
		});

		test('aborts with rebaseInOtherWorkspace when memento is from different workspace', async () => {
			const h = createHarness({
				workspaceRoot: '/other-repo',
				fileExists: fileExistsNoRebase,
				memento: {
					workspaceRoot: '/repo',
					featureBranch: 'feature/my-branch',
					hasStash: false,
					upstreamRef: 'main',
					upstreamIsRemote: false,
				},
				git: { 'rev-parse --absolute-git-dir': { stdout: '/other-repo/.git' } },
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.deepStrictEqual(h.errorMessages, [syncMessages.rebaseInOtherWorkspace]);
			assert.ok(h.outputLines.includes(syncMessages.rebaseInOtherWorkspace));
			assert.ok(
				!h.commands.includes('rebase --continue') && !h.commands.includes('push --force-with-lease'),
				'Should not run resume operations (rebase continue, push)'
			);
		});

		test('refuses to resume a rebase not started by the extension (no memento)', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: (p) => p.includes('rebase-merge') || p.includes('rebase-apply'),
				readFileUtf8: (p) => (p.includes('head-name') ? 'refs/heads/feature/my-branch' : ''),
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
				},
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.deepStrictEqual(h.errorMessages, [syncMessages.rebaseNotStartedByExtension]);
			assert.ok(!h.commands.includes('rebase --continue'));
			assert.ok(!h.commands.includes('push --force-with-lease'));
		});

		test('refuses to resume when the active rebase is on a different branch than the memento', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: (p) => p.includes('rebase-merge') || p.includes('rebase-apply'),
				readFileUtf8: (p) => (p.includes('head-name') ? 'refs/heads/other-branch' : ''),
				memento: {
					workspaceRoot: '/repo',
					featureBranch: 'feature/my-branch',
					hasStash: false,
					upstreamRef: 'main',
					upstreamIsRemote: false,
				},
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
				},
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.deepStrictEqual(h.errorMessages, [
				syncMessages.rebaseBranchMismatch('feature/my-branch', 'other-branch'),
			]);
			assert.ok(!h.commands.includes('rebase --continue'));
			assert.ok(!h.commands.includes('push --force-with-lease'));
		});

		test('resume with remote upstream syncs the local branch after push', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				memento: {
					workspaceRoot: '/repo',
					featureBranch: 'feature/my-branch',
					hasStash: false,
					upstreamRef: 'origin/main',
					upstreamIsRemote: true,
					tempBranchToCleanup: '__gsp_sync_origin_main',
				},
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
					'checkout feature/my-branch': { stdout: '' },
					'push --force-with-lease': { stdout: '' },
					'branch -D __gsp_sync_origin_main': { stdout: '' },
					'rev-parse --verify refs/heads/main': new Error('fatal: Needed a single revision'),
					'branch main origin/main': { stdout: '' },
				},
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.ok(h.commands.includes('branch main origin/main'), 'Should create the local branch from the remote ref');
			assert.deepStrictEqual(h.infoMessages, [syncMessages.syncedSuccess('feature/my-branch')]);
		});

		test('resume with rebase in progress: continues rebase, push, clears memento', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: (p) => p.includes('rebase-merge') || p.includes('rebase-apply'),
				readFileUtf8: (p) => (p.includes('head-name') ? 'refs/heads/feature/my-branch' : ''),
				memento: {
					workspaceRoot: '/repo',
					featureBranch: 'feature/my-branch',
					hasStash: false,
					upstreamRef: 'main',
					upstreamIsRemote: false,
				},
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
					'rebase --continue': { stdout: '' },
					'push --force-with-lease': { stdout: '' },
				},
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.ok(h.commands.includes('rebase --continue'));
			assert.ok(!h.commands.some((c) => c.startsWith('checkout ')));
			assert.ok(h.commands.includes('push --force-with-lease'));
			assert.deepStrictEqual(h.infoMessages, [syncMessages.syncedSuccess('feature/my-branch')]);
			assert.ok(h.outputLines.includes(syncMessages.outputResumeComplete));
			const clearUpdate = h.mementoUpdates.find((u) => u.key === MEMENTO_KEY && u.value === undefined);
			assert.ok(clearUpdate, 'Memento should be cleared after successful resume');
		});

		test('resume with memento only (no rebase): checks out feature branch, push, clears memento', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				memento: {
					workspaceRoot: '/repo',
					featureBranch: 'feature/my-branch',
					hasStash: false,
					upstreamRef: 'main',
					upstreamIsRemote: false,
				},
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
					'checkout feature/my-branch': { stdout: '' },
					'push --force-with-lease': { stdout: '' },
				},
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.ok(!h.commands.includes('rebase --continue'));
			assert.ok(h.commands.includes('checkout feature/my-branch'));
			assert.ok(h.commands.includes('push --force-with-lease'));
			assert.ok(h.outputLines.includes(syncMessages.infoNoRebaseInProgress));
			assert.deepStrictEqual(h.infoMessages, [syncMessages.syncedSuccess('feature/my-branch')]);
			const clearUpdate = h.mementoUpdates.find((u) => u.key === MEMENTO_KEY && u.value === undefined);
			assert.ok(clearUpdate, 'Memento should be cleared');
		});

		test('resume with memento and temp branch: cleans up temp branch after push', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				memento: {
					workspaceRoot: '/repo',
					featureBranch: 'feature/my-branch',
					hasStash: false,
					upstreamRef: 'origin/main',
					upstreamIsRemote: true,
					tempBranchToCleanup: '__gsp_sync_origin_main',
				},
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
					'checkout feature/my-branch': { stdout: '' },
					'push --force-with-lease': { stdout: '' },
					'branch -D __gsp_sync_origin_main': { stdout: '' },
				},
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.ok(h.commands.includes('branch -D __gsp_sync_origin_main'));
			assert.deepStrictEqual(h.infoMessages, [syncMessages.syncedSuccess('feature/my-branch')]);
		});

		test('resume with hasStash: pops stash after push', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				memento: {
					workspaceRoot: '/repo',
					featureBranch: 'feature/my-branch',
					hasStash: true,
					upstreamRef: 'main',
					upstreamIsRemote: false,
				},
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
					'checkout feature/my-branch': { stdout: '' },
					'push --force-with-lease': { stdout: '' },
					'stash pop': { stdout: '' },
				},
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.ok(h.commands.includes('stash pop'));
			assert.deepStrictEqual(h.infoMessages, [syncMessages.syncedSuccess('feature/my-branch')]);
		});

		test('resume with rebase in progress: reports error when continue fails with conflicts', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: (p) => p.includes('rebase-merge') || p.includes('rebase-apply'),
				readFileUtf8: (p) => (p.includes('head-name') ? 'refs/heads/feature/my-branch' : ''),
				memento: {
					workspaceRoot: '/repo',
					featureBranch: 'feature/my-branch',
					hasStash: false,
					upstreamRef: 'main',
					upstreamIsRemote: false,
				},
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
					'rebase --continue': new Error('CONFLICT (content): Merge conflict in bar.ts'),
				},
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.deepStrictEqual(h.errorMessages, [syncMessages.remainingConflicts]);
			assert.ok(!h.commands.includes('push --force-with-lease'));
			assert.ok(h.outputLines.includes(syncMessages.outputRebasePaused), 'log should end with a terminal marker');
		});

		test('resume with rebase in progress: rebase --continue succeeds but push fails, memento not cleared', async () => {
			const rebaseContinueRanRef = { current: false };
			const h = createHarness({
				workspaceRoot: '/repo',
				rebaseContinueRanRef,
				fileExists: (p) =>
					!rebaseContinueRanRef.current &&
					(p.includes('rebase-merge') || p.includes('rebase-apply')),
				readFileUtf8: (p) => (p.includes('head-name') ? 'refs/heads/feature/my-branch' : ''),
				memento: {
					workspaceRoot: '/repo',
					featureBranch: 'feature/my-branch',
					hasStash: false,
					upstreamRef: 'main',
					upstreamIsRemote: false,
				},
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
					'rebase --continue': { stdout: '' },
					'push --force-with-lease': new Error('rejected: failed to push'),
				},
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.ok(h.commands.includes('rebase --continue'));
			assert.ok(h.commands.includes('push --force-with-lease'));
			assert.ok(h.errorMessages.some((m) => m.includes('failed to push')));
			assert.ok(h.outputLines.some((l) => l.includes('[error]') && l.includes('failed to push')));
			assert.ok(h.outputLines.includes(syncMessages.outputFailed));
			assert.ok(!h.mementoUpdates.some((u) => u.key === MEMENTO_KEY && u.value === undefined));
		});

		test('falls back to the non-rebase path when continue fails because the rebase already ended', async () => {
			const rebaseContinueRanRef = { current: false };
			const h = createHarness({
				workspaceRoot: '/repo',
				rebaseContinueRanRef,
				fileExists: (p) =>
					!rebaseContinueRanRef.current &&
					(p.includes('rebase-merge') || p.includes('rebase-apply')),
				readFileUtf8: (p) => (p.includes('head-name') ? 'refs/heads/feature/my-branch' : ''),
				memento: {
					workspaceRoot: '/repo',
					featureBranch: 'feature/my-branch',
					hasStash: false,
					upstreamRef: 'main',
					upstreamIsRemote: false,
				},
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
					'rebase --continue': new Error('fatal: No rebase in progress?'),
					'checkout feature/my-branch': { stdout: '' },
					'push --force-with-lease': { stdout: '' },
				},
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.deepStrictEqual(h.errorMessages, []);
			assert.ok(h.outputLines.includes(syncMessages.infoNoRebaseInProgress));
			assert.ok(h.commands.includes('checkout feature/my-branch'));
			assert.ok(h.commands.includes('push --force-with-lease'));
			assert.deepStrictEqual(h.infoMessages, [syncMessages.syncedSuccess('feature/my-branch')]);
			const clearUpdate = h.mementoUpdates.find((u) => u.key === MEMENTO_KEY && u.value === undefined);
			assert.ok(clearUpdate, 'Memento should be cleared after the fallback completes');
		});

		test('resume errors when memento exists but featureBranch missing and no rebase head', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				memento: { workspaceRoot: '/repo', featureBranch: '', hasStash: false, upstreamRef: 'main', upstreamIsRemote: false },
				git: { 'rev-parse --absolute-git-dir': { stdout: '/repo/.git' } },
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.deepStrictEqual(h.errorMessages, [syncMessages.couldNotDetermineRebaseBranch]);
		});

		test('resume with active rebase does not checkout before push', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: (p) => p.includes('rebase-merge') || p.includes('rebase-apply'),
				readFileUtf8: (p) => (p.includes('head-name') ? 'refs/heads/feature/my-branch' : ''),
				memento: {
					workspaceRoot: '/repo',
					featureBranch: 'feature/my-branch',
					hasStash: false,
					upstreamRef: 'main',
					upstreamIsRemote: false,
				},
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
					'rebase --continue': { stdout: '' },
					'push --force-with-lease': { stdout: '' },
				},
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.ok(h.commands.includes('rebase --continue'));
			assert.ok(!h.commands.some((c) => c.startsWith('checkout ')));
		});

		test('maps git-not-installed errors from rev-parse to friendly message', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				git: {
					'rev-parse --absolute-git-dir': new Error('spawn git ENOENT'),
				},
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.deepStrictEqual(h.errorMessages, [syncMessages.gitNotInstalled]);
			assert.ok(!h.commands.includes('push --force-with-lease'));
			assert.ok(!h.commands.some((c) => c.startsWith('checkout ')));
		});

		test('resume shows error when checkout fails before push', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				memento: {
					workspaceRoot: '/repo',
					featureBranch: 'feature/my-branch',
					hasStash: false,
					upstreamRef: 'main',
					upstreamIsRemote: false,
				},
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
					'checkout feature/my-branch': new Error('error: pathspec did not match'),
				},
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.ok(h.errorMessages.some((m) => m.includes('pathspec did not match')));
			assert.ok(!h.commands.includes('push --force-with-lease'));
			assert.ok(h.outputLines.includes(syncMessages.outputFailed), 'log should end with a terminal marker');
			assert.ok(!h.mementoUpdates.some((u) => u.key === MEMENTO_KEY && u.value === undefined));
		});

		test('resume shows error when push fails', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				memento: {
					workspaceRoot: '/repo',
					featureBranch: 'feature/my-branch',
					hasStash: false,
					upstreamRef: 'main',
					upstreamIsRemote: false,
				},
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
					'checkout feature/my-branch': { stdout: '' },
					'push --force-with-lease': new Error('rejected: failed to push'),
				},
			});

			await assert.doesNotReject(async () => runSyncWithUpstreamResumeWorkflow(h.deps));

			assert.ok(h.errorMessages.some((m) => m.includes('failed to push')));
			assert.ok(h.outputLines.some((l) => l.includes('[error]') && l.includes('failed to push')));
			assert.ok(h.outputLines.includes(syncMessages.outputFailed));
			assert.ok(!h.mementoUpdates.some((u) => u.key === MEMENTO_KEY && u.value === undefined));
		});
	});
});
