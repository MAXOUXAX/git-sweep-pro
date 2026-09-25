import * as assert from 'assert';
import { createBranchDeleter } from '../../core/branch-deletion';
import {
	createDeletionLog,
	createDeletionRecorder,
	DELETION_LOG_KEY,
	formatAge,
	latestDeletions,
	MAX_DELETION_LOG_ENTRIES,
	type DeletedBranch,
	type DeletionLog,
} from '../../core/deletion-log';
import { runRestoreWorkflow, type RestoreDeps } from '../../core/restore-workflow';
import type { StateStore } from '../../core/state-store';
import { DEFAULT_SWEEP_SETTINGS } from '../../core/sweep-logic';
import type { SelectableBranch } from '../../core/sweep-selection';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const entry = (branch: string, sha: string, deletedAt: string, extra: Partial<DeletedBranch> = {}): DeletedBranch => ({
	branch,
	sha,
	deletedAt,
	source: 'sweep',
	...extra,
});

function createMemoryStore(initial: Record<string, unknown> = {}): StateStore & { state: Record<string, unknown> } {
	const store = {
		state: { ...initial },
		get: <T>(key: string) => store.state[key] as T | undefined,
		update: async (key: string, value: unknown) => {
			store.state[key] = value;
		},
	};
	return store;
}

const logWith = (entries: DeletedBranch[]) => {
	const store = createMemoryStore({ [DELETION_LOG_KEY]: entries });
	return { store, log: createDeletionLog(store) };
};

function createHarness(options: { log: DeletionLog; git?: Record<string, { stdout?: string } | Error>; picked?: readonly string[] }) {
	const infos: string[] = [];
	const errors: string[] = [];
	const lines: string[] = [];
	const commands: string[] = [];
	const pickRequests: Array<{ items: SelectableBranch[]; title: string }> = [];
	const deps: RestoreDeps = {
		getWorkspaceRoot: () => '/repo',
		getSettings: () => DEFAULT_SWEEP_SETTINGS,
		output: { show: () => undefined, appendLine: (line) => lines.push(line), header: () => undefined },
		runGitCommand: async (args) => {
			const key = args.join(' ');
			commands.push(key);
			const result = options.git?.[key];
			if (result instanceof Error) {
				throw result;
			}
			return { stdout: result?.stdout ?? '', stderr: '' };
		},
		ui: {
			withProgress: (_o, task) => task(),
			showQuickPick: async () => undefined,
			pickBranches: async ({ items, title }) => {
				pickRequests.push({ items: [...items], title });
				return options.picked;
			},
			showInformationMessage: (m) => infos.push(m),
			showErrorMessage: (m) => errors.push(m),
			confirm: async () => true,
		},
		deletionLog: options.log,
		now: () => new Date('2026-01-01T02:00:00.000Z'),
	};
	return { deps, infos, errors, lines, commands, pickRequests };
}

const LOCAL_BRANCHES_CMD = 'for-each-ref --format=%(refname) refs/heads';

suite('deletion log', () => {
	test('records newest first, caps its size and forgets one entry', async () => {
		let tick = 0;
		const store = createMemoryStore();
		const log = createDeletionLog(store, () => new Date(Date.UTC(2026, 0, 1, 0, tick++)));
		assert.deepStrictEqual(log.list(), []);

		for (let i = 0; i <= MAX_DELETION_LOG_ENTRIES; i++) {
			await log.record({ branch: `b${i}`, sha: SHA_A, source: 'sweep' });
		}
		const entries = log.list();
		assert.strictEqual(entries.length, MAX_DELETION_LOG_ENTRIES);
		assert.strictEqual(entries[0].branch, `b${MAX_DELETION_LOG_ENTRIES}`);

		await log.forget(entries[0]);
		assert.strictEqual(log.list()[0].branch, `b${MAX_DELETION_LOG_ENTRIES - 1}`);
	});

	test('ignores malformed entries and a value that is not a list', () => {
		const valid = entry('ok', SHA_A, '2026-01-01T00:00:00Z');
		const { log } = logWith([
			valid,
			entry('-D', SHA_A, '2026-01-01T00:00:00Z'),
			entry('short-sha', 'abc1234', '2026-01-01T00:00:00Z'),
			entry('bad-date', SHA_A, 'yesterday'),
			{ ...valid, source: 'other' } as unknown as DeletedBranch,
			null as unknown as DeletedBranch,
		]);
		assert.deepStrictEqual(log.list(), [valid]);
		assert.deepStrictEqual(createDeletionLog(createMemoryStore({ [DELETION_LOG_KEY]: { not: 'a list' } })).list(), []);
	});

	test('the recorder is best effort', async () => {
		const warnings: string[] = [];
		const failing: DeletionLog = {
			list: () => [],
			record: async () => {
				throw new Error('EACCES: permission denied');
			},
			forget: async () => undefined,
		};
		const recorded = await createDeletionRecorder(failing, 'sweep', (line) => warnings.push(line))({ branch: 'x', sha: SHA_A });
		assert.strictEqual(recorded, false);
		assert.deepStrictEqual(warnings, [
			'[warning] Could not record the deletion of x, so it cannot be restored: EACCES: permission denied',
		]);
	});

	test('the branch deleter reads the tip right before deleting and reports the removed worktree', async () => {
		const commands: string[] = [];
		const deletions: unknown[] = [];
		const deleteBranch = createBranchDeleter({
			runGit: async (args) => {
				commands.push(args.join(' '));
				return { stdout: args[0] === 'rev-parse' ? `${SHA_B}\n` : args[0] === 'branch' && args[1] === '--format=%(refname:short)' ? 'wt\n' : '' };
			},
			log: () => undefined,
			worktrees: new Map([['wt', '/repo-wt']]),
			onDeleted: async (deletion) => deletions.push(deletion),
		});

		assert.strictEqual(await deleteBranch('wt', '-d'), 'deleted');
		assert.strictEqual(await deleteBranch('plain', '-D'), 'deleted');
		assert.deepStrictEqual(commands.slice(1), [
			'worktree remove /repo-wt',
			'rev-parse --verify --quiet refs/heads/wt^{commit}',
			'branch -d wt',
			'rev-parse --verify --quiet refs/heads/plain^{commit}',
			'branch -D plain',
		]);
		assert.deepStrictEqual(deletions, [
			{ branch: 'wt', sha: SHA_B, worktree: '/repo-wt' },
			{ branch: 'plain', sha: SHA_B },
		]);
	});

	test('latestDeletions keeps the newest entry per branch', () => {
		const newer = entry('x', SHA_B, '2026-01-02T00:00:00Z');
		const older = entry('x', SHA_A, '2026-01-01T00:00:00Z');
		const other = entry('y', SHA_A, '2026-01-01T00:00:00Z');
		assert.deepStrictEqual(latestDeletions([newer, other, older]), [newer, other]);
	});

	test('formatAge picks a compact unit', () => {
		const now = new Date('2026-01-10T00:00:00Z');
		assert.strictEqual(formatAge('2026-01-09T23:59:50Z', now), 'just now');
		assert.strictEqual(formatAge('2026-01-09T23:55:00Z', now), '5 min ago');
		assert.strictEqual(formatAge('2026-01-09T21:00:00Z', now), '3 h ago');
		assert.strictEqual(formatAge('2026-01-07T00:00:00Z', now), '3 d ago');
		assert.strictEqual(formatAge('2026-01-11T00:00:00Z', now), 'just now', 'clock skew never goes negative');
	});
});

suite('restore workflow', () => {
	test('reports when there is nothing to restore', async () => {
		const h = createHarness({ log: logWith([]).log });
		assert.strictEqual(await runRestoreWorkflow(h.deps, []), 'ok');
		assert.deepStrictEqual(h.infos, ['No deleted branches to restore.']);
		assert.strictEqual(h.pickRequests.length, 0);
	});

	test('offers restorable deletions (unselected) and restores the picked ones', async () => {
		const { store, log } = logWith([
			entry('feature/a', SHA_A, '2026-01-01T00:00:00.000Z'),
			entry('feature/b', SHA_B, '2026-01-01T01:00:00.000Z', { source: 'post-pr' }),
			entry('back', SHA_B, '2026-01-01T01:00:00.000Z'),
		]);
		const h = createHarness({ log, picked: ['feature/a'], git: { [LOCAL_BRANCHES_CMD]: { stdout: 'refs/heads/main\nrefs/heads/back\n' } } });

		assert.strictEqual(await runRestoreWorkflow(h.deps, []), 'ok');

		assert.deepStrictEqual(h.pickRequests, [
			{
				title: 'Select branches to restore',
				items: [
					{ label: 'feature/a', picked: false, description: 'aaaaaaa · deleted 2 h ago by sweep' },
					{ label: 'feature/b', picked: false, description: 'bbbbbbb · deleted 1 h ago by post-pr' },
				],
			},
		]);
		assert.ok(h.commands.includes(`branch feature/a ${SHA_A}`));
		assert.ok(!h.commands.some((c) => c.startsWith('branch feature/b')));
		assert.deepStrictEqual(
			(store.state[DELETION_LOG_KEY] as DeletedBranch[]).map((e) => e.branch),
			['feature/b', 'back'],
			'restored entries leave the log'
		);
		assert.deepStrictEqual(h.infos, ['Restored 1 branch(es): feature/a.']);
	});

	test('a dismissed or empty pick restores nothing', async () => {
		const h = createHarness({ log: logWith([entry('feature/a', SHA_A, '2026-01-01T00:00:00Z')]).log, picked: [] });
		assert.strictEqual(await runRestoreWorkflow(h.deps, []), 'cancelled');
		assert.deepStrictEqual(h.infos, ['No branches selected.']);
		assert.ok(!h.commands.some((c) => c.startsWith('branch ')));
	});

	test('restores branches named on the command line and rejects unknown names', async () => {
		const { log } = logWith([entry('feature/a', SHA_A, '2026-01-01T00:00:00Z')]);
		const unknown = createHarness({ log });
		assert.strictEqual(await runRestoreWorkflow(unknown.deps, ['feature/a', 'nope']), 'failed');
		assert.deepStrictEqual(unknown.errors, ['No recorded deletion for: nope.']);
		assert.ok(!unknown.commands.some((c) => c.startsWith('branch ')));

		const h = createHarness({ log });
		assert.strictEqual(await runRestoreWorkflow(h.deps, ['feature/a', 'feature/a']), 'ok');
		assert.strictEqual(h.pickRequests.length, 0);
		assert.deepStrictEqual(
			h.commands.filter((c) => c.startsWith('branch ')),
			[`branch feature/a ${SHA_A}`]
		);
	});

	test('never overwrites a branch that exists again, and reports collected commits', async () => {
		const { store, log } = logWith([entry('back', SHA_A, '2026-01-01T00:00:00Z'), entry('gone', SHA_B, '2026-01-01T00:00:00Z')]);
		const h = createHarness({
			log,
			git: {
				[LOCAL_BRANCHES_CMD]: { stdout: 'refs/heads/back\n' },
				[`cat-file -e ${SHA_B}^{commit}`]: new Error('fatal: Not a valid object name'),
			},
		});

		assert.strictEqual(await runRestoreWorkflow(h.deps, ['back', 'gone']), 'failed');

		assert.ok(!h.commands.some((c) => c.startsWith('branch ')));
		assert.deepStrictEqual(h.errors, [
			'Restored 0 of 2 branch(es). Could not restore back (a branch with this name already exists); gone (Git has garbage-collected its commit bbbbbbb).',
		]);
		assert.strictEqual((store.state[DELETION_LOG_KEY] as DeletedBranch[]).length, 2, 'failed restores stay in the log');
	});

	test('explains how to recreate a removed worktree', async () => {
		const { log } = logWith([entry('wt', SHA_A, '2026-01-01T00:00:00Z', { worktree: '/tmp/my wt' })]);
		const h = createHarness({ log });
		assert.strictEqual(await runRestoreWorkflow(h.deps, ['wt']), 'ok');
		assert.deepStrictEqual(h.lines, [
			'Restored wt at aaaaaaa.',
			"Its worktree was removed. To recreate it, run: git worktree add '/tmp/my wt' wt",
		]);
	});
});
