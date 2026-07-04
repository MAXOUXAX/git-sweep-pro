import * as assert from 'assert';
import {
	orderRepoCandidates,
	resolveTargetRepository,
	resolveWorkspaceRoot,
	type RepoFolder,
	type WorkspaceFolderLike,
} from '../../core/workspace';

suite('workspace resolver', () => {
	test('returns active editor workspace when available', () => {
		const editorUri = { scheme: 'file', path: '/repo/a.ts' };
		const expected = '/repo';
		const result = resolveWorkspaceRoot({
			activeEditor: { document: { uri: editorUri } },
			getWorkspaceFolder: (uri) => {
				assert.strictEqual(uri, editorUri);
				return { uri: { fsPath: expected } };
			},
			workspaceFolders: [{ uri: { fsPath: '/fallback' } }],
		});

		assert.strictEqual(result, expected);
	});

	test('falls back to first workspace folder when active editor has no folder', () => {
		const workspaceFolders: WorkspaceFolderLike[] = [
			{ uri: { fsPath: '/first' } },
			{ uri: { fsPath: '/second' } },
		];
		const result = resolveWorkspaceRoot({
			activeEditor: { document: { uri: { scheme: 'untitled' } } },
			getWorkspaceFolder: () => undefined,
			workspaceFolders,
		});

		assert.strictEqual(result, '/first');
	});

	test('returns first workspace folder when no active editor', () => {
		const result = resolveWorkspaceRoot({
			activeEditor: undefined,
			getWorkspaceFolder: () => undefined,
			workspaceFolders: [{ uri: { fsPath: '/repo' } }],
		});

		assert.strictEqual(result, '/repo');
	});

	test('returns undefined when no active editor and no workspace folders', () => {
		const result = resolveWorkspaceRoot({
			activeEditor: undefined,
			getWorkspaceFolder: () => undefined,
			workspaceFolders: undefined,
		});

		assert.strictEqual(result, undefined);
	});
});

suite('orderRepoCandidates', () => {
	const a: RepoFolder = { fsPath: '/a', name: 'a' };
	const b: RepoFolder = { fsPath: '/b', name: 'b' };
	const c: RepoFolder = { fsPath: '/c', name: 'c' };

	test('keeps original order when there is no last/active hint', () => {
		assert.deepStrictEqual(orderRepoCandidates([a, b, c], undefined, undefined), [a, b, c]);
	});

	test('surfaces the last selected repository first', () => {
		assert.deepStrictEqual(orderRepoCandidates([a, b, c], '/c', undefined), [c, a, b]);
	});

	test('surfaces the active repository first when no last selection', () => {
		assert.deepStrictEqual(orderRepoCandidates([a, b, c], undefined, '/b'), [b, a, c]);
	});

	test('prefers last selected over active repository', () => {
		assert.deepStrictEqual(orderRepoCandidates([a, b, c], '/c', '/b'), [c, b, a]);
	});

	test('does not mutate the input array', () => {
		const input = [a, b, c];
		orderRepoCandidates(input, '/c', undefined);
		assert.deepStrictEqual(input, [a, b, c]);
	});
});

suite('resolveTargetRepository', () => {
	const a: RepoFolder = { fsPath: '/a', name: 'a' };
	const b: RepoFolder = { fsPath: '/b', name: 'b' };

	function baseParams(overrides: Partial<Parameters<typeof resolveTargetRepository>[0]>) {
		const stored: { value: string | undefined } = { value: undefined };
		return {
			params: {
				folders: [],
				activeRepoRoot: undefined,
				isGitRepo: async () => true,
				getLastSelected: () => stored.value,
				setLastSelected: (fsPath: string) => {
					stored.value = fsPath;
				},
				promptForRepo: async () => undefined,
				...overrides,
			},
			stored,
		};
	}

	test('falls back to the active root when no folder is a git repo', async () => {
		const { params } = baseParams({
			folders: [a, b],
			activeRepoRoot: '/fallback',
			isGitRepo: async () => false,
		});

		const result = await resolveTargetRepository(params);
		assert.deepStrictEqual(result, { kind: 'resolved', fsPath: '/fallback' });
	});

	test('uses the only repository without prompting', async () => {
		let prompted = false;
		const { params, stored } = baseParams({
			folders: [a, b],
			isGitRepo: async (fsPath) => fsPath === '/b',
			promptForRepo: async () => {
				prompted = true;
				return undefined;
			},
		});

		const result = await resolveTargetRepository(params);
		assert.deepStrictEqual(result, { kind: 'resolved', fsPath: '/b' });
		assert.strictEqual(prompted, false);
		assert.strictEqual(stored.value, '/b');
	});

	test('prompts and persists the choice when multiple repositories exist', async () => {
		let offered: readonly RepoFolder[] = [];
		const { params, stored } = baseParams({
			folders: [a, b],
			getLastSelected: () => '/b',
			promptForRepo: async (candidates) => {
				offered = candidates;
				return candidates[0];
			},
		});

		const result = await resolveTargetRepository(params);
		assert.deepStrictEqual(result, { kind: 'resolved', fsPath: '/b' });
		assert.deepStrictEqual(offered, [b, a]);
		assert.strictEqual(stored.value, '/b');
	});

	test('returns cancelled when the picker is dismissed', async () => {
		const { params, stored } = baseParams({
			folders: [a, b],
			promptForRepo: async () => undefined,
		});

		const result = await resolveTargetRepository(params);
		assert.deepStrictEqual(result, { kind: 'cancelled' });
		assert.strictEqual(stored.value, undefined);
	});
});
