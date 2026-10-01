import type { CallResults, CliEvent, HostResponse, PromptMethod, UiCall } from '../core/rpc-protocol';
import type { Frontend } from './frontend';
import type { CliIo } from './io';

/**
 * Forwards every workflow UI call and output line to the host over NDJSON
 * (see {@link CliEvent}). Used when the VS Code extension runs the CLI.
 */
export function createRpcFrontend(io: CliIo): Frontend {
	let nextId = 1;

	const send = (event: CliEvent): void => io.stdout(`${JSON.stringify(event)}\n`);
	const log = (line: string): void => send({ type: 'log', line });

	const request = async <K extends PromptMethod>(
		call: Extract<UiCall<PromptMethod>, { method: K }>
	): Promise<CallResults[K] | undefined> => {
		const id = nextId++;
		send({ type: 'request', id, ...call });
		const line = await io.readLine();
		if (line === undefined) {
			// The host went away: treat it as a dismissed prompt so nothing destructive runs.
			return undefined;
		}
		const response = JSON.parse(line) as HostResponse<K>;
		if (response.type !== 'response' || response.id !== id) {
			throw new Error(`Unexpected RPC response for request ${id}: ${line}`);
		}
		return response.result;
	};

	return {
		trace: log,
		output: {
			show: (preserveFocus) => send({ type: 'showOutput', preserveFocus }),
			appendLine: log,
		},
		ui: {
			withProgress: async (options, task) => {
				const id = nextId++;
				send({ type: 'progressStart', id, title: options.title });
				try {
					return await task();
				} finally {
					send({ type: 'progressEnd', id });
				}
			},
			showQuickPick: (...params) => request({ method: 'showQuickPick', params }),
			pickBranches: (...params) => request({ method: 'pickBranches', params }),
			showInformationMessage: (...params) => send({ type: 'notify', method: 'showInformationMessage', params }),
			showErrorMessage: (...params) => send({ type: 'notify', method: 'showErrorMessage', params }),
			confirm: async (...params) => (await request({ method: 'confirm', params })) === true,
		},
	};
}
