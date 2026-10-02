import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import * as readline from 'node:readline';
import { toErrorMessage } from '../core/errors';
import type { CallMethod, CallParams, CallResults, CliEvent, HostResponse, HostUi, PromptMethod, UiCall } from '../core/rpc-protocol';

type CallHandlers = { [K in CallMethod]: (...params: CallParams[K]) => CallResults[K] | PromiseLike<CallResults[K]> };

/** Runs a forwarded call on the host UI. */
function invoke<K extends CallMethod>(ui: CallHandlers, call: UiCall<K>): CallResults[K] | PromiseLike<CallResults[K]> {
	return ui[call.method](...call.params);
}

/**
 * Handles the CLI's NDJSON events: logs, notifications, progress spans and
 * prompts. Each prompt is answered through `respond` once the UI resolves.
 * Kept free of process handling so the protocol can be tested in isolation.
 */
export function createCliEventHandler(ui: HostUi, respond: (response: HostResponse) => void) {
	const openProgress = new Map<number, () => void>();
	let errorShown = false;
	let disposed = false;
	let cancelPrompts!: () => void;
	const cancelled = new Promise<undefined>((resolve) => { cancelPrompts = () => resolve(undefined); });

	const handleEvent = async (event: CliEvent): Promise<void> => {
		switch (event.type) {
			case 'log':
				ui.log(event.line);
				return;
			case 'notify':
				errorShown ||= event.method === 'showErrorMessage';
				invoke(ui, event);
				return;
			case 'progressStart': {
				if (disposed) {
					return;
				}
				// The host may invoke its task later, after progressEnd or dispose.
				const done = new Promise<void>((resolve) => openProgress.set(event.id, resolve));
				void ui.withProgress({ title: event.title }, () => done);
				return;
			}
			case 'progressEnd':
				openProgress.get(event.id)?.();
				openProgress.delete(event.id);
				return;
			case 'request': {
				if (disposed) {
					return;
				}
				let result: CallResults[PromptMethod] | undefined;
				try {
					result = await Promise.race([invoke(ui, event), cancelled]);
				} catch (error) {
					// The CLI waits for this answer: a failed prompt counts as dismissed, so nothing destructive runs.
					ui.log(`[error] ${event.method} failed: ${toErrorMessage(error)}`);
				}
				if (!disposed) {
					respond({ type: 'response', id: event.id, result });
				}
				return;
			}
		}
	};

	return {
		/** Processes one stdout line from the CLI; non-protocol lines are logged verbatim. */
		handleLine: (line: string): Promise<void> => {
			let event: CliEvent;
			try {
				event = JSON.parse(line) as CliEvent;
			} catch {
				ui.log(line);
				return Promise.resolve();
			}
			return handleEvent(event);
		},
		/** True once the CLI reported an error to the user. */
		errorShown: (): boolean => errorShown,
		/** Releases pending prompt handlers and closes progress when the CLI exits. */
		dispose: (): void => {
			disposed = true;
			cancelPrompts();
			openProgress.forEach((resolve) => resolve());
			openProgress.clear();
		},
	};
}

export type CliRunOptions = {
	/** Node-compatible runtime; in VS Code this is the extension host's own executable. */
	readonly nodePath: string;
	readonly cliPath: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly ui: HostUi;
	readonly spawnFn?: (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
};

export type CliRunResult = {
	/** The CLI's exit code; -1 when it could not start. */
	readonly exitCode: number;
	/** True when the user already saw an error notification for this run. */
	readonly errorShown: boolean;
};

/**
 * Runs `gsp --rpc <args>` as a child process, rendering its UI with
 * `ui`, and resolves once it exits.
 */
export function runCliProcess(options: CliRunOptions): Promise<CliRunResult> {
	const spawnFn = options.spawnFn ?? spawn;
	return new Promise((resolve) => {
		const child = spawnFn(options.nodePath, [options.cliPath, '--rpc', ...options.args], {
			cwd: options.cwd,
			// Lets the Electron-based VS Code executable behave as plain Node.
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
		});

		// Answering a prompt after the CLI exited must not crash the extension host.
		child.stdin.on('error', () => undefined);
		const handler = createCliEventHandler(options.ui, (response) => {
			child.stdin.write(`${JSON.stringify(response)}\n`);
		});

		// Events are handled strictly in order: a prompt must be answered before
		// the notifications that follow it are shown.
		let queue = Promise.resolve();
		readline.createInterface({ input: child.stdout }).on('line', (line) => {
			queue = queue.then(() => handler.handleLine(line)).catch((error) => options.ui.log(`[error] ${toErrorMessage(error)}`));
		});
		readline.createInterface({ input: child.stderr }).on('line', (line) => options.ui.log(`[cli] ${line}`));

		let settled = false;
		const finish = (exitCode: number, startFailed = false): void => {
			if (!settled) {
				settled = true;
				// Release pending prompts before waiting for the event queue to drain.
				handler.dispose();
				void queue.then(() => {
					resolve({ exitCode, errorShown: startFailed || handler.errorShown() });
				});
			}
		};

		child.on('error', (error) => {
			options.ui.showErrorMessage(`Could not start the gsp CLI: ${error.message}`);
			finish(-1, true);
		});
		child.on('close', (code) => finish(code ?? -1));
	});
}
