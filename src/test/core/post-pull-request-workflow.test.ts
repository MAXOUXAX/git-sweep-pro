import * as assert from 'assert';
import { runPostPullRequestWorkflow } from '../../core/post-pull-request-workflow';
import type { QuickPickItemLike, SweepWorkflowDeps } from '../../core/sweep-workflow';
import { DEFAULT_SWEEP_SETTINGS, type SweepSettings } from '../../core/sweep-logic';

const GONE_REFS_CMD = 'for-each-ref --format=%(refname:short)%09%(upstream:track) refs/heads';

type GitEntry = { stdout?: string; stderr?: string } | Error;

type HarnessOptions = {
	workspaceRoot?: string;
	quickPickSelection?: QuickPickItemLike | undefined;
	/** Per-call quick-pick answers (post-PR pick, then sweep multi-select). Takes precedence over quickPickSelection. */
	quickPickSelections?: Array<QuickPickItemLike | QuickPickItemLike[] | undefined>;
	/** Git commands: value or array (for repeated calls, e.g. git branch -vv) */
	git?: Record<string, GitEntry | GitEntry[]>;
	settings?: Partial<SweepSettings>;
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

	const deps: SweepWorkflowDeps = {
		getWorkspaceRoot: () => options.workspaceRoot,
		getSettings: () => ({
			...DEFAULT_SWEEP_SETTINGS,
			confirmBeforeDelete: false,
			...options.settings,
		}),
		output: {
			show: () => undefined,
			appendLine: (line) => outputLines.push(line),
			header: (line) => outputLines.push(line),
		},
		runGitCommand: async (args) => {
			const key = args.join(' ');
			commands.push(key);
			const entry = resolveGitEntry(key);
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
				if (options.quickPickSelections) {
					return options.quickPickSelections[quickPickRequests.length - 1];
				}
				return options.quickPickSelection;
			},
			pickBranches: async ({ items }) => items.map((item) => item.label),
			showInformationMessage: (message) => {
				infoMessages.push(message);
			},
			showErrorMessage: (message) => {
				errorMessages.push(message);
			},
			confirm: async () => true,
		},
	};

	return { deps, outputLines, infoMessages, errorMessages, commands, progressTitles, quickPickRequests };
}

const baseBranchList = [
	'* feature/merged',
	'  main',
	'  develop',
	'  remotes/origin/HEAD -> origin/main',
	'  remotes/origin/main',
	'  remotes/origin/develop',
].join('\n');

const baseGit = {
	'fetch -p': { stdout: '' },
	'rev-parse --abbrev-ref HEAD': { stdout: 'feature/merged' },
	'branch --no-column -a': { stdout: baseBranchList },
	'for-each-ref --format=%(refname) refs/remotes/*/HEAD': { stdout: 'refs/remotes/origin/HEAD' },
	'rev-parse --abbrev-ref refs/remotes/origin/HEAD': { stdout: 'origin/main' },
	[GONE_REFS_CMD]: [{ stdout: 'feature/merged\t[gone]' }, { stdout: '' }],
};

suite('post-pull-request workflow', () => {
	test('fails fast when no workspace is open', async () => {
		const h = createHarness();
		assert.strictEqual(await runPostPullRequestWorkflow(h.deps), 'failed');

		assert.deepStrictEqual(h.errorMessages, ['No workspace folder is open.']);
		assert.strictEqual(h.commands.length, 0);
		assert.ok(!h.outputLines.includes('--- Post Pull Request session started ---'));
	});

	test('handles detached HEAD (current branch is HEAD)', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			git: {
				...baseGit,
				'rev-parse --abbrev-ref HEAD': { stdout: 'HEAD' },
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		assert.deepStrictEqual(h.errorMessages, [
			'Could not determine current branch (detached HEAD?).',
		]);
		assert.strictEqual(h.quickPickRequests.length, 0);
	});

	test('handles empty current branch name', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			git: {
				...baseGit,
				'rev-parse --abbrev-ref HEAD': { stdout: '' },
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		assert.deepStrictEqual(h.errorMessages, [
			'Could not determine current branch (detached HEAD?).',
		]);
	});

	test('shows info and exits when no other branches available', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			git: {
				...baseGit,
				'branch --no-column -a': {
					stdout: '* feature/merged\n  remotes/origin/HEAD -> origin/main',
				},
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		assert.deepStrictEqual(h.infoMessages, ['No other branches available to checkout.']);
		assert.strictEqual(h.quickPickRequests.length, 0);
	});

	test('handles quick-pick cancellation', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: undefined,
			git: baseGit,
		});

		assert.strictEqual(await runPostPullRequestWorkflow(h.deps), 'cancelled');

		assert.strictEqual(h.quickPickRequests.length, 1);
		assert.strictEqual(h.quickPickRequests[0]?.title, 'Post Pull Request: Branch to switch to');
		assert.ok(h.outputLines.includes('Operation cancelled.'));
	});

	test('checks out local branch and deletes previous branch', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: { label: 'main' },
			git: {
				...baseGit,
				[GONE_REFS_CMD]: [{ stdout: 'feature/merged\t[gone]' }, { stdout: 'main\t\ndevelop\t' }],
				'checkout main': { stdout: '' },
				'branch -D feature/merged': { stdout: '' },
				'pull': { stdout: '' },
			},
		});

		assert.strictEqual(await runPostPullRequestWorkflow(h.deps), 'ok');

		assert.ok(h.commands.includes('checkout main'));
		assert.ok(h.commands.includes('branch -D feature/merged'));
		assert.ok(h.outputLines.includes('Checked out: main'));
		assert.ok(h.outputLines.includes('Deleted branch: feature/merged'));
		assert.ok(h.commands.includes('fetch -p'));
		assert.ok(h.commands.includes('pull'));
		assert.deepStrictEqual(h.infoMessages, [
			'No stale branches found.',
			'Switched to main and pulled.',
		]);
		assert.ok(h.outputLines.includes('--- Post Pull Request session ended ---'));
	});

	test('checks out remote branch with -B to create local tracking branch', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: { label: 'origin/main (remote)' },
			git: {
				...baseGit,
				[GONE_REFS_CMD]: [{ stdout: 'feature/merged\t[gone]' }, { stdout: 'main\t' }],
				'checkout main': new Error('error: pathspec did not match'),
				'checkout -b main --track origin/main': { stdout: '' },
				'branch -D feature/merged': { stdout: '' },
				'pull': { stdout: '' },
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		assert.ok(h.commands.includes('checkout main'), 'Should try local checkout first');
		assert.ok(h.commands.includes('checkout -b main --track origin/main'), 'Should fall back to creating tracking branch');
		assert.ok(h.outputLines.includes('Checked out: main'));
		assert.ok(h.outputLines.includes('Deleted branch: feature/merged'));
	});

	test('pre-selects default branch in quick-pick when current is gone', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: { label: 'main' },
			git: {
				...baseGit,
				[GONE_REFS_CMD]: [{ stdout: 'feature/merged\t[gone]' }, { stdout: 'main\t' }],
				'checkout main': { stdout: '' },
				'branch -D feature/merged': { stdout: '' },
				'pull': { stdout: '' },
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		const quickPick = h.quickPickRequests[0];
		assert.ok(quickPick);
		const mainItem = quickPick.items.find((i) => i.label === 'main');
		assert.ok(mainItem, 'main branch should be in quick-pick');
		assert.ok(mainItem?.picked, 'Default branch (main) should be pre-selected');
	});

	test('shows error on checkout failure', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: { label: 'main' },
			git: {
				...baseGit,
				[GONE_REFS_CMD]: [{ stdout: 'feature/merged\t[gone]' }, { stdout: 'main\t' }],
				'checkout main': new Error('fatal: pathspec main did not match any file(s) known to git'),
				'branch -D feature/merged': { stdout: '' },
				'pull': { stdout: '' },
			},
		});

		assert.strictEqual(await runPostPullRequestWorkflow(h.deps), 'failed');

		assert.deepStrictEqual(h.errorMessages, [
			'Checkout failed: fatal: pathspec main did not match any file(s) known to git',
		]);
		assert.ok(!h.commands.includes('branch -D feature/merged'));
		assert.ok(!h.commands.includes('pull'));
		assert.ok(h.outputLines.some((l) => l.includes('Checkout failed')));
		assert.ok(h.outputLines.includes('--- Post Pull Request session ended ---'));
	});

	test('shows error and continues when branch deletion fails', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: { label: 'main' },
			git: {
				...baseGit,
				[GONE_REFS_CMD]: [{ stdout: 'feature/merged\t[gone]' }, { stdout: 'main\t' }],
				'checkout main': { stdout: '' },
				'branch -D feature/merged': new Error('error: Cannot delete branch \'feature/merged\' checked out'),
				'pull': { stdout: '' },
			},
		});

		assert.strictEqual(await runPostPullRequestWorkflow(h.deps), 'failed');

		assert.deepStrictEqual(h.errorMessages, [
			"Could not delete branch \"feature/merged\". You can delete it manually with: git branch -D 'feature/merged'",
		]);
		assert.ok(h.commands.includes('pull'));
		assert.ok(h.outputLines.includes('Checked out: main'));
		assert.deepStrictEqual(h.infoMessages, [
			'No stale branches found.',
			'Switched to main and pulled.',
		]);
	});

	test('handles branch without upstream—skips pull and shows friendly message', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: { label: 'feature/auth/oauth' },
			git: {
				...baseGit,
				'rev-parse --abbrev-ref HEAD': { stdout: 'feature/merged' },
				'branch --no-column -a': {
					stdout: '* feature/merged\n  feature/auth/oauth\n  main\n  remotes/origin/HEAD -> origin/main',
				},
				[GONE_REFS_CMD]: [
					{ stdout: 'feature/merged\t[gone]' },
					{ stdout: 'feature/auth/oauth\t\nmain\t' },
				],
				'checkout feature/auth/oauth': { stdout: '' },
				'branch -D feature/merged': { stdout: '' },
				'pull': new Error(
					'There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.'
				),
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		assert.deepStrictEqual(h.errorMessages, []);
		assert.deepStrictEqual(h.infoMessages, [
			'No stale branches found.',
			'Switched to feature/auth/oauth. (No upstream—pull skipped.)',
		]);
		assert.ok(h.outputLines.includes('No upstream configured for feature/auth/oauth. Pull skipped.'));
		assert.ok(h.outputLines.includes('--- Post Pull Request session ended ---'));
	});

	test('rethrows when pull fails for reasons other than no upstream', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: { label: 'main' },
			git: {
				...baseGit,
				[GONE_REFS_CMD]: [{ stdout: 'feature/merged\t[gone]' }, { stdout: 'main\t' }],
				'checkout main': { stdout: '' },
				'branch -D feature/merged': { stdout: '' },
				'pull': new Error('error: Your local changes would be overwritten by merge.'),
			},
		});

		assert.strictEqual(await runPostPullRequestWorkflow(h.deps), 'failed');

		assert.deepStrictEqual(h.errorMessages, [
			'error: Your local changes would be overwritten by merge.',
		]);
		assert.ok(h.outputLines.some((l) => l.includes('--- Post Pull Request session ended ---')));
	});

	test('invokes sweep workflow after checkout and delete', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelections: [{ label: 'main' }, [{ label: 'stale' }]],
			git: {
				...baseGit,
				[GONE_REFS_CMD]: [{ stdout: 'feature/merged\t[gone]' }, { stdout: 'stale\t[gone]' }],
				'checkout main': { stdout: '' },
				'branch -D feature/merged': { stdout: '' },
				"branch -d stale": { stdout: '' },
				'pull': { stdout: '' },
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		const fetchCount = h.commands.filter((c) => c === 'fetch -p').length;
		assert.ok(fetchCount >= 2, 'Should fetch at least twice (post-PR + sweep)');
		assert.ok(h.commands.includes('branch --no-column -a'), 'Should run branch --no-column -a once for post-PR');
		assert.ok(h.commands.includes(GONE_REFS_CMD), 'Sweep workflow should query gone refs');
		assert.ok(h.commands.includes('branch -d stale'), 'Sweep should delete stale branch');
	});

	test('maps not-a-repository errors to friendly message', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			git: {
				'fetch -p': new Error('fatal: not a git repository (or any of the parent directories): .git'),
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		assert.deepStrictEqual(h.errorMessages, [
			'The selected workspace folder is not a Git repository.',
		]);
		assert.ok(h.outputLines.some((l) => l.includes('--- Post Pull Request session ended ---')));
	});

	test('maps command-not-found / ENOENT errors to friendly message', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			git: {
				'fetch -p': new Error('spawn git ENOENT'),
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		assert.deepStrictEqual(h.errorMessages, [
			'Git is not installed or not available in PATH.',
		]);
	});

	test('discovers default branch from non-origin remote', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: { label: 'main' },
			git: {
				...baseGit,
				'for-each-ref --format=%(refname) refs/remotes/*/HEAD': { stdout: 'refs/remotes/upstream/HEAD' },
				'rev-parse --abbrev-ref refs/remotes/upstream/HEAD': { stdout: 'upstream/main' },
				'branch --no-column -a': {
					stdout: '* feature/merged\n  main\n  remotes/upstream/HEAD -> upstream/main\n  remotes/upstream/main\n  remotes/upstream/develop',
				},
				[GONE_REFS_CMD]: [{ stdout: 'feature/merged\t[gone]' }, { stdout: 'main\t' }],
				'checkout main': { stdout: '' },
				'branch -D feature/merged': { stdout: '' },
				'pull': { stdout: '' },
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		const quickPick = h.quickPickRequests[0];
		const mainItem = quickPick?.items.find((i) => i.label === 'main');
		assert.ok(mainItem?.picked, 'Default branch (main) from upstream should be pre-selected');
		assert.ok(h.commands.includes('rev-parse --abbrev-ref refs/remotes/upstream/HEAD'));
	});

	test('handles branch name with slashes in checkout and delete', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: { label: 'feature/auth/oauth' },
			git: {
				...baseGit,
				'rev-parse --abbrev-ref HEAD': { stdout: 'team/subteam/merged-pr' },
				'branch --no-column -a': {
					stdout: '* team/subteam/merged-pr\n  feature/auth/oauth\n  main\n  remotes/origin/HEAD -> origin/main',
				},
				[GONE_REFS_CMD]: [
					{ stdout: 'team/subteam/merged-pr\t[gone]' },
					{ stdout: 'feature/auth/oauth\t\nmain\t' },
				],
				'checkout feature/auth/oauth': { stdout: '' },
				'branch -D team/subteam/merged-pr': { stdout: '' },
				'pull': { stdout: '' },
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		assert.ok(h.commands.includes('checkout feature/auth/oauth'));
		assert.ok(h.commands.includes('branch -D team/subteam/merged-pr'));
	});
});
