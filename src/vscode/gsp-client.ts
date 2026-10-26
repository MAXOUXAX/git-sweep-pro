import type { JsonErrorDocument } from '../core/clean-plan';
import type { CliRunResult } from './cli-client';

/** How a `--json` run ended: its document, or why there is none. */
export type JsonRun<T> =
	| { readonly kind: 'document'; readonly exitCode: number; readonly document: T }
	| {
			readonly kind: 'error';
			readonly exitCode: number;
			readonly message: string;
			/** The JSON error code, or `crashed` when the CLI sent no document at all. */
			readonly code: JsonErrorDocument['error']['code'] | 'crashed';
			/** The CLI already showed this error in a notification. */
			readonly shown: boolean;
	  };

/** The `gsp` CLI as the extension's commands use it. Faked in tests. */
export type GspClient = {
	/** Runs `gsp <args> --json` in `cwd` and returns its schema-2 document. */
	readonly json: <T>(cwd: string, args: readonly string[]) => Promise<JsonRun<T>>;
	/** Runs `gsp <args>` in `cwd`, rendering its prompts and notifications in VS Code. */
	readonly run: (cwd: string, args: readonly string[]) => Promise<CliRunResult>;
};

const isErrorDocument = (document: unknown): document is JsonErrorDocument =>
	typeof document === 'object' && document !== null && 'error' in document;

/** Reads the document of a `--json` run: the JSON error document and a missing document both become an error. */
export function readJsonRun<T>(result: CliRunResult): JsonRun<T> {
	const { exitCode, document, errorShown } = result;
	if (document === undefined) {
		return { kind: 'error', exitCode, message: `The gsp command line stopped unexpectedly (exit code ${exitCode}).`, code: 'crashed', shown: errorShown };
	}
	if (isErrorDocument(document)) {
		return { kind: 'error', exitCode, message: document.error.message, code: document.error.code, shown: errorShown };
	}
	return { kind: 'document', exitCode, document: document as T };
}

/**
 * Builds the client on top of a raw CLI run. `settingsArgs` are read on each
 * run, so a settings change applies to the next command without a reload.
 */
export function createGspClient(runProcess: (cwd: string, args: readonly string[]) => Promise<CliRunResult>, settingsArgs: () => readonly string[]): GspClient {
	return {
		json: async <T>(cwd: string, args: readonly string[]) => readJsonRun<T>(await runProcess(cwd, [...args, '--json', ...settingsArgs()])),
		run: (cwd, args) => runProcess(cwd, [...args, ...settingsArgs()]),
	};
}
