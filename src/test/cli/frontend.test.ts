import * as assert from 'assert';
import { parseArgs } from '../../cli/args';
import { createFrontend, createInteractiveFrontend, createPlainFrontend, type TerminalOptions } from '../../cli/frontend';
import { stripProductPrefix } from '../../cli/io';
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

const plain: TerminalOptions = { yes: false, presetPick: undefined, verbose: false };

suite('cli front ends', () => {
	test('stripProductPrefix drops the product name but keeps a qualifier', () => {
		assert.strictEqual(stripProductPrefix('Git Sweep Pro: Done.'), 'Done.');
		assert.strictEqual(stripProductPrefix('Git Sweep Pro (dry run): 2 would go.'), 'Dry run: 2 would go.');
		assert.strictEqual(stripProductPrefix('Other text'), 'Other text');
	});

	suite('createFrontend', () => {
		test('--rpc forwards everything to the host as NDJSON', async () => {
			const io = createFakeIo('/repo', { interactive: true });
			const frontend = await createFrontend(parseArgs(['--rpc']), io);
			frontend.trace('$ git fetch -p');
			frontend.ui.showInformationMessage('done');
			assert.deepStrictEqual(io.out.map((line) => JSON.parse(line).type), ['log', 'notify']);
			assert.strictEqual(frontend.intro, undefined);
		});

		test('a terminal with a prompter gets the interactive widgets', async () => {
			const { prompter, calls } = createFakePrompter();
			const io = { ...createFakeIo('/repo', { interactive: true }), loadPrompter: async () => prompter };
			const frontend = await createFrontend(parseArgs([]), io);
			frontend.intro?.('git sweep-pro sweep');
			assert.deepStrictEqual(calls, ['intro git sweep-pro sweep']);
		});

		test('without a prompter, even an interactive terminal stays on safe defaults', async () => {
			const frontend = await createFrontend(parseArgs([]), createFakeIo('/repo', { interactive: true }));
			assert.strictEqual(await frontend.ui.confirm('Delete?', 'Delete'), false);
			assert.strictEqual(frontend.intro, undefined);
		});
	});

	suite('plain (pipes, CI)', () => {
		test('messages go to stdout, errors and output to stderr', () => {
			const io = createFakeIo('/repo');
			const frontend = createPlainFrontend(io, plain);
			frontend.ui.showInformationMessage('Git Sweep Pro: hello');
			frontend.ui.showErrorMessage('Git Sweep Pro: broken');
			frontend.output.appendLine('- feature/x');
			assert.deepStrictEqual(io.out, ['hello\n']);
			assert.ok(io.err[0].includes('error:') && io.err[0].includes('broken'));
			assert.ok(io.err[1].includes('- feature/x'));
		});

		test('git traces only show with --verbose', () => {
			const quiet = createFakeIo('/repo');
			createPlainFrontend(quiet, plain).trace('$ git fetch -p');
			assert.deepStrictEqual(quiet.err, []);

			const verbose = createFakeIo('/repo');
			createPlainFrontend(verbose, { ...plain, verbose: true }).trace('$ git fetch -p');
			assert.deepStrictEqual(verbose.err, ['$ git fetch -p\n']);
		});

		test('withProgress prints the title and returns the task result', async () => {
			const io = createFakeIo('/repo');
			assert.strictEqual(await createPlainFrontend(io, plain).ui.withProgress({ title: 'Git Sweep Pro: Fetching...' }, async () => 42), 42);
			assert.ok(io.err[0].includes('Fetching...'));
		});

		test('confirm is refused unless --yes', async () => {
			const io = createFakeIo('/repo');
			assert.strictEqual(await createPlainFrontend(io, plain).ui.confirm('Delete?', 'Delete 2'), false);
			assert.ok(io.err.some((line) => line.includes('needs --yes')));
			assert.strictEqual(await createPlainFrontend(io, { ...plain, yes: true }).ui.confirm('Delete?', 'Delete 2'), true);
		});

		test('pickBranches keeps the pre-selection', async () => {
			const { ui } = createPlainFrontend(createFakeIo('/repo'), plain);
			assert.deepStrictEqual(await ui.pickBranches({ items: branchItems, title: 't', placeHolder: '' }), ['a', 'b']);
		});

		test('showQuickPick falls back to the pre-picked item, or fails without one', async () => {
			const { ui } = createPlainFrontend(createFakeIo('/repo'), plain);
			const items = [{ label: 'dev' }, { label: 'main', picked: true }];
			assert.deepStrictEqual(await ui.showQuickPick(items, pickOptions), items[1]);
			await assert.rejects(async () => ui.showQuickPick([{ label: 'dev' }], pickOptions), /no default available/);
		});

		test('showQuickPick uses the preset branch, matching remote labels too', async () => {
			const items = [{ label: 'main' }, { label: 'origin/dev (remote)' }];
			const io = createFakeIo('/repo');
			assert.deepStrictEqual(await createPlainFrontend(io, { ...plain, presetPick: 'origin/dev' }).ui.showQuickPick(items, pickOptions), items[1]);

			const missing = createPlainFrontend(io, { ...plain, presetPick: 'nope' });
			await assert.rejects(async () => missing.ui.showQuickPick(items, pickOptions), /Branch "nope" is not available/);
		});
	});

	suite('interactive (prompter)', () => {
		const interactiveIo = () => createFakeIo('/repo', { interactive: true });

		test('messages, output, progress and the session frame use the widgets', async () => {
			const { prompter, calls } = createFakePrompter();
			const frontend = createInteractiveFrontend(interactiveIo(), plain, prompter);
			frontend.ui.showInformationMessage('Git Sweep Pro: Deleted 1 branch(es).');
			frontend.ui.showErrorMessage('Git Sweep Pro: oops');
			frontend.output.appendLine('- a');
			assert.strictEqual(await frontend.ui.withProgress({ title: 'Git Sweep Pro: Fetching...' }, async () => 'ok'), 'ok');
			frontend.outro?.('paused');
			assert.deepStrictEqual(calls, [
				'success Deleted 1 branch(es).',
				'error oops',
				'detail - a',
				'spin Fetching...',
				'outro Paused: resolve the conflicts, then run "git sweep-pro sync --continue".',
			]);
		});

		test('spinners are skipped with --verbose', async () => {
			const { prompter, calls } = createFakePrompter();
			const io = interactiveIo();
			await createInteractiveFrontend(io, { ...plain, verbose: true }, prompter).ui.withProgress({ title: 'Fetching' }, async () => 1);
			assert.deepStrictEqual(calls, []);
			assert.ok(io.err[0].includes('Fetching'));
		});

		test('pickBranches maps the multiselect with the pre-selection as initial values', async () => {
			const { prompter, seen } = createFakePrompter({ multiselect: [0, 2] });
			const { ui } = createInteractiveFrontend(interactiveIo(), plain, prompter);
			assert.deepStrictEqual(await ui.pickBranches({ items: branchItems, title: 't', placeHolder: '' }), ['a', 'c']);
			assert.deepStrictEqual(seen.initial, [0, 1]);
			assert.deepStrictEqual(seen.options?.map((o) => o.label), ['a', 'b', 'c']);
		});

		test('pickBranches: cancel returns undefined, --yes skips the prompt', async () => {
			const cancelled = createFakePrompter();
			assert.strictEqual(
				await createInteractiveFrontend(interactiveIo(), plain, cancelled.prompter).ui.pickBranches({ items: branchItems, title: 't', placeHolder: '' }),
				undefined
			);
			const yes = createFakePrompter();
			assert.deepStrictEqual(
				await createInteractiveFrontend(interactiveIo(), { ...plain, yes: true }, yes.prompter).ui.pickBranches({ items: branchItems, title: 't', placeHolder: '' }),
				['a', 'b']
			);
			assert.deepStrictEqual(yes.calls, []);
		});

		test('showQuickPick selects with the pre-picked item as initial value', async () => {
			const items = [{ label: 'dev', description: 'local' }, { label: 'main', picked: true }];
			const { prompter, seen } = createFakePrompter({ select: 0 });
			assert.deepStrictEqual(await createInteractiveFrontend(interactiveIo(), plain, prompter).ui.showQuickPick(items, pickOptions), items[0]);
			assert.strictEqual(seen.initial, 1);
			assert.strictEqual(seen.options?.[0].hint, 'local');

			const cancelled = createFakePrompter();
			assert.strictEqual(await createInteractiveFrontend(interactiveIo(), plain, cancelled.prompter).ui.showQuickPick(items, pickOptions), undefined);
		});

		test('confirm only proceeds on an explicit yes, or with --yes', async () => {
			const confirm = (answer: boolean | undefined, yes = false) =>
				createInteractiveFrontend(interactiveIo(), { ...plain, yes }, createFakePrompter({ confirm: answer }).prompter).ui.confirm('m', 'Delete');
			assert.strictEqual(await confirm(true), true);
			assert.strictEqual(await confirm(false), false);
			assert.strictEqual(await confirm(undefined), false);
			assert.strictEqual(await confirm(undefined, true), true);
		});
	});
});
