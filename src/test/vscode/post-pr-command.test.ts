import * as assert from 'assert';
import { COPY_COMMAND, OPEN_MAIN_CHECKOUT, SHOW_OUTPUT, UNDO } from '../../vscode/command-ui';
import { describePostPrResult, postPrPreview, runPostPrCommand } from '../../vscode/post-pr-command';
import { branch, cleanDocument, createFakeClient, createFakeUi, deps, ok, postPrDocument } from './fakes';

const wtWorktree = { path: '/work/wt-x', isMain: false, dirty: false, locked: false, prunable: false, inProgress: null, ignoredFiles: { count: 0, sample: [] }, submodules: false };
const merged = branch({ name: 'feature/x', worktree: wtWorktree });
const plan = postPrDocument({
	branch: merged,
	worktree: { path: '/work/wt-x', removed: false, switched: false },
	defaultBranch: { name: 'main', from: 'aaa', to: 'bbb', upstream: 'origin/main', where: '/repo', updated: false, remoteAhead: false, reason: 'not-applied', hint: null },
	clean: cleanDocument([branch({ name: 'feature/old', reason: 'empty', verdictReason: 'empty' })]),
});
const done = postPrDocument({
	mode: 'apply',
	branch: { ...merged, result: 'deleted' },
	worktree: { path: '/work/wt-x', removed: true, switched: false },
	defaultBranch: { ...plan.defaultBranch, updated: true, reason: null },
	clean: cleanDocument([branch({ name: 'feature/old', reason: 'empty', verdictReason: 'empty', result: 'deleted' })], { mode: 'apply' }),
	nextCwd: '/repo',
});

suite('Finish Merged Pull Request command', () => {
	test('previews, applies for the same branch, then offers the main checkout when this window loses its worktree', async () => {
		const { client, calls } = createFakeClient([ok(plan, 5), ok(done, 5)]);
		const fake = createFakeUi({ notify: () => OPEN_MAIN_CHECKOUT });

		await runPostPrCommand(deps(client, fake.ui, ['/work/wt-x']), '/work/wt-x');

		assert.deepStrictEqual(calls.map((call) => call.args), [['post-pr', '--dry-run'], ['post-pr', '--yes', 'feature/x']]);
		assert.deepStrictEqual(fake.confirms, [
			{
				message: 'Finish feature/x?',
				detail: [
					'Deletes feature/x: squash-merged into origin/main.',
					'Removes its worktree /work/wt-x.',
					'Updates main to origin/main.',
					'Also deletes 1 other merged branch: feature/old, and any other branch proven merged after fetching.',
					'This window has that worktree open. You can open the main checkout afterwards.',
				].join('\n'),
				confirmLabel: 'Finish',
			},
		]);
		assert.deepStrictEqual(fake.notices, [
			{ kind: 'info', message: 'Finished feature/x: deleted it and its worktree. Updated main. Also deleted 1 other merged branch.', actions: [OPEN_MAIN_CHECKOUT, UNDO] },
		]);
		assert.deepStrictEqual(fake.opened, [{ path: '/repo', newWindow: false }]);
	});

	test('Undo restores every branch it deleted, from the main checkout', async () => {
		const { client, calls } = createFakeClient([ok(plan, 5), ok(done)]);
		const fake = createFakeUi({ notify: () => UNDO });

		await runPostPrCommand(deps(client, fake.ui, ['/repo']), '/work/wt-x');

		assert.deepStrictEqual(fake.notices[0].actions, [UNDO], 'this window keeps its folder: nothing to open');
		assert.deepStrictEqual(calls[2], { cwd: '/repo', args: ['restore', 'feature/x', 'feature/old'], json: false });
	});

	test('an unproven branch is not finished: says why and offers the command', async () => {
		const unproven = branch({ name: 'feature/x', action: 'skip', reason: 'needs-force', verdict: 'alive', verdictReason: 'unmerged-commits', evidence: { method: 'unique-commits', base: 'refs/remotes/origin/main', commits: 1 } as never, hint: 'git push' });
		const { client, calls } = createFakeClient([ok(postPrDocument({ branch: unproven }), 5)]);
		const fake = createFakeUi({ notify: () => COPY_COMMAND });

		await runPostPrCommand(deps(client, fake.ui), '/repo');

		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(fake.notices, [{ kind: 'warning', message: 'feature/x is not proven merged yet: 1 commit not merged into origin/main.', actions: [COPY_COMMAND] }]);
		assert.deepStrictEqual(fake.copied, ['git push']);
	});

	test('when the remote has new commits, an unproven branch can be finished after fetching them', async () => {
		const unproven = { ...merged, action: 'skip' as const, reason: 'needs-force' as const, verdictReason: 'upstream-gone' as const, upstream: 'origin/feature/x', unpushedCommits: 1 };
		const ahead = postPrDocument({ ...plan, branch: unproven, defaultBranch: { ...plan.defaultBranch, reason: 'up-to-date', remoteAhead: true } });
		const proven = postPrDocument({ ...done, branch: { ...merged, reason: 'squash-merged', result: 'deleted' } });
		const { client, calls } = createFakeClient([ok(ahead, 5), ok(proven)]);
		const fake = createFakeUi({ notify: () => OPEN_MAIN_CHECKOUT });

		await runPostPrCommand(deps(client, fake.ui, ['/work/wt-x']), '/work/wt-x');

		assert.deepStrictEqual(fake.confirms, [
			{
				message: 'feature/x is not proven merged yet',
				detail: [
					'Upstream origin/feature/x is gone, 1 commit found nowhere else.',
					'origin/main has new commits. Finishing fetches them first, and deletes feature/x only if they prove it merged.',
					'If they do, it also removes its worktree /work/wt-x.',
					'Updates main too.',
					'Also deletes 1 other merged branch: feature/old, and any other branch proven merged after fetching.',
					'This window has that worktree open. If it is removed, you can open the main checkout afterwards.',
				].join('\n'),
				confirmLabel: 'Fetch and finish',
			},
		]);
		assert.deepStrictEqual(calls[1].args, ['post-pr', '--yes', 'feature/x']);
		assert.deepStrictEqual(fake.notices, [
			{ kind: 'info', message: 'Finished feature/x: deleted it and its worktree. Updated main. Also deleted 1 other merged branch.', actions: [OPEN_MAIN_CHECKOUT, UNDO] },
		]);
		assert.deepStrictEqual(fake.opened, [{ path: '/repo', newWindow: false }]);
	});

	test('when the fetch does not prove it, says why the branch is kept', async () => {
		const unproven = branch({ name: 'feature/x', action: 'skip', reason: 'needs-force', verdictReason: 'upstream-gone', upstream: 'origin/feature/x', unpushedCommits: 1 });
		const ahead = postPrDocument({ branch: unproven, defaultBranch: { ...plan.defaultBranch, reason: 'up-to-date', remoteAhead: true } });
		const { client } = createFakeClient([ok(ahead, 5), ok(postPrDocument({ mode: 'apply', branch: unproven }), 5)]);
		const fake = createFakeUi();

		await runPostPrCommand(deps(client, fake.ui), '/repo');

		assert.deepStrictEqual(fake.notices, [{ kind: 'warning', message: 'feature/x is not proven merged yet: upstream origin/feature/x is gone, 1 commit found nowhere else.', actions: [] }]);
	});

	test('a branch kept for another reason is not offered a fetch, even when the remote has new commits', async () => {
		const dirty = branch({ name: 'feature/x', action: 'skip', reason: 'dirty-worktree', hint: 'git stash' });
		const { client, calls } = createFakeClient([ok(postPrDocument({ branch: dirty, defaultBranch: { ...plan.defaultBranch, remoteAhead: true } }), 5)]);
		const fake = createFakeUi();

		await runPostPrCommand(deps(client, fake.ui), '/repo');

		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(fake.confirms, []);
		assert.deepStrictEqual(fake.notices, [{ kind: 'warning', message: 'feature/x is not finished: its worktree has uncommitted changes.', actions: [COPY_COMMAND] }]);
	});

	test('the preview lists at most eight other branches; without a fetch, it promises none', () => {
		const many = cleanDocument(Array.from({ length: 10 }, (_, i) => branch({ name: `b${i}` })), { checks: { ...cleanDocument([]).checks, remote: { source: 'local-refs', reason: 'no-fetch' } } });
		const preview = postPrPreview(postPrDocument({ clean: many }), false);
		assert.strictEqual(preview?.detail, 'Also deletes 10 other merged branches: b0, b1, b2, b3, b4, b5, b6, b7 and 2 more.');
	});

	test('on the default branch with nothing to clean, says so; with merged branches, offers to clean them', async () => {
		const idle = createFakeClient([ok(postPrDocument())]);
		const idleUi = createFakeUi();
		await runPostPrCommand(deps(idle.client, idleUi.ui), '/repo');
		assert.deepStrictEqual(idleUi.notices.map((n) => n.message), ['Nothing to finish: you are on main, and no merged branch is left to clean.']);

		const preview = postPrPreview(postPrDocument({ clean: cleanDocument([branch({ name: 'a' })]) }), false);
		assert.deepStrictEqual(preview, {
			message: 'Update main and clean merged branches?',
			detail: 'Also deletes 1 other merged branch: a, and any other branch proven merged after fetching.',
			confirmLabel: 'Update and clean',
		});
	});

	test('a declined preview changes nothing; a failure shows the output', async () => {
		const declined = createFakeClient([ok(plan, 5)]);
		await runPostPrCommand(deps(declined.client, createFakeUi({ confirm: () => false }).ui), '/repo');
		assert.strictEqual(declined.calls.length, 1);

		const failing = createFakeClient([ok(plan, 5), { kind: 'error', exitCode: 1, message: 'fatal: unable to write', code: 'failed', shown: false }]);
		const failingUi = createFakeUi({ notify: () => SHOW_OUTPUT });
		await runPostPrCommand(deps(failing.client, failingUi.ui), '/repo');
		assert.deepStrictEqual(failingUi.notices, [{ kind: 'error', message: 'fatal: unable to write', actions: [SHOW_OUTPUT] }]);
		assert.strictEqual(failingUi.outputShown(), 1);

		const planError = createFakeClient([{ kind: 'error', exitCode: 2, message: 'No branch to finish.', code: 'usage', shown: false }]);
		const planErrorUi = createFakeUi();
		await runPostPrCommand(deps(planError.client, planErrorUi.ui), '/repo');
		assert.deepStrictEqual(planErrorUi.notices.map((n) => n.message), ['No branch to finish.']);
	});

	test('result wording: the main checkout switched, a dirty default branch', () => {
		const switched = postPrPreview(postPrDocument({ branch: merged, worktree: { path: '/repo', removed: false, switched: true } }), false);
		assert.strictEqual(
			switched?.detail,
			'Deletes feature/x: squash-merged into origin/main.\nSwitches the main checkout to main first.\nAlso deletes any other branch proven merged after fetching.'
		);
		const dirty = describePostPrResult(postPrDocument({ mode: 'apply', branch: { ...merged, result: 'deleted' }, defaultBranch: { ...plan.defaultBranch, reason: 'dirty', where: '/repo' } }));
		assert.strictEqual(dirty, 'Finished feature/x: deleted it. main was not updated: its checkout has uncommitted changes.');
		const plannedDirty = postPrPreview(postPrDocument({ branch: merged, defaultBranch: { ...plan.defaultBranch, reason: 'dirty', where: '/repo' } }), false);
		assert.ok(plannedDirty?.detail.includes('Leaves main as it is: /repo has uncommitted changes.'));
	});
});
