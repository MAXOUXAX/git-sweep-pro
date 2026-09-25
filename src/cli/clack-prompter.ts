import pc from 'picocolors';
import type { Prompter } from './prompter';

/**
 * {@link Prompter} rendered with @clack/prompts on stderr, keeping stdout free
 * for data. @clack/prompts is ESM-only, hence the dynamic import; it is only
 * loaded for interactive sessions (never in --rpc mode or in pipes).
 */
export async function createClackPrompter(output: NodeJS.WritableStream = process.stderr): Promise<Prompter> {
	const p = await import('@clack/prompts');
	const common = { output: output as import('node:stream').Writable };
	const orUndefined = <T>(value: T | symbol): T | undefined => (p.isCancel(value) ? undefined : (value as T));

	return {
		intro: (title) => p.intro(pc.inverse(` ${title} `), common),
		outro: (message) => p.outro(message, common),
		select: async (message, options, initialValue) =>
			orUndefined<number>(await p.select<number>({ ...common, message, options: options.map((o) => ({ ...o })), initialValue })),
		multiselect: async (message, options, initialValues) =>
			orUndefined<number[]>(
				await p.multiselect<number>({
					...common,
					message,
					options: options.map((o) => ({ ...o })),
					initialValues: [...initialValues],
					required: false,
				})
			),
		confirm: async (message, activeLabel) =>
			orUndefined<boolean>(await p.confirm({ ...common, message, active: activeLabel, inactive: 'Cancel', initialValue: false })),
		spin: async (title, task) => {
			const spinner = p.spinner(common);
			spinner.start(title);
			try {
				const result = await task();
				spinner.stop(title.replace(/\.{3}$/, ''));
				return result;
			} catch (error) {
				spinner.error(title.replace(/\.{3}$/, ''));
				throw error;
			}
		},
		info: (message) => p.log.info(message, common),
		success: (message) => p.log.success(message, common),
		warn: (message) => p.log.warn(message, common),
		error: (message) => p.log.error(message, common),
		detail: (message) => p.log.message(pc.dim(message), common),
	};
}
