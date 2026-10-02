import * as assert from 'assert';
import { createBranchDeleter } from '../../core/branch-deletion';
import {
	canRecordDeletions,
	createDeletionLog,
	createDeletionRecorder,
	DELETION_LOG_KEY,
	formatAge,
	latestDeletions,
	MAX_DELETION_LOG_ENTRIES,
	type DeletedBranch,
	type DeletionLog,
} from '../../core/deletion-log';
import { runRestoreWorkflow } from '../../core/restore-workflow';
import type { StateStore } from '../../core/state-store';
import { createFakeContext, createMemoryStore, type GitEntry } from '../fake-context';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const entry = (branch: string, sha: string, deletedAt: string, extra: Partial<DeletedBranch> = {}): DeletedBranch => ({
	branch,
	sha,
	deletedAt,
	source: 'sweep',
	...extra,
});

const logWith = (entries: DeletedBranch[]) => {
	const store = createMemoryStore({ [DELETION_LOG_KEY]: entries });
	return { store, log: createDeletionLog(store) };
};

function createHarness(options: { log: DeletionLog; git?: Record<string, GitEntry>; picked?: readonly string[] }) {
	const fake = createFakeContext({
		git: options.git,
		// By default, every recorded commit still exists.
		gitFallback: (args) => ({ stdout: args[0] === 'rev-list' ? args.slice(3).join('\n') : '' }),
		pickBranches: () => options.picked,
		deletionLog: options.log,
	});
	const restore = (requested: readonly string[]) => runRestoreWorkflow(fake.context, requested, new Date('2026-01-01T02:00:00.000Z'));
	return {
		...fake,
		restore,
		infos: fake.infoMessages,
		errors: fake.errorMessages,
		pickRequests: fake.pickBranchesRequests,
		lines: fake.appendedLines,
	};
}

const LOCAL_BRANCHES_CMD = 'for-each-ref --format=%(refname) refs/heads refs/remotes';

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

		await log.forget(entries[0].branch);
		assert.strictEqual(log.list()[0].branch, `b${MAX_DELETION_LOG_ENTRIES - 1}`);
	});

	test('forgetting a branch drops all its deletions', async () => {
		const { store, log } = logWith([
			entry('x', SHA_B, '2026-01-02T00:00:00Z'),
			entry('y', SHA_A, '2026-01-01T12:00:00Z'),
			entry('x', SHA_A, '2026-01-01T00:00:00Z'),
		]);
		await log.forget('x');
		assert.deepStrictEqual(log.list().map((e) => e.branch), ['y']);
		await log.forget('y');
		assert.strictEqual(store.state[DELETION_LOG_KEY], undefined, 'an empty log removes its key');
	});

	test('ignores malformed entries, drops them on the next write, and survives a value that is not a list', async () => {
		const valid = entry('ok', SHA_A, '2026-01-01T00:00:00Z');
		const { store, log } = logWith([
			valid,
			entry('-D', SHA_A, '2026-01-01T00:00:00Z'),
			entry('short-sha', 'abc1234', '2026-01-01T00:00:00Z'),
			entry('bad-date', SHA_A, 'yesterday'),
			{ ...valid, source: 'other' } as unknown as DeletedBranch,
			null as unknown as DeletedBranch,
		]);
		assert.deepStrictEqual(log.list(), [valid]);
		await log.forget('other');
		assert.deepStrictEqual(store.state[DELETION_LOG_KEY], [valid]);
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
		const recorder = createDeletionRecorder(failing, 'sweep', (line) => warnings.push(line));
		await recorder.record({ branch: 'x', sha: SHA_A });
		assert.deepStrictEqual(recorder.recorded, []);
		assert.deepStrictEqual(warnings, [
			'[warning] Could not record the deletion of x, so it cannot be restored: EACCES: permission denied',
		]);
	});

	test('the branch deleter reads the branch right before deleting it and reports the removed worktree', async () => {
		const commands: string[] = [];
		const deletions: unknown[] = [];
		const answers: Record<string, string> = {
			'branch --format=%(refname:short) --merged HEAD --list wt': 'wt\n',
			// A pattern also lists the refs below it.
			'for-each-ref --format=%(refname)%09%(objectname)%09%(upstream) refs/heads/wt': `refs/heads/wt\t${SHA_B}\trefs/remotes/origin/wt\n`,
			'for-each-ref --format=%(refname)%09%(objectname)%09%(upstream) refs/heads/plain': `refs/heads/plain\t${SHA_A}\t\nrefs/heads/plain/sub\t${SHA_B}\t\n`,
		};
		const deleteBranch = createBranchDeleter({
			git: async (args) => {
				commands.push(args.join(' '));
				return { stdout: answers[args.join(' ')] ?? '', stderr: '' };
			},
			log: () => undefined,
			worktrees: new Map([['wt', '/repo-wt']]),
			onDeleted: async (deletion) => deletions.push(deletion),
		});

		assert.strictEqual(await deleteBranch('wt', '-d'), 'deleted');
		assert.strictEqual(await deleteBranch('plain', '-D'), 'deleted');
		assert.deepStrictEqual(commands.slice(1), [
			'worktree remove /repo-wt',
			'for-each-ref --format=%(refname)%09%(objectname)%09%(upstream) refs/heads/wt',
			'branch -d wt',
			'for-each-ref --format=%(refname)%09%(objectname)%09%(upstream) refs/heads/plain',
			'branch -D plain',
		]);
		assert.deepStrictEqual(deletions, [
			{ branch: 'wt', sha: SHA_B, upstream: 'refs/remotes/origin/wt', worktree: '/repo-wt' },
			{ branch: 'plain', sha: SHA_A },
		]);
	});

	test('deletions can be recorded only when the log can be read', () => {
		assert.strictEqual(canRecordDeletions(logWith([]).log), true);
		const corrupt: StateStore = {
			get: () => {
				throw new SyntaxError('Unexpected end of JSON input');
			},
			update: async () => undefined,
		};
		assert.strictEqual(canRecordDeletions(createDeletionLog(corrupt)), false);
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
		assert.strictEqual(await h.restore([]), 'ok');
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

		assert.strictEqual(await h.restore([]), 'ok');

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

	test('does not offer deletions whose commit Git garbage-collected', async () => {
		const { log } = logWith([entry('gone', SHA_B, '2026-01-01T00:00:00Z')]);
		const h = createHarness({ log, git: { [`rev-list --no-walk --ignore-missing ${SHA_B}`]: { stdout: '' } } });
		assert.strictEqual(await h.restore([]), 'ok');
		assert.strictEqual(h.pickRequests.length, 0);
		assert.deepStrictEqual(h.infos, ['No deleted branches to restore.']);
	});

	test('a dismissed or empty pick restores nothing', async () => {
		const h = createHarness({ log: logWith([entry('feature/a', SHA_A, '2026-01-01T00:00:00Z')]).log, picked: [] });
		assert.strictEqual(await h.restore([]), 'cancelled');
		assert.deepStrictEqual(h.infos, ['No branches selected.']);
		assert.ok(!h.commands.some((c) => c.startsWith('branch ')));
	});

	test('restores branches named on the command line and rejects unknown names', async () => {
		const { log } = logWith([entry('feature/a', SHA_A, '2026-01-01T00:00:00Z')]);
		const unknown = createHarness({ log });
		assert.strictEqual(await unknown.restore(['feature/a', 'nope']), 'failed');
		assert.deepStrictEqual(unknown.errors, ['No recorded deletion for: nope.']);
		assert.ok(!unknown.commands.some((c) => c.startsWith('branch ')));

		const h = createHarness({ log });
		assert.strictEqual(await h.restore(['feature/a', 'feature/a']), 'ok');
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
				[`rev-list --no-walk --ignore-missing ${SHA_A} ${SHA_B}`]: { stdout: `${SHA_A}\n` },
			},
		});

		assert.strictEqual(await h.restore(['back', 'gone']), 'failed');

		assert.ok(!h.commands.some((c) => c.startsWith('branch ')));
		assert.deepStrictEqual(h.errors, [
			'Restored 0 of 2 branch(es). Could not restore back (a branch with this name already exists); gone (Git has garbage-collected its commit bbbbbbb).',
		]);
		assert.strictEqual((store.state[DELETION_LOG_KEY] as DeletedBranch[]).length, 2, 'failed restores stay in the log');
	});

	test('tracks the recorded upstream again only while it exists', async () => {
		const { log } = logWith([
			entry('live', SHA_A, '2026-01-01T00:00:00Z', { upstream: 'refs/remotes/origin/live' }),
			entry('merged', SHA_B, '2026-01-01T00:00:00Z', { upstream: 'refs/remotes/origin/merged' }),
		]);
		const h = createHarness({ log, git: { [LOCAL_BRANCHES_CMD]: { stdout: 'refs/heads/main\nrefs/remotes/origin/live\n' } } });
		assert.strictEqual(await h.restore(['live', 'merged']), 'ok');
		assert.deepStrictEqual(
			h.commands.filter((c) => c.startsWith('branch ')),
			[`branch live ${SHA_A}`, 'branch --set-upstream-to=refs/remotes/origin/live live', `branch merged ${SHA_B}`]
		);
		assert.deepStrictEqual(h.lines, ['Restored live at aaaaaaa.', 'It tracks origin/live again.', 'Restored merged at bbbbbbb.']);
	});

	test('explains how to recreate a removed worktree', async () => {
		const { log } = logWith([entry('wt', SHA_A, '2026-01-01T00:00:00Z', { worktree: '/tmp/my wt' })]);
		const h = createHarness({ log });
		assert.strictEqual(await h.restore(['wt']), 'ok');
		assert.deepStrictEqual(h.lines, [
			'Restored wt at aaaaaaa.',
			"Its worktree was removed. To recreate it, run: git worktree add '/tmp/my wt' wt",
		]);
	});
});
