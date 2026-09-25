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
	options: { cwd: string; env?: NodeJS.ProcessEnv }
) => Promise<{ stdout: string; stderr: string }>;

export type OutputWriter = {
	appendLine: (line: string) => void;
};

/**
 * Environment for every git invocation.
 *
 * The extension host has no terminal: any git command that tries to open an
 * editor (e.g. `rebase --continue`) or prompt for credentials would fail or
 * hang, so git is forced into non-interactive mode.
 *
 * LC_ALL=C forces English, C-locale output so machine-readable tokens we parse
 * (e.g. `[gone]` from `for-each-ref`'s upstream:track) are stable regardless of
 * the user's system locale or a localized git build.
 */
function gitEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_EDITOR: 'true',
		GIT_SEQUENCE_EDITOR: 'true',
		GIT_TERMINAL_PROMPT: '0',
		LC_ALL: 'C',
	};
}

function logStreams(outputChannel: OutputWriter, streams: { stdout?: string; stderr?: string }): void {
	const stdout = streams.stdout?.trim();
	const stderr = streams.stderr?.trim();
	if (stdout) {
		outputChannel.appendLine(stdout);
	}
	if (stderr) {
		outputChannel.appendLine(`[stderr] ${stderr}`);
	}
}

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
	outputChannel.appendLine(`$ ${buildDisplayCmd(args)}`);
	try {
		const { stdout, stderr } = await execFn('git', args, { cwd, env: gitEnv() });
		logStreams(outputChannel, { stdout, stderr });
		return { stdout, stderr };
	} catch (error) {
		const execError = error as Error & { stdout?: string; stderr?: string };
		logStreams(outputChannel, execError);
		outputChannel.appendLine(`[error] ${execError.message}`);
		throw execError;
	}
}
