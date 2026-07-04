import { defineConfig } from '@vscode/test-cli';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = path.join(os.tmpdir(), 'gsp-vst');
const userDataDir = path.join(base, 'ud');
const extensionsDir = path.join(base, 'ext');

/*
 * End-to-end config: open a real folder as the workspace so the extension
 * resolves it and runs the real git CLI against it. The folder must exist at
 * launch time (this file runs in Node before VS Code starts); the e2e suite
 * populates it with a real git repository in its setup hook.
 */
const e2eBase = path.join(os.tmpdir(), 'gsp-e2e');
const e2eRepo = path.join(e2eBase, 'repo');
fs.mkdirSync(e2eRepo, { recursive: true });

export default defineConfig([
	{
		label: 'unit',
		files: ['out/test/*.test.js', 'out/test/core/**/*.test.js'],
		launchArgs: [
			`--user-data-dir=${userDataDir}`,
			`--extensions-dir=${extensionsDir}`,
		],
	},
	{
		label: 'e2e',
		files: 'out/test/e2e/**/*.test.js',
		workspaceFolder: e2eRepo,
		launchArgs: [
			`--user-data-dir=${path.join(e2eBase, 'ud')}`,
			`--extensions-dir=${path.join(e2eBase, 'ext')}`,
		],
		env: { GSP_E2E_REPO: e2eRepo },
		mocha: { timeout: 120000 },
	},
]);
