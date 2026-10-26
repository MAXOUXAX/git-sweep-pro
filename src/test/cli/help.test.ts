import * as assert from 'assert';
import { helpFor, USAGE } from '../../cli/help';

suite('cli help', () => {
	test('the overview opens with five common tasks, before the commands', () => {
		const tasks = USAGE.indexOf('Common tasks:');
		assert.ok(tasks > 0 && tasks < USAGE.indexOf('Commands:'));
		const block = USAGE.slice(tasks).split('\n\n')[0].split('\n').slice(1);
		assert.deepStrictEqual(
			block.map((line) => line.trim().split(/\s{2,}/)[0]),
			['gsp post-pr --yes', 'gsp clean --yes', 'gsp clean --json', 'gsp worktree remove <path>', 'gsp restore <branch>']
		);
	});

	test('every command agents use has its own common tasks', () => {
		for (const command of ['clean', 'post-pr', 'worktree', 'restore', 'agents'] as const) {
			const help = helpFor(command);
			assert.ok(help.startsWith(`Usage: gsp ${command}`), command);
			assert.ok(help.includes('\nCommon tasks:\n'), command);
		}
	});

	test('the help documents every exit code a command can return', () => {
		for (const text of ['worktree remove: the worktree was', 'agents --check: it found outdated', 'branch, remote or worktree that does not exist']) {
			assert.ok(USAGE.includes(text), text);
		}
	});
});
