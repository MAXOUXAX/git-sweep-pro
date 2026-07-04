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

/*
 * Multi-root end-to-end config: open a real .code-workspace referencing two
 * folders so the extension has to resolve which repository to operate on. The
 * folders and workspace file must exist before VS Code launches; the suite
 * populates them with real git repositories in its setup hook.
 */
const mrBase = path.join(os.tmpdir(), 'gsp-e2e-mr');
const mrRepoA = path.join(mrBase, 'repoA');
const mrRepoB = path.join(mrBase, 'repoB');
const mrWorkspaceFile = path.join(mrBase, 'multi.code-workspace');
fs.mkdirSync(mrRepoA, { recursive: true });
fs.mkdirSync(mrRepoB, { recursive: true });
fs.writeFileSync(
	mrWorkspaceFile,
	JSON.stringify({ folders: [{ path: mrRepoA }, { path: mrRepoB }], settings: {} }, null, 2)
);

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
	{
		label: 'e2e-mr',
		files: 'out/test/e2e-mr/**/*.test.js',
		workspaceFolder: mrWorkspaceFile,
		launchArgs: [
			`--user-data-dir=${path.join(mrBase, 'ud')}`,
			`--extensions-dir=${path.join(mrBase, 'ext')}`,
		],
		env: { GSP_E2E_MR_A: mrRepoA, GSP_E2E_MR_B: mrRepoB },
		mocha: { timeout: 120000 },
	},
]);
