import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CliIo } from '../../cli/io';

const gitEnv: NodeJS.ProcessEnv = {
	...process.env,
	GIT_AUTHOR_NAME: 'Test',
	GIT_AUTHOR_EMAIL: 'test@example.com',
	GIT_COMMITTER_NAME: 'Test',
	GIT_COMMITTER_EMAIL: 'test@example.com',
	GIT_CONFIG_NOSYSTEM: '1',
	LC_ALL: 'C',
};

export function git(args: string[], cwd: string): string {
	return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: gitEnv, stdio: 'pipe' });
}

export function commitFile(repo: string, file: string, content: string, message: string): void {
	fs.writeFileSync(path.join(repo, file), content);
	git(['add', file], repo);
	git(['commit', '-q', '-m', message], repo);
}

export type RepoFixture = {
	readonly dir: string;
	readonly repo: string;
	readonly remote: string;
	readonly cleanup: () => void;
};

/** A working clone of a bare "origin" with one commit on main. */
export function createRepoFixture(): RepoFixture {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsp-cli-'));
	const remote = path.join(dir, 'remote.git');
	const repo = path.join(dir, 'repo');
	git(['init', '-q', '--bare', remote], dir);
	git(['init', '-q', repo], dir);
	commitFile(repo, 'README.md', '# test\n', 'init');
	git(['branch', '-M', 'main'], repo);
	git(['remote', 'add', 'origin', remote], repo);
	git(['push', '-q', '-u', 'origin', 'main'], repo);
	git(['remote', 'set-head', 'origin', 'main'], repo);
	return { dir, repo, remote, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Pushes a branch, then deletes it on the remote so its upstream is gone after `fetch -p`. */
export function makeGoneBranch(repo: string, name: string): void {
	git(['checkout', '-q', '-b', name], repo);
	git(['push', '-q', '-u', 'origin', name], repo);
	git(['checkout', '-q', 'main'], repo);
	git(['push', '-q', 'origin', '--delete', name], repo);
}

export function branchExists(repo: string, name: string): boolean {
	return git(['branch', '--list', name], repo).trim().length > 0;
}

export type FakeIo = CliIo & { readonly out: string[]; readonly err: string[]; readonly answers: string[] };

/** In-memory process I/O; `answers` are fed to prompts in order, then stdin reads as closed. */
export function createFakeIo(cwd: string, options: { interactive?: boolean; answers?: string[] } = {}): FakeIo {
	const out: string[] = [];
	const err: string[] = [];
	const answers = [...(options.answers ?? [])];
	return {
		cwd,
		interactive: options.interactive ?? false,
		out,
		err,
		answers,
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		readLine: async () => answers.shift(),
	};
}
