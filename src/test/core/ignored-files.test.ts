import * as assert from 'assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { RunGit } from '../../core/git-command';
import { HUSKY_FILES, isRegenerable, listIgnoredFiles } from '../../core/ignored-files';
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

	test("husky's generated hooks are regenerable only in a .husky/_ folder holding husky's .gitignore, and only the files husky writes", async () => {
		const { repo } = fixture;
		commitFile(repo, '.gitignore', ['/whole/.husky/_/', '/bare/.husky/_/'].join('\n'), 'ignore');
		const writeHusky = (folder: string, marker = '*') => {
			fs.mkdirSync(path.join(repo, folder), { recursive: true });
			for (const name of HUSKY_FILES) {
				fs.writeFileSync(path.join(repo, folder, name), name === '.gitignore' ? marker : '#!/usr/bin/env sh\n', { mode: 0o755 });
			}
		};
		writeHusky('.husky/_');
		writeHusky('whole/.husky/_');
		writeHusky('web/.husky/_');
		fs.writeFileSync(path.join(repo, 'web/.husky/_/notes.md'), 'mine');
		fs.writeFileSync(path.join(repo, 'web/.husky/_/.env.local'), 'TOKEN=1');
		writeHusky('tools/_');
		for (const name of HUSKY_FILES.filter((name) => name !== '.gitignore' && name !== 'pre-commit')) {
			fs.rmSync(path.join(repo, 'tools/_', name));
		}
		writeHusky('bare/.husky/_', 'node_modules');
		writeHusky('link/.husky/_');
		fs.rmSync(path.join(repo, 'link/.husky/_/h'));
		fs.symlinkSync(path.join(repo, 'web/.husky/_/notes.md'), path.join(repo, 'link/.husky/_/h'));

		assert.deepStrictEqual(await listIgnoredFiles(gitIn(repo), repo), [
			'bare/.husky/_/',
			'link/.husky/_/h',
			'tools/_/.gitignore',
			'tools/_/pre-commit',
			'web/.husky/_/.env.local',
			'web/.husky/_/notes.md',
		]);

		fs.writeFileSync(path.join(repo, 'whole/.husky/_/notes.md'), 'mine');
		assert.ok((await listIgnoredFiles(gitIn(repo), repo)).includes('whole/.husky/_/'), 'a file husky does not write keeps the whole folder');
	});
});
