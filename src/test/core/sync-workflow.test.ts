import * as assert from 'assert';
import { NOT_A_REPOSITORY } from '../../core/errors';
import { syncMessages } from '../../core/sync-messages';
import { MEMENTO_KEY, type SyncMemento } from '../../core/sync-state';
import { runSyncWorkflow, tempBranchNameFor } from '../../core/sync-workflow';
import {
	baseGitForSync,
	createHarness,
	fileExistsNoRebase,
} from './sync-with-upstream.harness';

const tempMain = tempBranchNameFor('origin/main', '/repo/.git');
const tempDevelop = tempBranchNameFor('origin/develop', '/repo/.git');

suite('sync-with-upstream workflow', () => {
	suite('runSyncWorkflow', () => {
		test('fails fast when rebase already in progress', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: (p) => p.includes('rebase-merge') || p.includes('rebase-apply'),
				git: { 'rev-parse --absolute-git-dir': { stdout: '/repo/.git' } },
			});
			assert.strictEqual(await runSyncWorkflow(h.context), 'paused');

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
			await runSyncWorkflow(h.context);

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
					'branch --no-column -a': { stdout: '* feature/my-branch\n  remotes/origin/HEAD -> origin/main' },
				},
			});
			await runSyncWorkflow(h.context);

			assert.deepStrictEqual(h.infoMessages, [syncMessages.noBranchesForSync]);
			assert.strictEqual(h.quickPickRequests.length, 0);
		});

		test('syncs with the requested branch without asking', async () => {
			const h = createHarness({ fileExists: fileExistsNoRebase, git: baseGitForSync });
			await runSyncWorkflow(h.context, 'main');

			assert.strictEqual(h.quickPickRequests.length, 0);
			assert.ok(h.commands.includes('rebase main'));
		});

		test('handles quick-pick cancellation', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				quickPickSelection: undefined,
				git: baseGitForSync,
			});
			assert.strictEqual(await runSyncWorkflow(h.context), 'cancelled');

			assert.ok(h.outputLines.includes(syncMessages.operationCancelled));
			assert.strictEqual(h.quickPickRequests.length, 1);
			assert.strictEqual(h.quickPickRequests[0]?.title, syncMessages.pickBranchTitle);
		});

		test('fails when the picker returns a label that matches no branch', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				quickPickSelection: { label: 'does-not-exist' },
				git: baseGitForSync,
			});
			await runSyncWorkflow(h.context);

			assert.deepStrictEqual(h.errorMessages, ['Unknown branch picked: does-not-exist']);
			assert.ok(h.outputLines.includes(syncMessages.outputFailed), 'log should end with a terminal marker');
			assert.ok(!h.commands.some((c) => c.startsWith('rebase')));
		});

		test('aborts when git status fails instead of assuming a clean tree', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				quickPickSelection: { label: 'main' },
				git: {
					...baseGitForSync,
					'status --porcelain -u': new Error('fatal: index file corrupt'),
					'checkout feature/my-branch': { stdout: '' },
				},
			});
			await runSyncWorkflow(h.context);

			assert.ok(h.errorMessages.some((m) => m.includes('index file corrupt')));
			assert.ok(!h.commands.some((c) => c.startsWith('stash push')));
			assert.ok(!h.commands.some((c) => c.startsWith('rebase')));
			assert.ok(h.outputLines.includes(syncMessages.outputFailed));
			assert.ok(h.outputLines.includes(syncMessages.outputSessionEnded));
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
					'pull --ff-only': { stdout: '' },
					'checkout feature/my-branch': { stdout: '' },
					'rebase main': { stdout: '' },
					'push --force-with-lease': { stdout: '' },
				},
			});
			assert.strictEqual(await runSyncWorkflow(h.context), 'ok');

			assert.deepStrictEqual(h.infoMessages, [syncMessages.syncedWith('feature/my-branch', 'main')]);
			assert.deepStrictEqual(h.errorMessages, []);
			assert.ok(h.commands.includes('fetch -p'));
			assert.ok(h.commands.includes('status --porcelain -u'));
			assert.ok(!h.commands.includes('stash push -u -m gsp-sync-with-upstream'));
			assert.ok(!h.commands.includes('stash pop'));
			assert.ok(h.commands.includes('checkout main'));
			assert.ok(h.commands.includes('pull --ff-only'));
			assert.ok(h.commands.includes('checkout feature/my-branch'));
			assert.ok(h.commands.includes('rebase main'));
			assert.ok(h.commands.includes('push --force-with-lease'));
			assert.ok(h.outputLines.includes(syncMessages.outputComplete));
		});

		test('successful sync clears a stale memento from a previous failure', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				quickPickSelection: { label: 'main' },
				memento: {
					workspaceRoot: '/repo',
					featureBranch: 'old-branch',
					hasStash: false,
					upstreamRef: 'main',
					upstreamIsRemote: false,
				},
				git: {
					...baseGitForSync,
					'status --porcelain -u': { stdout: '' },
					'checkout main': { stdout: '' },
					'pull --ff-only': { stdout: '' },
					'checkout feature/my-branch': { stdout: '' },
					'rebase main': { stdout: '' },
					'push --force-with-lease': { stdout: '' },
				},
			});
			await runSyncWorkflow(h.context);

			assert.deepStrictEqual(h.infoMessages, [syncMessages.syncedWith('feature/my-branch', 'main')]);
			const clearUpdate = h.mementoUpdates.find((u) => u.key === MEMENTO_KEY && u.value === undefined);
			assert.ok(clearUpdate, 'Stale memento should be cleared after a successful sync');
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
					'pull --ff-only': { stdout: '' },
					'checkout feature/my-branch': { stdout: '' },
					'rebase main': { stdout: '' },
					'push --force-with-lease': { stdout: '' },
					'stash pop': { stdout: '' },
				},
			});
			await runSyncWorkflow(h.context);

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
					[`checkout -B ${tempMain} origin/main`]: { stdout: '' },
					'pull --ff-only origin main': { stdout: '' },
					'checkout feature/my-branch': { stdout: '' },
					[`rebase ${tempMain}`]: { stdout: '' },
					'push --force-with-lease': { stdout: '' },
					[`branch -D ${tempMain}`]: { stdout: '' },
					'rev-parse --verify refs/heads/main': { stdout: 'abc123' },
				},
			});
			await runSyncWorkflow(h.context);

			assert.ok(h.commands.includes(`checkout -B ${tempMain} origin/main`));
			assert.ok(h.commands.includes('pull --ff-only origin main'));
			assert.ok(h.commands.includes(`rebase ${tempMain}`));
			assert.ok(h.commands.includes(`branch -D ${tempMain}`));
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
					[`checkout -B ${tempMain} origin/main`]: { stdout: '' },
					'pull --ff-only origin main': { stdout: '' },
					'checkout feature/my-branch': { stdout: '' },
					[`rebase ${tempMain}`]: { stdout: '' },
					'push --force-with-lease': { stdout: '' },
					[`branch -D ${tempMain}`]: { stdout: '' },
					'rev-parse --verify refs/heads/main': new Error('not a valid ref'),
					'branch main origin/main': { stdout: '' },
				},
			});
			await runSyncWorkflow(h.context);

			assert.ok(h.commands.includes('branch main origin/main'));
			assert.ok(!h.commands.some((c) => c.includes('branch -f')), 'should not force-update');
			assert.ok(h.outputLines.some((l) => l.includes(syncMessages.infoLocalBranchSynced('main', 'origin/main'))));
		});

		test('blocks syncing a branch onto its own remote counterpart', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				quickPickSelection: { label: 'origin/main (remote)' },
				git: {
					...baseGitForSync,
					'rev-parse --abbrev-ref HEAD': { stdout: 'main' },
				},
			});
			assert.strictEqual(await runSyncWorkflow(h.context), 'cancelled');

			assert.deepStrictEqual(h.infoMessages, [syncMessages.cannotSyncOntoItself('main')]);
			assert.ok(h.outputLines.includes(syncMessages.operationCancelled));
			assert.ok(!h.commands.some((c) => c.startsWith('rebase')));
			assert.ok(!h.commands.includes('push --force-with-lease'));
			assert.ok(!h.commands.some((c) => c.startsWith('stash')));
		});

		test('aborts and cleans up when pulling the target branch fails for a real reason', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				quickPickSelection: { label: 'main' },
				git: {
					...baseGitForSync,
					'status --porcelain -u': { stdout: '' },
					'checkout main': { stdout: '' },
					'pull --ff-only': new Error('error: Your local changes would be overwritten by merge.'),
					'checkout feature/my-branch': { stdout: '' },
				},
			});
			await runSyncWorkflow(h.context);

			assert.ok(!h.commands.some((c) => c.startsWith('rebase')));
			assert.ok(!h.commands.includes('push --force-with-lease'));
			assert.ok(h.errorMessages.some((m) => m.includes('local changes would be overwritten')));
			assert.ok(h.commands.includes('checkout feature/my-branch'), 'cleanup should return to the feature branch');
			assert.ok(h.outputLines.includes(syncMessages.outputFailed));
		});

		test('still skips pull when the local target branch has no upstream', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				quickPickSelection: { label: 'main' },
				git: {
					...baseGitForSync,
					'status --porcelain -u': { stdout: '' },
					'checkout main': { stdout: '' },
					'pull --ff-only': new Error('There is no tracking information for the current branch.'),
					'checkout feature/my-branch': { stdout: '' },
					'rebase main': { stdout: '' },
					'push --force-with-lease': { stdout: '' },
				},
			});
			await runSyncWorkflow(h.context);

			assert.ok(h.outputLines.includes(syncMessages.infoPullSkippedLocal));
			assert.ok(h.commands.includes('rebase main'));
			assert.ok(h.commands.includes('push --force-with-lease'));
			assert.deepStrictEqual(h.errorMessages, []);
		});

		test('aborts when pulling a remote target fails', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				quickPickSelection: { label: 'origin/develop (remote)' },
				git: {
					...baseGitForSync,
					'branch --no-column -a': {
						stdout: '* feature/my-branch\n  main\n  remotes/origin/develop\n  remotes/origin/HEAD -> origin/main',
					},
					'status --porcelain -u': { stdout: '' },
					[`checkout -B ${tempDevelop} origin/develop`]: { stdout: '' },
					'pull --ff-only origin develop': new Error('fatal: unable to access remote'),
					'checkout feature/my-branch': { stdout: '' },
					[`branch -D ${tempDevelop}`]: { stdout: '' },
				},
			});
			await runSyncWorkflow(h.context);

			assert.ok(!h.commands.some((c) => c.startsWith('rebase')));
			assert.ok(!h.commands.includes('push --force-with-lease'));
			assert.ok(h.commands.includes(`branch -D ${tempDevelop}`), 'cleanup should delete the temp branch');
			assert.ok(h.errorMessages.some((m) => m.includes('unable to access remote')));
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
					'pull --ff-only': { stdout: '' },
					'checkout feature/my-branch': { stdout: '' },
					'rebase main': new Error('CONFLICT (content): Merge conflict in foo.ts'),
				},
			});
			assert.strictEqual(await runSyncWorkflow(h.context), 'paused');

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
					'pull --ff-only': { stdout: '' },
					'checkout feature/my-branch': { stdout: '' },
					'rebase main': { stdout: '' },
					'push --force-with-lease': new Error('rejected: non-fast-forward'),
				},
			});

			assert.strictEqual(await runSyncWorkflow(h.context), 'failed');

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
			await runSyncWorkflow(h.context);

			assert.deepStrictEqual(h.errorMessages, [NOT_A_REPOSITORY]);
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
			await runSyncWorkflow(h.context);

			assert.deepStrictEqual(h.errorMessages, ['Git is not installed or not available in PATH.']);
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
			await runSyncWorkflow(h.context);

			assert.deepStrictEqual(h.errorMessages, ['mysterious failure']);
		});
	});

	suite('tempBranchNameFor', () => {
		test('long refs sharing a 40-char prefix do not collide', () => {
			const prefix = 'origin/feature/really-long-shared-prefix-name';
			const a = tempBranchNameFor(`${prefix}-aaaa`, '/repo/.git');
			const b = tempBranchNameFor(`${prefix}-bbbb`, '/repo/.git');
			assert.notStrictEqual(a, b);
		});

		test('is deterministic for the same ref', () => {
			assert.strictEqual(tempBranchNameFor('origin/main', '/repo/.git'), tempBranchNameFor('origin/main', '/repo/.git'));
		});

		test('differs between worktrees', () => {
			assert.notStrictEqual(
				tempBranchNameFor('origin/main', '/repo/.git'),
				tempBranchNameFor('origin/main', '/repo/.git/worktrees/wt')
			);
		});
	});

	suite('worktrees', () => {
		test('rebases onto a local upstream checked out in another worktree without checking it out', async () => {
			const h = createHarness({
				workspaceRoot: '/repo/wt',
				fileExists: fileExistsNoRebase,
				quickPickSelection: { label: 'main' },
				git: {
					...baseGitForSync,
					'branch --no-column -a': { stdout: ['* feature/my-branch', '+ main', '  remotes/origin/main'].join('\n') },
				},
			});

			await runSyncWorkflow(h.context);

			assert.strictEqual(
				h.quickPickRequests[0].items.find((item) => item.label === 'main')?.description,
				'local, checked out in another worktree (used as is)'
			);
			assert.ok(!h.commands.includes('checkout main'), 'main cannot be checked out in this worktree');
			assert.ok(!h.commands.some((cmd) => cmd.startsWith('pull')));
			assert.ok(h.commands.includes('rebase main'));
			assert.ok(h.outputLines.includes(syncMessages.infoUpstreamInOtherWorktree('main')));
			assert.deepStrictEqual(h.infoMessages, [syncMessages.syncedWith('feature/my-branch', 'main')]);
		});
	});
});
