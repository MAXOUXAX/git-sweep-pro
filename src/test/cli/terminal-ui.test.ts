import * as assert from 'assert';
import { stripProductPrefix } from '../../cli/io';
import { createTerminalUi, type TerminalUiOptions } from '../../cli/terminal-ui';
import type { QuickPickOptionsLike } from '../../core/sweep-workflow';
import { createFakePrompter } from './fake-prompter';
import { createFakeIo } from './git-fixture';

const pickOptions: QuickPickOptionsLike = {
	canPickMany: false,
	ignoreFocusOut: true,
	matchOnDescription: true,
	title: 'Choose a branch',
	placeHolder: '',
};

const branchItems = [
	{ label: 'a', picked: true },
	{ label: 'b', picked: true },
	{ label: 'c', picked: false },
];

const plain: TerminalUiOptions = { yes: false, presetPick: undefined, spinners: true };

suite('cli terminal ui', () => {
	test('stripProductPrefix drops the product name but keeps a qualifier', () => {
		assert.strictEqual(stripProductPrefix('Git Sweep Pro: Done.'), 'Done.');
		assert.strictEqual(stripProductPrefix('Git Sweep Pro (dry run): 2 would go.'), 'Dry run: 2 would go.');
		assert.strictEqual(stripProductPrefix('Other text'), 'Other text');
	});

	suite('plain output (pipes, CI)', () => {
		test('messages go to stdout and stderr', () => {
			const io = createFakeIo('/repo');
			const ui = createTerminalUi(io, plain);
			ui.showInformationMessage('Git Sweep Pro: hello');
			ui.showErrorMessage('Git Sweep Pro: broken');
			ui.detail('- feature/x');
			assert.deepStrictEqual(io.out, ['hello\n']);
			assert.ok(io.err[0].includes('error:') && io.err[0].includes('broken'));
			assert.ok(io.err[1].includes('- feature/x'));
		});

		test('withProgress prints the title and returns the task result', async () => {
			const io = createFakeIo('/repo');
			assert.strictEqual(await createTerminalUi(io, plain).withProgress({ title: 'Git Sweep Pro: Fetching...' }, async () => 42), 42);
			assert.ok(io.err[0].includes('Fetching...'));
		});

		test('confirm is refused unless --yes', async () => {
			const io = createFakeIo('/repo');
			assert.strictEqual(await createTerminalUi(io, plain).confirm('Delete?', 'Delete 2'), false);
			assert.ok(io.err.some((line) => line.includes('needs --yes')));
			assert.strictEqual(await createTerminalUi(io, { ...plain, yes: true }).confirm('Delete?', 'Delete 2'), true);
		});

		test('pickBranches keeps the pre-selection', async () => {
			const ui = createTerminalUi(createFakeIo('/repo'), plain);
			assert.deepStrictEqual(await ui.pickBranches({ items: branchItems, title: 't', placeHolder: '' }), ['a', 'b']);
		});

		test('showQuickPick falls back to the pre-picked item, or fails without one', async () => {
			const ui = createTerminalUi(createFakeIo('/repo'), plain);
			const items = [{ label: 'dev' }, { label: 'main', picked: true }];
			assert.deepStrictEqual(await ui.showQuickPick(items, pickOptions), items[1]);
			await assert.rejects(async () => ui.showQuickPick([{ label: 'dev' }], pickOptions), /no default available/);
		});

		test('an interactive terminal without a prompter still behaves safely', async () => {
			const ui = createTerminalUi(createFakeIo('/repo', { interactive: true }), plain);
			assert.strictEqual(await ui.confirm('Delete?', 'Delete'), false);
		});
	});

	test('showQuickPick uses the preset branch, matching remote labels too', async () => {
		const items = [{ label: 'main' }, { label: 'origin/dev (remote)' }];
		const io = createFakeIo('/repo');
		assert.deepStrictEqual(await createTerminalUi(io, { ...plain, presetPick: 'origin/dev' }).showQuickPick(items, pickOptions), items[1]);

		const missing = createTerminalUi(io, { ...plain, presetPick: 'nope' });
		await assert.rejects(async () => missing.showQuickPick(items, pickOptions), /Branch "nope" is not available/);
	});

	suite('interactive (prompter)', () => {
		const interactiveIo = () => createFakeIo('/repo', { interactive: true });

		test('messages, details and progress use the widgets', async () => {
			const { prompter, calls } = createFakePrompter();
			const ui = createTerminalUi(interactiveIo(), plain, prompter);
			ui.showInformationMessage('Git Sweep Pro: Deleted 1 branch(es).');
			ui.showErrorMessage('Git Sweep Pro: oops');
			ui.detail('- a');
			assert.strictEqual(await ui.withProgress({ title: 'Git Sweep Pro: Fetching...' }, async () => 'ok'), 'ok');
			assert.deepStrictEqual(calls, ['success Deleted 1 branch(es).', 'error oops', 'detail - a', 'spin Fetching...']);
		});

		test('spinners are skipped when disabled (--verbose)', async () => {
			const { prompter, calls } = createFakePrompter();
			const io = interactiveIo();
			await createTerminalUi(io, { ...plain, spinners: false }, prompter).withProgress({ title: 'Fetching' }, async () => 1);
			assert.deepStrictEqual(calls, []);
			assert.ok(io.err[0].includes('Fetching'));
		});

		test('pickBranches maps the multiselect with the pre-selection as initial values', async () => {
			const { prompter, seen } = createFakePrompter({ multiselect: [0, 2] });
			const ui = createTerminalUi(interactiveIo(), plain, prompter);
			assert.deepStrictEqual(await ui.pickBranches({ items: branchItems, title: 't', placeHolder: '' }), ['a', 'c']);
			assert.deepStrictEqual(seen.initial, [0, 1]);
			assert.deepStrictEqual(seen.options?.map((o) => o.label), ['a', 'b', 'c']);
		});

		test('pickBranches: cancel returns undefined, --yes skips the prompt', async () => {
			const cancelled = createFakePrompter();
			assert.strictEqual(
				await createTerminalUi(interactiveIo(), plain, cancelled.prompter).pickBranches({ items: branchItems, title: 't', placeHolder: '' }),
				undefined
			);
			const yes = createFakePrompter();
			assert.deepStrictEqual(
				await createTerminalUi(interactiveIo(), { ...plain, yes: true }, yes.prompter).pickBranches({ items: branchItems, title: 't', placeHolder: '' }),
				['a', 'b']
			);
			assert.deepStrictEqual(yes.calls, []);
		});

		test('showQuickPick selects with the pre-picked item as initial value', async () => {
			const items = [{ label: 'dev', description: 'local' }, { label: 'main', picked: true }];
			const { prompter, seen } = createFakePrompter({ select: 0 });
			assert.deepStrictEqual(await createTerminalUi(interactiveIo(), plain, prompter).showQuickPick(items, pickOptions), items[0]);
			assert.strictEqual(seen.initial, 1);
			assert.strictEqual(seen.options?.[0].hint, 'local');

			const cancelled = createFakePrompter();
			assert.strictEqual(await createTerminalUi(interactiveIo(), plain, cancelled.prompter).showQuickPick(items, pickOptions), undefined);
		});

		test('confirm only proceeds on an explicit yes', async () => {
			assert.strictEqual(await createTerminalUi(interactiveIo(), plain, createFakePrompter({ confirm: true }).prompter).confirm('m', 'Delete'), true);
			assert.strictEqual(await createTerminalUi(interactiveIo(), plain, createFakePrompter({ confirm: false }).prompter).confirm('m', 'Delete'), false);
			assert.strictEqual(await createTerminalUi(interactiveIo(), plain, createFakePrompter().prompter).confirm('m', 'Delete'), false);
		});
	});
});
