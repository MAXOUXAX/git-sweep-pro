import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Escapes a string for safe use in shell commands by wrapping in single quotes.
 * Single quotes within the string are escaped as '\'' (end quote, escaped quote, start quote).
 */
export function escapeForShell(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

export type CommandResult = {
	readonly stdout: string;
	readonly stderr: string;
};

export type ExecFn = (command: string, options: { cwd: string }) => Promise<CommandResult>;

export type OutputWriter = {
	appendLine: (line: string) => void;
};

export async function runGitCommand(
	command: string,
	cwd: string,
	outputChannel: OutputWriter,
	execFn: ExecFn = execAsync
): Promise<CommandResult> {
	outputChannel.appendLine(`$ ${command}`);
	try {
		const result = await execFn(command, { cwd });
		if (result.stdout.trim()) {
			outputChannel.appendLine(result.stdout.trim());
		}
		if (result.stderr.trim()) {
			outputChannel.appendLine(`[stderr] ${result.stderr.trim()}`);
		}

		return {
			stdout: result.stdout,
			stderr: result.stderr,
		};
	} catch (error) {
		const execError = error as Error & { stdout?: string; stderr?: string };
		if (execError.stdout?.trim()) {
			outputChannel.appendLine(execError.stdout.trim());
		}
		if (execError.stderr?.trim()) {
			outputChannel.appendLine(`[stderr] ${execError.stderr.trim()}`);
		}
		outputChannel.appendLine(`[error] ${execError.message}`);
		throw execError;
	}
}
