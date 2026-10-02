import * as assert from 'assert';
import { NOT_A_REPOSITORY } from '../../core/errors';
import { findStaleBranches } from '../../core/stale-branches';
import type { SweepSettings } from '../../core/sweep-logic';
import { runSweepWorkflow } from '../../core/sweep-workflow';
import { createFakeContext, type GitEntry } from '../fake-context';

const GONE_REFS_CMD = 'for-each-ref --format=%(refname:short)%09%(upstream:track)%09%(HEAD)%09%(worktreepath) refs/heads';

type HarnessOptions = {
	workspaceRoot?: string;
	/** Branches the multi-select picker returns; `undefined` dismisses it. */
	quickPickSelection?: readonly { label: string }[] | undefined;
	git?: Record<string, GitEntry>;
	settings?: Partial<SweepSettings>;
	confirmResult?: boolean;
};

function createHarness(options: HarnessOptions = {}) {
	const fake = createFakeContext({
		root: options.workspaceRoot,
		settings: options.settings,
		git: options.git,
		confirm: options.confirmResult,
		pickMany: () => options.quickPickSelection?.map((item) => item.label),
	});
	return { ...fake, quickPickRequests: fake.pickManyRequests };
}

suite('sweep workflow', () => {
	test('reports no stale branches and stops', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			git: {
				'fetch -p': { stdout: '' },
				[GONE_REFS_CMD]: { stdout: 'main\t' },
			},
		});

		assert.strictEqual(await runSweepWorkflow(h.context, 'safeDelete'), 'ok');

		assert.deepStrictEqual(h.infoMessages, ['No stale branches found.']);
		assert.deepStrictEqual(h.commands, ['fetch -p', 'worktree prune', GONE_REFS_CMD]);
		assert.ok(h.outputLines.includes('No stale branches found.'));
		assert.strictEqual(h.quickPickRequests.length, 0);
		assert.strictEqual(h.progressTitles[0], 'Fetching and pruning remote references');
		assert.strictEqual(h.outputLines.at(-1), '--- Git Sweep session ended ---');
	});

	test('handles quick-pick cancellation', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: undefined,
			git: {
				'fetch -p': { stdout: '' },
				[GONE_REFS_CMD]: { stdout: 'stale/one\t[gone]' },
			},
		});

		assert.strictEqual(await runSweepWorkflow(h.context, 'safeDelete'), 'cancelled');

		assert.deepStrictEqual(h.infoMessages, ['No branches selected.']);
		assert.ok(h.outputLines.includes('Operation cancelled or no branches selected.'));
		assert.strictEqual(h.quickPickRequests.length, 1);
	});

	test('handles empty quick-pick selection', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: [],
			git: {
				'fetch -p': { stdout: '' },
				[GONE_REFS_CMD]: { stdout: 'stale/one\t[gone]' },
			},
		});

		await runSweepWorkflow(h.context, 'safeDelete');

		assert.deepStrictEqual(h.infoMessages, ['No branches selected.']);
	});

	test('dry-run mode reports selection and avoids delete commands', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: [{ label: 'stale/one' }, { label: 'stale/two' }],
			git: {
				'fetch -p': { stdout: '' },
				[GONE_REFS_CMD]: {
					stdout: ['stale/one\t[gone]', 'stale/two\t[gone]'].join('\n'),
				},
			},
		});

		assert.strictEqual(await runSweepWorkflow(h.context, 'dryRun'), 'ok');

		assert.deepStrictEqual(h.infoMessages, ['2 branch(es) would be deleted.']);
		assert.deepStrictEqual(h.noticeOptions, [{ dryRun: true }]);
		assert.deepStrictEqual(h.commands, ['fetch -p', 'worktree prune', GONE_REFS_CMD]);
		assert.ok(h.outputLines.includes('[DRY RUN] Selected branches:'));
		assert.ok(h.outputLines.includes('- stale/one'));
		assert.ok(h.outputLines.includes('- stale/two'));
		assert.strictEqual(h.quickPickRequests[0]?.title, 'Select branches to include in dry run');
	});

	test('safe delete deletes all selected branches successfully', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: [{ label: 'stale/one' }, { label: 'stale/two' }],
			git: {
				'fetch -p': { stdout: '' },
				[GONE_REFS_CMD]: {
					stdout: ['stale/one\t[gone]', 'stale/two\t[gone]'].join('\n'),
				},
				'branch -d stale/one': { stdout: '' },
				'branch -d stale/two': { stdout: '' },
			},
		});

		assert.strictEqual(await runSweepWorkflow(h.context, 'safeDelete'), 'ok');

		assert.deepStrictEqual(h.infoMessages, ['Deleted 2 branch(es); 0 skipped, 0 failed.']);
		assert.ok(h.commands.includes('branch -d stale/one'));
		assert.ok(h.commands.includes('branch -d stale/two'));
		assert.strictEqual(h.quickPickRequests[0]?.title, 'Select branches to delete');
	});

	test('force delete uses -D and reports partial failure', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: [{ label: 'stale/one' }, { label: 'stale/two' }],
			git: {
				'fetch -p': { stdout: '' },
				[GONE_REFS_CMD]: {
					stdout: ['stale/one\t[gone]', 'stale/two\t[gone]'].join('\n'),
				},
				'branch -D stale/one': { stdout: '' },
				'branch -D stale/two': new Error('not fully merged'),
			},
		});

		assert.strictEqual(await runSweepWorkflow(h.context, 'forceDelete'), 'failed');

		assert.deepStrictEqual(h.errorMessages, [
			'Deleted 1 branch(es); 0 skipped, 1 failed.',
		]);
		assert.ok(h.outputLines.some((line) => line.includes('[delete-failed] stale/two: not fully merged')));
	});

	test('offers force-delete for squash/rebase-merged branches that fail safe delete', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: [{ label: 'squashed/one' }, { label: 'clean/two' }],
			confirmResult: true,
			git: {
				'fetch -p': { stdout: '' },
				[GONE_REFS_CMD]: {
					stdout: ['squashed/one\t[gone]', 'clean/two\t[gone]'].join('\n'),
				},
				'branch -d squashed/one': new Error("error: the branch 'squashed/one' is not fully merged."),
				'branch -d clean/two': { stdout: '' },
				'branch -D squashed/one': { stdout: '' },
			},
		});

		await runSweepWorkflow(h.context, 'safeDelete');

		assert.ok(h.outputLines.some((line) => line.includes('[not-fully-merged] squashed/one')));
		assert.strictEqual(h.confirmRequests.length, 1);
		assert.match(h.confirmRequests[0].message, /usual after a squash or rebase merge/);
		assert.ok(h.commands.includes('branch -D squashed/one'));
		assert.deepStrictEqual(h.infoMessages, ['Deleted 2 branch(es); 0 skipped, 0 failed.']);
	});

	test('leaves not-fully-merged branches when force-delete is declined', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: [{ label: 'squashed/one' }],
			confirmResult: false,
			git: {
				'fetch -p': { stdout: '' },
				[GONE_REFS_CMD]: { stdout: 'squashed/one\t[gone]' },
				'branch -d squashed/one': new Error("error: the branch 'squashed/one' is not fully merged."),
			},
		});

		assert.strictEqual(await runSweepWorkflow(h.context, 'safeDelete'), 'ok');

		assert.strictEqual(h.confirmRequests.length, 1);
		assert.ok(!h.commands.includes('branch -D squashed/one'));
		assert.ok(h.outputLines.some((line) => line === 'Force-delete of not-fully-merged branches declined.'));
		assert.deepStrictEqual(h.infoMessages, ['Deleted 0 branch(es); 1 skipped, 0 failed.']);
		assert.deepStrictEqual(h.errorMessages, []);
	});

	test('does not offer force-delete escalation when already in force mode', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: [{ label: 'stale/one' }],
			git: {
				'fetch -p': { stdout: '' },
				[GONE_REFS_CMD]: { stdout: 'stale/one\t[gone]' },
				'branch -D stale/one': new Error("error: the branch 'stale/one' is not fully merged."),
			},
		});

		await runSweepWorkflow(h.context, 'forceDelete');

		assert.strictEqual(h.confirmRequests.length, 0);
		assert.ok(h.outputLines.some((line) => line.includes('[delete-failed] stale/one')));
	});

	test('maps not-a-repository errors to friendly message', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			git: {
				'fetch -p': new Error('fatal: not a git repository (or any of the parent directories): .git'),
			},
		});

		await runSweepWorkflow(h.context, 'safeDelete');

		assert.deepStrictEqual(h.errorMessages, [
			NOT_A_REPOSITORY,
		]);
		assert.strictEqual(h.outputLines.at(-1), '--- Git Sweep session ended ---');
	});

	test('maps command-not-found / ENOENT errors to friendly message', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			git: {
				'fetch -p': new Error('spawn git ENOENT'),
			},
		});

		await runSweepWorkflow(h.context, 'safeDelete');

		assert.deepStrictEqual(h.errorMessages, ['Git is not installed or not available in PATH.']);
	});

	test('maps unknown errors to generic failure message', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			git: {
				'fetch -p': new Error('mysterious failure'),
			},
		});

		assert.strictEqual(await runSweepWorkflow(h.context, 'safeDelete'), 'failed');

		assert.deepStrictEqual(h.errorMessages, ['mysterious failure']);
		assert.deepStrictEqual(h.noticeOptions, [{ failed: true }]);
	});

	test('pre-selects all stale branches in quick-pick', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: [{ label: 'stale/one' }],
			git: {
				'fetch -p': { stdout: '' },
				[GONE_REFS_CMD]: {
					stdout: ['stale/one\t[gone]', 'stale/two\t[gone]'].join('\n'),
				},
			},
		});

		await runSweepWorkflow(h.context, 'dryRun');

		const quickPick = h.quickPickRequests[0];
		assert.ok(quickPick);
		assert.deepStrictEqual(quickPick.items, [
			{ label: 'stale/one', picked: true },
			{ label: 'stale/two', picked: true },
		]);
	});

	test('skips protected branches and offers only the rest', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			settings: { protectedBranches: ['main', 'release/*'] },
			quickPickSelection: [{ label: 'stale/one' }],
			git: {
				'fetch -p': { stdout: '' },
				[GONE_REFS_CMD]: {
					stdout: ['stale/one\t[gone]', 'release/2.0\t[gone]', 'main\t[gone]'].join('\n'),
				},
				'branch -d stale/one': { stdout: '' },
			},
		});

		await runSweepWorkflow(h.context, 'safeDelete');

		const quickPick = h.quickPickRequests[0];
		assert.deepStrictEqual(quickPick?.items, [{ label: 'stale/one', picked: true }]);
		assert.ok(h.outputLines.some((line) => line.includes('Protected branches skipped')));
		assert.ok(h.outputLines.some((line) => line === '- release/2.0'));
		assert.ok(h.outputLines.some((line) => line === '- main'));
		assert.deepStrictEqual(h.infoMessages, ['Deleted 1 branch(es); 0 skipped, 0 failed.']);
	});

	test('reports when all stale branches are protected', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			settings: { protectedBranches: ['*'] },
			git: {
				'fetch -p': { stdout: '' },
				[GONE_REFS_CMD]: {
					stdout: ['stale/one\t[gone]', 'stale/two\t[gone]'].join('\n'),
				},
			},
		});

		assert.strictEqual(await runSweepWorkflow(h.context, 'safeDelete'), 'ok');

		assert.deepStrictEqual(h.infoMessages, ['All 2 stale branch(es) are protected.']);
		assert.strictEqual(h.quickPickRequests.length, 0);
	});

	test('skips fetch/prune when autoFetchPrune is disabled', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			settings: { autoFetchPrune: false },
			git: {
				[GONE_REFS_CMD]: { stdout: 'stale/one\t[gone]' },
			},
		});

		await runSweepWorkflow(h.context, 'dryRun');

		assert.ok(!h.commands.includes('fetch -p'));
		assert.strictEqual(h.commands[0], GONE_REFS_CMD);
		assert.ok(h.outputLines.some((line) => line.includes('Auto fetch/prune disabled')));
	});

	test('asks for confirmation before deleting when confirmBeforeDelete is enabled', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			settings: { confirmBeforeDelete: true },
			confirmResult: true,
			quickPickSelection: [{ label: 'stale/one' }],
			git: {
				'fetch -p': { stdout: '' },
				[GONE_REFS_CMD]: { stdout: 'stale/one\t[gone]' },
				'branch -d stale/one': { stdout: '' },
			},
		});

		await runSweepWorkflow(h.context, 'safeDelete');

		assert.strictEqual(h.confirmRequests.length, 1);
		assert.ok(h.confirmRequests[0].message.includes('git branch -d'));
		assert.deepStrictEqual(h.infoMessages, ['Deleted 1 branch(es); 0 skipped, 0 failed.']);
	});

	test('aborts deletion when confirmation is declined', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			settings: { confirmBeforeDelete: true },
			confirmResult: false,
			quickPickSelection: [{ label: 'stale/one' }],
			git: {
				'fetch -p': { stdout: '' },
				[GONE_REFS_CMD]: { stdout: 'stale/one\t[gone]' },
				'branch -d stale/one': { stdout: '' },
			},
		});

		assert.strictEqual(await runSweepWorkflow(h.context, 'safeDelete'), 'cancelled');

		assert.strictEqual(h.confirmRequests.length, 1);
		assert.ok(!h.commands.includes('branch -d stale/one'));
		assert.deepStrictEqual(h.infoMessages, ['Deletion cancelled.']);
	});

	test('does not confirm on dry run even when confirmBeforeDelete is enabled', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			settings: { confirmBeforeDelete: true },
			quickPickSelection: [{ label: 'stale/one' }],
			git: {
				'fetch -p': { stdout: '' },
				[GONE_REFS_CMD]: { stdout: 'stale/one\t[gone]' },
			},
		});

		await runSweepWorkflow(h.context, 'dryRun');

		assert.strictEqual(h.confirmRequests.length, 0);
		assert.deepStrictEqual(h.infoMessages, ['1 branch(es) would be deleted.']);
	});

	test('writes a summary preview (detected, selected, mode) before deleting', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: [{ label: 'stale/one' }, { label: 'stale/two' }],
			git: {
				'fetch -p': { stdout: '' },
				[GONE_REFS_CMD]: {
					stdout: ['stale/one\t[gone]', 'stale/two\t[gone]'].join('\n'),
				},
				'branch -d stale/one': { stdout: '' },
				'branch -d stale/two': { stdout: '' },
			},
		});

		await runSweepWorkflow(h.context, 'safeDelete');

		assert.ok(h.outputLines.includes('Summary:'));
		assert.ok(h.outputLines.includes('  Detected: 2 stale branch(es)'));
		assert.ok(h.outputLines.includes('  Selected: 2'));
		assert.ok(h.outputLines.includes('  Mode: safe delete (-d)'));
	});

	test('summary and confirmation reflect a partial selection from the picker', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			settings: { confirmBeforeDelete: true, protectedBranches: ['main'] },
			confirmResult: true,
			// The picker returns only one of the two candidate branches.
			quickPickSelection: [{ label: 'stale/one' }],
			git: {
				'fetch -p': { stdout: '' },
				[GONE_REFS_CMD]: {
					stdout: ['stale/one\t[gone]', 'stale/two\t[gone]', 'main\t[gone]'].join('\n'),
				},
				'branch -d stale/one': { stdout: '' },
			},
		});

		await runSweepWorkflow(h.context, 'safeDelete');

		assert.ok(h.outputLines.includes('  Detected: 3 stale branch(es)'));
		assert.ok(h.outputLines.includes('  Protected (skipped): 1'));
		assert.ok(h.outputLines.includes('  Selected: 1'));
		assert.ok(h.confirmRequests[0].message.includes('Detected: 3 stale branch(es)'));
		assert.ok(h.confirmRequests[0].message.includes('Selected: 1'));
		assert.ok(!h.commands.includes('branch -d stale/two'));
		assert.deepStrictEqual(h.infoMessages, ['Deleted 1 branch(es); 0 skipped, 0 failed.']);
	});

	test('treats picker dismissal (undefined) as no selection', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: undefined,
			git: {
				'fetch -p': { stdout: '' },
				[GONE_REFS_CMD]: { stdout: 'stale/one\t[gone]' },
			},
		});

		await runSweepWorkflow(h.context, 'safeDelete');

		assert.deepStrictEqual(h.infoMessages, ['No branches selected.']);
		assert.ok(!h.commands.some((cmd) => cmd.startsWith('branch -d')));
	});

	test('findStaleBranches fetches, then splits gone branches by the protected patterns', async () => {
		const h = createHarness({
			settings: { protectedBranches: ['release/*'] },
			git: {
				[GONE_REFS_CMD]: { stdout: 'feature/a\t[gone]\nrelease/1\t[gone]\nmain\t' },
			},
		});

		assert.deepStrictEqual(await findStaleBranches(h.context), {
			stale: ['feature/a'],
			protected: ['release/1'],
			checkedOut: [],
			merged: [],
			mergedSkipped: false,
			worktrees: new Map(),
		});
		assert.deepStrictEqual(h.commands, ['fetch -p', 'worktree prune', GONE_REFS_CMD]);
		assert.strictEqual(h.progressTitles.length, 1);
	});

	suite('worktrees', () => {
		test('skips the stale branch checked out in the current worktree', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				quickPickSelection: [{ label: 'stale/other' }],
				git: {
					[GONE_REFS_CMD]: { stdout: ['feature/here\t[gone]\t*\t/repo', 'stale/other\t[gone]\t \t'].join('\n') },
				},
			});

			assert.strictEqual(await runSweepWorkflow(h.context, 'safeDelete'), 'ok');

			assert.deepStrictEqual(h.quickPickRequests[0].items.map((item) => item.label), ['stale/other']);
			assert.ok(h.outputLines.some((line) => line.startsWith('Skipped "feature/here": it is the current branch.')));
			assert.ok(!h.commands.includes('branch -d feature/here'));
			assert.ok(h.commands.includes('branch -d stale/other'));
		});

		test('skips a stale branch checked out in the main worktree', async () => {
			const h = createHarness({
				workspaceRoot: '/work/wt',
				settings: { protectedBranches: ['release/*'] },
				git: {
					[GONE_REFS_CMD]: {
						stdout: ['feature/main-wt\t[gone]\t \t/repo', 'release/1\t[gone]\t \t', 'feature/wt\t\t*\t/work/wt'].join('\n'),
					},
					'worktree list --porcelain': { stdout: 'worktree /repo\nHEAD abc\nbranch refs/heads/feature/main-wt\n\nworktree /work/wt\n' },
				},
			});

			assert.strictEqual(await runSweepWorkflow(h.context, 'safeDelete'), 'ok');

			assert.strictEqual(h.quickPickRequests.length, 0);
			assert.ok(!h.commands.some((cmd) => cmd.startsWith('worktree remove')));
			assert.deepStrictEqual(h.infoMessages, [
				'Skipped "feature/main-wt": it is checked out in the main worktree (/repo). Switch branches there to delete it. 1 other stale branch(es) are protected.',
			]);
		});

		test('explains when the only stale branch is the current one', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				git: { [GONE_REFS_CMD]: { stdout: 'feature/here\t[gone]\t*\t/repo' } },
			});

			assert.strictEqual(await runSweepWorkflow(h.context, 'safeDelete'), 'ok');

			assert.strictEqual(h.quickPickRequests.length, 0);
			assert.deepStrictEqual(h.infoMessages, [
				'Skipped "feature/here": it is the current branch. Switch to another branch to delete it.',
			]);
		});

		test('offers branches from other worktrees unselected and removes the worktree before deleting', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				settings: { confirmBeforeDelete: true },
				quickPickSelection: [{ label: 'feature/wt' }, { label: 'stale/plain' }],
				git: {
					[GONE_REFS_CMD]: {
						stdout: ['feature/wt\t[gone]\t \t/work/wt', 'stale/plain\t[gone]\t \t', 'main\t\t*\t/repo'].join('\n'),
					},
					'branch --format=%(refname:short) --merged HEAD --list feature/wt': { stdout: 'feature/wt\n' },
				},
			});

			await runSweepWorkflow(h.context, 'safeDelete');

			assert.deepStrictEqual(h.quickPickRequests[0].items, [
				{ label: 'feature/wt', picked: false, description: 'checked out in worktree /work/wt' },
				{ label: 'stale/plain', picked: true },
			]);
			assert.ok(h.confirmRequests[0].message.includes('Worktrees to remove: 1'));
			assert.ok(h.commands.includes('worktree list --porcelain'));
			assert.ok(h.outputLines.includes('- feature/wt (removes worktree /work/wt)'));
			const removeIndex = h.commands.indexOf('worktree remove /work/wt');
			assert.ok(removeIndex >= 0 && removeIndex < h.commands.indexOf('branch -d feature/wt'));
			assert.deepStrictEqual(h.infoMessages, ['Deleted 2 branch(es); 0 skipped, 0 failed.']);
		});

		test('keeps the worktree of a squash-merged branch until its force-delete is confirmed', async () => {
			const squashed = (confirmResult: boolean) =>
				createHarness({
					workspaceRoot: '/repo',
					confirmResult,
					quickPickSelection: [{ label: 'feature/wt' }],
					git: {
						[GONE_REFS_CMD]: { stdout: 'feature/wt\t[gone]\t \t/work/wt' },
						'worktree list --porcelain': { stdout: 'worktree /repo\n' },
						'branch --format=%(refname:short) --merged HEAD --list feature/wt': { stdout: '' },
					},
				});

			const declined = squashed(false);
			assert.strictEqual(await runSweepWorkflow(declined.context, 'safeDelete'), 'ok');
			const isDestructive = (cmd: string) => /^(worktree remove|branch -[dD] )/.test(cmd);
			assert.ok(!declined.commands.some(isDestructive));
			assert.deepStrictEqual(declined.infoMessages, ['Deleted 0 branch(es); 1 skipped, 0 failed.']);

			const confirmed = squashed(true);
			assert.strictEqual(await runSweepWorkflow(confirmed.context, 'safeDelete'), 'ok');
			const commands = confirmed.commands.filter(isDestructive);
			assert.deepStrictEqual(commands, ['worktree remove /work/wt', 'branch -D feature/wt']);
		});

		test('keeps the branch when its worktree cannot be removed', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				quickPickSelection: [{ label: 'feature/wt' }],
				git: {
					[GONE_REFS_CMD]: { stdout: 'feature/wt\t[gone]\t \t/work/wt' },
					'branch --format=%(refname:short) --merged HEAD --list feature/wt': { stdout: 'feature/wt\n' },
					'worktree remove /work/wt': new Error("fatal: '/work/wt' contains modified or untracked files, use --force to delete it"),
				},
			});

			assert.strictEqual(await runSweepWorkflow(h.context, 'safeDelete'), 'failed');

			assert.ok(!h.commands.includes('branch -d feature/wt'));
			assert.ok(h.outputLines.some((line) => line.startsWith('[worktree-not-removed] feature/wt')));
			assert.deepStrictEqual(h.errorMessages, ['Deleted 0 branch(es); 0 skipped, 1 failed.']);
			assert.deepStrictEqual(h.noticeOptions, [{ seeOutput: true }]);
			assert.strictEqual(h.confirmRequests.length, 0, 'no force-delete offer');
		});

		test('dry run lists the worktree that would be removed without touching it', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				quickPickSelection: [{ label: 'feature/wt' }],
				git: { [GONE_REFS_CMD]: { stdout: 'feature/wt\t[gone]\t \t/work/wt' } },
			});

			await runSweepWorkflow(h.context, 'dryRun');

			assert.ok(h.outputLines.includes('- feature/wt (removes worktree /work/wt)'));
			assert.ok(!h.commands.some((cmd) => cmd.startsWith('worktree remove')));
			assert.ok(!h.outputLines.includes('Not selected (worktree kept):'));
		});

		test('lists the worktree branches left unselected', async () => {
			const h = createHarness({
				workspaceRoot: '/repo',
				quickPickSelection: [],
				git: {
					[GONE_REFS_CMD]: { stdout: 'feature/wt\t[gone]\t \t/work/wt' },
					'worktree list --porcelain': { stdout: 'worktree /repo\n' },
				},
			});

			assert.strictEqual(await runSweepWorkflow(h.context, 'safeDelete'), 'cancelled');
			const index = h.outputLines.indexOf('Not selected (worktree kept):');
			assert.ok(index >= 0);
			assert.strictEqual(h.outputLines[index + 1], '- feature/wt (worktree /work/wt)');
		});
	});
});
