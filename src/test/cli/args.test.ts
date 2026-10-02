import * as assert from 'assert';
import { modeToCliArgs, parseArgs, settingsToCliArgs, UsageError } from '../../cli/args';
import { DEFAULT_SETTINGS } from '../fake-context';

suite('cli args', () => {
	test('defaults to a safe, fetching, confirming sweep', () => {
		const options = parseArgs([]);
		assert.strictEqual(options.command, 'sweep');
		assert.strictEqual(options.mode, 'safeDelete');
		assert.strictEqual(options.fetch, true);
		assert.strictEqual(options.confirm, true);
		assert.strictEqual(options.rpc, false);
		assert.deepStrictEqual(options.protect, []);
	});

	test('parses short and long flags, repeatable --protect and -C', () => {
		const options = parseArgs(['sweep', '-n', '-y', '--protect', 'main', '-p', 'release/*', '--protect=hotfix/*', '--no-fetch', '--no-confirm', '-C', '/repo', '-v']);
		assert.strictEqual(options.mode, 'dryRun');
		assert.strictEqual(options.yes, true);
		assert.deepStrictEqual(options.protect, ['main', 'release/*', 'hotfix/*']);
		assert.strictEqual(options.fetch, false);
		assert.strictEqual(options.confirm, false);
		assert.strictEqual(options.cwd, '/repo');
		assert.strictEqual(options.verbose, true);
	});

	test('accepts grouped short flags and a --protect value that starts with a dash', () => {
		const options = parseArgs(['-ny', '--protect=-wip']);
		assert.strictEqual(options.mode, 'dryRun');
		assert.strictEqual(options.yes, true);
		assert.deepStrictEqual(options.protect, ['-wip']);
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
		assert.throws(() => parseArgs(['-C', '--yes']), /Option -C requires a value/);
		assert.throws(() => parseArgs(['--yes=1']), /Option --yes does not take a value/);
		assert.throws(() => parseArgs(['sweep', 'extra']), /Unexpected argument: extra/);
		assert.throws(() => parseArgs(['sync', 'a', 'b']), /Unexpected argument: b/);
		assert.throws(() => parseArgs(['restore', 'a', '--dry-run']), /--dry-run cannot be used with restore\./);
		assert.throws(() => parseArgs(['restore', '-f']), /--force cannot be used with restore\./);
	});

	test('agents takes instruction file names, and rejects any other', () => {
		assert.deepStrictEqual(parseArgs(['agents']).positionals, []);
		assert.deepStrictEqual(parseArgs(['agents', 'AGENTS.md', 'CLAUDE.md']).positionals, ['AGENTS.md', 'CLAUDE.md']);
		assert.throws(() => parseArgs(['agents', 'README.md']), /Unknown instruction file: README\.md\. Use AGENTS\.md or CLAUDE\.md\./);
	});

	test('restore takes any number of branches', () => {
		assert.deepStrictEqual(parseArgs(['restore']).positionals, []);
		assert.deepStrictEqual(parseArgs(['restore', 'a', 'b/c']).positionals, ['a', 'b/c']);
	});

	test('--force selects a force delete, and modeToCliArgs maps each mode back to its flags', () => {
		assert.strictEqual(parseArgs(['-f']).mode, 'forceDelete');
		assert.deepStrictEqual(modeToCliArgs('dryRun'), ['--dry-run']);
		assert.deepStrictEqual(modeToCliArgs('safeDelete'), []);
		assert.deepStrictEqual(modeToCliArgs('forceDelete'), ['--force']);
	});

	test('settingsToCliArgs mirrors the extension settings', () => {
		assert.deepStrictEqual(settingsToCliArgs(DEFAULT_SETTINGS), []);
		assert.deepStrictEqual(
			settingsToCliArgs({
				...DEFAULT_SETTINGS,
				protectedBranches: ['main', 'release/*'],
				autoFetchPrune: false,
				confirmBeforeDelete: false,
			}),
			['--protect', 'main', '--protect', 'release/*', '--no-fetch', '--no-confirm']
		);
	});
});
