import * as assert from 'assert';
import { runPostPullRequestWorkflow } from '../../core/post-pull-request-workflow';
import type { QuickPickItemLike, SweepWorkflowDeps } from '../../core/sweep-workflow';

type GitEntry = { stdout?: string; stderr?: string } | Error;

type HarnessOptions = {
	workspaceRoot?: string;
	quickPickSelection?: QuickPickItemLike | undefined;
	/** Git commands: value or array (for repeated calls, e.g. git branch -vv) */
	git?: Record<string, GitEntry | GitEntry[]>;
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
		output: {
			show: () => undefined,
			appendLine: (line) => outputLines.push(line),
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

const baseBranchAvv = [
	'* feature/merged 123 [origin/feature/merged: gone] msg',
	'  main 456 [origin/main] main',
	'  develop 789 [origin/develop] develop',
	'  remotes/origin/HEAD -> origin/main',
	'  remotes/origin/main 43a6a46 0.2.1',
	'  remotes/origin/develop 43a6a46 develop',
].join('\n');

const baseGit = {
	'fetch -p': { stdout: '' },
	'rev-parse --abbrev-ref HEAD': { stdout: 'feature/merged' },
	'branch -avv': { stdout: baseBranchAvv },
	'for-each-ref --format=%(refname) refs/remotes/*/HEAD': { stdout: 'refs/remotes/origin/HEAD' },
	'rev-parse --abbrev-ref refs/remotes/origin/HEAD': { stdout: 'origin/main' },
};

suite('post-pull-request workflow', () => {
	test('fails fast when no workspace is open', async () => {
		const h = createHarness();
		await runPostPullRequestWorkflow(h.deps);

		assert.deepStrictEqual(h.errorMessages, ['Git Sweep Pro: No workspace folder is open.']);
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
			'Git Sweep Pro: Could not determine current branch (detached HEAD?).',
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
			'Git Sweep Pro: Could not determine current branch (detached HEAD?).',
		]);
	});

	test('shows info and exits when no other branches available', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			git: {
				...baseGit,
				'branch -avv': {
					stdout: '* feature/merged 123 [origin/feature/merged: gone] msg\n  remotes/origin/HEAD -> origin/main',
				},
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		assert.deepStrictEqual(h.infoMessages, ['Git Sweep Pro: No other branches available to checkout.']);
		assert.strictEqual(h.quickPickRequests.length, 0);
	});

	test('handles quick-pick cancellation', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: undefined,
			git: baseGit,
		});

		await runPostPullRequestWorkflow(h.deps);

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
				'branch -vv': { stdout: '* main 456 [origin/main] main\n  develop 789 [origin/develop] develop' },
				'checkout main': { stdout: '' },
				'branch -D feature/merged': { stdout: '' },
				'pull': { stdout: '' },
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		assert.ok(h.commands.includes('checkout main'));
		assert.ok(h.commands.includes('branch -D feature/merged'));
		assert.ok(h.outputLines.includes('Checked out: main'));
		assert.ok(h.outputLines.includes('Deleted branch: feature/merged'));
		assert.ok(h.commands.includes('fetch -p'));
		assert.ok(h.commands.includes('pull'));
		assert.deepStrictEqual(h.infoMessages, ['Git Sweep Pro: Switched to main and pulled.']);
		assert.ok(h.outputLines.includes('--- Post Pull Request session ended ---'));
	});

	test('checks out remote branch with -B to create local tracking branch', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: { label: 'origin/main (remote)' },
			git: {
				...baseGit,
				'branch -vv': { stdout: '* main 456 [origin/main] main' },
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
				'branch -vv': { stdout: '* main 456 [origin/main] main' },
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
				'branch -vv': { stdout: '* main 456 [origin/main] main' },
				'checkout main': new Error('fatal: pathspec main did not match any file(s) known to git'),
				'branch -D feature/merged': { stdout: '' },
				'pull': { stdout: '' },
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		assert.deepStrictEqual(h.errorMessages, [
			'Git Sweep Pro: Checkout failed: fatal: pathspec main did not match any file(s) known to git',
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
				'branch -vv': { stdout: '* main 456 [origin/main] main' },
				'checkout main': { stdout: '' },
				'branch -D feature/merged': new Error('error: Cannot delete branch \'feature/merged\' checked out'),
				'pull': { stdout: '' },
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		assert.deepStrictEqual(h.errorMessages, [
			'Git Sweep Pro: Could not delete branch "feature/merged". You can delete it manually with: git branch -D "feature/merged"',
		]);
		assert.ok(h.commands.includes('pull'));
		assert.ok(h.outputLines.includes('Checked out: main'));
		assert.deepStrictEqual(h.infoMessages, ['Git Sweep Pro: Switched to main and pulled.']);
	});

	test('handles branch without upstream—skips pull and shows friendly message', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: { label: 'feature/auth/oauth' },
			git: {
				...baseGit,
				'rev-parse --abbrev-ref HEAD': { stdout: 'feature/merged' },
				'branch -avv': {
					stdout: '* feature/merged 123 [origin/feature/merged: gone] msg\n  feature/auth/oauth 456 msg\n  main 789 [origin/main] main\n  remotes/origin/HEAD -> origin/main',
				},
				'branch -vv': [
					{ stdout: '* feature/auth/oauth 456 msg\n  main 789 [origin/main] main' },
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
			'Git Sweep Pro: Switched to feature/auth/oauth. (No upstream—pull skipped.)',
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
				'branch -vv': { stdout: '* main 456 [origin/main] main' },
				'checkout main': { stdout: '' },
				'branch -D feature/merged': { stdout: '' },
				'pull': new Error('error: Your local changes would be overwritten by merge.'),
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		assert.deepStrictEqual(h.errorMessages, [
			'Git Sweep Pro failed: error: Your local changes would be overwritten by merge.',
		]);
		assert.ok(h.outputLines.some((l) => l.includes('--- Post Pull Request session ended ---')));
	});

	test('invokes sweep workflow after checkout and delete', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: { label: 'main' },
			git: {
				...baseGit,
				'branch -vv': { stdout: '* main 456 [origin/main] main\n  stale 789 [origin/stale: gone] msg' },
				'checkout main': { stdout: '' },
				'branch -D feature/merged': { stdout: '' },
				"branch -d stale": { stdout: '' },
				'pull': { stdout: '' },
			},
		});

		await runPostPullRequestWorkflow(h.deps);

		const fetchCount = h.commands.filter((c) => c === 'fetch -p').length;
		assert.ok(fetchCount >= 2, 'Should fetch at least twice (post-PR + sweep)');
		assert.ok(h.commands.includes('branch -avv'), 'Should run branch -avv once for post-PR');
		assert.ok(h.commands.includes('branch -vv'), 'Sweep workflow should run branch -vv');
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
			'Git Sweep Pro: The selected workspace folder is not a Git repository.',
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
			'Git Sweep Pro: Git is not installed or not available in PATH.',
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
				'branch -avv': {
					stdout: '* feature/merged 123 [upstream/feature/merged: gone] msg\n  main 456 [upstream/main] main\n  remotes/upstream/HEAD -> upstream/main\n  remotes/upstream/main 43a6a46 main\n  remotes/upstream/develop 43a6a46 develop',
				},
				'branch -vv': { stdout: '* main 456 [upstream/main] main' },
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
				'branch -avv': {
					stdout: '* team/subteam/merged-pr 123 [origin/team/subteam/merged-pr: gone] msg\n  feature/auth/oauth 456 [origin/feature/auth/oauth] oauth\n  main 789 [origin/main] main\n  remotes/origin/HEAD -> origin/main',
				},
				'branch -vv': [
					{ stdout: '* feature/auth/oauth 456 [origin/feature/auth/oauth] oauth\n  main 789 [origin/main] main' },
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
