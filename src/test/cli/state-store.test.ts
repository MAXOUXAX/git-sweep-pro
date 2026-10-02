import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFileStateStore, createMemoryStateStore, stateFilePath } from '../../cli/state-store';

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

		await store.update('k', { a: 1 });
		assert.deepStrictEqual(createFileStateStore(file).get('k'), { a: 1 }, 'visible to a fresh store (another process)');

		await store.update('other', true);
		assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['state.json'], 'no temporary file is left behind');
		await store.update('k', undefined);
		assert.strictEqual(store.get('k'), undefined);
		assert.ok(fs.existsSync(file));

		await store.update('other', undefined);
		assert.ok(!fs.existsSync(file));
	});

	test('surfaces a corrupt state file instead of silently dropping it', () => {
		const file = stateFilePath(dir);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '{not json');
		assert.throws(() => createFileStateStore(file).get('k'), SyntaxError);
	});

	test('memory store behaves like the file store', async () => {
		const store = createMemoryStateStore();
		await store.update('k', 1);
		assert.strictEqual(store.get('k'), 1);
		await store.update('k', undefined);
		assert.strictEqual(store.get('k'), undefined);
	});
});
