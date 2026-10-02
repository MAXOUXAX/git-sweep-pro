import * as assert from 'assert';
import type { RunGit } from '../../core/git-command';
import { findMergedBranches } from '../../core/merged-branches';

suite('merged branch classification concurrency', () => {
	test('bounds Git processes and keeps branch order across all candidates', async () => {
		let active = 0;
		let peak = 0;
		const branches = Array.from({ length: 24 }, (_, index) => `feature/${index}`);
		const runGit: RunGit = async (args) => {
			if (args[0] === 'for-each-ref') {
				return { stdout: '', stderr: '' };
			}
			assert.strictEqual(args[0], 'cherry');
			active++;
			peak = Math.max(peak, active);
			await new Promise<void>((resolve) => setImmediate(resolve));
			active--;
			return { stdout: '- abc123 patch already upstream\n', stderr: '' };
		};
		const found = await findMergedBranches(runGit, branches, { name: 'main', remoteRef: 'origin/main' });
		assert.ok(peak > 1 && peak <= 4, `peak concurrent processes: ${peak}`);
		assert.deepStrictEqual(found, branches.map(name => ({ name, how: 'rebase-merged', into: 'origin/main' })));
	});
});
