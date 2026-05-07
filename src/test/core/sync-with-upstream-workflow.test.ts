import * as assert from 'assert';
import {
	runSyncWithUpstreamResumeWorkflow,
	runSyncWithUpstreamWorkflow,
	type SyncWithUpstreamDeps,
} from '../../core/sync-with-upstream-workflow';
import type { QuickPickItemLike } from '../../core/sweep-workflow';
import type { SyncMemento } from '../../core/sync-with-upstream-state';
import { MEMENTO_KEY } from '../../core/sync-with-upstream-state';
import { syncMessages } from '../../core/sync-with-upstream-messages';

type GitEntry = { stdout?: string; stderr?: string } | Error;

type HarnessOptions = {
	workspaceRoot?: string;
	quickPickSelection?: QuickPickItemLike | undefined;
	git?: Record<string, GitEntry | GitEntry[]>;
	/** Return true for .git dir, false for rebase-merge/rebase-apply. Omit to default to false. */
	fileExists?: (path: string) => boolean;
		/** When set, runGitCommand will set .current=true when a rebase (non-continue) command runs. Use with stateful fileExists for conflict tests. */
	rebaseAttemptedRef?: { current: boolean };
	/** When set, runGitCommand will set .current=true when 'rebase --continue' runs. Use with stateful fileExists for resume push-failure tests. */
	rebaseContinueRanRef?: { current: boolean };
	readFileUtf8?: (path: string) => string;
	memento?: SyncMemento | undefined;
};

type Harness = {
	deps: SyncWithUpstreamDeps;
	outputLines: string[];
	infoMessages: string[];
	errorMessages: string[];
	commands: string[];
	progressTitles: string[];
	quickPickRequests: Array<{ items: QuickPickItemLike[]; title: string }>;
	mementoUpdates: Array<{ key: string; value: unknown }>;
	mementoGets: string[];
};

function createHarness(options: HarnessOptions = {}): Harness {
	const outputLines: string[] = [];
	const infoMessages: string[] = [];
	const errorMessages: string[] = [];
	const commands: string[] = [];
	const progressTitles: string[] = [];
	const quickPickRequests: Array<{ items: QuickPickItemLike[]; title: string }> = [];
	const mementoUpdates: Array<{ key: string; value: unknown }> = [];
	const mementoGets: string[] = [];
	const callCount: Record<string, number> = {};

	const resolveGitEntry = (command: string): GitEntry | undefined => {
		const entry = options.git?.[command];
		if (entry === undefined) {
			return undefined;
		}
		if (Array.isArray(entry)) {
			const idx = callCount[command] ?? 0;
			callCount[command] = idx + 1;
			return entry[idx] ?? entry[entry.length - 1];
		}
		return entry;
	};

	const workspaceStateStore: Record<string, unknown> = {
		...(options.memento !== undefined && { [MEMENTO_KEY]: options.memento }),
	};

	const deps: SyncWithUpstreamDeps = {
		getWorkspaceRoot: () => options.workspaceRoot,
		output: {
			appendLine: (line) => outputLines.push(line),
		},
		runGitCommand: async (args, _cwd) => {
			const key = args.join(' ');
			if (options.rebaseAttemptedRef && key.startsWith('rebase ') && !key.includes('--continue')) {
				options.rebaseAttemptedRef.current = true;
			}
			if (options.rebaseContinueRanRef && key === 'rebase --continue') {
				options.rebaseContinueRanRef.current = true;
			}
			commands.push(key);
			const entry = resolveGitEntry(key);
			if (entry instanceof Error) {
				throw entry;
			}
			return { stdout: entry?.stdout ?? '', stderr: entry?.stderr ?? '' };
		},
		ui: {
			withProgress: async (progress, task) => {
				progressTitles.push(progress.title);
				return task();
			},
			showQuickPick: async (items, config) => {
				quickPickRequests.push({ items, title: config.title });
				return options.quickPickSelection;
			},
			showInformationMessage: (message) => infoMessages.push(message),
			showErrorMessage: (message) => errorMessages.push(message),
		},
		workspaceState: {
			get: <T>(key: string) => {
				mementoGets.push(key);
				return workspaceStateStore[key] as T | undefined;
			},
			update: async (key, value) => {
				mementoUpdates.push({ key, value });
				workspaceStateStore[key] = value;
			},
		},
		fileExists: options.fileExists ?? (() => false),
		readFileUtf8: options.readFileUtf8 ?? (() => ''),
	};

	return { deps, outputLines, infoMessages, errorMessages, commands, progressTitles, quickPickRequests, mementoUpdates, mementoGets };
}

/** No rebase in progress. Use for sync-flow tests that should proceed past the initial checks. */
const fileExistsNoRebase = (p: string) => !p.includes('rebase');

/** Matches git branch -a: simple branch names; parseBranches uses whole line as name. */
const baseBranchList = [
	'* feature/my-branch',
	'  main',
	'  develop',
	'  remotes/origin/HEAD -> origin/main',
	'  remotes/origin/main',
	'  remotes/origin/develop',
].join('\n');

const baseGitForSync = {
	'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
	'fetch -p': { stdout: '' },
	'rev-parse --abbrev-ref HEAD': { stdout: 'feature/my-branch' },
	'branch -a': { stdout: baseBranchList },
};

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

		test('resume with rebase in progress: continues rebase, push, clears memento', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: (p) => p.includes('rebase-merge') || p.includes('rebase-apply'),
				readFileUtf8: (p) => (p.includes('head-name') ? 'refs/heads/feature/my-branch' : ''),
				memento: undefined,
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
					'rebase --continue': { stdout: '' },
					'push --force-with-lease': { stdout: '' },
				},
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.ok(h.commands.includes('rebase --continue'));
			assert.ok(h.commands.includes('push --force-with-lease'));
			assert.deepStrictEqual(h.infoMessages, [syncMessages.syncedSuccess('feature/my-branch')]);
			assert.ok(h.outputLines.includes(syncMessages.outputResumeComplete));
			const clearUpdate = h.mementoUpdates.find((u) => u.key === MEMENTO_KEY && u.value === undefined);
			assert.ok(clearUpdate, 'Memento should be cleared after successful resume');
		});

		test('resume with memento only (no rebase): skips continue, push, clears memento', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				memento: {
					workspaceRoot: '/repo',
					featureBranch: 'feature/my-branch',
					hasStash: false,
					upstreamRef: 'main',
				},
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
					'push --force-with-lease': { stdout: '' },
				},
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.ok(!h.commands.includes('rebase --continue'));
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
					tempBranchToCleanup: '__gsp_sync_origin_main',
				},
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
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
				},
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
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
				memento: undefined,
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
					'rebase --continue': new Error('CONFLICT (content): Merge conflict in bar.ts'),
				},
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.deepStrictEqual(h.errorMessages, [syncMessages.remainingConflicts]);
			assert.ok(!h.commands.includes('push --force-with-lease'));
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
				memento: undefined,
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

		test('resume errors when memento exists but featureBranch missing and no rebase head', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				fileExists: fileExistsNoRebase,
				memento: { workspaceRoot: '/repo', featureBranch: '', hasStash: false, upstreamRef: 'main' },
				git: { 'rev-parse --absolute-git-dir': { stdout: '/repo/.git' } },
			});
			await runSyncWithUpstreamResumeWorkflow(h.deps);

			assert.deepStrictEqual(h.errorMessages, [syncMessages.couldNotDetermineRebaseBranch]);
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
				},
				git: {
					'rev-parse --absolute-git-dir': { stdout: '/repo/.git' },
					'push --force-with-lease': new Error('rejected: failed to push'),
				},
			});

			await assert.doesNotReject(
				async () => runSyncWithUpstreamResumeWorkflow(h.deps)
			);

			assert.ok(h.errorMessages.some((m) => m.includes('failed to push')));
			assert.ok(h.outputLines.some((l) => l.includes('[error]') && l.includes('failed to push')));
			assert.ok(h.outputLines.includes(syncMessages.outputFailed));
			assert.ok(!h.mementoUpdates.some((u) => u.key === MEMENTO_KEY && u.value === undefined));
		});
	});
});
