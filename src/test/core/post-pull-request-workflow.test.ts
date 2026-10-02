import * as assert from 'assert';
import { NOT_A_REPOSITORY } from '../../core/errors';
import { runPostPullRequestWorkflow } from '../../core/post-pull-request-workflow';
import type { SweepSettings } from '../../core/sweep-logic';
import { createFakeContext, type GitEntry } from '../fake-context';

const GONE_REFS_CMD = 'for-each-ref --format=%(refname:short)%09%(upstream:track)%09%(HEAD)%09%(worktreepath) refs/heads';

type HarnessOptions = {
	workspaceRoot?: string;
	/** Branch the single-select picker returns; `undefined` dismisses it. */
	quickPickSelection?: { label: string } | undefined;
	/** Git commands: value or array (for repeated calls, e.g. the gone refs). */
	git?: Record<string, GitEntry | GitEntry[]>;
	settings?: Partial<SweepSettings>;
};

/** The sweep that follows accepts every branch it offers. */
function createHarness(options: HarnessOptions = {}) {
	const fake = createFakeContext({
		root: options.workspaceRoot,
		settings: options.settings,
		git: options.git,
		pick: [options.quickPickSelection?.label],
		pickMany: (items) => items.map((item) => item.label),
	});
	return { ...fake, quickPickRequests: fake.pickRequests };
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
	'for-each-ref --format=%(refname)%09%(symref) refs/remotes/*/HEAD': { stdout: 'refs/remotes/origin/HEAD\trefs/remotes/origin/main' },
	[GONE_REFS_CMD]: [{ stdout: 'feature/merged\t[gone]' }, { stdout: '' }],
};

suite('post-pull-request workflow', () => {
	test('handles detached HEAD (current branch is HEAD)', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			git: {
				...baseGit,
				'rev-parse --abbrev-ref HEAD': { stdout: 'HEAD' },
			},
		});

		await runPostPullRequestWorkflow(h.context);

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

		await runPostPullRequestWorkflow(h.context);

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

		await runPostPullRequestWorkflow(h.context);

		assert.deepStrictEqual(h.infoMessages, ['No other branches available to checkout.']);
		assert.strictEqual(h.quickPickRequests.length, 0);
	});

	test('handles quick-pick cancellation', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: undefined,
			git: baseGit,
		});

		assert.strictEqual(await runPostPullRequestWorkflow(h.context), 'cancelled');

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

		assert.strictEqual(await runPostPullRequestWorkflow(h.context), 'ok');

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

		await runPostPullRequestWorkflow(h.context);

		assert.ok(h.commands.includes('checkout main'), 'Should try local checkout first');
		assert.ok(h.commands.includes('checkout -b main --track origin/main'), 'Should fall back to creating tracking branch');
		assert.ok(h.outputLines.includes('Checked out: main'));
		assert.ok(h.outputLines.includes('Deleted branch: feature/merged'));
	});

	test('switches to the requested branch without asking', async () => {
		const h = createHarness({
			git: {
				...baseGit,
				[GONE_REFS_CMD]: [{ stdout: 'feature/merged\t[gone]' }, { stdout: '' }],
				'checkout develop': { stdout: '' },
				'branch -D feature/merged': { stdout: '' },
				'pull': { stdout: '' },
			},
		});

		assert.strictEqual(await runPostPullRequestWorkflow(h.context, 'develop'), 'ok');

		assert.strictEqual(h.quickPickRequests.length, 0);
		assert.ok(h.commands.includes('checkout develop'));
		assert.ok(h.infoMessages.includes('Switched to develop and pulled.'));
	});

	test('fails before touching anything when the requested branch does not exist', async () => {
		const h = createHarness({ git: baseGit });

		assert.strictEqual(await runPostPullRequestWorkflow(h.context, 'nope'), 'failed');

		assert.strictEqual(h.errorMessages.length, 1);
		assert.match(h.errorMessages[0], /^Branch "nope" is not available\. Choose one of: main, develop, origin\/main \(remote\), origin\/develop \(remote\)$/);
		assert.ok(!h.commands.some((command) => command.startsWith('checkout') || command.startsWith('branch -D')));
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

		await runPostPullRequestWorkflow(h.context);

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

		assert.strictEqual(await runPostPullRequestWorkflow(h.context), 'failed');

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

		assert.strictEqual(await runPostPullRequestWorkflow(h.context), 'failed');

		assert.deepStrictEqual(h.errorMessages, [
			"Could not delete branch \"feature/merged\". You can delete it manually with: git branch -D feature/merged",
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

		await runPostPullRequestWorkflow(h.context);

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

		assert.strictEqual(await runPostPullRequestWorkflow(h.context), 'failed');

		assert.deepStrictEqual(h.errorMessages, [
			'error: Your local changes would be overwritten by merge.',
		]);
		assert.ok(h.outputLines.some((l) => l.includes('--- Post Pull Request session ended ---')));
	});

	test('invokes sweep workflow after checkout and delete', async () => {
		const h = createHarness({
			workspaceRoot: '/repo',
			quickPickSelection: { label: 'main' },
			git: {
				...baseGit,
				[GONE_REFS_CMD]: [{ stdout: 'feature/merged\t[gone]' }, { stdout: 'stale\t[gone]' }],
				'checkout main': { stdout: '' },
				'branch -D feature/merged': { stdout: '' },
				"branch -d stale": { stdout: '' },
				'pull': { stdout: '' },
			},
		});

		await runPostPullRequestWorkflow(h.context);

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

		await runPostPullRequestWorkflow(h.context);

		assert.deepStrictEqual(h.errorMessages, [
			NOT_A_REPOSITORY,
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

		await runPostPullRequestWorkflow(h.context);

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
				'for-each-ref --format=%(refname)%09%(symref) refs/remotes/*/HEAD': { stdout: 'refs/remotes/upstream/HEAD\trefs/remotes/upstream/main' },
				'branch --no-column -a': {
					stdout: '* feature/merged\n  main\n  remotes/upstream/HEAD -> upstream/main\n  remotes/upstream/main\n  remotes/upstream/develop',
				},
				[GONE_REFS_CMD]: [{ stdout: 'feature/merged\t[gone]' }, { stdout: 'main\t' }],
				'checkout main': { stdout: '' },
				'branch -D feature/merged': { stdout: '' },
				'pull': { stdout: '' },
			},
		});

		await runPostPullRequestWorkflow(h.context);

		const quickPick = h.quickPickRequests[0];
		const mainItem = quickPick?.items.find((i) => i.label === 'main');
		assert.ok(mainItem?.picked, 'Default branch (main) from upstream should be pre-selected');
		assert.ok(h.commands.includes('for-each-ref --format=%(refname)%09%(symref) refs/remotes/*/HEAD'));
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

		await runPostPullRequestWorkflow(h.context);

		assert.ok(h.commands.includes('checkout feature/auth/oauth'));
		assert.ok(h.commands.includes('branch -D team/subteam/merged-pr'));
	});

	suite('worktrees', () => {
		const worktreeGit = {
			...baseGit,
			'branch --no-column -a': { stdout: ['* feature/merged', '+ main', '  remotes/origin/HEAD -> origin/main', '  remotes/origin/main'].join('\n') },
		};

		test('pre-selects the remote default when the local one is in another worktree', async () => {
			const h = createHarness({ workspaceRoot: '/repo/wt', quickPickSelection: undefined, git: worktreeGit });

			await runPostPullRequestWorkflow(h.context);

			const items = h.quickPickRequests[0].items;
			assert.deepStrictEqual(items.find((i) => i.label === 'main'), {
				label: 'main',
				description: 'default, checked out in another worktree',
			});
			assert.strictEqual(items.find((i) => i.label === 'origin/main (remote)')?.picked, true);
		});

		test('pre-selects the default remote, not the first remote with the same branch', async () => {
			const h = createHarness({
				workspaceRoot: '/repo/wt',
				quickPickSelection: undefined,
				git: {
					...worktreeGit,
					'branch --no-column -a': {
						stdout: ['* feature/merged', '+ main', '  remotes/fork/main', '  remotes/origin/HEAD -> origin/main', '  remotes/origin/main'].join('\n'),
					},
				},
			});

			await runPostPullRequestWorkflow(h.context);

			const picked = h.quickPickRequests[0].items.filter((item) => item.picked).map((item) => item.label);
			assert.deepStrictEqual(picked, ['origin/main (remote)']);
		});

		test('switches to a detached HEAD, deletes the merged branch and skips the pull', async () => {
			const h = createHarness({
				workspaceRoot: '/repo/wt',
				quickPickSelection: { label: 'origin/main (remote)' },
				git: worktreeGit,
			});

			await runPostPullRequestWorkflow(h.context);

			assert.ok(h.commands.includes('checkout --detach origin/main'));
			assert.ok(h.progressTitles.includes('Checking out origin/main as a detached HEAD'));
			assert.ok(!h.commands.includes('checkout main'));
			assert.ok(h.commands.includes('branch -D feature/merged'));
			assert.ok(!h.commands.includes('pull'));
			assert.strictEqual(
				h.infoMessages.at(-1),
				'Switched to a detached HEAD at origin/main because "main" is checked out in another worktree. Pull skipped.'
			);
		});
	});
});
