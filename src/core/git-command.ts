import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Escapes a string for safe display in shell-style command strings.
 * Used when showing commands to users (e.g. in error messages).
 * For actual execution, use runGitCommand with args array—no shell is invoked.
 */
export function escapeForShell(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Builds a user-facing command string for display (e.g. in logs or error messages).
 * Args containing whitespace or single quotes are wrapped with escapeForShell.
 * Returns 'git' when args is empty.
 */
function buildDisplayCmd(args: string[]): string {
	if (args.length === 0) {
		return 'git';
	}
	const formatted = args.map((a) => (/\s|'/.test(a) ? escapeForShell(a) : a)).join(' ');
	return `git ${formatted}`;
}

export type CommandResult = {
	readonly stdout: string;
	readonly stderr: string;
};

export type ExecFileFn = (
	file: string,
	args: string[],
	options: { cwd: string }
) => Promise<{ stdout: string; stderr: string }>;

export type OutputWriter = {
	appendLine: (line: string) => void;
};

/**
 * Runs a git command by invoking the git executable with an arguments array.
 * No shell is invoked, so branch names and other user-controlled strings cannot
 * cause command injection regardless of their content.
 */
export async function runGitCommand(
	args: string[],
	cwd: string,
	outputChannel: OutputWriter,
	execFn: ExecFileFn = execFileAsync
): Promise<CommandResult> {
	const displayCmd = buildDisplayCmd(args);
	outputChannel.appendLine(`$ ${displayCmd}`);
	try {
		const result = await execFn('git', args, { cwd });
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
