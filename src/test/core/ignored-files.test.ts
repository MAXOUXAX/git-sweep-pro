import * as assert from 'assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { RunGit } from '../../core/git-command';
import { isRegenerable, listIgnoredFiles } from '../../core/ignored-files';
import { commitFile, createRepoFixture, type RepoFixture } from '../cli/git-fixture';

const run = promisify(execFile);
const gitIn = (cwd: string): RunGit => (args) => run('git', [...args], { cwd });

suite('ignored files', () => {
	let fixture: RepoFixture;

	setup(() => {
		fixture = createRepoFixture();
	});

	teardown(() => fixture.cleanup());

	test('a symlinked node_modules and the caches of common tools are regenerable', async () => {
		const { repo, dir } = fixture;
		commitFile(repo, '.gitignore', ['node_modules', '.vscode-test/', '.expo/', '.eslintcache', 'storybook-static/', '.angular/', '.nx/', '.terraform/', '.yarn/cache/', 'notes.md', 'linked-notes', '.env'].join('\n'), 'ignore');
		const shared = path.join(dir, 'shared-modules');
		fs.mkdirSync(path.join(shared, 'pkg'), { recursive: true });
		fs.writeFileSync(path.join(shared, 'pkg', 'index.js'), '');
		fs.symlinkSync(shared, path.join(repo, 'node_modules'));
		for (const folder of ['.vscode-test/user-data', '.expo/web', 'storybook-static', '.angular/cache', '.nx/cache', '.terraform/providers', '.yarn/cache']) {
			fs.mkdirSync(path.join(repo, folder), { recursive: true });
			fs.writeFileSync(path.join(repo, folder, 'file'), '');
		}
		// A downloaded VS Code ships certificates of its own: a dependency folder is not searched.
		fs.writeFileSync(path.join(repo, '.vscode-test', 'user-data', 'cert.pem'), '');
		fs.writeFileSync(path.join(repo, '.eslintcache'), '');
		fs.writeFileSync(path.join(repo, 'notes.md'), 'mine');
		fs.symlinkSync(path.join(repo, 'notes.md'), path.join(repo, 'linked-notes'));
		fs.writeFileSync(path.join(dir, 'secret'), '');
		fs.symlinkSync(path.join(dir, 'secret'), path.join(repo, '.env'));

		assert.deepStrictEqual(await listIgnoredFiles(gitIn(repo), repo), ['.env', 'linked-notes', 'notes.md']);
	});

	test('a symlink is regenerable only with the name of a regenerable folder or file', () => {
		assert.strictEqual(isRegenerable('node_modules', true), true);
		assert.strictEqual(isRegenerable('.eslintcache', true), true);
		assert.strictEqual(isRegenerable('data', true), false);
		assert.strictEqual(isRegenerable('.env.local', true), false);
		assert.strictEqual(isRegenerable('node_modules'), false);
		for (const regenerable of ['.vscode-test/', '.expo/', 'storybook-static/', '.angular/', '.nx/', '.yarn/cache/', '.terraform/', '.eslintcache']) {
			assert.strictEqual(isRegenerable(regenerable), true, regenerable);
		}
	});
});
