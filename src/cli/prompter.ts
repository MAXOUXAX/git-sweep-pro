/**
 * Interactive terminal widgets used by the CLI when a human is at the
 * keyboard. The production implementation is backed by @clack/prompts
 * ({@link ./clack-prompter}); tests use a scripted fake. Every prompt resolves
 * to `undefined` when the user cancels (Ctrl+C / Esc).
 */
export type PromptOption = {
	readonly value: number;
	readonly label: string;
	readonly hint?: string;
};

export type Prompter = {
	intro: (title: string) => void;
	outro: (message: string) => void;
	select: (message: string, options: readonly PromptOption[], initialValue?: number) => Promise<number | undefined>;
	multiselect: (message: string, options: readonly PromptOption[], initialValues: readonly number[]) => Promise<number[] | undefined>;
	confirm: (message: string, activeLabel: string) => Promise<boolean | undefined>;
	/** Runs `task` behind a spinner labelled `title`. */
	spin: <T>(title: string, task: () => Promise<T>) => Promise<T>;
	info: (message: string) => void;
	success: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
	/** Secondary detail (workflow output). */
	detail: (message: string) => void;
};
