import * as assert from 'assert';
import * as path from 'node:path';
import {
	clearMemento,
	getMemento,
	isRebaseInProgress,
	MEMENTO_KEY,
	readRebaseHeadName,
	resolveGitDir,
	saveMemento,
	TEMP_BRANCH_PREFIX,
	type SyncMemento,
	type SyncWithUpstreamDeps,
} from '../../core/sync-with-upstream-state';

function createDeps(overrides: {
	workspaceState?: Partial<SyncWithUpstreamDeps['workspaceState']>;
	fileExists?: (p: string) => boolean;
	readFileUtf8?: (p: string) => string;
	runGitCommand?: SyncWithUpstreamDeps['runGitCommand'];
} = {}): SyncWithUpstreamDeps {
	const state = new Map<string, unknown>();

	return {
		getWorkspaceRoot: () => '/repo',
		output: { show: () => undefined, appendLine: () => undefined },
		runGitCommand: overrides.runGitCommand ?? (async () => ({ stdout: '', stderr: '' })),
		ui: {
			withProgress: async (_, task) => task(),
			showQuickPick: async () => undefined,
			showInformationMessage: () => undefined,
			showErrorMessage: () => undefined,
		},
		workspaceState: {
			get: <T>(key: string) => state.get(key) as T | undefined,
			update: async (key: string, value: unknown) => {
				if (value === undefined) {
					state.delete(key);
				} else {
					state.set(key, value);
				}
			},
			...overrides.workspaceState,
		},
		fileExists: overrides.fileExists ?? (() => false),
		readFileUtf8: overrides.readFileUtf8 ?? (() => ''),
	};
}

suite('sync-with-upstream-state', () => {
	suite('MEMENTO_KEY and TEMP_BRANCH_PREFIX', () => {
		test('exports expected constants', () => {
			assert.strictEqual(MEMENTO_KEY, 'git-sweep-pro.syncWithUpstream.memento');
			assert.strictEqual(TEMP_BRANCH_PREFIX, '__gsp_sync_');
		});
	});

	suite('getMemento / saveMemento / clearMemento', () => {
		test('getMemento returns undefined when nothing saved', () => {
			const deps = createDeps();
			assert.strictEqual(getMemento(deps), undefined);
		});

		test('saveMemento and getMemento round-trip', async () => {
			const deps = createDeps();
			const memento: SyncMemento = {
				workspaceRoot: '/repo',
				featureBranch: 'feature/foo',
				hasStash: true,
				upstreamRef: 'origin/main',
				upstreamIsRemote: true,
			};

			await saveMemento(deps, memento);
			assert.deepStrictEqual(getMemento(deps), memento);
		});

		test('saveMemento with tempBranchToCleanup', async () => {
			const deps = createDeps();
			const memento: SyncMemento = {
				workspaceRoot: '/repo',
				featureBranch: 'feature/foo',
				hasStash: false,
				upstreamRef: 'origin/main',
				upstreamIsRemote: true,
				tempBranchToCleanup: '__gsp_sync_origin_main',
			};

			await saveMemento(deps, memento);
			assert.deepStrictEqual(getMemento(deps), memento);
		});

		test('clearMemento removes saved memento', async () => {
			const deps = createDeps();
			const memento: SyncMemento = {
				workspaceRoot: '/repo',
				featureBranch: 'main',
				hasStash: false,
				upstreamRef: 'origin/develop',
				upstreamIsRemote: true,
			};

			await saveMemento(deps, memento);
			assert.ok(getMemento(deps));

			await clearMemento(deps);
			assert.strictEqual(getMemento(deps), undefined);
		});
	});

	suite('resolveGitDir', () => {
		test('returns git dir path when rev-parse succeeds', async () => {
			const deps = createDeps({
				runGitCommand: async (args) => {
					assert.deepStrictEqual(args, ['rev-parse', '--absolute-git-dir']);
					return { stdout: '/repo/.git\n', stderr: '' };
				},
			});
			const dir = await resolveGitDir('/repo', deps);
			assert.strictEqual(dir, '/repo/.git');
		});

		test('returns worktree git dir when .git is a file (worktree/submodule)', async () => {
			const worktreeGitDir = '/main-repo/.git/worktrees/my-feature';
			const deps = createDeps({
				runGitCommand: async (args) => {
					assert.deepStrictEqual(args, ['rev-parse', '--absolute-git-dir']);
					return { stdout: `${worktreeGitDir}\n`, stderr: '' };
				},
			});
			const dir = await resolveGitDir('/worktree/root', deps);
			assert.strictEqual(dir, worktreeGitDir);
		});

		test('returns undefined when rev-parse fails (not a git repo)', async () => {
			const deps = createDeps({
				runGitCommand: async () => {
					throw new Error('fatal: not a git repository');
				},
			});
			const dir = await resolveGitDir('/not-a-repo', deps);
			assert.strictEqual(dir, undefined);
		});

		test('rethrows when rev-parse fails for reasons other than not a git repo', async () => {
			const deps = createDeps({
				runGitCommand: async () => {
					throw new Error('spawn git ENOENT');
				},
			});
			await assert.rejects(() => resolveGitDir('/repo', deps), /spawn git ENOENT/);
		});
	});

	suite('isRebaseInProgress', () => {
		test('returns false when neither rebase dir exists', () => {
			const gitDir = '/repo/.git';
			const deps = createDeps({
				fileExists: (p) => {
					assert.ok(
						p === path.join(gitDir, 'rebase-merge') || p === path.join(gitDir, 'rebase-apply'),
						`unexpected path: ${p}`
					);
					return false;
				},
			});

			assert.strictEqual(isRebaseInProgress(gitDir, deps), false);
		});

		test('returns true when rebase-merge exists', () => {
			const gitDir = '/repo/.git';
			const rebaseMerge = path.join(gitDir, 'rebase-merge');
			const deps = createDeps({
				fileExists: (p) => p === rebaseMerge,
			});

			assert.strictEqual(isRebaseInProgress(gitDir, deps), true);
		});

		test('returns true when rebase-apply exists', () => {
			const gitDir = '/repo/.git';
			const rebaseApply = path.join(gitDir, 'rebase-apply');
			const deps = createDeps({
				fileExists: (p) => p === rebaseApply,
			});

			assert.strictEqual(isRebaseInProgress(gitDir, deps), true);
		});

		test('returns true when both exist (rebase-merge wins first)', () => {
			const gitDir = '/repo/.git';
			const deps = createDeps({
				fileExists: (p) =>
					p === path.join(gitDir, 'rebase-merge') || p === path.join(gitDir, 'rebase-apply'),
			});

			assert.strictEqual(isRebaseInProgress(gitDir, deps), true);
		});
	});

	suite('readRebaseHeadName', () => {
		test('returns undefined when no head-name file exists', () => {
			const gitDir = '/repo/.git';
			const deps = createDeps({ fileExists: () => false });

			assert.strictEqual(readRebaseHeadName(gitDir, deps), undefined);
		});

		test('returns undefined when head-name is empty or whitespace-only', () => {
			const gitDir = '/repo/.git';
			const headPath = path.join(gitDir, 'rebase-merge', 'head-name');
			const deps = createDeps({
				fileExists: (p) => p === headPath,
				readFileUtf8: () => '   \n',
			});

			assert.strictEqual(readRebaseHeadName(gitDir, deps), undefined);
		});

		test('returns branch name when head-name contains refs/heads/branch', () => {
			const gitDir = '/repo/.git';
			const headPath = path.join(gitDir, 'rebase-merge', 'head-name');
			const deps = createDeps({
				fileExists: (p) => p === headPath,
				readFileUtf8: (p) => {
					if (p === headPath) {
						return 'refs/heads/feature/xyz\n';
					}
					return '';
				},
			});

			assert.strictEqual(readRebaseHeadName(gitDir, deps), 'feature/xyz');
		});

		test('returns content as-is when not refs/heads/ prefix', () => {
			const gitDir = '/repo/.git';
			const headPath = path.join(gitDir, 'rebase-merge', 'head-name');
			const deps = createDeps({
				fileExists: (p) => p === headPath,
				readFileUtf8: (p) => (p === headPath ? 'origin/main' : ''),
			});

			assert.strictEqual(readRebaseHeadName(gitDir, deps), 'origin/main');
		});

		test('trims whitespace from head-name content', () => {
			const gitDir = '/repo/.git';
			const headPath = path.join(gitDir, 'rebase-merge', 'head-name');
			const deps = createDeps({
				fileExists: (p) => p === headPath,
				readFileUtf8: (p) => (p === headPath ? '  refs/heads/develop  ' : ''),
			});

			assert.strictEqual(readRebaseHeadName(gitDir, deps), 'develop');
		});

		test('prefers rebase-merge over rebase-apply', () => {
			const gitDir = '/repo/.git';
			const mergePath = path.join(gitDir, 'rebase-merge', 'head-name');
			const applyPath = path.join(gitDir, 'rebase-apply', 'head-name');
			const deps = createDeps({
				fileExists: (p) => p === mergePath || p === applyPath,
				readFileUtf8: (p) => {
					if (p === mergePath) {
						return 'refs/heads/from-merge';
					}
					if (p === applyPath) {
						return 'refs/heads/from-apply';
					}
					return '';
				},
			});

			assert.strictEqual(readRebaseHeadName(gitDir, deps), 'from-merge');
		});
	});
});
