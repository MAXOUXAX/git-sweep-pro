import * as assert from 'assert';
import { buildCleanSections, confirmLocal, confirmRemote, describeCleanResult, displayPath, pickerPlaceholder, type CleanEntry } from '../../vscode/clean-model';
import { NO_ORIGIN_NOTE, runCleanCommand, type CleanCommandOptions } from '../../vscode/clean-command';
import { SHOW_OUTPUT, UNDO } from '../../vscode/command-ui';
import { readJsonRun } from '../../vscode/gsp-client';
import { branch, cleanDocument, createFakeClient, createFakeUi, deps, ok, remoteBranch } from './fakes';

const OPTIONS: CleanCommandOptions = { root: '/repo', readOnly: false, force: false, remote: false, confirm: true };

const squashed = branch({ name: 'feature/squash', worktree: { path: '/work/wt-squash', isMain: false, dirty: false, locked: false, prunable: false, inProgress: null, ignoredFiles: { count: 0, sample: [] }, submodules: false, processes: null, changedFiles: null } });
const empty = branch({ name: 'feature/empty', reason: 'empty', verdictReason: 'empty' });
const unpushed = branch({
	name: 'feature/unpushed',
	action: 'skip',
	reason: 'needs-force',
	verdictReason: 'upstream-gone',
	upstream: 'origin/feature/unpushed',
	upstreamState: 'gone',
	unpushedCommits: 2,
	needsForce: true,
	hint: 'gsp clean feature/unpushed --yes --force',
});
const dirty = branch({ name: 'feature/dirty', action: 'skip', reason: 'dirty-worktree', hint: 'git -C /work/wt-dirty stash --include-untracked && gsp clean feature/dirty --yes' });
const wip = branch({ name: 'feature/wip', action: 'keep', reason: 'unmerged-commits', verdict: 'alive', verdictReason: 'unmerged-commits', evidence: { method: 'unique-commits', base: 'refs/remotes/origin/main', commits: 1 } as never });

/** The document after applying: the given branches deleted, the others as planned. */
const applied = (deleted: readonly string[], branches = [squashed, empty]) =>
	cleanDocument(branches.map((b) => (deleted.includes(b.name) ? { ...b, result: 'deleted' as const } : b)), { mode: 'apply' });

const entries = (sections: ReturnType<typeof buildCleanSections>) => sections.flatMap((section) => section.entries);
const pickAll = (_: unknown, document: Parameters<typeof buildCleanSections>[0] | undefined) => ({ kind: 'picked' as const, entries: entries(buildCleanSections(document!, { force: true })).filter((e) => e.selectable) });

suite('clean model', () => {
	test('sections: planned deletions picked, skipped and kept below with why and how to fix it', () => {
		const sections = buildCleanSections(cleanDocument([wip, dirty, unpushed, squashed]), { force: false });
		assert.deepStrictEqual(sections.map((s) => [s.title, s.entries.map((e) => [e.arg, e.selectable, e.picked])]), [
			['To delete', [['feature/squash', true, true]]],
			['Skipped', [['feature/dirty', false, false], ['feature/unpushed', false, false]]],
			['Kept', [['feature/wip', false, false]]],
		]);
		const [toDelete, skipped, kept] = sections;
		assert.strictEqual(toDelete.entries[0].description, 'squash-merged into origin/main');
		assert.strictEqual(toDelete.entries[0].detail, 'Removes the worktree /work/wt-squash');
		assert.strictEqual(skipped.entries[0].detail, 'Its worktree has uncommitted changes');
		assert.strictEqual(skipped.entries[0].hint, dirty.hint);
		assert.strictEqual(skipped.entries[1].description, 'upstream origin/feature/unpushed is gone, 2 commits found nowhere else');
		assert.strictEqual(kept.entries[0].description, '1 commit not merged into origin/main');
	});

	test('force mode offers what only a forced delete removes, never picked; a worktree holding ignored files stays skipped', () => {
		const ignored = branch({
			name: 'feature/ignored',
			action: 'skip',
			reason: 'ignored-files',
			worktree: { path: '/work/wt-ignored', isMain: false, dirty: false, locked: false, prunable: false, inProgress: null, ignoredFiles: { count: 4, sample: ['.env', 'notes/', 'a.key', 'b.key'] }, submodules: false, processes: null, changedFiles: null },
		});
		const sections = buildCleanSections(cleanDocument([unpushed, ignored, dirty]), { force: true });
		assert.deepStrictEqual(sections.map((s) => [s.title, s.entries.map((e) => [e.arg, e.selectable, e.picked, e.forced])]), [
			['Needs a forced delete', [['feature/unpushed', true, false, true]]],
			['Skipped', [['feature/ignored', false, false, false], ['feature/dirty', false, false, false]]],
		]);
		// --force never deletes what a worktree would lose for good: that takes --discard-changes.
		assert.strictEqual(sections[1].entries[0].detail, 'Its worktree holds 4 ignored files: .env, notes/, a.key and 1 more');

		const confirmation = confirmLocal(sections[0].entries);
		assert.strictEqual(confirmation.confirmLabel, 'Force delete branch');
		assert.ok(confirmation.detail.endsWith('feature/unpushed is not proven merged: undo brings it back only until Git cleans up unreachable commits.'), confirmation.detail);
	});

	test('remote branches get their own sections, named by remote', () => {
		const document = cleanDocument([], {
			remoteBranches: [remoteBranch({ name: 'feature/a' }), remoteBranch({ name: 'release/1', action: 'skip', reason: 'protected', protected: { by: 'pattern', pattern: 'release/*' } })],
			checks: { ...cleanDocument([]).checks, cleanedRemote: { remote: 'origin', defaultBranch: 'main', github: null } } as never,
		});
		const sections = buildCleanSections(document, { force: false });
		assert.deepStrictEqual(sections.map((s) => [s.title, s.entries.map((e) => [e.arg, e.label, e.selectable])]), [
			['To delete on origin', [['origin/feature/a', '$(cloud) origin/feature/a', true]]],
			['Skipped on origin', [['origin/release/1', '$(cloud) origin/release/1', false]]],
		]);
		assert.strictEqual(sections[1].entries[0].detail, 'Protected by "release/*"');
		assert.deepStrictEqual(confirmRemote(sections[0].entries, 'origin'), {
			message: 'Delete feature/a on origin?',
			detail: 'This deletes it for everyone who uses origin. You can push it back from the notification, or with gsp restore.',
			confirmLabel: 'Delete on origin',
		});
	});

	test('confirmations name one branch, and list at most eight', () => {
		const one = confirmLocal(buildCleanSections(cleanDocument([empty]), { force: false })[0].entries);
		assert.deepStrictEqual(one, { message: 'Delete feature/empty?', detail: 'You can undo this from the notification, or with gsp restore.', confirmLabel: 'Delete branch' });
		const many = Array.from({ length: 10 }, (_, i) => ({ arg: `b${i}`, scope: 'local' }) as CleanEntry);
		assert.ok(confirmLocal(many).detail.startsWith('b0\nb1\nb2\nb3\nb4\nb5\nb6\nb7\nand 2 more'));
	});

	test('result wording and placeholders', () => {
		assert.strictEqual(describeCleanResult({ local: ['a'], remote: [] }, 0, []), 'Deleted a.');
		assert.strictEqual(describeCleanResult({ local: ['a', 'b'], remote: [] }, 1, [{ arg: 'c', why: 'Changed since the plan' }]), "Deleted 2 branches and 1 worktree. c wasn't deleted: changed since the plan.");
		assert.strictEqual(describeCleanResult({ local: [], remote: ['x', 'y'], remoteName: 'origin' }, 0, []), 'Deleted 2 branches on origin.');
		assert.strictEqual(describeCleanResult({ local: [], remote: [] }, 0, [{ arg: 'a', why: 'X' }, { arg: 'b', why: 'Y' }]), "Nothing was deleted. 2 branches weren't deleted: a (x) and b (y).");
		const many = Array.from({ length: 10 }, (_, i) => ({ arg: `b${i}`, why: 'X' }));
		assert.strictEqual(
			describeCleanResult({ local: [], remote: [] }, 0, many),
			"Nothing was deleted. 10 branches weren't deleted: b0 (x), b1 (x), b2 (x), b3 (x), b4 (x), b5 (x), b6 (x), b7 (x) and 2 more."
		);
		assert.strictEqual(pickerPlaceholder(buildCleanSections(cleanDocument([dirty]), { force: false }), false), 'Nothing to delete. 1 branch is skipped: see why below.');
		assert.strictEqual(pickerPlaceholder(buildCleanSections(cleanDocument([empty]), { force: false }), true), '1 branch to delete. Nothing changes until you run Sweep Stale Branches.');
		assert.strictEqual(displayPath('/home/me/code/x', '/home/me'), '~/code/x');
		assert.strictEqual(displayPath('/elsewhere', '/home/me'), '/elsewhere');
	});

	test('readJsonRun reads the document, the error document and a crash', () => {
		assert.deepStrictEqual(readJsonRun({ exitCode: 5, errorShown: false, document: { schema: 2 } }), { kind: 'document', exitCode: 5, document: { schema: 2 } });
		assert.deepStrictEqual(readJsonRun({ exitCode: 2, errorShown: false, document: { schema: 2, error: { message: 'No branch named "x".', code: 'unknown-branch' } } }), {
			kind: 'error',
			exitCode: 2,
			message: 'No branch named "x".',
			code: 'unknown-branch',
			shown: false,
		});
		assert.strictEqual(readJsonRun({ exitCode: 1, errorShown: true }).kind, 'error');
	});
});

suite('Sweep Stale Branches command', () => {
	test('plans read-only, deletes exactly the picked branches at the tips shown, and offers Undo', async () => {
		const { client, calls } = createFakeClient([ok(cleanDocument([squashed, { ...empty, tip: 'e3b0c44' }, dirty]), 5), ok(applied(['feature/squash', 'feature/empty']))]);
		const fake = createFakeUi({ pick: pickAll, notify: (message) => (message.startsWith('Deleted') ? UNDO : undefined) });

		await runCleanCommand(deps(client, fake.ui), OPTIONS);

		assert.deepStrictEqual(calls.map((call) => [call.args, call.json]), [
			[['clean'], true],
			[['clean', '--yes', '--expect', 'feature/squash=a4d8464', '--expect', 'feature/empty=e3b0c44'], true],
			[['restore', 'feature/squash', 'feature/empty'], false],
		]);
		assert.strictEqual(fake.confirms[0].message, 'Delete 2 branches?');
		assert.deepStrictEqual(fake.notices, [
			{ kind: 'info', message: 'Deleted 2 branches and 1 worktree.', actions: [UNDO] },
			{ kind: 'info', message: 'Restored 2 branches.', actions: [] },
		]);
		assert.deepStrictEqual(fake.progress, ['Deleting branches', 'Restoring 2 branches']);
	});

	test('Undo says when gsp could not restore, unless the CLI already did', async () => {
		const failing = createFakeClient([ok(cleanDocument([empty]), 5), ok(applied(['feature/empty'], [empty]))]);
		failing.runResults.push({ exitCode: 1, errorShown: false });
		const failingUi = createFakeUi({ pick: pickAll, notify: (message) => (message.startsWith('Deleted') ? UNDO : SHOW_OUTPUT) });
		await runCleanCommand(deps(failing.client, failingUi.ui), OPTIONS);
		assert.deepStrictEqual(failingUi.notices.at(-1), { kind: 'error', message: 'Could not restore feature/empty.', actions: [SHOW_OUTPUT] });
		assert.strictEqual(failingUi.outputShown(), 1);

		const shown = createFakeClient([ok(cleanDocument([empty]), 5), ok(applied(['feature/empty'], [empty]))]);
		shown.runResults.push({ exitCode: 1, errorShown: true });
		const shownUi = createFakeUi({ pick: pickAll, notify: () => UNDO });
		await runCleanCommand(deps(shown.client, shownUi.ui), OPTIONS);
		assert.strictEqual(shownUi.notices.length, 1);
	});

	test('proven and forced picks go in separate runs: only the forced one gets --force', async () => {
		const forcedDone = cleanDocument([{ ...unpushed, action: 'delete', result: 'deleted' }], { mode: 'apply' });
		const { client, calls } = createFakeClient([ok(cleanDocument([empty, unpushed]), 5), ok(applied(['feature/empty'], [empty])), ok(forcedDone)]);
		const fake = createFakeUi({ pick: pickAll });

		await runCleanCommand(deps(client, fake.ui), { ...OPTIONS, force: true });

		assert.deepStrictEqual(calls.map((call) => call.args), [
			['clean'],
			['clean', '--yes', '--expect', 'feature/empty=a4d8464'],
			['clean', '--yes', '--force', '--expect', 'feature/unpushed=a4d8464'],
		]);
		assert.deepStrictEqual(fake.progress, ['Deleting branches', 'Force deleting feature/unpushed']);
		assert.strictEqual(fake.notices[0].message, 'Deleted 2 branches.');
	});

	test('a forced pick adds --force, and is confirmed even when confirmations are off', async () => {
		const { client, calls } = createFakeClient([ok(cleanDocument([unpushed]), 5), ok(applied(['feature/unpushed'], [unpushed]))]);
		const fake = createFakeUi({ pick: pickAll });

		await runCleanCommand(deps(client, fake.ui), { ...OPTIONS, force: true, confirm: false });

		assert.deepStrictEqual(calls[1].args, ['clean', '--yes', '--force', '--expect', 'feature/unpushed=a4d8464']);
		assert.strictEqual(fake.confirms.length, 1);
		assert.strictEqual(fake.pickers[0].options.force, true);
	});

	test('without confirmations, proven deletions apply at once; a declined confirmation deletes nothing', async () => {
		const quiet = createFakeClient([ok(cleanDocument([empty]), 5), ok(applied(['feature/empty'], [empty]))]);
		const quietUi = createFakeUi({ pick: pickAll });
		await runCleanCommand(deps(quiet.client, quietUi.ui), { ...OPTIONS, confirm: false });
		assert.strictEqual(quietUi.confirms.length, 0);
		assert.strictEqual(quiet.calls.length, 2);

		const declined = createFakeClient([ok(cleanDocument([empty]), 5)]);
		const declinedUi = createFakeUi({ pick: pickAll, confirm: () => false });
		await runCleanCommand(deps(declined.client, declinedUi.ui), OPTIONS);
		assert.strictEqual(declined.calls.length, 1, 'only the plan ran');
		assert.deepStrictEqual(declinedUi.notices, []);
	});

	test('remote branches: their own confirmation, then a second run with --remote and qualified names only', async () => {
		const plan = cleanDocument([empty], {
			remoteBranches: [remoteBranch({ name: 'feature/empty' }), remoteBranch({ name: 'feature/b' })],
			checks: { ...cleanDocument([]).checks, cleanedRemote: { remote: 'origin', defaultBranch: 'main', github: null } } as never,
		});
		const remoteApplied = cleanDocument([], { mode: 'apply', remoteBranches: plan.remoteBranches!.map((b) => ({ ...b, result: 'deleted' as const })) });
		const { client, calls } = createFakeClient([ok(plan, 5), ok(applied(['feature/empty'], [empty])), ok(remoteApplied)]);
		const fake = createFakeUi({ pick: pickAll, notify: () => UNDO });

		await runCleanCommand(deps(client, fake.ui), { ...OPTIONS, remote: true });

		assert.deepStrictEqual(fake.confirms.map((c) => c.message), ['Delete feature/empty?', 'Delete 2 branches on origin?']);
		assert.deepStrictEqual(calls.map((call) => call.args), [
			['clean', '--remote'],
			['clean', '--yes', '--expect', 'feature/empty=a4d8464'],
			['clean', '--yes', '--remote=origin', '--expect', 'origin/feature/empty=b5e9575', '--expect', 'origin/feature/b=b5e9575'],
			['restore', 'feature/empty', 'origin/feature/empty', 'origin/feature/b'],
		]);
		assert.strictEqual(fake.notices[0].message, 'Deleted feature/empty. Also deleted 2 branches on origin.');
	});

	test('cancelling the local confirmation cancels the remote deletions too', async () => {
		const plan = cleanDocument([empty], { remoteBranches: [remoteBranch({ name: 'feature/b' })] });
		const { client, calls } = createFakeClient([ok(plan, 5)]);
		const fake = createFakeUi({ pick: pickAll, confirm: () => false });

		await runCleanCommand(deps(client, fake.ui), { ...OPTIONS, remote: true });

		assert.strictEqual(fake.confirms.length, 1);
		assert.strictEqual(calls.length, 1);
	});

	test('declining the remote confirmation still deletes the confirmed local branches', async () => {
		const plan = cleanDocument([empty], { remoteBranches: [remoteBranch({ name: 'feature/b' })], summary: { ...cleanDocument([]).summary, remote: { remote: 'origin', delete: 1, deleted: 0, failed: 0, skipped: 0, kept: 0 } } });
		const { client, calls } = createFakeClient([ok(plan, 5), ok(applied(['feature/empty'], [empty]))]);
		const fake = createFakeUi({ pick: pickAll, confirm: (c) => !c.message.includes('on origin') });

		await runCleanCommand(deps(client, fake.ui), { ...OPTIONS, remote: true });

		assert.deepStrictEqual(calls.map((call) => call.args), [['clean', '--remote'], ['clean', '--yes', '--expect', 'feature/empty=a4d8464']]);
	});

	test('what changed while applying is reported with why, as a warning', async () => {
		const changed = { ...empty, action: 'skip' as const, reason: 'plan-changed' as const };
		const { client } = createFakeClient([ok(cleanDocument([squashed, empty]), 5), ok(cleanDocument([{ ...squashed, result: 'deleted' }, changed], { mode: 'apply' }), 5)]);
		const fake = createFakeUi({ pick: pickAll, notify: () => SHOW_OUTPUT });

		await runCleanCommand(deps(client, fake.ui), OPTIONS);

		assert.deepStrictEqual(fake.notices, [{ kind: 'warning', message: "Deleted feature/squash and 1 worktree. feature/empty wasn't deleted: changed since the plan.", actions: [UNDO, SHOW_OUTPUT] }]);
		assert.strictEqual(fake.outputShown(), 1);
	});

	test('a failed deletion is an error with its message', async () => {
		const failed = { ...empty, result: 'failed' as const, error: 'cannot lock ref' };
		const { client } = createFakeClient([ok(cleanDocument([empty]), 5), ok(cleanDocument([failed], { mode: 'apply' }), 1)]);
		const fake = createFakeUi({ pick: pickAll });

		await runCleanCommand(deps(client, fake.ui), OPTIONS);

		assert.deepStrictEqual(fake.notices, [{ kind: 'error', message: "Nothing was deleted. feature/empty wasn't deleted: cannot lock ref.", actions: [SHOW_OUTPUT] }]);
	});

	test('a plan error shows the JSON error, unless the CLI already did', async () => {
		const usage = createFakeClient([{ kind: 'error', exitCode: 2, message: 'No remote named "origin".', code: 'unknown-remote', shown: false }]);
		const usageUi = createFakeUi({ notify: () => SHOW_OUTPUT });
		await runCleanCommand(deps(usage.client, usageUi.ui), OPTIONS);
		assert.deepStrictEqual(usageUi.notices, [{ kind: 'error', message: 'No remote named "origin".', actions: [SHOW_OUTPUT] }]);
		assert.strictEqual(usageUi.pickers[0].document, undefined, 'the picker closes');
		assert.strictEqual(usageUi.outputShown(), 1);

		const shown = createFakeClient([{ kind: 'error', exitCode: 1, message: 'not a git repository', code: 'not-a-repository', shown: true }]);
		const shownUi = createFakeUi();
		await runCleanCommand(deps(shown.client, shownUi.ui), OPTIONS);
		assert.deepStrictEqual(shownUi.notices, []);
	});

	test('with no remote to pick, remote branches are left out of the plan, with a note saying why', async () => {
		const { client, calls } = createFakeClient([{ kind: 'error', exitCode: 2, message: 'No remote named "origin".', code: 'unknown-remote', shown: false }, ok(cleanDocument([empty]), 5)]);
		const fake = createFakeUi({ pick: () => ({ kind: 'closed' }) });

		await runCleanCommand(deps(client, fake.ui), { ...OPTIONS, remote: true });

		assert.deepStrictEqual(calls.map((call) => call.args), [['clean', '--remote'], ['clean']]);
		assert.strictEqual(await fake.pickers[0].options.note, NO_ORIGIN_NOTE);
		assert.deepStrictEqual(fake.pickers[0].document?.branches, [empty]);
		assert.deepStrictEqual(fake.notices, []);
	});

	test('closing the picker before the plan is read stops it, and drops what it would say', async () => {
		let finishPlan!: (run: ReturnType<typeof ok>) => void;
		const { client, signals } = createFakeClient([() => new Promise((resolve) => (finishPlan = resolve)) as never]);
		const fake = createFakeUi();
		const ui = { ...fake.ui, pickCleanup: async () => ({ kind: 'closed' as const }) };

		await runCleanCommand(deps(client, ui), OPTIONS);

		assert.strictEqual(signals[0]?.aborted, true);
		finishPlan({ kind: 'error', exitCode: -1, message: 'stopped', code: 'crashed', shown: false } as never);
		assert.deepStrictEqual(fake.notices, []);
	});

	test('nothing to clean, nothing picked, a closed picker and a preview delete nothing', async () => {
		for (const [pick, expected] of [
			[{ kind: 'empty' }, ['Nothing to clean.']],
			[{ kind: 'picked', entries: [] }, ['No branch selected. Nothing was deleted.']],
			[{ kind: 'closed' }, []],
		] as const) {
			const { client, calls } = createFakeClient([ok(cleanDocument([empty]), 5)]);
			const fake = createFakeUi({ pick: () => pick });
			await runCleanCommand(deps(client, fake.ui), OPTIONS);
			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(fake.notices.map((n) => n.message), expected);
		}

		const { client } = createFakeClient([ok(cleanDocument([empty]), 5)]);
		const fake = createFakeUi({ pick: () => ({ kind: 'closed' }) });
		await runCleanCommand(deps(client, fake.ui), { ...OPTIONS, readOnly: true });
		assert.deepStrictEqual([fake.pickers[0].options.title, fake.pickers[0].options.readOnly], ['Preview stale branches', true]);
	});
});
