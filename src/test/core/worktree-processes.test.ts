import * as assert from 'assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lsofScan, parseLsof, scanProcesses, withDeadline, WorktreeProcesses, type ProcessScan } from '../../core/worktree-processes';

const running = (pid: number, cwd: string, command = 'node', ppid = 1) => ({ pid, ppid, command, cwd });

suite('worktree processes', () => {
	let dir: string;

	setup(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsp-proc-')));
		fs.mkdirSync(path.join(dir, 'wt', 'src'), { recursive: true });
		fs.mkdirSync(path.join(dir, 'wt-other'));
	});

	teardown(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('parses lsof field output, keeping only processes with a directory', () => {
		const output = ['p12', 'R1', 'czsh', 'fcwd', 'n/work/wt', 'p13', 'R12', 'cnode', 'fcwd', 'n/work/wt/src', 'p14', 'R1', 'ckernel_task', ''].join('\n');
		assert.deepStrictEqual(parseLsof(output), [running(12, '/work/wt', 'zsh'), running(13, '/work/wt/src', 'node', 12)]);
	});

	test('an lsof run cut short is a failed scan, even with some output; one that skipped a process still counts', () => {
		const partial = ['p12', 'R1', 'czsh', 'n/work/wt', ''].join('\n');
		const failure = (message: string, extra: object) => Object.assign(new Error(message), extra);
		assert.deepStrictEqual(lsofScan(failure('Command failed: lsof', { killed: true, signal: 'SIGTERM' }), partial), {
			ok: false,
			reason: 'failed',
			detail: 'lsof took more than 5 s',
		});
		assert.deepStrictEqual(lsofScan(failure('stdout maxBuffer length exceeded', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), partial), {
			ok: false,
			reason: 'failed',
			detail: 'stdout maxBuffer length exceeded',
		});
		assert.deepStrictEqual(lsofScan(failure('Command failed: lsof', { code: 1 }), partial), { ok: true, processes: [running(12, '/work/wt', 'zsh')] });
		assert.deepStrictEqual(lsofScan(failure('spawn lsof ENOENT', { code: 'ENOENT' }), ''), { ok: false, reason: 'lsof-missing' });
	});

	test('a scan past its deadline gives up with the late result; one in time keeps its own', async () => {
		const late = () => 'late';
		assert.strictEqual(await withDeadline(new Promise<string>(() => {}), 10, late), 'late');
		assert.strictEqual(await withDeadline(Promise.resolve('scanned'), 1000, late), 'scanned');
		await assert.rejects(withDeadline(Promise.reject(new Error('no /proc')), 1000, late), /no \/proc/);
	});

	test('finds the processes inside a worktree, its subfolders included, never a sibling folder', async () => {
		const scan: ProcessScan = {
			ok: true,
			processes: [running(30, path.join(dir, 'wt', 'src'), 'vite'), running(20, path.join(dir, 'wt'), 'claude'), running(40, path.join(dir, 'wt-other'), 'zsh')],
		};
		const processes = new WorktreeProcesses(async () => scan);
		assert.deepStrictEqual(processes.check(), { used: false, reason: 'not-needed' });
		assert.deepStrictEqual(await processes.inside(path.join(dir, 'wt')), [
			{ pid: 20, command: 'claude' },
			{ pid: 30, command: 'vite' },
		]);
		assert.deepStrictEqual(processes.check(), { used: true });
	});

	test('gsp and the processes that started it do not count: running gsp from a worktree is fine', async () => {
		const wt = path.join(dir, 'wt');
		const scan: ProcessScan = {
			ok: true,
			processes: [running(process.pid, wt, 'node', 900), running(900, wt, 'zsh', 800), running(800, '/', 'login', 1), running(901, wt, 'zsh', 800)],
		};
		assert.deepStrictEqual(await new WorktreeProcesses(async () => scan).inside(wt), [{ pid: 901, command: 'zsh' }]);
	});

	test('fails open: when processes cannot be read, nothing is in use and the check says why', async () => {
		const missing = new WorktreeProcesses(async () => ({ ok: false, reason: 'lsof-missing' }));
		assert.strictEqual(await missing.inside(dir), null);
		assert.deepStrictEqual(missing.check(), { used: false, reason: 'lsof-missing' });

		const throwing = new WorktreeProcesses(async () => {
			throw new Error('boom');
		});
		assert.strictEqual(await throwing.inside(dir), null);
		assert.deepStrictEqual(throwing.check(), { used: false, reason: 'failed', detail: 'Error: boom' });
	});

	test('scans once until refreshed', async () => {
		let scans = 0;
		const processes = new WorktreeProcesses(async () => ({ ok: true, processes: [running(++scans + 100, dir)] }));
		await processes.inside(dir);
		assert.deepStrictEqual(await processes.inside(dir), [{ pid: 101, command: 'node' }]);
		processes.refresh();
		assert.deepStrictEqual(await processes.inside(dir), [{ pid: 102, command: 'node' }]);
	});

	test('sees a real process running in a folder', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const wt = path.join(dir, 'wt');
		const child = spawn('sleep', ['30'], { cwd: path.join(wt, 'src'), stdio: 'ignore' });
		try {
			const scan = await scanProcesses();
			assert.ok(scan.ok, JSON.stringify(scan));
			const found = await new WorktreeProcesses(async () => scan).inside(wt);
			assert.ok(found?.some((entry) => entry.pid === child.pid && entry.command === 'sleep'), JSON.stringify(found));
		} finally {
			child.kill();
		}
	});
});
