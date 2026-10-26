import * as fs from 'node:fs';
import * as path from 'node:path';
import { isAgentFile, runAgentsWorkflow } from '../core/agent-instructions';
import { createDeletionLog, describeDeletion } from '../core/deletion-log';
import { describeGitFailure, toErrorMessage } from '../core/errors';
import { runGitCommand } from '../core/git-command';
import { CLEAN_SCHEMA, formatBranchLines, formatSummary, nextCommand, type CleanDocument, type CleanReport } from '../core/clean-plan';
import { runCleanWorkflow, UnknownBranchError, type CleanOutcome } from '../core/clean-workflow';
import { createGhRunner } from '../core/github-signal';
import { runPostPullRequestWorkflow } from '../core/post-pull-request-workflow';
import { inspectDeletions, runRestoreWorkflow } from '../core/restore-workflow';
import { runResumeWorkflow } from '../core/sync-resume-workflow';
import type { SyncContext } from '../core/sync-state';
import { runSyncWorkflow } from '../core/sync-workflow';
import type { WorkflowContext, WorkflowOutcome } from '../core/workflow';
import { describeWorktree, listWorktrees, pruneWorktrees, removeWorktree } from '../core/worktrees';
import { EXIT, parseArgs, UsageError, type CliOptions } from './args';
import { createFrontend, type Frontend } from './frontend';
import { helpFor, USAGE } from './help';
import type { CliIo } from './io';
import { createFileStateStore, stateFilePath } from './state-store';

/** git config key holding extra protected-branch globs (multi-valued). */
export const PROTECTED_CONFIG_KEY = 'git-sweep-pro.protected';

const EXIT_CODES: Record<WorkflowOutcome, number> = {
	ok: EXIT.ok,
	cancelled: EXIT.cancelled,
	failed: EXIT.failed,
	paused: EXIT.paused,
};

const CLEAN_EXIT_CODES: Record<CleanOutcome, number> = {
	done: EXIT.ok,
	'not-applied': EXIT.notApplied,
	cancelled: EXIT.cancelled,
	failed: EXIT.failed,
};

const CLEAN_OUTCOMES: Record<CleanOutcome, WorkflowOutcome> = {
	done: 'ok',
	'not-applied': 'ok',
	cancelled: 'cancelled',
	failed: 'failed',
};

function readVersion(): string {
	const manifest = path.join(__dirname, '..', '..', 'package.json');
	return (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version: string }).version;
}

/** Where the repository containing a directory keeps its working tree and state. */
type Repository = {
	readonly root: string;
	/** Git directory of this worktree. */
	readonly gitDir: string;
	/** Git directory shared by every worktree of the repository. */
	readonly commonDir: string;
	/** Protected-branch globs from {@link PROTECTED_CONFIG_KEY}. */
	readonly protectedPatterns: readonly string[];
};

async function openRepository(dir: string, trace: (line: string) => void): Promise<Repository> {
	const output = { appendLine: trace };
	const { stdout } = await runGitCommand(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], dir, output);
	const [root, gitDir, commonDir] = stdout.split('\n');
	// Exits with 1 when no pattern is configured.
	const config = await runGitCommand(['config', '--get-all', PROTECTED_CONFIG_KEY], root, output, { expectedExitCodes: [1] });
	return {
		root,
		gitDir,
		// --git-common-dir may be relative to the directory git runs in.
		commonDir: path.resolve(dir, commonDir),
		protectedPatterns: config.stdout.split('\n').filter((line) => line.trim()),
	};
}

/**
 * Runs the `gsp` CLI and resolves to its exit code. All process I/O
 * goes through `io`, so the CLI can run in-process (tests) or as a child
 * process driven over RPC by the VS Code extension.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
	let options: CliOptions;
	try {
		options = parseArgs(argv);
	} catch (error) {
		if (error instanceof UsageError) {
			if (argv.includes('--json')) {
				printJsonError(io, error.message, 'usage');
			}
			io.stderr(`error: ${error.message}\n\n${USAGE}\n`);
			return EXIT.usage;
		}
		throw error;
	}

	if (options.command === 'help') {
		io.stdout(`${helpFor(options.helpTopic)}\n`);
		return EXIT.ok;
	}
	if (options.command === 'version') {
		io.stdout(`${readVersion()}\n`);
		return EXIT.ok;
	}

	const requestedDir = path.resolve(io.cwd, options.cwd ?? '.');
	if (!fs.existsSync(requestedDir)) {
		if (options.json) {
			printJsonError(io, `no such directory: ${requestedDir}`, 'no-such-directory');
		}
		io.stderr(`error: no such directory: ${requestedDir}\n`);
		return EXIT.failed;
	}

	if (options.merged) {
		io.stderr('note: --merged is deprecated and does nothing: merged branches are always cleaned.\n');
	}

	const frontend = await createFrontend(options, io);
	frontend.intro?.(`gsp ${options.command}`);
	const outcome = await runCommand(options, requestedDir, frontend, io);
	const workflowOutcome = typeof outcome === 'number' ? 'failed' : outcome.kind === 'clean' ? CLEAN_OUTCOMES[outcome.outcome] : outcome.outcome;
	frontend.outro?.(workflowOutcome);
	if (typeof outcome === 'number') {
		return outcome;
	}
	if (outcome.kind === 'clean') {
		return CLEAN_EXIT_CODES[outcome.outcome];
	}
	// Nobody could answer: the prompt was refused for lack of --yes, not cancelled.
	return outcome.outcome === 'cancelled' && !frontend.canPrompt ? EXIT.notApplied : EXIT_CODES[outcome.outcome];
}

/** Why a command stopped before producing its JSON document. */
type JsonErrorCode = 'usage' | 'no-such-directory' | 'unknown-branch' | 'not-a-repository' | 'failed';

/**
 * With `--json`, a fatal error is still one JSON document on stdout, so a
 * script parsing it gets the reason, not an empty string. The message also
 * goes to stderr as usual.
 */
function printJsonError(io: CliIo, message: string, code: JsonErrorCode): void {
	io.stdout(`${JSON.stringify({ schema: CLEAN_SCHEMA, error: { message, code } }, null, 2)}\n`);
}

function gitErrorCode(message: string): JsonErrorCode {
	return message.toLowerCase().includes('not a git repository') ? 'not-a-repository' : 'failed';
}

/** How a command ended: a workflow outcome, a `clean` outcome, or an exit code decided on the spot. */
type CommandOutcome = { readonly kind: 'workflow'; readonly outcome: WorkflowOutcome } | { readonly kind: 'clean'; readonly outcome: CleanOutcome } | number;

async function runCommand(options: CliOptions, dir: string, frontend: Frontend, io: CliIo): Promise<CommandOutcome> {
	if (options.command === 'clean') {
		return runClean(options, dir, frontend, io);
	}
	return { kind: 'workflow', outcome: await runWorkflow(options, dir, frontend, io) };
}

async function runWorkflow(options: CliOptions, dir: string, frontend: Frontend, io: CliIo): Promise<WorkflowOutcome> {
	let repository: Repository;
	try {
		repository = await openRepository(dir, frontend.trace);
	} catch (error) {
		frontend.ui.showErrorMessage(...describeGitFailure(toErrorMessage(error)));
		return 'failed';
	}

	const { gitDir } = repository;
	const context = createContext(repository, options, frontend);
	const [requested] = options.positionals;
	switch (options.command) {
		case 'worktree':
			return runWorktree(context, options, io, dir);
		case 'post-pr':
			return runPostPullRequestWorkflow(context, requested);
		case 'restore':
			return runRestore(context, options, frontend, io);
		case 'agents':
			return runAgentsWorkflow(context, options.positionals.filter(isAgentFile));
		case 'sync':
		case 'resume': {
			// A paused sync belongs to the worktree it was started in.
			const syncContext: SyncContext = {
				...context,
				gitDir,
				state: createFileStateStore(stateFilePath(gitDir)),
				fileExists: (p) => fs.existsSync(p),
				readFileUtf8: (p) => fs.readFileSync(p, 'utf8'),
			};
			return options.command === 'sync' ? runSyncWorkflow(syncContext, requested) : runResumeWorkflow(syncContext);
		}
		case 'clean':
		case 'help':
		case 'version':
			return 'ok';
	}
}

function createContext({ root, commonDir, protectedPatterns }: Repository, options: CliOptions, frontend: Frontend): WorkflowContext {
	return {
		root,
		settings: {
			protectedBranches: [...options.protect, ...protectedPatterns],
			autoFetchPrune: options.fetch,
			confirmBeforeDelete: options.confirm,
			// Only post-pr still runs the previous sweep; it never offered merged branches.
			includeMergedBranches: false,
		},
		git: (args) => runGitCommand(args, root, { appendLine: frontend.trace }),
		output: frontend.output,
		ui: frontend.ui,
		// Branches are shared by every worktree, and so is their undo history.
		deletionLog: createDeletionLog(createFileStateStore(stateFilePath(commonDir))),
	};
}

/**
 * `clean` (and its aliases `sweep` and `list`): plans, picks when someone can
 * answer, applies, then reports. With `--json`, the report is the only thing
 * on stdout; in a terminal, one line per branch and a summary line.
 */
async function runClean(options: CliOptions, dir: string, frontend: Frontend, io: CliIo): Promise<CommandOutcome> {
	let repository: Repository;
	try {
		repository = await openRepository(dir, frontend.trace);
	} catch (error) {
		if (options.json) {
			printJsonError(io, describeGitFailure(toErrorMessage(error))[0], gitErrorCode(toErrorMessage(error)));
		}
		frontend.ui.showErrorMessage(...describeGitFailure(toErrorMessage(error)));
		return EXIT.failed;
	}
	const context = createContext(repository, options, frontend);
	try {
		const { report, outcome } = await runCleanWorkflow(
			{ ...context, ...(options.github ? { gh: createGhRunner(repository.root) } : {}) },
			{
				patterns: options.positionals,
				dryRun: options.mode === 'dryRun',
				yes: options.yes,
				force: options.mode === 'forceDelete',
				fetch: options.fetch,
				github: options.github,
				protectedPatterns: options.protect,
				canPrompt: frontend.canPrompt && !options.json,
				confirm: options.confirm,
			}
		);
		printCleanReport(report, outcome, options, frontend, io);
		return { kind: 'clean', outcome };
	} catch (error) {
		if (error instanceof UnknownBranchError) {
			if (options.json) {
				printJsonError(io, error.message, 'unknown-branch');
			}
			io.stderr(`error: ${error.message}\n`);
			return EXIT.usage;
		}
		if (options.json) {
			printJsonError(io, describeGitFailure(toErrorMessage(error))[0], gitErrorCode(toErrorMessage(error)));
		}
		frontend.ui.showErrorMessage(...describeGitFailure(toErrorMessage(error), { failed: true }));
		return EXIT.failed;
	}
}

/** What to do next when the plan was not applied, or `undefined` when there is nothing to say. */
function nextStep(report: CleanReport, outcome: CleanOutcome, next: string | null): string | undefined {
	if (outcome !== 'not-applied') {
		return undefined;
	}
	if (next && report.summary.delete > 0 && !report.branches.some((branch) => branch.result !== undefined)) {
		return `Nothing was changed. To apply this plan, run: ${next}`;
	}
	const count = (test: (branch: CleanReport['branches'][number]) => boolean) => report.branches.filter(test).length;
	const unpushed = count((branch) => branch.reason === 'needs-force' && branch.verdict === 'dead');
	const unmerged = count((branch) => branch.reason === 'needs-force' && branch.verdict === 'alive');
	const ignored = count((branch) => branch.reason === 'ignored-files');
	const kept = [
		...(unpushed > 0 ? [`${unpushed} with commits found nowhere else`] : []),
		...(unmerged > 0 ? [`${unmerged} named but not merged`] : []),
		...(ignored > 0 ? [`${ignored} whose worktree holds ignored files`] : []),
	];
	const changed = count((branch) => branch.reason === 'plan-changed' || branch.reason === 'fetch-failed' || branch.reason === 'worktree-changed');
	const lines = [
		...(kept.length > 0 ? [`Kept without --force: ${kept.join(', ')}. Each line above gives the command.`] : []),
		...(changed > 0 && next ? [`${changed} not deleted, as things changed while applying. Review them with: ${next}`] : []),
	];
	return lines.length > 0 ? lines.join('\n') : undefined;
}

function printCleanReport(report: CleanReport, outcome: CleanOutcome, options: CliOptions, frontend: Frontend, io: CliIo): void {
	const command =
		outcome === 'cancelled'
			? null
			: nextCommand(report, {
					...(options.cwd === undefined ? {} : { cwd: options.cwd }),
					patterns: options.positionals,
					protectedPatterns: options.protect,
					github: options.github,
					fetch: options.fetch,
				});
	if (options.json) {
		const document: CleanDocument = { ...report, next: command };
		io.stdout(`${JSON.stringify(document, null, 2)}\n`);
		return;
	}
	const lines = formatBranchLines(report);
	const summary = outcome === 'cancelled' ? 'Cancelled. Nothing was deleted.' : formatSummary(report);
	const next = nextStep(report, outcome, command);
	if (options.rpc || frontend.canPrompt) {
		lines.forEach((line) => frontend.output.appendLine(line));
		const message = next ? `${summary}\n${next}` : summary;
		if (outcome === 'failed') {
			frontend.ui.showErrorMessage(message, { seeOutput: true });
		} else {
			frontend.ui.showInformationMessage(message, report.mode === 'plan' ? { dryRun: true } : undefined);
		}
		return;
	}
	lines.forEach((line) => io.stdout(`${line}\n`));
	io.stdout(`${summary}\n`);
	if (next) {
		io.stdout(`${next}\n`);
	}
}

/**
 * `worktree`: list every worktree, prune the registrations whose directory is
 * gone, or remove one linked worktree. Nothing mutates the repository history.
 * `dir` is the invocation directory, so a relative removal target is read the
 * way the user typed it.
 */
async function runWorktree(context: WorkflowContext, options: CliOptions, io: CliIo, dir: string): Promise<WorkflowOutcome> {
	const worktree = options.worktree;
	if (!worktree) {
		return 'failed';
	}
	try {
		switch (worktree.subcommand) {
			case 'list': {
				const worktrees = await listWorktrees(context);
				if (options.json) {
					const json = worktrees.map(({ path, branch, state }) => ({ path, branch: branch ?? null, state }));
					io.stdout(`${JSON.stringify(json, null, 2)}\n`);
				} else {
					worktrees.forEach((entry) => io.stdout(describeWorktree(entry)));
				}
				return 'ok';
			}
			case 'prune': {
				const dryRun = options.mode === 'dryRun';
				const { pruned } = await pruneWorktrees(context, dryRun);
				if (pruned.length === 0) {
					io.stderr('No worktree registrations to prune.\n');
				} else {
					io.stdout(`${dryRun ? 'Would prune' : 'Pruned'} ${pruned.length} worktree registration(s):\n`);
					pruned.forEach((path) => io.stdout(`  ${path}\n`));
				}
				return 'ok';
			}
			case 'remove': {
				const result = await removeWorktree(context, worktree.target ?? '', options.mode === 'forceDelete', dir);
				switch (result.kind) {
					case 'removed':
						io.stdout(`Removed worktree ${result.worktree.path}.\n`);
						return 'ok';
					case 'main':
						context.ui.showErrorMessage(`Refusing to remove the main worktree (${result.worktree.path}).`, { failed: true });
						return 'failed';
					case 'ambiguous': {
						const [byPath, byBranch] = result.worktrees;
						context.ui.showErrorMessage(
							`"${result.target}" is both the worktree ${byPath.path} and the branch ${byBranch.branch} (${byBranch.path}). Remove one by its full path.`,
							{ failed: true }
						);
						return 'failed';
					}
					case 'not-found':
						context.ui.showErrorMessage(`No worktree found for "${result.target}". Run "gsp worktree list" to see them.`, { failed: true });
						return 'failed';
				}
				return 'failed';
			}
		}
	} catch (error) {
		context.ui.showErrorMessage(...describeGitFailure(toErrorMessage(error), { failed: true }));
		return 'failed';
	}
}

/**
 * `restore`: restores the branches named, or the ones picked. Without names
 * and without anyone to pick (pipes, `--yes`, `--json`), lists the deletions
 * that can be restored instead.
 */
async function runRestore(context: WorkflowContext, options: CliOptions, frontend: Frontend, io: CliIo): Promise<WorkflowOutcome> {
	if (options.positionals.length > 0 || (frontend.canPrompt && !options.json)) {
		return runRestoreWorkflow(context, options.positionals);
	}

	try {
		const entries = (await inspectDeletions(context)).flatMap(({ entry, blocker }) => (blocker ? [] : [entry]));
		if (options.json) {
			io.stdout(`${JSON.stringify(entries, null, 2)}\n`);
		} else if (entries.length === 0) {
			io.stderr('No deleted branches to restore.\n');
		} else {
			const now = new Date();
			const width = Math.max(...entries.map((entry) => entry.branch.length));
			entries.forEach((entry) => io.stdout(`${entry.branch.padEnd(width)}  ${describeDeletion(entry, now)}\n`));
			io.stderr('To restore them, run: gsp restore <branch>...\n');
		}
		return 'ok';
	} catch (error) {
		context.ui.showErrorMessage(...describeGitFailure(toErrorMessage(error), { failed: true }));
		return 'failed';
	}
}
