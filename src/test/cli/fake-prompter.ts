import type { PromptOption, Prompter } from '../../cli/prompter';

/** Scripted {@link Prompter}: answers come from `answers`, every call is recorded. */
export function createFakePrompter(answers: { select?: number; multiselect?: number[]; confirm?: boolean } = {}) {
	const calls: string[] = [];
	const seen: { options?: readonly PromptOption[]; initial?: unknown } = {};
	const prompter: Prompter = {
		intro: (title) => calls.push(`intro ${title}`),
		outro: (message) => calls.push(`outro ${message}`),
		select: async (message, options, initialValue) => {
			calls.push(`select ${message}`);
			seen.options = options;
			seen.initial = initialValue;
			return answers.select;
		},
		multiselect: async (_message, options, initialValues) => {
			calls.push('multiselect');
			seen.options = options;
			seen.initial = initialValues;
			return answers.multiselect;
		},
		confirm: async (_message, activeLabel) => {
			calls.push(`confirm ${activeLabel}`);
			return answers.confirm;
		},
		spin: async (title, task) => {
			calls.push(`spin ${title}`);
			return task();
		},
		success: (message) => calls.push(`success ${message}`),
		error: (message) => calls.push(`error ${message}`),
		detail: (message) => calls.push(`detail ${message}`),
	};
	return { prompter, calls, seen };
}
