#!/usr/bin/env node
import * as readline from 'node:readline';
import { runCli } from './app';
import { createClackPrompter } from './clack-prompter';

let lines: AsyncIterator<string> | undefined;
let reader: readline.Interface | undefined;

// stdin is only attached on the first read, so commands that never prompt do
// not keep the process alive waiting for input.
const readLine = async (): Promise<string | undefined> => {
	if (!reader) {
		reader = readline.createInterface({ input: process.stdin, terminal: false });
		lines = reader[Symbol.asyncIterator]();
	}
	const next = await lines!.next();
	return next.done ? undefined : next.value;
};

// A closed pipe (e.g. `gsp list | head -1`) is not an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
	if (error.code !== 'EPIPE') {
		throw error;
	}
});

runCli(process.argv.slice(2), {
	cwd: process.cwd(),
	interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	readLine,
	loadPrompter: () => createClackPrompter(),
})
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		process.exitCode = 1;
	})
	.finally(() => reader?.close());
