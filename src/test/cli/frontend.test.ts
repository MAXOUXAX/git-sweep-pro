import * as assert from 'assert';
import { parseArgs } from '../../cli/args';
import { createFrontend, createInteractiveFrontend, createPlainFrontend, type TerminalOptions } from '../../cli/frontend';
import { createFakePrompter } from './fake-prompter';
import { createFakeIo } from './git-fixture';

const pick = (items: readonly { label: string; description?: string; picked?: boolean }[]) => ({
	items,
	title: 'Choose a branch',
	placeholder: '',
});

const branchItems = [
	{ label: 'a', picked: true },
	{ label: 'b', picked: true },
	{ label: 'c', picked: false },
];

const plain: TerminalOptions = { yes: false, verbose: false };

suite('cli front ends', () => {
	suite('createFrontend', () => {
		test('--rpc forwards everything to the host as NDJSON', async () => {
			const io = createFakeIo('/repo', { interactive: true });
			const frontend = await createFrontend(parseArgs(['--rpc']), io);
			frontend.trace('$ git fetch -p');
			frontend.ui.showInformationMessage('done');
			assert.deepStrictEqual(io.out.map((line) => JSON.parse(line).type), ['log', 'notify']);
			assert.strictEqual(frontend.intro, undefined);
			assert.strictEqual(frontend.canPrompt, true);
		});

		test('a terminal with a prompter gets the interactive widgets', async () => {
			const { prompter, calls } = createFakePrompter();
			const io = { ...createFakeIo('/repo', { interactive: true }), loadPrompter: async () => prompter };
			const frontend = await createFrontend(parseArgs([]), io);
			frontend.intro?.('gsp sweep');
			assert.deepStrictEqual(calls, ['intro gsp sweep']);
			assert.strictEqual(frontend.canPrompt, true);
			assert.strictEqual((await createFrontend(parseArgs(['--yes']), io)).canPrompt, false, '--yes answers every prompt');
		});

		test('without a prompter, even an interactive terminal stays on safe defaults', async () => {
			const frontend = await createFrontend(parseArgs([]), createFakeIo('/repo', { interactive: true }));
			assert.strictEqual(await frontend.ui.confirm('Delete?', 'Delete'), false);
			assert.strictEqual(frontend.intro, undefined);
			assert.strictEqual(frontend.canPrompt, false);
		});
	});

	suite('plain (pipes, CI)', () => {
		test('messages go to stdout, errors and output to stderr', () => {
			const io = createFakeIo('/repo');
			const frontend = createPlainFrontend(io, plain);
			frontend.ui.showInformationMessage('hello');
			frontend.ui.showInformationMessage('2 branch(es) would be deleted.', { dryRun: true });
			frontend.ui.showErrorMessage('broken', { failed: true, seeOutput: true });
			frontend.output.appendLine('- feature/x');
			assert.deepStrictEqual(io.out, ['hello\n', 'Dry run: 2 branch(es) would be deleted.\n']);
			assert.ok(io.err[0].includes('error:') && io.err[0].endsWith(' broken\n'));
			assert.ok(io.err[1].includes('- feature/x'));
		});

		test('session headers and git traces only show with --verbose', () => {
			const quiet = createFakeIo('/repo');
			const quietFrontend = createPlainFrontend(quiet, plain);
			quietFrontend.output.header('--- Git Sweep session started ---');
			quietFrontend.trace('$ git fetch -p');
			assert.deepStrictEqual(quiet.err, []);

			const verbose = createFakeIo('/repo');
			const verboseFrontend = createPlainFrontend(verbose, { ...plain, verbose: true });
			verboseFrontend.output.header('--- Git Sweep session started ---');
			verboseFrontend.trace('$ git fetch -p');
			assert.strictEqual(verbose.err.length, 2);
			assert.strictEqual(verbose.err[1], '$ git fetch -p\n');
		});

		test('withProgress prints the title and returns the task result', async () => {
			const io = createFakeIo('/repo');
			assert.strictEqual(await createPlainFrontend(io, plain).ui.withProgress({ title: 'Fetching' }, async () => 42), 42);
			assert.ok(io.err[0].includes('Fetching'));
		});

		test('confirm is refused unless --yes', async () => {
			const io = createFakeIo('/repo');
			assert.strictEqual(await createPlainFrontend(io, plain).ui.confirm('Delete?', 'Delete 2'), false);
			assert.ok(io.err.some((line) => line.includes('needs --yes')));
			assert.strictEqual(await createPlainFrontend(io, { ...plain, yes: true }).ui.confirm('Delete?', 'Delete 2'), true);
		});

		test('pickMany keeps the pre-selection', async () => {
			const { ui } = createPlainFrontend(createFakeIo('/repo'), plain);
			assert.deepStrictEqual(await ui.pickMany({ items: branchItems, title: 't' }), ['a', 'b']);
		});

		test('pickOne falls back to the pre-picked item, or fails without one', async () => {
			const { ui } = createPlainFrontend(createFakeIo('/repo'), plain);
			assert.strictEqual(await ui.pickOne(pick([{ label: 'dev' }, { label: 'main', picked: true }])), 'main');
			await assert.rejects(async () => ui.pickOne(pick([{ label: 'dev' }])), /no default available/);
		});

	});

	suite('interactive (prompter)', () => {
		const interactiveIo = () => createFakeIo('/repo', { interactive: true });

		test('messages, output, progress and the session frame use the widgets', async () => {
			const { prompter, calls } = createFakePrompter();
			const frontend = createInteractiveFrontend(interactiveIo(), plain, prompter);
			frontend.ui.showInformationMessage('Deleted 1 branch(es).');
			frontend.ui.showErrorMessage('oops', { failed: true });
			frontend.output.header('--- Git Sweep session started ---');
			frontend.output.appendLine('- a');
			assert.strictEqual(await frontend.ui.withProgress({ title: 'Fetching' }, async () => 'ok'), 'ok');
			frontend.outro?.('paused');
			assert.deepStrictEqual(calls, [
				'success Deleted 1 branch(es).',
				'error oops',
				'detail - a',
				'spin Fetching',
				'outro Paused: resolve the conflicts, then run "gsp resume".',
			]);
		});

		test('spinners are skipped with --verbose', async () => {
			const { prompter, calls } = createFakePrompter();
			const io = interactiveIo();
			await createInteractiveFrontend(io, { ...plain, verbose: true }, prompter).ui.withProgress({ title: 'Fetching' }, async () => 1);
			assert.deepStrictEqual(calls, []);
			assert.ok(io.err[0].includes('Fetching'));
		});

		test('pickMany maps the multiselect with the pre-selection as initial values', async () => {
			const { prompter, seen } = createFakePrompter({ multiselect: [0, 2] });
			const { ui } = createInteractiveFrontend(interactiveIo(), plain, prompter);
			assert.deepStrictEqual(await ui.pickMany({ items: branchItems, title: 't' }), ['a', 'c']);
			assert.deepStrictEqual(seen.initial, [0, 1]);
			assert.deepStrictEqual(seen.options?.map((o) => o.label), ['a', 'b', 'c']);
		});

		test('pickMany: cancel returns undefined, --yes skips the prompt', async () => {
			const cancelled = createFakePrompter();
			assert.strictEqual(
				await createInteractiveFrontend(interactiveIo(), plain, cancelled.prompter).ui.pickMany({ items: branchItems, title: 't' }),
				undefined
			);
			const yes = createFakePrompter();
			assert.deepStrictEqual(
				await createInteractiveFrontend(interactiveIo(), { ...plain, yes: true }, yes.prompter).ui.pickMany({ items: branchItems, title: 't' }),
				['a', 'b']
			);
			assert.deepStrictEqual(yes.calls, []);
		});

		test('pickOne selects with the pre-picked item as initial value', async () => {
			const items = [{ label: 'dev', description: 'local' }, { label: 'main', picked: true }];
			const { prompter, seen } = createFakePrompter({ select: 0 });
			assert.strictEqual(await createInteractiveFrontend(interactiveIo(), plain, prompter).ui.pickOne(pick(items)), 'dev');
			assert.strictEqual(seen.initial, 1);
			assert.strictEqual(seen.options?.[0].hint, 'local');

			const cancelled = createFakePrompter();
			assert.strictEqual(await createInteractiveFrontend(interactiveIo(), plain, cancelled.prompter).ui.pickOne(pick(items)), undefined);
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
