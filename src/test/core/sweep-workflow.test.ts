import * as assert from 'assert';
import { runSweepWorkflow, type QuickPickItemLike, type SweepWorkflowDeps } from '../../core/sweep-workflow';
import { DEFAULT_SWEEP_SETTINGS, type SweepMode, type SweepSettings } from '../../core/sweep-logic';

const GONE_REFS_CMD = 'for-each-ref --format=%(refname:short)%09%(upstream:track) refs/heads';

type HarnessOptions = {
	workspaceRoot?: string;
	quickPickSelection?: readonly QuickPickItemLike[] | undefined;
	git?: Record<string, { stdout?: string; stderr?: string } | Error>;
	settings?: Partial<SweepSettings>;
	confirmResult?: boolean;
};

type Harness = {
	deps: SweepWorkflowDeps;
	outputLines: string[];
	infoMessages: string[];
	errorMessages: string[];
	commands: string[];
	progressTitles: string[];
	quickPickRequests: Array<{ items: QuickPickItemLike[]; title: string }>;
	confirmRequests: Array<{ message: string; confirmLabel: string }>;
};

function createHarness(options: HarnessOptions = {}): Harness {
	const outputLines: string[] = [];
	const infoMessages: string[] = [];
	const errorMessages: string[] = [];
	const commands: string[] = [];
	const progressTitles: string[] = [];
	const quickPickRequests: Array<{ items: QuickPickItemLike[]; title: string }> = [];
	const confirmRequests: Array<{ message: string; confirmLabel: string }> = [];

	const settings: SweepSettings = {
		...DEFAULT_SWEEP_SETTINGS,
		confirmBeforeDelete: false,
		...options.settings,
	};

	const deps: SweepWorkflowDeps = {
		getWorkspaceRoot: () => options.workspaceRoot,
		getSettings: () => settings,
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
			confirm: async (message, confirmLabel) => {
				confirmRequests.push({ message, confirmLabel });
				return options.confirmResult ?? true;
			},
		},
	};

	return { deps, outputLines, infoMessages, errorMessages, commands, progressTitles, quickPickRequests, confirmRequests };
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
				[GONE_REFS_CMD]: { stdout: 'main\t' },
			},
		});

		await runSweepWorkflow(safeMode, h.deps);

		assert.deepStrictEqual(h.infoMessages, ['Git Sweep Pro: No stale branches found.']);
		assert.deepStrictEqual(h.commands, ['fetch -p', GONE_REFS_CMD]);
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
				[GONE_REFS_CMD]: { stdout: 'stale/one\t[gone]' },
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
				[GONE_REFS_CMD]: { stdout: 'stale/one\t[gone]' },
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
				[GONE_REFS_CMD]: {
					stdout: ['stale/one\t[gone]', 'stale/two\t[gone]'].join('\n'),
				},
			},
		});

		await runSweepWorkflow(dryMode, h.deps);

		assert.deepStrictEqual(h.infoMessages, ['Git Sweep Pro (dry run): 2 branch(es) would be deleted.']);
		assert.deepStrictEqual(h.commands, ['fetch -p', GONE_REFS_CMD]);
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
				[GONE_REFS_CMD]: {
					stdout: ['stale/one\t[gone]', 'stale/two\t[gone]'].join('\n'),
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
				[GONE_REFS_CMD]: {
					stdout: ['stale/one\t[gone]', 'stale/two\t[gone]'].join('\n'),
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
				[GONE_REFS_CMD]: {
					stdout: ['stale/one\t[gone]', 'stale/two\t[gone]'].join('\n'),
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

		await runSweepWorkflow(safeMode, h.deps);

		const quickPick = h.quickPickRequests[0];
		assert.deepStrictEqual(quickPick?.items, [{ label: 'stale/one', picked: true }]);
		assert.ok(h.outputLines.some((line) => line.includes('Protected branches skipped')));
		assert.ok(h.outputLines.some((line) => line === '- release/2.0'));
		assert.ok(h.outputLines.some((line) => line === '- main'));
		assert.deepStrictEqual(h.infoMessages, ['Git Sweep Pro: Deleted 1 branch(es).']);
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

		await runSweepWorkflow(safeMode, h.deps);

		assert.deepStrictEqual(h.infoMessages, ['Git Sweep Pro: All 2 stale branch(es) are protected.']);
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

		await runSweepWorkflow(dryMode, h.deps);

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

		await runSweepWorkflow(safeMode, h.deps);

		assert.strictEqual(h.confirmRequests.length, 1);
		assert.ok(h.confirmRequests[0].message.includes('git branch -d'));
		assert.deepStrictEqual(h.infoMessages, ['Git Sweep Pro: Deleted 1 branch(es).']);
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

		await runSweepWorkflow(safeMode, h.deps);

		assert.strictEqual(h.confirmRequests.length, 1);
		assert.ok(!h.commands.includes('branch -d stale/one'));
		assert.deepStrictEqual(h.infoMessages, ['Git Sweep Pro: Deletion cancelled.']);
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

		await runSweepWorkflow(dryMode, h.deps);

		assert.strictEqual(h.confirmRequests.length, 0);
		assert.deepStrictEqual(h.infoMessages, ['Git Sweep Pro (dry run): 1 branch(es) would be deleted.']);
	});
});
