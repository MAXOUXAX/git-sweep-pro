import type { SelectableBranch } from './sweep-selection';
import type { QuickPickItemLike, QuickPickOptionsLike } from './sweep-workflow';

/**
 * Wire protocol between the `git-sweep-pro` CLI running with `--rpc` and a
 * host (the VS Code extension) that renders its UI.
 *
 * Both directions use newline-delimited JSON. The CLI writes {@link CliEvent}s
 * to stdout; the host answers each `request` with exactly one
 * {@link HostResponse} line on the CLI's stdin. Requests are strictly
 * sequential: the CLI waits for the answer before sending anything else that
 * needs one, so ids only guard against protocol bugs.
 */

export type RpcRequest =
	| {
			readonly method: 'quickPick';
			readonly params: { readonly items: QuickPickItemLike[]; readonly options: QuickPickOptionsLike };
	  }
	| {
			readonly method: 'pickBranches';
			readonly params: {
				readonly items: readonly SelectableBranch[];
				readonly title: string;
				readonly placeHolder: string;
			};
	  }
	| {
			readonly method: 'confirm';
			readonly params: { readonly message: string; readonly confirmLabel: string };
	  };

export type CliEvent =
	| { readonly type: 'log'; readonly line: string }
	| { readonly type: 'showOutput'; readonly preserveFocus: boolean }
	| { readonly type: 'progressStart'; readonly id: number; readonly title: string }
	| { readonly type: 'progressEnd'; readonly id: number }
	| { readonly type: 'info'; readonly message: string }
	| { readonly type: 'error'; readonly message: string }
	| ({ readonly type: 'request'; readonly id: number } & RpcRequest);

export type HostResponse = {
	readonly type: 'response';
	readonly id: number;
	/** Omitted when the host's answer is `undefined` (e.g. a dismissed picker). */
	readonly result?: unknown;
};
