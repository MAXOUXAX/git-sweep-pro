import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import * as path from 'node:path';
import type { ProcessCheck, WorktreeProcess } from './clean-plan';
import { canonical } from './worktrees';

/*
 * Which processes run inside a worktree: their current directory is in it.
 * An agent, a shell or a dev server working there means the worktree is in
 * use, and a sweep must not remove it. Read from /proc on Linux, from `lsof`
 * elsewhere. Fail-open: when neither can be read, nothing is reported in use
 * and the check says why; `git worktree lock` is the protection that holds.
 */

type RunningProcess = WorktreeProcess & { readonly ppid: number; readonly cwd: string };

/** Every process whose current directory could be read, or why none could. */
export type ProcessScan =
	| { readonly ok: true; readonly processes: readonly RunningProcess[] }
	| { readonly ok: false; readonly reason: Exclude<Extract<ProcessCheck, { used: false }>['reason'], 'not-needed'>; readonly detail?: string };

/** Lists the processes and their current directory. */
export type ScanProcesses = () => Promise<ProcessScan>;

/** lsof walks every process: past this, the check gives up rather than hold the sweep. */
const LSOF_TIMEOUT_MS = 5000;

/** Parses `lsof -F pRcn` output: a `p<pid>` line opens a process, then `R<ppid>`, `c<command>` and `n<cwd>`. */
export function parseLsof(output: string): RunningProcess[] {
	const processes: RunningProcess[] = [];
	let current: { pid: number; ppid: number; command: string; cwd: string } | undefined;
	const flush = () => {
		if (current?.cwd) {
			processes.push(current);
		}
	};
	for (const line of output.split('\n')) {
		const value = line.slice(1);
		switch (line[0]) {
			case 'p':
				flush();
				current = { pid: Number(value), ppid: 0, command: '', cwd: '' };
				break;
			case 'R':
				if (current) {
					current.ppid = Number(value);
				}
				break;
			case 'c':
				if (current) {
					current.command = value;
				}
				break;
			case 'n':
				if (current && path.isAbsolute(value)) {
					current.cwd = value;
				}
				break;
		}
	}
	flush();
	return processes;
}

function scanWithLsof(): Promise<ProcessScan> {
	return new Promise((resolve) => {
		// -d cwd: only the current directory; -n -P: no name lookups; -w: no warnings.
		execFile('lsof', ['-n', '-P', '-w', '-d', 'cwd', '-F', 'pRcn'], { timeout: LSOF_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
			const code = (error as NodeJS.ErrnoException | null)?.code;
			if (code === 'ENOENT') {
				resolve({ ok: false, reason: 'lsof-missing' });
				return;
			}
			const processes = parseLsof(stdout);
			// lsof exits with 1 when some process could not be read: what it could read still counts.
			if (error && processes.length === 0) {
				resolve({ ok: false, reason: 'failed', detail: error.killed ? `lsof took more than ${LSOF_TIMEOUT_MS / 1000} s` : error.message.split('\n')[0] });
				return;
			}
			resolve({ ok: true, processes });
		});
	});
}

async function scanProc(): Promise<ProcessScan> {
	const pids = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry));
	const processes = await Promise.all(
		pids.map(async (pid): Promise<RunningProcess | undefined> => {
			try {
				const [cwd, stat] = await Promise.all([readlink(`/proc/${pid}/cwd`), readFile(`/proc/${pid}/stat`, 'utf8')]);
				// "pid (command) state ppid …": the command may hold spaces and parentheses.
				const close = stat.lastIndexOf(')');
				const ppid = Number(stat.slice(close + 2).split(' ')[1]);
				return { pid: Number(pid), ppid, command: stat.slice(stat.indexOf('(') + 1, close), cwd };
			} catch {
				// Gone meanwhile, or another user's.
				return undefined;
			}
		})
	);
	return { ok: true, processes: processes.filter((process): process is RunningProcess => process !== undefined) };
}

/** The processes of this machine with their current directory: /proc on Linux, lsof on macOS and other Unixes. */
export const scanProcesses: ScanProcesses = async () => {
	if (process.platform === 'win32') {
		return { ok: false, reason: 'unsupported', detail: process.platform };
	}
	if (process.platform === 'linux') {
		try {
			return await scanProc();
		} catch {
			// No /proc mounted: lsof may still work.
		}
	}
	return scanWithLsof();
};

/** gsp itself and the processes that started it: running gsp from a worktree does not make it in use. */
function ownLineage(processes: readonly RunningProcess[]): Set<number> {
	const parents = new Map(processes.map((running) => [running.pid, running.ppid]));
	const own = new Set<number>();
	for (let pid: number | undefined = process.pid; pid !== undefined && pid > 1 && !own.has(pid); pid = parents.get(pid) ?? (pid === process.pid ? process.ppid : undefined)) {
		own.add(pid);
	}
	return own;
}

/**
 * Finds the processes inside given worktrees. Scans once, lazily, on the
 * first question; `refresh` scans again (just before removing a worktree).
 */
export class WorktreeProcesses {
	private scan: Promise<ProcessScan> | undefined;
	private found: ProcessCheck = { used: false, reason: 'not-needed' };

	constructor(private readonly scanner: ScanProcesses = scanProcesses) {}

	/** Forgets the last scan: the next question scans again. */
	refresh(): void {
		this.scan = undefined;
	}

	private async read(): Promise<ProcessScan> {
		this.scan ??= this.scanner().catch((error: unknown) => ({ ok: false as const, reason: 'failed' as const, detail: String(error) }));
		const scan = await this.scan;
		this.found = scan.ok ? { used: true } : { used: false, reason: scan.reason, ...(scan.detail ? { detail: scan.detail } : {}) };
		return scan;
	}

	/** What the last scan found, or `not-needed` when no worktree was asked about. */
	check(): ProcessCheck {
		return this.found;
	}

	/** The processes running inside `worktreePath`, gsp's own lineage left out; null when they could not be read. */
	async inside(worktreePath: string): Promise<WorktreeProcess[] | null> {
		const scan = await this.read();
		if (!scan.ok) {
			return null;
		}
		const root = canonical(worktreePath);
		const own = ownLineage(scan.processes);
		return scan.processes
			.filter((running) => !own.has(running.pid))
			.filter((running) => {
				const relative = path.relative(root, running.cwd);
				return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
			})
			.map(({ pid, command }) => ({ pid, command }))
			.sort((a, b) => a.pid - b.pid);
	}
}
