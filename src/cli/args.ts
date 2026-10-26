import { parseArgs as parseArgv, type ParseArgsOptionsConfig } from 'node:util';
import { AGENT_FILE_NAMES, isAgentFile } from '../core/agent-instructions';
import type { SweepMode, SweepSettings } from '../core/sweep-logic';

export const COMMANDS = ['clean', 'sweep', 'list', 'worktree', 'post-pr', 'sync', 'resume', 'restore', 'agents', 'help', 'version'] as const;
export type CommandName = (typeof COMMANDS)[number];

export const WORKTREE_SUBCOMMANDS = ['list', 'prune', 'remove'] as const;
export type WorktreeSubcommand = (typeof WORKTREE_SUBCOMMANDS)[number];

export type WorktreeArgs = {
	readonly subcommand: WorktreeSubcommand;
	/** Path or branch named by `worktree remove`; `undefined` for `list`/`prune`. */
	readonly target: string | undefined;
};

/** Commands that run `clean`: `sweep` is an alias, `list` an alias of `clean --dry-run`. */
const CLEAN_ALIASES: readonly CommandName[] = ['clean', 'sweep', 'list'];

export type CliOptions = {
	/** The command to run; `sweep` and `list` are read as `clean`. */
	readonly command: Exclude<CommandName, 'sweep' | 'list'>;
	/** The command whose help `help` prints (`gsp help clean`, `gsp clean --help`); `undefined` for the overview. */
	readonly helpTopic: CommandName | undefined;
	/**
	 * Positional arguments after the command: branch names or globs for `clean`,
	 * the branch for `post-pr`/`sync`, the branches for `restore`, the files for `agents`.
	 */
	readonly positionals: readonly string[];
	/** The `worktree` subcommand and its target, when {@link command} is `worktree`. */
	readonly worktree: WorktreeArgs | undefined;
	/** Repository directory (`-C <path>`); defaults to the current directory. */
	readonly cwd: string | undefined;
	/** `--dry-run`, `--force`, or a safe delete by default. */
	readonly mode: SweepMode;
	readonly yes: boolean;
	/** Never load terminal widgets, even when an agent uses a pseudo-terminal. */
	readonly nonInteractive: boolean;
	readonly fetch: boolean;
	readonly confirm: boolean;
	/** Deprecated `--merged`: merged branches are always candidates now. Accepted so old scripts keep working. */
	readonly merged: boolean;
	/** Ask GitHub for merged pull requests through `gh` (`--no-github` turns it off). */
	readonly github: boolean;
	readonly protect: readonly string[];
	readonly json: boolean;
	readonly verbose: boolean;
	/** Internal: drive the UI over NDJSON on stdio (used by the VS Code extension). */
	readonly rpc: boolean;
};

export class UsageError extends Error {}

/** Exit codes, documented in the README. */
export const EXIT = {
	ok: 0,
	failed: 1,
	usage: 2,
	/** A sync stopped on rebase conflicts; run `resume` once they are resolved. */
	paused: 3,
	/** Someone at the keyboard cancelled a prompt. */
	cancelled: 4,
	/** The plan holds deletions that were not applied: no `--yes`, `--dry-run`, or `--force` missing. */
	notApplied: 5,
} as const;

const OPTIONS = {
	'dry-run': { type: 'boolean', short: 'n', default: false },
	force: { type: 'boolean', short: 'f', default: false },
	yes: { type: 'boolean', short: 'y', default: false },
	'non-interactive': { type: 'boolean', default: false },
	merged: { type: 'boolean', short: 'm', default: false },
	protect: { type: 'string', short: 'p', multiple: true, default: [] },
	// Declared explicitly: `allowNegative` needs Node 22.4, and VS Code 1.92 runs Node 20.14.
	'no-fetch': { type: 'boolean', default: false },
	'no-confirm': { type: 'boolean', default: false },
	'no-github': { type: 'boolean', default: false },
	json: { type: 'boolean', default: false },
	cwd: { type: 'string', short: 'C' },
	verbose: { type: 'boolean', short: 'v', default: false },
	help: { type: 'boolean', short: 'h', default: false },
	version: { type: 'boolean', default: false },
	/** `sync --continue` is an alias of `resume`. */
	continue: { type: 'boolean', default: false },
	rpc: { type: 'boolean', default: false },
} satisfies ParseArgsOptionsConfig;

/**
 * Reports unknown options and missing values with the CLI's own wording. The
 * strict parse would throw too, but with messages written for Node developers.
 */
function rejectInvalidOptions(argv: readonly string[]): void {
	const { tokens } = parseArgv({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: false, tokens: true });
	for (const token of tokens) {
		if (token.kind !== 'option') {
			continue;
		}
		const option = Object.entries(OPTIONS).find(([name]) => name === token.name)?.[1];
		if (!option) {
			throw new UsageError(`Unknown option: ${token.rawName}`);
		}
		if (option.type === 'string' && (token.value === undefined || (!token.inlineValue && token.value.startsWith('-')))) {
			throw new UsageError(`Option ${token.rawName} requires a value.`);
		}
		if (option.type === 'boolean' && token.value !== undefined) {
			throw new UsageError(`Option ${token.rawName} does not take a value.`);
		}
	}
}

/**
 * Validates a `worktree` invocation: a known subcommand, no extra arguments,
 * and exactly one target for `remove`. Invalid uses are usage errors (exit 2).
 */
function parseWorktreeArgs(args: readonly string[]): WorktreeArgs {
	const [subcommand, ...rest] = args;
	if (subcommand === undefined) {
		throw new UsageError(`worktree requires a subcommand: ${WORKTREE_SUBCOMMANDS.join(', ')}.`);
	}
	if (!(WORKTREE_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
		throw new UsageError(`Unknown worktree subcommand: ${subcommand}. Use ${WORKTREE_SUBCOMMANDS.join(', ')}.`);
	}
	const sub = subcommand as WorktreeSubcommand;
	const maxTargets = sub === 'remove' ? 1 : 0;
	if (rest.length > maxTargets) {
		throw new UsageError(`Unexpected argument: ${rest[maxTargets]}`);
	}
	if (sub === 'remove' && rest.length === 0) {
		throw new UsageError('worktree remove requires a path or a branch.');
	}
	return { subcommand: sub, target: rest[0] };
}

/**
 * Parses `gsp` arguments with `util.parseArgs`: no dependency, as the
 * CLI ships inside the VS Code extension, which is packaged without
 * node_modules.
 */
export function parseArgs(argv: readonly string[]): CliOptions {
	rejectInvalidOptions(argv);
	const { values, positionals } = parseArgv({ args: [...argv], options: OPTIONS, allowPositionals: true });

	if (values['dry-run'] && values.force) {
		throw new UsageError('--dry-run and --force cannot be combined.');
	}

	const [first, ...rest] = positionals;
	const named = COMMANDS.find((name) => name === first);
	if (first !== undefined && named === undefined && first !== '-') {
		throw new UsageError(`Unknown command: ${first}`);
	}
	const args = named ? rest : positionals;

	const requested: CommandName = named ?? 'clean';
	if (values.help || requested === 'help') {
		const topic = values.help ? named : COMMANDS.find((name) => name === args[0]);
		if (!values.help && args[0] !== undefined && topic === undefined) {
			throw new UsageError(`Unknown command: ${args[0]}`);
		}
		return helpOptions(topic);
	}
	if (values.version || requested === 'version') {
		return { ...helpOptions(undefined), command: 'version' };
	}
	const isClean = CLEAN_ALIASES.includes(requested);
	let command: CliOptions['command'] = isClean ? 'clean' : (requested as CliOptions['command']);
	if (command === 'sync' && values.continue) {
		command = 'resume';
	}
	if (values.rpc && values['non-interactive']) {
		throw new UsageError('--non-interactive cannot be combined with --rpc.');
	}
	const worktree = command === 'worktree' ? parseWorktreeArgs(args) : undefined;
	const jsonAllowed =
		command === 'clean' || (worktree !== undefined && worktree.subcommand === 'list') || (command === 'restore' && args.length === 0);
	if (values.json && !jsonAllowed) {
		throw new UsageError('--json requires clean, worktree list, or restore without branch arguments.');
	}
	if (command === 'restore' && (values['dry-run'] || values.force)) {
		// Restore never overwrites a branch, so there is nothing to force or to preview.
		throw new UsageError(`${values.force ? '--force' : '--dry-run'} cannot be used with restore.`);
	}
	if (command === 'worktree' && worktree?.subcommand === 'remove' && values['dry-run']) {
		// Only `worktree remove` mutates without a preview: refusing the flag
		// beats silently removing a worktree during a supposedly dry run.
		// `worktree list` ignores it and `worktree prune` uses it as a preview.
		throw new UsageError('--dry-run cannot be used with worktree remove.');
	}
	if (requested === 'list' && values.force) {
		throw new UsageError('list only plans: --force cannot be used with it.');
	}
	const maxPositionals = command === 'restore' || command === 'agents' || command === 'clean' ? Infinity : command === 'post-pr' || command === 'sync' ? 1 : 0;
	if (command !== 'worktree' && args.length > maxPositionals) {
		throw new UsageError(`Unexpected argument: ${args[maxPositionals]}`);
	}
	const invalidBranch = command === 'clean' ? args.find((arg) => arg.startsWith('-') || arg.trim() === '') : undefined;
	if (invalidBranch !== undefined) {
		throw new UsageError(`Invalid branch name: "${invalidBranch}".`);
	}
	const unknownFile = command === 'agents' ? args.find((file) => !isAgentFile(file)) : undefined;
	if (unknownFile !== undefined) {
		throw new UsageError(`Unknown instruction file: ${unknownFile}. Use ${AGENT_FILE_NAMES.join(' or ')}.`);
	}

	return {
		command,
		helpTopic: undefined,
		positionals: args,
		worktree,
		cwd: values.cwd,
		mode: values.force ? 'forceDelete' : values['dry-run'] || requested === 'list' ? 'dryRun' : 'safeDelete',
		yes: values.yes,
		nonInteractive: values['non-interactive'],
		fetch: !values['no-fetch'],
		confirm: !values['no-confirm'],
		merged: values.merged,
		github: !values['no-github'],
		protect: values.protect,
		json: values.json,
		verbose: values.verbose,
		rpc: values.rpc,
	};
}

/** Options of a `help` run: nothing else is read. */
function helpOptions(topic: CommandName | undefined): CliOptions {
	return {
		command: 'help',
		helpTopic: topic,
		positionals: [],
		worktree: undefined,
		cwd: undefined,
		mode: 'safeDelete',
		yes: false,
		nonInteractive: false,
		fetch: true,
		confirm: true,
		merged: false,
		github: true,
		protect: [],
		json: false,
		verbose: false,
		rpc: false,
	};
}

const MODE_FLAGS: Record<SweepMode, readonly string[]> = { dryRun: ['--dry-run'], safeDelete: [], forceDelete: ['--force'] };

/** The CLI flags selecting a sweep mode. */
export function modeToCliArgs(mode: SweepMode): string[] {
	return [...MODE_FLAGS[mode]];
}

/** Translates sweep settings (e.g. the VS Code configuration) into CLI flags. */
export function settingsToCliArgs(settings: SweepSettings): string[] {
	return [
		...settings.protectedBranches.flatMap((pattern) => ['--protect', pattern]),
		...(settings.autoFetchPrune ? [] : ['--no-fetch']),
		...(settings.confirmBeforeDelete ? [] : ['--no-confirm']),
	];
}

