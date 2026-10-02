import * as assert from 'assert';
import { runGitCommand, type ExecFileFn } from '../../core/git-command';

suite('git-command', () => {
	test('logs command and stdout/stderr on success', async () => {
		const lines: string[] = [];
		const execFileFn: ExecFileFn = async () => ({
			stdout: 'hello\n',
			stderr: 'warn\n',
		});

		const result = await runGitCommand(
			['status'],
			'/repo',
			{ appendLine: (line) => lines.push(line) },
			{ exec: execFileFn }
		);

		assert.deepStrictEqual(result, { stdout: 'hello\n', stderr: 'warn\n' });
		assert.deepStrictEqual(lines, ['$ git status', 'hello', '[stderr] warn']);
	});

	test('does not log empty stdout/stderr content', async () => {
		const lines: string[] = [];
		const execFileFn: ExecFileFn = async () => ({ stdout: '   ', stderr: '' });

		await runGitCommand(
			['rev-parse', '--show-toplevel'],
			'/repo',
			{ appendLine: (line) => lines.push(line) },
			{ exec: execFileFn }
		);

		assert.deepStrictEqual(lines, ['$ git rev-parse --show-toplevel']);
	});

	test('logs error details and rethrows on command failure', async () => {
		const lines: string[] = [];
		const thrown = Object.assign(new Error('boom'), {
			stdout: 'partial out\n',
			stderr: 'fatal: something bad\n',
		});
		const execFileFn: ExecFileFn = async () => {
			throw thrown;
		};

		await assert.rejects(
			() =>
				runGitCommand(['fetch', '-p'], '/repo', { appendLine: (line) => lines.push(line) }, { exec: execFileFn }),
			(error: unknown) => {
				assert.strictEqual(error, thrown);
				return true;
			}
		);

		assert.deepStrictEqual(lines, [
			'$ git fetch -p',
			'partial out',
			'[stderr] fatal: something bad',
			'[error] boom',
		]);
	});

	test('handles thrown non-standard error objects gracefully', async () => {
		const lines: string[] = [];
		const execFileFn: ExecFileFn = async () => {
			throw Object.assign(new Error('object-error'), {
				stdout: 'x\n',
				stderr: 'y\n',
			});
		};

		await assert.rejects(
			() =>
				runGitCommand(['branch', '-vv'], '/repo', { appendLine: (line) => lines.push(line) }, { exec: execFileFn }),
			/error/
		);

		assert.deepStrictEqual(lines, ['$ git branch -vv', 'x', '[stderr] y', '[error] object-error']);
	});

	test('passes branch names as separate argv elements—no shell injection', async () => {
		const lines: string[] = [];
		let receivedArgs: readonly string[] = [];
		const execFileFn: ExecFileFn = async (_file, args) => {
			receivedArgs = args;
			return { stdout: '', stderr: '' };
		};

		await runGitCommand(
			['branch', '-d', '; rm -rf /'],
			'/repo',
			{ appendLine: (line) => lines.push(line) },
			{ exec: execFileFn }
		);

		assert.deepStrictEqual(receivedArgs, ['branch', '-d', '; rm -rf /']);
	});

	test('runs git in non-interactive mode (no editor, no terminal prompt)', async () => {
		let receivedEnv: NodeJS.ProcessEnv | undefined;
		const execFileFn: ExecFileFn = async (_file, _args, options) => {
			receivedEnv = options.env;
			return { stdout: '', stderr: '' };
		};

		await runGitCommand(
			['rebase', '--continue'],
			'/repo',
			{ appendLine: () => undefined },
			{ exec: execFileFn }
		);

		assert.strictEqual(receivedEnv?.GIT_EDITOR, 'true');
		assert.strictEqual(receivedEnv?.GIT_SEQUENCE_EDITOR, 'true');
		assert.strictEqual(receivedEnv?.GIT_TERMINAL_PROMPT, '0');
		assert.strictEqual(receivedEnv?.LC_ALL, 'C');
	});

	test('an expected exit code resolves with the output and logs no error', async () => {
		const lines: string[] = [];
		const execFileFn: ExecFileFn = async () => {
			throw Object.assign(new Error('Command failed: git config --get-all a.b'), { code: 1, stdout: '', stderr: '' });
		};
		const result = await runGitCommand(['config', '--get-all', 'a.b'], '/repo', { appendLine: (line) => lines.push(line) }, {
			exec: execFileFn,
			expectedExitCodes: [1],
		});
		assert.deepStrictEqual(result, { stdout: '', stderr: '' });
		assert.deepStrictEqual(lines, ['$ git config --get-all a.b']);
	});
});
