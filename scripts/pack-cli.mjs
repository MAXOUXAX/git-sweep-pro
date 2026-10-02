import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Packs the bundled CLI (dist/cli/main.js, built by `npm run build`) as the
 * archive the Homebrew formula installs, then points Formula/git-sweep-pro.rb
 * at the release asset it becomes. Run by semantic-release before publishing:
 *   node scripts/pack-cli.mjs <version>
 */
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+/.test(version ?? '')) {
	throw new Error('Usage: node scripts/pack-cli.mjs <version>');
}

const archive = `git-sweep-pro-cli-${version}.tar.gz`;
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gsp-cli-'));
const root = path.join(stage, `git-sweep-pro-${version}`);
// The CLI reads its version from the package.json two levels above main.js.
for (const file of ['package.json', 'LICENCE', 'dist/cli/main.js']) {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.copyFileSync(file, path.join(root, file));
}
execFileSync('tar', ['-czf', path.resolve(archive), '-C', stage, path.basename(root)]);
fs.rmSync(stage, { recursive: true, force: true });

const sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
const formulaPath = 'Formula/git-sweep-pro.rb';
const formula = fs
	.readFileSync(formulaPath, 'utf8')
	.replace(/^(\s*url ").*(")$/m, `$1https://github.com/MAXOUXAX/git-sweep-pro/releases/download/v${version}/${archive}$2`)
	.replace(/^(\s*sha256 ")[0-9a-f]*(")$/m, `$1${sha256}$2`);
fs.writeFileSync(formulaPath, formula);
console.log(`Packed ${archive} (sha256 ${sha256}) and updated ${formulaPath}.`);
