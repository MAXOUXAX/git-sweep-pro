import * as assert from 'assert';
import * as path from 'node:path';
import {
	clearMemento,
	getMemento,
	isRebaseInProgress,
	MEMENTO_KEY,
	readRebaseHeadName,
	saveMemento,
	TEMP_BRANCH_PREFIX,
	type SyncContext,
	type SyncMemento,
} from '../../core/sync-state';
import { createFakeContext, createMemoryStore } from '../fake-context';

function createDeps(overrides: { fileExists?: (p: string) => boolean; readFileUtf8?: (p: string) => string } = {}): SyncContext {
	return {
		...createFakeContext().context,
		gitDir: '/repo/.git',
		state: createMemoryStore(),
		fileExists: overrides.fileExists ?? (() => false),
		readFileUtf8: overrides.readFileUtf8 ?? (() => ''),
	};
}

suite('sync state', () => {
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

			assert.strictEqual(isRebaseInProgress({ ...deps, gitDir }), false);
		});

		test('returns true when rebase-merge exists', () => {
			const gitDir = '/repo/.git';
			const rebaseMerge = path.join(gitDir, 'rebase-merge');
			const deps = createDeps({
				fileExists: (p) => p === rebaseMerge,
			});

			assert.strictEqual(isRebaseInProgress({ ...deps, gitDir }), true);
		});

		test('returns true when rebase-apply exists', () => {
			const gitDir = '/repo/.git';
			const rebaseApply = path.join(gitDir, 'rebase-apply');
			const deps = createDeps({
				fileExists: (p) => p === rebaseApply,
			});

			assert.strictEqual(isRebaseInProgress({ ...deps, gitDir }), true);
		});

		test('returns true when both exist (rebase-merge wins first)', () => {
			const gitDir = '/repo/.git';
			const deps = createDeps({
				fileExists: (p) =>
					p === path.join(gitDir, 'rebase-merge') || p === path.join(gitDir, 'rebase-apply'),
			});

			assert.strictEqual(isRebaseInProgress({ ...deps, gitDir }), true);
		});
	});

	suite('readRebaseHeadName', () => {
		test('returns undefined when no head-name file exists', () => {
			const gitDir = '/repo/.git';
			const deps = createDeps({ fileExists: () => false });

			assert.strictEqual(readRebaseHeadName({ ...deps, gitDir }), undefined);
		});

		test('falls back to the other head-name location when the first read hits ENOENT', () => {
			const gitDir = '/repo/.git';
			const mergePath = path.join(gitDir, 'rebase-merge', 'head-name');
			const applyPath = path.join(gitDir, 'rebase-apply', 'head-name');
			const deps = createDeps({
				fileExists: (p) => p === mergePath || p === applyPath,
				readFileUtf8: (p) => {
					if (p === mergePath) {
						throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
					}
					return 'refs/heads/from-apply\n';
				},
			});

			assert.strictEqual(readRebaseHeadName({ ...deps, gitDir }), 'from-apply');
		});

		test('returns undefined when head-name is empty or whitespace-only', () => {
			const gitDir = '/repo/.git';
			const headPath = path.join(gitDir, 'rebase-merge', 'head-name');
			const deps = createDeps({
				fileExists: (p) => p === headPath,
				readFileUtf8: () => '   \n',
			});

			assert.strictEqual(readRebaseHeadName({ ...deps, gitDir }), undefined);
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

			assert.strictEqual(readRebaseHeadName({ ...deps, gitDir }), 'feature/xyz');
		});

		test('returns content as-is when not refs/heads/ prefix', () => {
			const gitDir = '/repo/.git';
			const headPath = path.join(gitDir, 'rebase-merge', 'head-name');
			const deps = createDeps({
				fileExists: (p) => p === headPath,
				readFileUtf8: (p) => (p === headPath ? 'origin/main' : ''),
			});

			assert.strictEqual(readRebaseHeadName({ ...deps, gitDir }), 'origin/main');
		});

		test('trims whitespace from head-name content', () => {
			const gitDir = '/repo/.git';
			const headPath = path.join(gitDir, 'rebase-merge', 'head-name');
			const deps = createDeps({
				fileExists: (p) => p === headPath,
				readFileUtf8: (p) => (p === headPath ? '  refs/heads/develop  ' : ''),
			});

			assert.strictEqual(readRebaseHeadName({ ...deps, gitDir }), 'develop');
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

			assert.strictEqual(readRebaseHeadName({ ...deps, gitDir }), 'from-merge');
		});
	});
});
