import type { SweepSettings } from '../core/sweep-logic';

export const COMMANDS = ['sweep', 'list', 'post-pr', 'sync', 'resume', 'help', 'version'] as const;
export type CommandName = (typeof COMMANDS)[number];

export type CliOptions = {
	readonly command: CommandName;
	/** Positional arguments after the command (e.g. the branch for `post-pr`/`sync`). */
	readonly positionals: readonly string[];
	/** Repository directory (`-C <path>`); defaults to the current directory. */
	readonly cwd: string | undefined;
	readonly dryRun: boolean;
	readonly force: boolean;
	readonly yes: boolean;
	readonly fetch: boolean;
	readonly confirm: boolean;
	readonly protect: readonly string[];
	readonly json: boolean;
	readonly verbose: boolean;
	/** `sync --continue` is an alias of `resume`. */
	readonly continueSync: boolean;
	/** Internal: drive the UI over NDJSON on stdio (used by the VS Code extension). */
	readonly rpc: boolean;
};

export class UsageError extends Error {}

const BOOLEAN_FLAGS: Record<string, keyof CliOptions> = {
	'--dry-run': 'dryRun',
	'-n': 'dryRun',
	'--force': 'force',
	'-f': 'force',
	'--yes': 'yes',
	'-y': 'yes',
	'--json': 'json',
	'--verbose': 'verbose',
	'-v': 'verbose',
	'--continue': 'continueSync',
	'--rpc': 'rpc',
};

const NEGATED_FLAGS: Record<string, keyof CliOptions> = {
	'--no-fetch': 'fetch',
	'--no-confirm': 'confirm',
};

/**
 * Parses `git-sweep-pro` arguments. Deliberately tiny and dependency-free: the
 * CLI ships inside the VS Code extension, which is packaged without
 * node_modules.
 */
export function parseArgs(argv: readonly string[]): CliOptions {
	const flags: Record<string, unknown> = {
		dryRun: false,
		force: false,
		yes: false,
		fetch: true,
		confirm: true,
		json: false,
		verbose: false,
		continueSync: false,
		rpc: false,
	};
	const protect: string[] = [];
	const positionals: string[] = [];
	let cwd: string | undefined;
	let command: CommandName | undefined;

	const takeValue = (flag: string, index: number): string => {
		const value = argv[index + 1];
		if (value === undefined || value.startsWith('-')) {
			throw new UsageError(`Option ${flag} requires a value.`);
		}
		return value;
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '-h' || arg === '--help') {
			command = 'help';
		} else if (arg === '--version') {
			command = 'version';
		} else if (arg === '-C') {
			cwd = takeValue(arg, i);
			i++;
		} else if (arg === '--protect' || arg === '-p') {
			protect.push(takeValue(arg, i));
			i++;
		} else if (arg.startsWith('--protect=')) {
			protect.push(arg.slice('--protect='.length));
		} else if (arg in BOOLEAN_FLAGS) {
			flags[BOOLEAN_FLAGS[arg]] = true;
		} else if (arg in NEGATED_FLAGS) {
			flags[NEGATED_FLAGS[arg]] = false;
		} else if (arg.startsWith('-') && arg !== '-') {
			throw new UsageError(`Unknown option: ${arg}`);
		} else if (command === undefined && (COMMANDS as readonly string[]).includes(arg)) {
			command = arg as CommandName;
		} else if (command === undefined && positionals.length === 0 && arg !== '-') {
			throw new UsageError(`Unknown command: ${arg}`);
		} else {
			positionals.push(arg);
		}
	}

	if (flags.dryRun && flags.force) {
		throw new UsageError('--dry-run and --force cannot be combined.');
	}

	let resolved: CommandName = command ?? 'sweep';
	if (resolved === 'sync' && flags.continueSync) {
		resolved = 'resume';
	}
	const maxPositionals = resolved === 'post-pr' || resolved === 'sync' ? 1 : 0;
	if (positionals.length > maxPositionals) {
		throw new UsageError(`Unexpected argument: ${positionals[maxPositionals]}`);
	}

	return {
		...(flags as Omit<CliOptions, 'command' | 'positionals' | 'cwd' | 'protect'>),
		command: resolved,
		positionals,
		cwd,
		protect,
	};
}

/** Translates sweep settings (e.g. the VS Code configuration) into CLI flags. */
export function settingsToCliArgs(settings: SweepSettings): string[] {
	return [
		...settings.protectedBranches.flatMap((pattern) => ['--protect', pattern]),
		...(settings.autoFetchPrune ? [] : ['--no-fetch']),
		...(settings.confirmBeforeDelete ? [] : ['--no-confirm']),
	];
}

export const USAGE = `Usage: git-sweep-pro [command] [options]

Safely prune local branches whose remote upstream is gone.
Also available as "git sweep-pro" when the executable is on your PATH.

Commands:
  sweep              Detect stale branches, pick, confirm and delete them (default)
  list               Print stale branches without deleting anything
  post-pr [branch]   After a merged PR: switch to [branch], delete the old branch,
                     sweep, then pull
  sync [upstream]    Rebase the current branch onto [upstream] and force-push
                     with --force-with-lease (stashes local changes)
  resume             Continue a sync paused on conflicts (alias: sync --continue)
  help, version

Options:
  -n, --dry-run      Only report what would be deleted
  -f, --force        Delete with "git branch -D" instead of "-d"
  -y, --yes          Accept pre-selected branches and confirm every prompt
  -p, --protect <glob>
                     Never delete branches matching <glob> (repeatable; also read
                     from "git config --get-all git-sweep-pro.protected")
      --no-fetch     Skip "git fetch -p" and use local ref state
      --no-confirm   Do not ask before deleting
      --json         Machine-readable output (list)
  -C <path>          Run as if started in <path>
  -v, --verbose      Echo every git command and its output
  -h, --help         Show this help

Without a terminal (e.g. in scripts), prompts fall back to their defaults and
confirmations are refused unless --yes is given.`;
