import type { Prompter } from './prompter';

/** Process I/O used by the CLI, injectable so the whole CLI can run in-process in tests. */
export type CliIo = {
	readonly cwd: string;
	/** True when a human can answer prompts (stdin and stderr are TTYs). */
	readonly interactive: boolean;
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	/** Resolves to the next line of stdin, or `undefined` once stdin is closed. */
	readonly readLine: () => Promise<string | undefined>;
	/** Loads the interactive widgets; only called for interactive, non-RPC runs. */
	readonly loadPrompter?: () => Promise<Prompter>;
};

