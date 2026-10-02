import { build } from 'esbuild';
import fs from 'node:fs';

/*
 * Production bundles. The extension is packaged with --no-dependencies, so the
 * CLI's runtime dependencies (@clack/prompts, picocolors) are inlined here.
 * Outputs:
 *   dist/extension.js  VS Code entry point ("main")
 *   dist/cli/main.js   git-sweep-pro CLI ("bin" and the bin/ launchers)
 * Type checking is done separately by `tsc --noEmit`.
 */
fs.rmSync('dist', { recursive: true, force: true });

const common = {
	bundle: true,
	platform: 'node',
	// VS Code 1.92 (the minimum engine) runs extensions on Node 20.14; @clack/prompts
	// needs 20.12 (util.styleText).
	target: 'node20.14',
	format: 'cjs',
	logLevel: 'info',
};

await Promise.all([
	build({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] }),
	build({ ...common, entryPoints: ['src/cli/main.ts'], outfile: 'dist/cli/main.js' }),
]);
