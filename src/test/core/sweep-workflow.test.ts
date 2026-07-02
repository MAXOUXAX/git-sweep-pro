import * as assert from 'assert';
import { runSweepWorkflow, type QuickPickItemLike, type SweepWorkflowDeps } from '../../core/sweep-workflow';
import type { SweepMode } from '../../core/sweep-logic';

type HarnessOptions = {
	workspaceRoot?: string;
	quickPickSelection?: readonly QuickPickItemLike[] | undefined;
	git?: Record<string, { stdout?: string; stderr?: string } | Error>;
};

type Harness = {
	deps: SweepWorkflowDeps;
	outputLines: string[];
	infoMessages: string[];
	errorMessages: string[];
	commands: string[];
	progressTitles: string[];
	quickPickRequests: Array<{ items: QuickPickItemLike[]; title: string }>;
};

function createHarness(options: HarnessOptions = {}): Harness {
	const outputLines: string[] = [];
	const infoMessages: string[] = [];
	const errorMessages: string[] = [];
	const commands: string[] = [];
	const progressTitles: string[] = [];
	const quickPickRequests: Array<{ items: QuickPickItemLike[]; title: string }> = [];

	const deps: SweepWorkflowDeps = {
		getWorkspaceRoot: () => options.workspaceRoot,
		output: {
			show: () => undefined,
			appendLine: (line) => outputLines.push(line),
		},
		runGitCommand: async (args) => {
			const key = args.join(' ');
			commands.push(key);
			const entry = options.git?.[key];
			if (entry instanceof Error) {
				throw entry;
			}
			return {
				stdout: entry?.stdout ?? '',
				stderr: entry?.stderr ?? '',
			};
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
			showInformationMessage: (message) => {
				infoMessages.push(message);
			},
			showErrorMessage: (message) => {
				errorMessages.push(message);
			},
		},
	};

	return { deps, outputLines, infoMessages, errorMessages, commands, progressTitles, quickPickRequests };
}

suite('sweep workflow', () => {
	const safeMode: SweepMode = { dryRun: false, forceDelete: false };
	const forceMode: SweepMode = { dryRun: false, forceDelete: true };
	const dryMode: SweepMode = { dryRun: true, forceDelete: false };

	test('fails fast when no workspace is open', async () => {
		const h = createHarness();
		await runSweepWorkflow(safeMode, h.deps);

		assert.deepStrictEqual(h.errorMessages, ['Git Sweep Pro: No workspace folder is open.']);
		assert.deepStrictEqual(h.commands, []);
		assert.deepStrictEqual(h.outputLines, []);
	});

	test('reports no stale branches and stops', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			git: {
				'fetch -p': { stdout: '' },
				'branch -vv': { stdout: '  main 123 [origin/main] main' },
			},
		});

		await runSweepWorkflow(safeMode, h.deps);

		assert.deepStrictEqual(h.infoMessages, ['Git Sweep Pro: No stale branches found.']);
		assert.deepStrictEqual(h.commands, ['fetch -p', 'branch -vv']);
		assert.ok(h.outputLines.includes('No stale tracked branches found.'));
		assert.strictEqual(h.quickPickRequests.length, 0);
		assert.strictEqual(h.progressTitles[0], 'Git Sweep Pro: Fetching and pruning remote references...');
		assert.strictEqual(h.outputLines.at(-1), '--- Git Sweep session ended ---');
	});

	test('handles quick-pick cancellation', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: undefined,
			git: {
				'fetch -p': { stdout: '' },
				'branch -vv': { stdout: '  stale/one 123 [origin/stale/one: gone] msg' },
			},
		});

		await runSweepWorkflow(safeMode, h.deps);

		assert.deepStrictEqual(h.infoMessages, ['Git Sweep Pro: No branches selected.']);
		assert.ok(h.outputLines.includes('Operation cancelled or no branches selected.'));
		assert.strictEqual(h.quickPickRequests.length, 1);
	});

	test('handles empty quick-pick selection', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: [],
			git: {
				'fetch -p': { stdout: '' },
				'branch -vv': { stdout: '  stale/one 123 [origin/stale/one: gone] msg' },
			},
		});

		await runSweepWorkflow(safeMode, h.deps);

		assert.deepStrictEqual(h.infoMessages, ['Git Sweep Pro: No branches selected.']);
	});

	test('dry-run mode reports selection and avoids delete commands', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: [{ label: 'stale/one' }, { label: 'stale/two' }],
			git: {
				'fetch -p': { stdout: '' },
				'branch -vv': {
					stdout: [
						'  stale/one 123 [origin/stale/one: gone] msg',
						'  stale/two 456 [origin/stale/two: gone] msg',
					].join('\n'),
				},
			},
		});

		await runSweepWorkflow(dryMode, h.deps);

		assert.deepStrictEqual(h.infoMessages, ['Git Sweep Pro (dry run): 2 branch(es) would be deleted.']);
		assert.deepStrictEqual(h.commands, ['fetch -p', 'branch -vv']);
		assert.ok(h.outputLines.includes('[DRY RUN] Selected branches:'));
		assert.ok(h.outputLines.includes('- stale/one'));
		assert.ok(h.outputLines.includes('- stale/two'));
		assert.strictEqual(h.quickPickRequests[0]?.title, 'Git Sweep Pro: Select branches to include in dry run');
	});

	test('safe delete deletes all selected branches successfully', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: [{ label: 'stale/one' }, { label: 'stale/two' }],
			git: {
				'fetch -p': { stdout: '' },
				'branch -vv': {
					stdout: [
						'  stale/one 123 [origin/stale/one: gone] msg',
						'  stale/two 456 [origin/stale/two: gone] msg',
					].join('\n'),
				},
				'branch -d stale/one': { stdout: '' },
				'branch -d stale/two': { stdout: '' },
			},
		});

		await runSweepWorkflow(safeMode, h.deps);

		assert.deepStrictEqual(h.infoMessages, ['Git Sweep Pro: Deleted 2 branch(es).']);
		assert.ok(h.commands.includes('branch -d stale/one'));
		assert.ok(h.commands.includes('branch -d stale/two'));
		assert.strictEqual(h.quickPickRequests[0]?.title, 'Git Sweep Pro: Select branches to delete');
	});

	test('force delete uses -D and reports partial failure', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: [{ label: 'stale/one' }, { label: 'stale/two' }],
			git: {
				'fetch -p': { stdout: '' },
				'branch -vv': {
					stdout: [
						'  stale/one 123 [origin/stale/one: gone] msg',
						'  stale/two 456 [origin/stale/two: gone] msg',
					].join('\n'),
				},
				'branch -D stale/one': { stdout: '' },
				'branch -D stale/two': new Error('not fully merged'),
			},
		});

		await runSweepWorkflow(forceMode, h.deps);

		assert.deepStrictEqual(h.errorMessages, [
			'Git Sweep Pro: Deleted 1/2 branch(es). See "Git Sweep" output for details.',
		]);
		assert.ok(h.outputLines.some((line) => line.includes('[delete-failed] stale/two: not fully merged')));
	});

	test('maps not-a-repository errors to friendly message', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			git: {
				'fetch -p': new Error('fatal: not a git repository (or any of the parent directories): .git'),
			},
		});

		await runSweepWorkflow(safeMode, h.deps);

		assert.deepStrictEqual(h.errorMessages, [
			'Git Sweep Pro: The selected workspace folder is not a Git repository.',
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

		await runSweepWorkflow(safeMode, h.deps);

		assert.deepStrictEqual(h.errorMessages, ['Git Sweep Pro: Git is not installed or not available in PATH.']);
	});

	test('maps unknown errors to generic failure message', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			git: {
				'fetch -p': new Error('mysterious failure'),
			},
		});

		await runSweepWorkflow(safeMode, h.deps);

		assert.deepStrictEqual(h.errorMessages, ['Git Sweep Pro failed: mysterious failure']);
	});

	test('pre-selects all stale branches in quick-pick', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: [{ label: 'stale/one' }],
			git: {
				'fetch -p': { stdout: '' },
				'branch -vv': {
					stdout: [
						'  stale/one 123 [origin/stale/one: gone] msg',
						'  stale/two 123 [origin/stale/two: gone] msg',
					].join('\n'),
				},
			},
		});

		await runSweepWorkflow(dryMode, h.deps);

		const quickPick = h.quickPickRequests[0];
		assert.ok(quickPick);
		assert.deepStrictEqual(quickPick.items, [
			{ label: 'stale/one', picked: true },
			{ label: 'stale/two', picked: true },
		]);
	});
});
