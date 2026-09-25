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

/**
 * Drops the "Git Sweep Pro:" prefix used by extension notifications, which is
 * noise in a terminal. A qualifier survives: "Git Sweep Pro (dry run): x"
 * becomes "Dry run: x".
 */
export function stripProductPrefix(message: string): string {
	return message.replace(/^Git Sweep Pro(?: \((.+?)\))?:\s*/, (_match, qualifier?: string) =>
		qualifier ? `${qualifier[0].toUpperCase()}${qualifier.slice(1)}: ` : ''
	);
}
