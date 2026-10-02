import type { WorkflowUi } from './workflow';

/**
 * Wire protocol between the `gsp` CLI running with `--rpc` and a
 * host (the VS Code extension) that renders its UI. Every message is derived
 * from {@link WorkflowUi}, so the protocol cannot drift from the contract.
 *
 * Both directions use newline-delimited JSON. The CLI writes {@link CliEvent}s
 * to stdout; the host answers each `request` with exactly one
 * {@link HostResponse} line on the CLI's stdin. Requests are strictly
 * sequential: the CLI waits for the answer before sending anything else that
 * needs one, so ids only guard against protocol bugs.
 */

/** The {@link WorkflowUi} calls the host answers. */
export type PromptMethod = 'pickOne' | 'pickMany' | 'confirm';
/** The {@link WorkflowUi} calls the host only displays. */
export type NotifyMethod = 'showInformationMessage' | 'showErrorMessage';
type HostCalls = Pick<WorkflowUi, PromptMethod | NotifyMethod>;
export type CallMethod = keyof HostCalls;
export type CallParams = { [K in CallMethod]: Parameters<HostCalls[K]> };
export type CallResults = { [K in CallMethod]: Awaited<ReturnType<HostCalls[K]>> };

/** A {@link WorkflowUi} call forwarded to the host; `K` narrows it to a single method. */
export type UiCall<K extends CallMethod = CallMethod> = {
	[M in K]: { readonly method: M; readonly params: CallParams[M] };
}[K];

export type CliEvent =
	| { readonly type: 'log'; readonly line: string }
	| { readonly type: 'progressStart'; readonly id: number; readonly title: string }
	| { readonly type: 'progressEnd'; readonly id: number }
	| ({ readonly type: 'notify' } & UiCall<NotifyMethod>)
	| ({ readonly type: 'request'; readonly id: number } & UiCall<PromptMethod>);

export type HostResponse<K extends PromptMethod = PromptMethod> = {
	readonly type: 'response';
	readonly id: number;
	/** Omitted when the host's answer is `undefined` (e.g. a dismissed picker). */
	readonly result?: CallResults[K];
};

/** The UI a host provides to a CLI run: the workflow prompts plus the output channel. */
export type HostUi = WorkflowUi & {
	readonly log: (line: string) => void;
};
