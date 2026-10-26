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
	/** `post-pr --into <branch>`: the branch the pull request was merged into; the default branch when undefined. */
	readonly into: string | undefined;
	/** Repository directory (`-C <path>`); defaults to the current directory. */
	readonly cwd: string | undefined;
	/** `--dry-run`, `--force` (lifts the proof that a branch's work exists elsewhere), or a safe delete by default. */
	readonly mode: SweepMode;
	/**
	 * `--discard-changes` (clean, post-pr, worktree remove): a removed worktree
	 * may take uncommitted changes and ignored files with it, for good.
	 */
	readonly discardChanges: boolean;
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
	/** `--remote[=<name>]`: also clean the branches of that remote; empty for the default (origin). */
	readonly remote: string | undefined;
	/**
	 * `--expect <branch>=<sha>` (clean): delete each of these branches only if
	 * its tip is still that commit; remote branches as `<remote>/<name>`.
	 * They are named for the run too, as if given as positionals.
	 */
	readonly expect: ReadonlyMap<string, string>;
	readonly json: boolean;
	/** `agents --check`: report advice in instruction files that contradicts gsp, change nothing. */
	readonly check: boolean;
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
	'discard-changes': { type: 'boolean', default: false },
	yes: { type: 'boolean', short: 'y', default: false },
	'non-interactive': { type: 'boolean', default: false },
	merged: { type: 'boolean', short: 'm', default: false },
	protect: { type: 'string', short: 'p', multiple: true, default: [] },
	/** `--remote` alone is read as `--remote=` (see {@link withRemoteValue}): its value is optional. */
	remote: { type: 'string' },
	expect: { type: 'string', multiple: true, default: [] },
	// Declared explicitly: `allowNegative` needs Node 22.4, and VS Code 1.92 runs Node 20.14.
	'no-fetch': { type: 'boolean', default: false },
	'no-confirm': { type: 'boolean', default: false },
	'no-github': { type: 'boolean', default: false },
	json: { type: 'boolean', default: false },
	check: { type: 'boolean', default: false },
	cwd: { type: 'string', short: 'C' },
	into: { type: 'string' },
	verbose: { type: 'boolean', short: 'v', default: false },
	help: { type: 'boolean', short: 'h', default: false },
	version: { type: 'boolean', default: false },
	/** `sync --continue` is an alias of `resume`. */
	continue: { type: 'boolean', default: false },
	rpc: { type: 'boolean', default: false },
} satisfies ParseArgsOptionsConfig;

/**
 * `--remote` takes an optional value, which `util.parseArgs` cannot express:
 * a bare `--remote` becomes `--remote=` (the default remote), so the next
 * argument stays a branch name. The value is only read inline (`--remote=upstream`).
 */
function withRemoteValue(argv: readonly string[]): string[] {
	const end = argv.indexOf('--');
	return argv.map((arg, index) => (arg === '--remote' && (end < 0 || index < end) ? '--remote=' : arg));
}

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
export function parseArgs(rawArgv: readonly string[]): CliOptions {
	const argv = withRemoteValue(rawArgv);
	rejectInvalidOptions(argv);
	const { values, positionals } = parseArgv({ args: argv, options: OPTIONS, allowPositionals: true });

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
		command === 'clean' ||
		command === 'post-pr' || (worktree !== undefined && worktree.subcommand !== 'prune') ||
		(command === 'restore' && args.length === 0) ||
		(command === 'agents' && values.check);
	if (values.json && !jsonAllowed) {
		throw new UsageError('--json requires clean, post-pr, worktree list or remove, restore without branch arguments, or agents --check.');
	}
	if (values.check && command !== 'agents') {
		throw new UsageError('--check can only be used with agents.');
	}
	if (values.into !== undefined && command !== 'post-pr') {
		throw new UsageError('--into can only be used with post-pr.');
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
	if (worktree?.subcommand === 'remove' && values.force) {
		throw new UsageError(
			'--force cannot be used with worktree remove, which deletes no branch. To delete the uncommitted changes and ignored files of the worktree with it, use --discard-changes.'
		);
	}
	if (values['discard-changes'] && !(command === 'clean' || command === 'post-pr' || worktree?.subcommand === 'remove')) {
		throw new UsageError('--discard-changes can only be used with clean, post-pr or worktree remove.');
	}
	if (values.remote !== undefined && command !== 'clean') {
		throw new UsageError('--remote can only be used with clean.');
	}
	if (values.remote !== undefined && /^-|\s/.test(values.remote)) {
		throw new UsageError(`Invalid remote name: "${values.remote}".`);
	}
	if (values.expect.length > 0 && command !== 'clean') {
		throw new UsageError('--expect can only be used with clean.');
	}
	const expect = parseExpectations(values.expect);
	if (requested === 'list' && values.force) {
		throw new UsageError('list only plans: --force cannot be used with it.');
	}
	const maxPositionals = command === 'restore' || command === 'agents' || command === 'clean' ? Infinity : command === 'post-pr' || command === 'sync' ? 1 : 0;
	if (command !== 'worktree' && args.length > maxPositionals) {
		throw new UsageError(`Unexpected argument: ${args[maxPositionals]}`);
	}
	const invalidBranch = command === 'clean' || command === 'post-pr' ? args.find((arg) => arg.startsWith('-') || arg.trim() === '') : undefined;
	if (invalidBranch !== undefined) {
		throw new UsageError(`Invalid branch name: "${invalidBranch}".`);
	}
	// --check reads any file; writing is limited to the instruction files gsp knows.
	const unknownFile = command === 'agents' && !values.check ? args.find((file) => !isAgentFile(file)) : undefined;
	if (unknownFile !== undefined) {
		throw new UsageError(`Unknown instruction file: ${unknownFile}. Use ${AGENT_FILE_NAMES.join(' or ')}.`);
	}

	return {
		command,
		helpTopic: undefined,
		positionals: args,
		worktree,
		into: values.into,
		cwd: values.cwd,
		mode: values.force ? 'forceDelete' : values['dry-run'] || requested === 'list' ? 'dryRun' : 'safeDelete',
		discardChanges: values['discard-changes'],
		yes: values.yes,
		nonInteractive: values['non-interactive'],
		fetch: !values['no-fetch'],
		confirm: !values['no-confirm'],
		merged: values.merged,
		github: !values['no-github'],
		protect: values.protect,
		remote: values.remote,
		expect,
		json: values.json,
		check: values.check,
		verbose: values.verbose,
		rpc: values.rpc,
	};
}

/** A full commit SHA: SHA-1 or SHA-256. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** Reads `--expect <branch>=<sha>` values; the last `=` splits them, as a SHA has none. */
function parseExpectations(values: readonly string[]): Map<string, string> {
	const expect = new Map<string, string>();
	for (const value of values) {
		const split = value.lastIndexOf('=');
		const branch = value.slice(0, split);
		const sha = value.slice(split + 1).toLowerCase();
		if (split <= 0 || branch.startsWith('-') || !FULL_SHA.test(sha)) {
			throw new UsageError(`Invalid --expect "${value}": use <branch>=<full commit SHA>.`);
		}
		if (expect.has(branch) && expect.get(branch) !== sha) {
			throw new UsageError(`--expect names ${branch} twice, with different commits.`);
		}
		expect.set(branch, sha);
	}
	return expect;
}

/** Options of a `help` run: nothing else is read. */
function helpOptions(topic: CommandName | undefined): CliOptions {
	return {
		command: 'help',
		helpTopic: topic,
		positionals: [],
		worktree: undefined,
		into: undefined,
		cwd: undefined,
		mode: 'safeDelete',
		discardChanges: false,
		yes: false,
		nonInteractive: false,
		fetch: true,
		confirm: true,
		merged: false,
		github: true,
		protect: [],
		remote: undefined,
		expect: new Map(),
		json: false,
		check: false,
		verbose: false,
		rpc: false,
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

