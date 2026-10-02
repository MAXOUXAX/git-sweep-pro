import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDeletionLog } from '../../core/deletion-log';
import { createFileStateStore, stateFilePath } from '../../cli/state-store';

suite('cli state store', () => {
	let dir: string;

	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsp-state-'));
	});

	teardown(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('persists values under the git dir and removes the file once empty', async () => {
		const file = stateFilePath(dir);
		assert.strictEqual(file, path.join(dir, 'git-sweep-pro', 'state.json'));

		const store = createFileStateStore(file);
		assert.strictEqual(store.get('k'), undefined);

		await store.update('k', () => ({ a: 1 }));
		assert.deepStrictEqual(createFileStateStore(file).get('k'), { a: 1 }, 'visible to a fresh store (another process)');

		await store.update('other', () => true);
		assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['state.json'], 'no temporary file is left behind');
		await store.update('k', () => undefined);
		assert.strictEqual(store.get('k'), undefined);
		assert.ok(fs.existsSync(file));

		await store.update('other', () => undefined);
		assert.ok(!fs.existsSync(file));
	});

	test('removes its temporary file when the rename fails', async () => {
		const file = stateFilePath(dir);
		// The module object itself: the store reads fs through live bindings to it.
		const nodeFs = require('node:fs') as typeof fs;
		const rename = nodeFs.renameSync;
		nodeFs.renameSync = () => {
			throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
		};
		try {
			await assert.rejects(async () => createFileStateStore(file).update('k', () => 1), /EPERM/);
		} finally {
			nodeFs.renameSync = rename;
		}
		assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), []);
	});

	test('concurrent processes keep every deletion and unrelated state key', async function () {
		this.timeout(15000);
		const file = stateFilePath(dir);
		const script = `
			const { createFileStateStore } = require(process.argv[1]);
			const { createDeletionLog } = require(process.argv[2]);
			const store = createFileStateStore(process.argv[3]);
			const id = process.argv[4];
			(async () => {
				const log = createDeletionLog(store);
				for (let i = 0; i < 10; i++) {
					await log.record({ branch: id + '-' + i, sha: 'a'.repeat(40), source: 'sweep' });
				}
				await store.update('process-' + id, () => true);
			})().catch(error => { console.error(error); process.exitCode = 1; });
		`;
		await Promise.all(Array.from({ length: 4 }, (_, id) => promisify(execFile)(process.execPath, [
			'-e', script, require.resolve('../../cli/state-store'), require.resolve('../../core/deletion-log'), file, String(id),
		], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })));
		const store = createFileStateStore(file);
		const entries = createDeletionLog(store).list();
		assert.strictEqual(entries.length, 40);
		assert.strictEqual(new Set(entries.map(entry => entry.branch)).size, 40);
		for (let id = 0; id < 4; id++) {
			assert.strictEqual(store.get('process-' + id), true);
		}
		assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
	});

	test('waits for another writer and transforms the latest value', async () => {
		const file = stateFilePath(dir);
		const store = createFileStateStore(file);
		await store.update('count', () => 1);
		fs.writeFileSync(`${file}.lock`, '');
		const pending = store.update<number>('count', current => (current ?? 0) + 1);
		fs.writeFileSync(file, JSON.stringify({ count: 5, other: true }));
		fs.rmSync(`${file}.lock`);
		await pending;
		assert.strictEqual(store.get('count'), 6);
		assert.strictEqual(store.get('other'), true);
	});

	test('times out without removing an existing lock or changing state', async function () {
		this.timeout(10000);
		const file = stateFilePath(dir);
		const store = createFileStateStore(file);
		await store.update('k', () => 1);
		fs.writeFileSync(`${file}.lock`, 'another writer');
		// An old lock can still belong to a live process. Leave recovery to the operator.
		fs.utimesSync(`${file}.lock`, new Date(0), new Date(0));
		await assert.rejects(async () => store.update('k', () => 2), /Another gsp command/);
		assert.strictEqual(store.get('k'), 1);
		assert.strictEqual(fs.readFileSync(`${file}.lock`, 'utf8'), 'another writer');
	});

	test('releases its lock when the transform throws', async () => {
		const file = stateFilePath(dir);
		const store = createFileStateStore(file);
		await store.update('k', () => 1);
		await assert.rejects(async () => store.update('k', () => { throw new Error('failed change'); }), /failed change/);
		assert.strictEqual(store.get('k'), 1);
		await store.update('k', () => 2);
		assert.strictEqual(store.get('k'), 2);
		assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
	});

	test('surfaces a corrupt state file instead of silently dropping it', () => {
		const file = stateFilePath(dir);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '{not json');
		assert.throws(() => createFileStateStore(file).get('k'), SyntaxError);
	});

});
