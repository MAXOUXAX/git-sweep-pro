import * as assert from 'assert';
import { modeToCliArgs, parseArgs, settingsToCliArgs, UsageError } from '../../cli/args';
import { DEFAULT_SETTINGS } from '../fake-context';

suite('cli args', () => {
	test('defaults to a safe, fetching, confirming clean', () => {
		const options = parseArgs([]);
		assert.strictEqual(options.command, 'clean');
		assert.strictEqual(options.mode, 'safeDelete');
		assert.strictEqual(options.fetch, true);
		assert.strictEqual(options.github, true);
		assert.strictEqual(options.confirm, true);
		assert.strictEqual(options.rpc, false);
		assert.strictEqual(options.nonInteractive, false);
		assert.deepStrictEqual(options.protect, []);
		assert.deepStrictEqual(options.positionals, []);
	});

	test('sweep is an alias of clean, list of clean --dry-run', () => {
		assert.strictEqual(parseArgs(['sweep']).command, 'clean');
		assert.strictEqual(parseArgs(['sweep']).mode, 'safeDelete');
		assert.strictEqual(parseArgs(['list']).command, 'clean');
		assert.strictEqual(parseArgs(['list']).mode, 'dryRun');
		assert.strictEqual(parseArgs(['list', '--yes']).mode, 'dryRun', 'list never applies');
		assert.throws(() => parseArgs(['list', '--force']), /list only plans/);
	});

	test('clean takes branch names and globs', () => {
		assert.deepStrictEqual(parseArgs(['clean', 'feature/a', 'fix/*']).positionals, ['feature/a', 'fix/*']);
		assert.deepStrictEqual(parseArgs(['sweep', 'a']).positionals, ['a']);
		assert.throws(() => parseArgs(['clean', '--', '-x']), /Invalid branch name: "-x"/);
	});

	test('--remote takes an optional inline value, and only with clean', () => {
		assert.strictEqual(parseArgs([]).remote, undefined);
		const bare = parseArgs(['clean', '--remote', 'feature/a']);
		assert.deepStrictEqual([bare.remote, bare.positionals], ['', ['feature/a']]);
		assert.strictEqual(parseArgs(['--remote=upstream', '--yes']).remote, 'upstream');
		assert.strictEqual(parseArgs(['list', '--remote']).remote, '');
		assert.throws(() => parseArgs(['clean', '--', '--remote']), /Invalid branch name: "--remote"/, 'after --, not the option');
		assert.throws(() => parseArgs(['worktree', 'list', '--remote']), /--remote can only be used with clean/);
		assert.throws(() => parseArgs(['--remote=-x']), /Invalid remote name: "-x"/);
	});

	test('--merged is still accepted, as a no-op; --no-github turns GitHub off', () => {
		assert.strictEqual(parseArgs(['-m']).merged, true);
		assert.strictEqual(parseArgs(['--merged']).command, 'clean');
		assert.strictEqual(parseArgs(['--no-github']).github, false);
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

	test('supports explicit non-interactive mode without implying consent', () => {
		const options = parseArgs(['--non-interactive']);
		assert.strictEqual(options.nonInteractive, true);
		assert.strictEqual(options.yes, false);
		assert.throws(() => parseArgs(['--non-interactive', '--rpc']), /cannot be combined/);
	});

	test('JSON is available for clean and discovery, never silently ignored by another mutation', () => {
		assert.strictEqual(parseArgs(['--json']).json, true);
		assert.strictEqual(parseArgs(['clean', '--json', '--yes']).json, true);
		assert.strictEqual(parseArgs(['sweep', '--json']).json, true);
		assert.strictEqual(parseArgs(['list', '--json']).json, true);
		assert.strictEqual(parseArgs(['worktree', 'list', '--json']).json, true);
		assert.strictEqual(parseArgs(['restore', '--json']).json, true);
		assert.strictEqual(parseArgs(['--json', '--help']).command, 'help');
		for (const args of [
			['worktree', 'prune'],
			['worktree', 'remove', 'feature/x'],
			['post-pr', 'main'],
			['sync'],
			['resume'],
			['restore', 'feature/x'],
			['agents'],
		]) {
			assert.throws(() => parseArgs([...args, '--json']), /--json requires clean, worktree list, or restore without branch arguments/);
		}
	});

	test('sync --continue is an alias of resume', () => {
		assert.strictEqual(parseArgs(['sync', '--continue']).command, 'resume');
		assert.strictEqual(parseArgs(['resume']).command, 'resume');
	});

	test('recognizes help and version, with the help of one command', () => {
		assert.strictEqual(parseArgs(['--help']).command, 'help');
		assert.strictEqual(parseArgs(['--help']).helpTopic, undefined);
		assert.strictEqual(parseArgs(['sweep', '-h']).helpTopic, 'sweep');
		assert.strictEqual(parseArgs(['clean', '--help']).helpTopic, 'clean');
		assert.strictEqual(parseArgs(['worktree', '--help']).helpTopic, 'worktree');
		assert.strictEqual(parseArgs(['help', 'restore']).helpTopic, 'restore');
		assert.throws(() => parseArgs(['help', 'nope']), /Unknown command: nope/);
		assert.strictEqual(parseArgs(['--version']).command, 'version');
		assert.strictEqual(parseArgs(['version']).command, 'version');
	});

	test('rejects invalid input with a UsageError', () => {
		assert.throws(() => parseArgs(['--bogus']), UsageError);
		assert.throws(() => parseArgs(['frobnicate']), /Unknown command: frobnicate/);
		assert.throws(() => parseArgs(['--dry-run', '--force']), /cannot be combined/);
		assert.throws(() => parseArgs(['--protect']), /requires a value/);
		assert.throws(() => parseArgs(['-C', '--yes']), /Option -C requires a value/);
		assert.throws(() => parseArgs(['--yes=1']), /Option --yes does not take a value/);
		assert.throws(() => parseArgs(['resume', 'extra']), /Unexpected argument: extra/);
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

	test('parses worktree subcommands and their target', () => {
		assert.strictEqual(parseArgs(['worktree', 'list']).command, 'worktree');
		assert.deepStrictEqual(parseArgs(['worktree', 'list']).worktree, { subcommand: 'list', target: undefined });
		assert.deepStrictEqual(parseArgs(['worktree', 'prune']).worktree, { subcommand: 'prune', target: undefined });
		assert.deepStrictEqual(parseArgs(['worktree', 'remove', 'feature/x']).worktree, { subcommand: 'remove', target: 'feature/x' });
		assert.deepStrictEqual(parseArgs(['worktree', 'remove', '/tmp/wt']).worktree, { subcommand: 'remove', target: '/tmp/wt' });
	});

	test('rejects invalid worktree invocations', () => {
		assert.throws(() => parseArgs(['worktree']), /worktree requires a subcommand: list, prune, remove/);
		assert.throws(() => parseArgs(['worktree', 'frobnicate']), /Unknown worktree subcommand: frobnicate\. Use list, prune, remove/);
		assert.throws(() => parseArgs(['worktree', 'list', 'extra']), /Unexpected argument: extra/);
		assert.throws(() => parseArgs(['worktree', 'prune', 'extra']), /Unexpected argument: extra/);
		assert.throws(() => parseArgs(['worktree', 'remove']), /worktree remove requires a path or a branch/);
		assert.throws(() => parseArgs(['worktree', 'remove', 'a', 'b']), /Unexpected argument: b/);
		assert.throws(() => parseArgs(['worktree', 'remove', 'x', '--dry-run']), /--dry-run cannot be used with worktree remove\./);
	});

	test('--dry-run is refused only for worktree remove, and accepted by the read-only subcommands', () => {
		assert.strictEqual(parseArgs(['worktree', 'list', '--dry-run']).mode, 'dryRun');
		assert.strictEqual(parseArgs(['worktree', 'prune', '--dry-run']).mode, 'dryRun');
		assert.throws(() => parseArgs(['worktree', 'remove', 'feature/x', '--dry-run']), /--dry-run cannot be used with worktree remove\./);
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
