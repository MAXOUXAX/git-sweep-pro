import * as assert from 'assert';
import type { CliIo } from '../../cli/io';
import { createRpcFrontend } from '../../cli/rpc-frontend';
import type { HostUi } from '../../core/rpc-protocol';
import { createCliEventHandler } from '../../vscode/cli-client';

type Recorded = {
	logs: string[];
	infos: string[];
	errors: string[];
	progress: string[];
};

function createRecordingHostUi(answers: { pick?: string; branches?: readonly string[]; confirm?: boolean }): HostUi & { rec: Recorded } {
	const rec: Recorded = { logs: [], infos: [], errors: [], progress: [] };
	return {
		rec,
		log: (line) => rec.logs.push(line),
		withProgress: async (options, task) => {
			rec.progress.push(`start ${options.title}`);
			const result = await task();
			rec.progress.push(`end ${options.title}`);
			return result;
		},
		pickBranch: async () => answers.pick,
		pickBranches: async () => answers.branches,
		showInformationMessage: (message) => rec.infos.push(message),
		showErrorMessage: (message) => rec.errors.push(message),
		confirm: async () => answers.confirm ?? false,
	};
}

/** Wires the CLI's RPC UI straight into the host handler, as the real pipes would. */
function connect(host: HostUi): ReturnType<typeof createRpcFrontend> {
	const responses: string[] = [];
	const waiters: Array<(line: string) => void> = [];
	const handler = createCliEventHandler(host, (response) => {
		const line = JSON.stringify(response);
		const waiter = waiters.shift();
		if (waiter) {
			waiter(line);
		} else {
			responses.push(line);
		}
	});
	const io: CliIo = {
		cwd: '/repo',
		interactive: false,
		stdout: (text) => {
			for (const line of text.split('\n').filter(Boolean)) {
				void handler.handleLine(line);
			}
		},
		stderr: () => undefined,
		readLine: () =>
			responses.length > 0 ? Promise.resolve(responses.shift()) : new Promise((resolve) => waiters.push(resolve)),
	};
	return createRpcFrontend(io);
}

suite('cli rpc bridge', () => {
	test('forwards notifications and logs', () => {
		const host = createRecordingHostUi({});
		const { ui, output, trace } = connect(host);
		trace('$ git fetch -p');
		output.appendLine('Deleted branch a');
		ui.showInformationMessage('done');
		ui.showErrorMessage('bad');
		assert.deepStrictEqual(host.rec.logs, ['$ git fetch -p', 'Deleted branch a']);
		assert.deepStrictEqual(host.rec.infos, ['done']);
		assert.deepStrictEqual(host.rec.errors, ['bad']);
	});

	test('round-trips prompts and their answers', async () => {
		const host = createRecordingHostUi({ pick: 'main', branches: ['a'], confirm: true });
		const { ui } = connect(host);
		assert.strictEqual(await ui.pickBranch({ items: [{ label: 'main' }], title: 't', placeholder: '' }), 'main');
		assert.deepStrictEqual(await ui.pickBranches({ items: [{ label: 'a', picked: true }], title: 't' }), ['a']);
		assert.strictEqual(await ui.confirm('Delete?', 'Delete'), true);
	});

	test('a dismissed prompt comes back as undefined', async () => {
		const host = createRecordingHostUi({});
		const { ui } = connect(host);
		assert.strictEqual(await ui.pickBranches({ items: [], title: 't' }), undefined);
		assert.strictEqual(await ui.confirm('Delete?', 'Delete'), false);
	});

	test('progress spans open and close around the task', async () => {
		const host = createRecordingHostUi({});
		const { ui } = connect(host);
		assert.strictEqual(await ui.withProgress({ title: 'Fetching' }, async () => 'ok'), 'ok');
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepStrictEqual(host.rec.progress, ['start Fetching', 'end Fetching']);
	});

	test('requests carry the WorkflowUi method name and its arguments', async () => {
		const sent: string[] = [];
		const io: CliIo = { cwd: '/', interactive: false, stdout: (text) => sent.push(text), stderr: () => undefined, readLine: async () => undefined };
		await createRpcFrontend(io).ui.confirm('Delete?', 'Delete');
		assert.deepStrictEqual(JSON.parse(sent[0]), { type: 'request', id: 1, method: 'confirm', params: ['Delete?', 'Delete'] });
	});

	test('a closed host answers prompts as dismissed', async () => {
		const io: CliIo = { cwd: '/', interactive: false, stdout: () => undefined, stderr: () => undefined, readLine: async () => undefined };
		assert.strictEqual(await createRpcFrontend(io).ui.confirm('Delete?', 'Delete'), false);
	});

	test('rejects a response for the wrong request', async () => {
		const io: CliIo = {
			cwd: '/',
			interactive: false,
			stdout: () => undefined,
			stderr: () => undefined,
			readLine: async () => JSON.stringify({ type: 'response', id: 99, result: true }),
		};
		await assert.rejects(async () => createRpcFrontend(io).ui.confirm('Delete?', 'Delete'), /Unexpected RPC response/);
	});

	test('host logs non-protocol lines and closes dangling progress on dispose', async () => {
		const host = createRecordingHostUi({});
		const handler = createCliEventHandler(host, () => undefined);
		await handler.handleLine('not json');
		void handler.handleLine(JSON.stringify({ type: 'progressStart', id: 1, title: 'Stuck' }));
		handler.dispose();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepStrictEqual(host.rec.logs, ['not json']);
		assert.deepStrictEqual(host.rec.progress, ['start Stuck', 'end Stuck']);
	});
});
