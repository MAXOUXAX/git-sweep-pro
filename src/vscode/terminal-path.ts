import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';

export const NODE_ENV_VAR = 'GIT_SWEEP_PRO_NODE';

/**
 * Makes the bundled CLI available as `gsp` and `git-sweep-pro` (and
 * therefore `git sweep-pro`) in VS Code's integrated terminals by appending the
 * extension's bin/ folder to PATH. The launchers run the CLI with VS Code's
 * own runtime (exposed through GIT_SWEEP_PRO_NODE), so Node.js does not need
 * to be installed.
 */
export function applyTerminalPath(context: vscode.ExtensionContext): void {
	const collection = context.environmentVariableCollection;
	collection.clear();
	if (!vscode.workspace.getConfiguration('gitSweepPro').get<boolean>('cli.addToTerminalPath', true)) {
		return;
	}

	const binDir = context.asAbsolutePath('bin');
	for (const launcher of ['gsp', 'git-sweep-pro']) {
		ensureExecutable(path.join(binDir, launcher));
	}
	collection.description = 'Adds the gsp command line to the terminal PATH.';
	collection.append('PATH', `${path.delimiter}${binDir}`);
	collection.replace(NODE_ENV_VAR, process.execPath);
}

/** VSIX archives do not reliably preserve the executable bit of the POSIX launcher. */
function ensureExecutable(file: string): void {
	if (process.platform === 'win32') {
		return;
	}
	try {
		fs.chmodSync(file, 0o755);
	} catch {
		// Read-only install location: the launcher can still be run with `sh`.
	}
}
