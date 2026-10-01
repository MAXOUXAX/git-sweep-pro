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
	// VS Code 1.85 (the minimum engine) runs extensions on Node 18.
	target: 'node18',
	format: 'cjs',
	logLevel: 'info',
};

await Promise.all([
	build({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] }),
	build({ ...common, entryPoints: ['src/cli/main.ts'], outfile: 'dist/cli/main.js' }),
]);
