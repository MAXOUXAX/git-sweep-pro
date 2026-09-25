import * as assert from 'assert';
import { parseArgs, settingsToCliArgs, UsageError } from '../../cli/args';
import { DEFAULT_SWEEP_SETTINGS } from '../../core/sweep-logic';

suite('cli args', () => {
	test('defaults to a safe, fetching, confirming sweep', () => {
		const options = parseArgs([]);
		assert.strictEqual(options.command, 'sweep');
		assert.strictEqual(options.dryRun, false);
		assert.strictEqual(options.force, false);
		assert.strictEqual(options.fetch, true);
		assert.strictEqual(options.confirm, true);
		assert.strictEqual(options.rpc, false);
		assert.deepStrictEqual(options.protect, []);
	});

	test('parses short and long flags, repeatable --protect and -C', () => {
		const options = parseArgs(['sweep', '-n', '-y', '--protect', 'main', '-p', 'release/*', '--protect=hotfix/*', '--no-fetch', '--no-confirm', '-C', '/repo', '-v']);
		assert.strictEqual(options.dryRun, true);
		assert.strictEqual(options.yes, true);
		assert.deepStrictEqual(options.protect, ['main', 'release/*', 'hotfix/*']);
		assert.strictEqual(options.fetch, false);
		assert.strictEqual(options.confirm, false);
		assert.strictEqual(options.cwd, '/repo');
		assert.strictEqual(options.verbose, true);
	});

	test('takes a branch positional for post-pr and sync', () => {
		assert.deepStrictEqual(parseArgs(['post-pr', 'main']).positionals, ['main']);
		assert.deepStrictEqual(parseArgs(['sync', 'origin/main']).positionals, ['origin/main']);
	});

	test('sync --continue is an alias of resume', () => {
		assert.strictEqual(parseArgs(['sync', '--continue']).command, 'resume');
		assert.strictEqual(parseArgs(['resume']).command, 'resume');
	});

	test('recognizes help and version', () => {
		assert.strictEqual(parseArgs(['--help']).command, 'help');
		assert.strictEqual(parseArgs(['sweep', '-h']).command, 'help');
		assert.strictEqual(parseArgs(['--version']).command, 'version');
	});

	test('rejects invalid input with a UsageError', () => {
		assert.throws(() => parseArgs(['--bogus']), UsageError);
		assert.throws(() => parseArgs(['frobnicate']), /Unknown command: frobnicate/);
		assert.throws(() => parseArgs(['--dry-run', '--force']), /cannot be combined/);
		assert.throws(() => parseArgs(['--protect']), /requires a value/);
		assert.throws(() => parseArgs(['-C', '--yes']), /requires a value/);
		assert.throws(() => parseArgs(['sweep', 'extra']), /Unexpected argument: extra/);
		assert.throws(() => parseArgs(['sync', 'a', 'b']), /Unexpected argument: b/);
	});

	test('settingsToCliArgs mirrors the extension settings', () => {
		assert.deepStrictEqual(settingsToCliArgs(DEFAULT_SWEEP_SETTINGS), []);
		assert.deepStrictEqual(
			settingsToCliArgs({
				...DEFAULT_SWEEP_SETTINGS,
				protectedBranches: ['main', 'release/*'],
				autoFetchPrune: false,
				confirmBeforeDelete: false,
			}),
			['--protect', 'main', '--protect', 'release/*', '--no-fetch', '--no-confirm']
		);
	});
});
