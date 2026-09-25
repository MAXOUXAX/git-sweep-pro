import type { CliEvent, HostResponse, RpcRequest } from '../core/rpc-protocol';
import type { QuickPickItemLike, WorkflowUi } from '../core/sweep-workflow';
import type { CliIo } from './io';

export type RpcUi = WorkflowUi & {
	readonly log: (line: string) => void;
	readonly showOutput: (preserveFocus: boolean) => void;
	readonly errorCount: () => number;
};

/**
 * Forwards every workflow UI call to the host over NDJSON (see
 * {@link CliEvent}). Used when the VS Code extension runs the CLI.
 */
export function createRpcUi(io: CliIo): RpcUi {
	let nextId = 1;
	let errors = 0;

	const send = (event: CliEvent): void => io.stdout(`${JSON.stringify(event)}\n`);

	const request = async (payload: RpcRequest): Promise<unknown> => {
		const id = nextId++;
		send({ type: 'request', id, ...payload } as CliEvent);
		const line = await io.readLine();
		if (line === undefined) {
			// The host went away: treat it as a dismissed prompt so nothing destructive runs.
			return undefined;
		}
		const response = JSON.parse(line) as HostResponse;
		if (response.type !== 'response' || response.id !== id) {
			throw new Error(`Unexpected RPC response for request ${id}: ${line}`);
		}
		return response.result;
	};

	return {
		errorCount: () => errors,
		log: (line) => send({ type: 'log', line }),
		showOutput: (preserveFocus) => send({ type: 'showOutput', preserveFocus }),
		withProgress: async (options, task) => {
			const id = nextId++;
			send({ type: 'progressStart', id, title: options.title });
			try {
				return await task();
			} finally {
				send({ type: 'progressEnd', id });
			}
		},
		showQuickPick: async (items, options) =>
			(await request({ method: 'quickPick', params: { items, options } })) as
				| QuickPickItemLike
				| readonly QuickPickItemLike[]
				| undefined,
		pickBranches: async (params) =>
			(await request({ method: 'pickBranches', params })) as readonly string[] | undefined,
		showInformationMessage: (message) => send({ type: 'info', message }),
		showErrorMessage: (message) => {
			errors += 1;
			send({ type: 'error', message });
		},
		confirm: async (message, confirmLabel) =>
			(await request({ method: 'confirm', params: { message, confirmLabel } })) === true,
	};
}
