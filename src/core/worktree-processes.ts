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

/** lsof and /proc walk every process: past this, the check gives up rather than hold the sweep. */
const SCAN_TIMEOUT_MS = 5000;

/** `work`, or `late()` once `ms` have passed without it settling. */
export function withDeadline<T>(work: Promise<T>, ms: number, late: () => T): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(late()), ms);
	});
	return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

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

/**
 * What an lsof run proves. A run that exited with 1 could not read some
 * process: what it read still counts. A run cut short (timeout, output past
 * the buffer) stopped mid-scan: what it printed is not the whole picture.
 */
export function lsofScan(error: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string): ProcessScan {
	if (error?.code === 'ENOENT') {
		return { ok: false, reason: 'lsof-missing' };
	}
	if (error?.killed) {
		return { ok: false, reason: 'failed', detail: `lsof took more than ${SCAN_TIMEOUT_MS / 1000} s` };
	}
	const processes = parseLsof(stdout);
	if (error && (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || processes.length === 0)) {
		return { ok: false, reason: 'failed', detail: error.message.split('\n')[0] };
	}
	return { ok: true, processes };
}

function scanWithLsof(): Promise<ProcessScan> {
	return new Promise((resolve) => {
		// -d cwd: only the current directory; -n -P: no name lookups; -w: no warnings.
		execFile('lsof', ['-n', '-P', '-w', '-d', 'cwd', '-F', 'pRcn'], { timeout: SCAN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
			resolve(lsofScan(error, stdout));
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
			} catch (error) {
				// Gone meanwhile, or another user's (lsof cannot read those either). Anything else: the scan is incomplete.
				if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
					return undefined;
				}
				throw error;
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
			// Past the deadline, lsof would be as slow: the scan failed.
			return await withDeadline(scanProc(), SCAN_TIMEOUT_MS, () => ({ ok: false, reason: 'failed', detail: `/proc took more than ${SCAN_TIMEOUT_MS / 1000} s` }));
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
