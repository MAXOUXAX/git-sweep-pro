import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import * as readline from 'node:readline';
import { toErrorMessage } from '../core/errors';
import type { CliEvent, HostResponse } from '../core/rpc-protocol';
import type { WorkflowUi } from '../core/sweep-workflow';

/** The UI a host provides to a CLI run: the workflow prompts plus the output channel. */
export type HostUi = WorkflowUi & {
	readonly log: (line: string) => void;
	readonly showOutput: (preserveFocus: boolean) => void;
};

/**
 * Handles the CLI's NDJSON events: logs, notifications, progress spans and
 * prompts. Each prompt is answered through `respond` once the UI resolves.
 * Kept free of process handling so the protocol can be tested in isolation.
 */
export function createCliEventHandler(ui: HostUi, respond: (response: HostResponse) => void) {
	const openProgress = new Map<number, () => void>();

	const handleEvent = async (event: CliEvent): Promise<void> => {
		switch (event.type) {
			case 'log':
				ui.log(event.line);
				return;
			case 'showOutput':
				ui.showOutput(event.preserveFocus);
				return;
			case 'info':
				ui.showInformationMessage(event.message);
				return;
			case 'error':
				ui.showErrorMessage(event.message);
				return;
			case 'progressStart':
				void ui.withProgress({ title: event.title }, () => new Promise<void>((resolve) => openProgress.set(event.id, resolve)));
				return;
			case 'progressEnd':
				openProgress.get(event.id)?.();
				openProgress.delete(event.id);
				return;
			case 'request': {
				let result: unknown;
				switch (event.method) {
					case 'quickPick':
						result = await ui.showQuickPick(event.params.items, event.params.options);
						break;
					case 'pickBranches':
						result = await ui.pickBranches(event.params);
						break;
					case 'confirm':
						result = await ui.confirm(event.params.message, event.params.confirmLabel);
						break;
				}
				respond({ type: 'response', id: event.id, result });
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
		/** Closes any progress notification left open (e.g. the CLI crashed mid-task). */
		dispose: (): void => {
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

/**
 * Runs `git-sweep-pro --rpc <args>` as a child process, rendering its UI with
 * `ui`, and resolves to the CLI's exit code (-1 when it could not start).
 */
export function runCliProcess(options: CliRunOptions): Promise<number> {
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
		const finish = (code: number): void => {
			if (!settled) {
				settled = true;
				void queue.then(() => {
					handler.dispose();
					resolve(code);
				});
			}
		};

		child.on('error', (error) => {
			options.ui.showErrorMessage(`Git Sweep Pro: Could not start the git-sweep-pro CLI: ${error.message}`);
			finish(-1);
		});
		child.on('close', (code) => finish(code ?? -1));
	});
}
