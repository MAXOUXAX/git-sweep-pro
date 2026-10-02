import { parseArgs as parseArgv, type ParseArgsOptionsConfig } from 'node:util';
import { AGENT_FILE_NAMES, isAgentFile } from '../core/agent-instructions';
import type { SweepMode, SweepSettings } from '../core/sweep-logic';

export const COMMANDS = ['sweep', 'list', 'post-pr', 'sync', 'resume', 'restore', 'agents', 'help', 'version'] as const;
export type CommandName = (typeof COMMANDS)[number];

export type CliOptions = {
	readonly command: CommandName;
	/** Positional arguments after the command (the branch for `post-pr`/`sync`, the branches for `restore`, the files for `agents`). */
	readonly positionals: readonly string[];
	/** Repository directory (`-C <path>`); defaults to the current directory. */
	readonly cwd: string | undefined;
	/** `--dry-run`, `--force`, or a safe delete by default. */
	readonly mode: SweepMode;
	readonly yes: boolean;
	readonly fetch: boolean;
	readonly confirm: boolean;
	/** Also offer branches already merged into the default branch whose upstream is not gone. */
	readonly merged: boolean;
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
} as const;

const OPTIONS = {
	'dry-run': { type: 'boolean', short: 'n', default: false },
	force: { type: 'boolean', short: 'f', default: false },
	yes: { type: 'boolean', short: 'y', default: false },
	merged: { type: 'boolean', short: 'm', default: false },
	protect: { type: 'string', short: 'p', multiple: true, default: [] },
	// Declared explicitly: `allowNegative` needs Node 22.4, and VS Code 1.85 runs Node 18.
	'no-fetch': { type: 'boolean', default: false },
	'no-confirm': { type: 'boolean', default: false },
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

	let command: CommandName = values.help ? 'help' : values.version ? 'version' : (named ?? 'sweep');
	if (command === 'sync' && values.continue) {
		command = 'resume';
	}
	if (command === 'restore' && (values['dry-run'] || values.force)) {
		// Restore never overwrites a branch, so there is nothing to force or to preview.
		throw new UsageError(`${values.force ? '--force' : '--dry-run'} cannot be used with restore.`);
	}
	const maxPositionals = command === 'restore' || command === 'agents' ? Infinity : command === 'post-pr' || command === 'sync' ? 1 : 0;
	if (args.length > maxPositionals) {
		throw new UsageError(`Unexpected argument: ${args[maxPositionals]}`);
	}
	const unknownFile = command === 'agents' ? args.find((file) => !isAgentFile(file)) : undefined;
	if (unknownFile !== undefined) {
		throw new UsageError(`Unknown instruction file: ${unknownFile}. Use ${AGENT_FILE_NAMES.join(' or ')}.`);
	}

	return {
		command,
		positionals: args,
		cwd: values.cwd,
		mode: values.force ? 'forceDelete' : values['dry-run'] ? 'dryRun' : 'safeDelete',
		yes: values.yes,
		fetch: !values['no-fetch'],
		confirm: !values['no-confirm'],
		merged: values.merged,
		protect: values.protect,
		json: values.json,
		verbose: values.verbose,
		rpc: values.rpc,
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
		...(settings.includeMergedBranches ? ['--merged'] : []),
	];
}

export const USAGE = `Usage: gsp [command] [options]

Safely prune local branches whose remote upstream is gone.
Also available as "git-sweep-pro" and "git sweep-pro".

Commands:
  sweep              Detect stale branches, pick, confirm and delete them (default)
  list               Print stale (and, with --merged, merged) branches without
                     deleting anything
  post-pr [branch]   After a merged PR: switch to [branch], delete the old branch,
                     sweep, then pull
  sync [upstream]    Rebase the current branch onto [upstream] and force-push
                     with --force-with-lease (stashes local changes)
  resume             Continue a sync paused on conflicts (alias: sync --continue)
  restore [branch...]
                     Recreate branches deleted by gsp at their last
                     commit; without arguments, pick among recent deletions
  agents [file...]   Tell coding agents to use gsp: add a short note to AGENTS.md
                     (Codex, Cursor, GitHub Copilot, OpenCode) and/or CLAUDE.md
                     (Claude Code); without arguments, pick the files
  help, version

Options:
  -n, --dry-run      Only report what would be deleted
  -f, --force        Delete with "git branch -D" instead of "-d"
  -m, --merged       Also offer local branches already merged into the default
                     branch, even squash-merged ones; never pre-selected
  -y, --yes          Accept pre-selected branches and confirm every prompt
  -p, --protect <glob>
                     Never delete branches matching <glob> (repeatable; also read
                     from "git config --get-all git-sweep-pro.protected")
      --no-fetch     Skip "git fetch -p" and use local ref state
      --no-confirm   Do not ask before deleting
      --json         Machine-readable output (list, restore)
  -C <path>          Run as if started in <path>
  -v, --verbose      Echo every git command and its output
  -h, --help         Show this help

Without a terminal (scripts, coding agents), prompts take their defaults and
confirmations are refused unless --yes is given:
  gsp list --json           See what a sweep would offer, without deleting
  gsp --yes                 Delete the pre-selected stale branches (never the
                            merged ones or those checked out in a worktree)
  gsp post-pr main --yes    After a merged PR: switch to main, clean up, pull
  gsp sync origin/main      Rebase onto origin/main, then force-push with a lease
  gsp restore <branch>      Undo a deletion

Exit codes: 0 done (or nothing to do), 1 failed, 2 invalid arguments,
3 sync paused on conflicts (resolve them, then run "gsp resume").`;
