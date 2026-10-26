import * as fs from 'node:fs';
import * as path from 'node:path';
import { AGENT_FILE_NAMES, checkAgentAdvice, isAgentFile, runAgentsWorkflow, type AdviceFinding } from '../core/agent-instructions';
import { createDeletionLog, describeDeletion, describeDeletionTarget } from '../core/deletion-log';
import { describeGitFailure, toErrorMessage } from '../core/errors';
import { quoteShellArg, runGitCommand } from '../core/git-command';
import { CLEAN_SCHEMA, formatBranchLines, formatRemoteLines, formatSummary, nextCommand, withCommand, type CleanDocument, type CleanReport, type JsonErrorCode, type JsonErrorDocument } from '../core/clean-plan';
import type { CliEvent } from '../core/rpc-protocol';
import { PushUrlMismatchError, runCleanWorkflow, UnknownBranchError, UnknownRemoteError, type CleanOutcome } from '../core/clean-workflow';
import { createSshRunner } from '../core/forge';
import { createGhRunner } from '../core/github-signal';
import { summarizeIgnored } from '../core/ignored-files';
import { formatNextSteps, formatPostPrLines, postPrNextCommand, type PostPrDocument, type PostPrReport } from '../core/post-pull-request-plan';
import { PostPrUsageError, runPostPullRequestWorkflow } from '../core/post-pull-request-workflow';
import { inspectDeletions, runRestoreWorkflow } from '../core/restore-workflow';
import { runResumeWorkflow } from '../core/sync-resume-workflow';
import type { SyncContext } from '../core/sync-state';
import { runSyncWorkflow } from '../core/sync-workflow';
import type { WorkflowContext, WorkflowOutcome } from '../core/workflow';
import { formatWorktreeLines, listWorktreeStates } from '../core/worktree-list';
import { pruneWorktrees, removeWorktree, worktreeRemoveDocument, type WorktreeKeptReason, type WorktreeRemoval } from '../core/worktrees';
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
				printJsonError(io, argv.includes('--rpc'), error.message, 'usage');
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
			printJsonError(io, options.rpc, `no such directory: ${requestedDir}`, 'no-such-directory');
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

/**
 * Writes a `--json` document: indented on stdout, or as one `result` event
 * when the extension drives the CLI over RPC, where stdout carries NDJSON.
 */
function printJson(io: CliIo, rpc: boolean, document: unknown): void {
	io.stdout(rpc ? `${JSON.stringify({ type: 'result', document } satisfies CliEvent)}\n` : `${JSON.stringify(document, null, 2)}\n`);
}

/**
 * With `--json`, a fatal error is still one JSON document on stdout, so a
 * script parsing it gets the reason, not an empty string. The message also
 * goes to stderr as usual.
 */
function printJsonError(io: CliIo, rpc: boolean, message: string, code: JsonErrorCode): void {
	printJson(io, rpc, { schema: CLEAN_SCHEMA, error: { message, code } } satisfies JsonErrorDocument);
}

/** {@link printJsonError} for a failed Git command, or any other error. */
function printJsonGitError(io: CliIo, rpc: boolean, error: unknown): void {
	const message = toErrorMessage(error);
	printJsonError(io, rpc, describeGitFailure(message)[0], message.toLowerCase().includes('not a git repository') ? 'not-a-repository' : 'failed');
}

/** How a command ended: a workflow outcome, a `clean` outcome, or an exit code decided on the spot. */
type CommandOutcome = { readonly kind: 'workflow'; readonly outcome: WorkflowOutcome } | { readonly kind: 'clean'; readonly outcome: CleanOutcome } | number;

async function runCommand(options: CliOptions, dir: string, frontend: Frontend, io: CliIo): Promise<CommandOutcome> {
	if (options.command === 'clean') {
		return runClean(options, dir, frontend, io);
	}
	if (options.command === 'post-pr') {
		return runPostPr(options, dir, frontend, io);
	}
	if (options.command === 'agents' && options.check) {
		return runAgentsCheck(options, dir, frontend, io);
	}
	const outcome = await runWorkflow(options, dir, frontend, io);
	return typeof outcome === 'string' ? { kind: 'workflow', outcome } : outcome;
}

async function runWorkflow(options: CliOptions, dir: string, frontend: Frontend, io: CliIo): Promise<WorkflowOutcome | CommandOutcome> {
	let repository: Repository;
	try {
		repository = await openRepository(dir, frontend.trace);
	} catch (error) {
		if (options.json) {
			printJsonGitError(io, options.rpc, error);
		}
		frontend.ui.showErrorMessage(...describeGitFailure(toErrorMessage(error)));
		return 'failed';
	}

	const { gitDir } = repository;
	const context = createContext(repository, options, frontend);
	const [requested] = options.positionals;
	switch (options.command) {
		case 'worktree':
			return runWorktree(context, options, io, dir);
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
		case 'post-pr':
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
			// Read by no command anymore: merged branches are always cleaned.
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
			printJsonGitError(io, options.rpc, error);
		}
		frontend.ui.showErrorMessage(...describeGitFailure(toErrorMessage(error)));
		return EXIT.failed;
	}
	const context = createContext(repository, options, frontend);
	try {
		const { report, outcome } = await runCleanWorkflow(
			{ ...context, ssh: createSshRunner(), ...(options.github ? { gh: createGhRunner(repository.root) } : {}) },
			{
				patterns: cleanPatterns(options),
				dryRun: options.mode === 'dryRun',
				yes: options.yes,
				force: options.mode === 'forceDelete',
				discardChanges: options.discardChanges,
				fetch: options.fetch,
				github: options.github,
				protectedPatterns: options.protect,
				canPrompt: frontend.canPrompt && !options.json,
				confirm: options.confirm,
				...(options.remote === undefined ? {} : { remote: options.remote }),
				...(options.cwd === undefined ? {} : { cwd: options.cwd }),
				...(options.expect.size > 0 ? { expect: options.expect } : {}),
			}
		);
		printCleanReport(report, outcome, options, frontend, io);
		return { kind: 'clean', outcome };
	} catch (error) {
		if (error instanceof UnknownBranchError || error instanceof UnknownRemoteError || error instanceof PushUrlMismatchError) {
			if (options.json) {
				const code = error instanceof UnknownBranchError ? 'unknown-branch' : error instanceof UnknownRemoteError ? 'unknown-remote' : 'push-url-differs';
				printJsonError(io, options.rpc, error.message, code);
			}
			io.stderr(`error: ${error.message}\n`);
			return EXIT.usage;
		}
		if (options.json) {
			printJsonGitError(io, options.rpc, error);
		}
		frontend.ui.showErrorMessage(...describeGitFailure(toErrorMessage(error), { failed: true }));
		return EXIT.failed;
	}
}

/** The branches `gsp clean` considers: those named or matched, and those `--expect` names. */
function cleanPatterns(options: CliOptions): string[] {
	return [...new Set([...options.positionals, ...options.expect.keys()])];
}

/** What to do next when the plan was not applied, or `undefined` when there is nothing to say. */
function nextStep(report: CleanReport, outcome: CleanOutcome, next: string | null): string | undefined {
	if (outcome !== 'not-applied') {
		return undefined;
	}
	const remote = report.summary.remote;
	const remoteBranches = report.remoteBranches ?? [];
	if (next && report.summary.delete + (remote?.delete ?? 0) > 0 && ![...report.branches, ...remoteBranches].some((branch) => branch.result !== undefined)) {
		return withCommand('Nothing was changed. To apply this plan, run', next);
	}
	const unapplied = remoteBranches.filter((branch) => branch.action === 'delete' && branch.result === undefined).length;
	const count = (test: (branch: CleanReport['branches'][number]) => boolean) => report.branches.filter(test).length;
	const unpushed = count((branch) => branch.reason === 'needs-force' && branch.verdict === 'dead');
	const unmerged = count((branch) => branch.reason === 'needs-force' && branch.verdict === 'alive');
	const ignored = count((branch) => branch.reason === 'ignored-files');
	const kept = [...(unpushed > 0 ? [`${unpushed} with commits found nowhere else`] : []), ...(unmerged > 0 ? [`${unmerged} named but not merged`] : [])];
	const changed = [...report.branches, ...remoteBranches].filter(
		(branch) => branch.reason === 'plan-changed' || branch.reason === 'fetch-failed' || branch.reason === 'worktree-changed'
	).length;
	const lines = [
		...(kept.length > 0 ? [`Kept without --force: ${kept.join(', ')}. Each line above gives the command.`] : []),
		...(ignored > 0 ? [`Kept without --discard-changes: ${ignored} whose worktree holds ignored files. Move what you need out first, as each line above says.`] : []),
		...(unapplied > 0 && remote && next ? [withCommand(`Branches on ${remote.remote} are only deleted with --yes. To delete them, run`, next)] : []),
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
					patterns: cleanPatterns(options),
					protectedPatterns: options.protect,
					github: options.github,
					fetch: options.fetch,
					...(report.summary.remote ? { remote: report.summary.remote.remote } : {}),
				});
	if (options.json) {
		const document: CleanDocument = { ...report, next: command };
		printJson(io, options.rpc, document);
		return;
	}
	const remoteLines = formatRemoteLines(report);
	const localLines = formatBranchLines(report);
	const lines = [...localLines, ...(localLines.length > 0 && remoteLines.length > 0 ? [''] : []), ...remoteLines];
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
 * `post-pr`: finishes a merged pull request. With `--json`, the report is the
 * only thing on stdout; otherwise one line per change, then the next steps.
 */
async function runPostPr(options: CliOptions, dir: string, frontend: Frontend, io: CliIo): Promise<CommandOutcome> {
	let repository: Repository;
	try {
		repository = await openRepository(dir, frontend.trace);
	} catch (error) {
		if (options.json) {
			printJsonGitError(io, options.rpc, error);
		}
		frontend.ui.showErrorMessage(...describeGitFailure(toErrorMessage(error)));
		return EXIT.failed;
	}
	const context = createContext(repository, options, frontend);
	try {
		const { report, outcome } = await runPostPullRequestWorkflow(
			{
				...context,
				...(options.github ? { gh: createGhRunner(repository.root) } : {}),
				gitAt: (worktree) => (args) => runGitCommand(args, worktree, { appendLine: frontend.trace }),
			},
			{
				branch: options.positionals[0],
				into: options.into,
				...(options.cwd === undefined ? {} : { cwd: options.cwd }),
				...(options.others === undefined ? {} : { others: options.others }),
				dryRun: options.mode === 'dryRun',
				yes: options.yes,
				force: options.mode === 'forceDelete',
				discardChanges: options.discardChanges,
				fetch: options.fetch,
				github: options.github,
				protectedPatterns: options.protect,
				canPrompt: frontend.canPrompt && !options.json,
				confirm: options.confirm,
			}
		);
		printPostPrReport(report, outcome, options, frontend, io);
		return { kind: 'clean', outcome };
	} catch (error) {
		if (error instanceof PostPrUsageError) {
			if (options.json) {
				printJsonError(io, options.rpc, error.message, error.code);
			}
			io.stderr(`error: ${error.message}\n`);
			return EXIT.usage;
		}
		if (options.json) {
			printJsonGitError(io, options.rpc, error);
		}
		frontend.ui.showErrorMessage(...describeGitFailure(toErrorMessage(error), { failed: true }));
		return EXIT.failed;
	}
}

function printPostPrReport(report: PostPrReport, outcome: CleanOutcome, options: CliOptions, frontend: Frontend, io: CliIo): void {
	const next =
		outcome === 'cancelled'
			? null
			: postPrNextCommand(report, {
					...(options.cwd === undefined ? {} : { cwd: options.cwd }),
					...(options.into === undefined ? {} : { into: options.into }),
					protectedPatterns: options.protect,
					github: options.github,
					fetch: options.fetch,
					...(options.others === undefined ? {} : { others: options.others }),
				});
	if (options.json) {
		const document: PostPrDocument = { ...report, next };
		printJson(io, options.rpc, document);
		return;
	}
	const lines = formatPostPrLines(report);
	const steps = outcome === 'cancelled' ? ['Cancelled. Nothing was changed.'] : formatNextSteps(report, next);
	if (options.rpc || frontend.canPrompt) {
		lines.forEach((line) => frontend.output.appendLine(line));
		const message = [lines[0], ...steps].join('\n');
		if (outcome === 'failed') {
			frontend.ui.showErrorMessage(message, { seeOutput: true });
		} else {
			frontend.ui.showInformationMessage(message, report.mode === 'plan' ? { dryRun: true } : undefined);
		}
		return;
	}
	[...lines, ...steps].forEach((line) => io.stdout(`${line}\n`));
}

/**
 * `worktree`: list every worktree, prune the registrations whose directory is
 * gone, or remove one linked worktree. Nothing mutates the repository history.
 * `dir` is the invocation directory, so a relative removal target is read the
 * way the user typed it.
 */
async function runWorktree(context: WorkflowContext, options: CliOptions, io: CliIo, dir: string): Promise<WorkflowOutcome | CommandOutcome> {
	const worktree = options.worktree;
	if (!worktree) {
		return 'failed';
	}
	// With --rpc, stdout carries only protocol events: a line goes to the output channel as a log event.
	const print = (line: string) => (options.rpc ? context.output.appendLine(line) : io.stdout(`${line}\n`));
	try {
		switch (worktree.subcommand) {
			case 'list': {
				const { document, branches } = await listWorktreeStates(
					{ ...context, ssh: createSshRunner(), ...(options.github ? { gh: createGhRunner(context.root) } : {}) },
					{ fetch: options.fetch, github: options.github, protectedPatterns: options.protect }
				);
				if (options.json) {
					printJson(io, options.rpc, document);
				} else {
					formatWorktreeLines(document, branches).forEach((line) => io.stdout(`${line}\n`));
				}
				return 'ok';
			}
			case 'prune': {
				const dryRun = options.mode === 'dryRun';
				const { pruned } = await pruneWorktrees(context, dryRun);
				if (pruned.length === 0) {
					io.stderr('No worktree registrations to prune.\n');
				} else {
					print(`${dryRun ? 'Would prune' : 'Pruned'} ${pruned.length} worktree registration(s):`);
					pruned.forEach((path) => print(`  ${path}`));
				}
				return 'ok';
			}
			case 'remove':
				return await runWorktreeRemove(context, options, io, dir, worktree.target ?? '');
		}
	} catch (error) {
		if (options.json) {
			printJsonGitError(io, options.rpc, error);
		}
		context.ui.showErrorMessage(...describeGitFailure(toErrorMessage(error), { failed: true }));
		return 'failed';
	}
}

/**
 * `worktree remove`: removes one linked worktree, or keeps it and says why
 * and what to run (exit 5). A target that is the main worktree, no worktree,
 * or two different ones is an invalid argument (exit 2).
 */
async function runWorktreeRemove(context: WorkflowContext, options: CliOptions, io: CliIo, dir: string, target: string): Promise<CommandOutcome> {
	const result = await removeWorktree(context, target, options.discardChanges, dir);
	const refuse = (message: string, code: JsonErrorCode): CommandOutcome => {
		if (options.json) {
			printJsonError(io, options.rpc, message, code);
		}
		context.ui.showErrorMessage(message, { failed: true });
		return EXIT.usage;
	};
	switch (result.kind) {
		case 'main':
			return refuse(`Refusing to remove the main worktree (${result.worktree.path}).`, 'main-worktree');
		case 'ambiguous': {
			const [byPath, byBranch] = result.worktrees;
			return refuse(
				`"${result.target}" is both the worktree ${byPath.path} and the branch ${byBranch.branch} (${byBranch.path}). Remove one by its full path.`,
				'ambiguous-worktree'
			);
		}
		case 'not-found':
			return refuse(`No worktree found for "${result.target}". Run "gsp worktree list" to see them.`, 'unknown-worktree');
		case 'removed':
		case 'kept':
			break;
	}
	if (options.json) {
		printJson(io, options.rpc, worktreeRemoveDocument(result));
	}
	if (result.kind === 'removed') {
		if (!options.json) {
			const lines = [`Removed worktree ${result.worktree.path}.`, ...(result.nextCwd ? [`It was the directory you ran gsp in. Continue in the main checkout: cd ${quoteShellArg(result.nextCwd)}`] : [])];
			// With --rpc, stdout carries only protocol events.
			lines.forEach((line) => (options.rpc ? context.output.appendLine(line) : io.stdout(`${line}\n`)));
		}
		return { kind: 'workflow', outcome: 'ok' };
	}
	// Kept is an answer, not a failure: it says why and what to run (exit 5).
	if (!options.json) {
		io.stderr(`Kept ${result.worktree.path}: ${KEPT_WORKTREE_MESSAGES[result.reason](result)}\n`);
		io.stderr(`To remove it: ${result.hint}\n`);
	}
	return { kind: 'clean', outcome: 'not-applied' };
}

const KEPT_WORKTREE_MESSAGES: Record<WorktreeKeptReason, (kept: Extract<WorktreeRemoval, { kind: 'kept' }>) => string> = {
	'locked-worktree': () => 'it is locked.',
	'rebase-in-progress': () => 'a rebase is in progress there.',
	'bisect-in-progress': () => 'a bisect is in progress there.',
	'dirty-worktree': ({ changedFiles }) => `removing it would delete uncommitted changes or untracked files:\n${listed(changedFiles)}`,
	submodules: () => 'it holds submodules, which would be deleted with it.',
	'ignored-files': ({ ignoredFiles }) => `removing it would delete ignored files a build does not recreate:\n${listed(ignoredFiles)}`,
};

/** Up to {@link IGNORED_SAMPLE_SIZE} files, one per line, then how many more. */
function listed(files: readonly string[]): string {
	const { sample, count } = summarizeIgnored(files);
	return [...sample.map((file) => `  ${file}`), ...(count > sample.length ? [`  and ${count - sample.length} more`] : [])].join('\n');
}

/** The `--json` document of `gsp agents --check`. */
type AgentsCheckDocument = {
	readonly schema: typeof CLEAN_SCHEMA;
	readonly command: 'agents --check';
	readonly files: readonly string[];
	readonly findings: readonly AdviceFinding[];
};

/**
 * `agents --check`: reads the files named, or the AGENTS.md and CLAUDE.md
 * of the repository (of `dir` outside one), and prints each line whose
 * advice contradicts gsp with what to write instead. Changes nothing; exits
 * with 5 when it found something.
 */
async function runAgentsCheck(options: CliOptions, dir: string, frontend: Frontend, io: CliIo): Promise<CommandOutcome> {
	const root = await openRepository(dir, frontend.trace).then(
		(repository) => repository.root,
		() => dir
	);
	const named = options.positionals.length > 0;
	const files = named ? options.positionals : AGENT_FILE_NAMES.filter((file) => fs.existsSync(path.join(root, file)));
	const absolute = (file: string) => path.resolve(named ? dir : root, file);
	const fail = (message: string, code: JsonErrorCode) => {
		if (options.json) {
			printJsonError(io, options.rpc, message, code);
		}
		io.stderr(`error: ${message}\n`);
		return code === 'usage' ? EXIT.usage : EXIT.failed;
	};
	// gsp agents only writes the instruction files at the repository's root.
	const writable = (file: string) => isAgentFile(path.basename(file)) && absolute(file) === path.join(root, path.basename(file));
	// A file read twice, as CLAUDE.md linked to AGENTS.md, is reported once.
	const seen = new Set<string>();
	const unique: string[] = [];
	const findings: AdviceFinding[] = [];
	for (const file of files) {
		let text: string | undefined;
		try {
			if (!fs.statSync(absolute(file), { throwIfNoEntry: false })?.isFile()) {
				return fail(`No such file: ${file}`, 'usage');
			}
			const real = fs.realpathSync(absolute(file));
			text = seen.has(real) ? undefined : fs.readFileSync(real, 'utf8');
			seen.add(real);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return fail(`Cannot read ${file}: ${code === 'EACCES' || code === 'EPERM' ? 'permission denied' : toErrorMessage(error)}`, 'failed');
		}
		if (text !== undefined) {
			unique.push(file);
			findings.push(...checkAgentAdvice(file, text, writable(file)));
		}
	}
	if (options.json) {
		printJson(io, options.rpc, { schema: CLEAN_SCHEMA, command: 'agents --check', files: unique, findings } satisfies AgentsCheckDocument);
	} else {
		findings.forEach((finding) => io.stdout(`${finding.file}:${finding.line}: ${finding.text.trim()}\n  → ${finding.suggestion}\n`));
	}
	if (files.length === 0) {
		io.stderr(`No ${AGENT_FILE_NAMES.join(' or ')} in ${root}. Name the files to check: gsp agents --check <file>...\n`);
	} else if (findings.length === 0) {
		io.stderr(`No outdated gsp advice in ${unique.join(', ')}.\n`);
	} else {
		io.stderr(`${findings.length} outdated ${findings.length === 1 ? 'line' : 'lines'}. Update ${findings.length === 1 ? 'it' : 'them'} as suggested.\n`);
	}
	// Like a plan that was not applied: something is left for the person to do.
	return findings.length > 0 ? { kind: 'clean', outcome: 'not-applied' } : { kind: 'workflow', outcome: 'ok' };
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
			printJson(io, options.rpc, entries);
		} else if (entries.length === 0) {
			io.stderr('No deleted branches to restore.\n');
		} else {
			const now = new Date();
			const width = Math.max(...entries.map((entry) => describeDeletionTarget(entry).length));
			entries.forEach((entry) => io.stdout(`${describeDeletionTarget(entry).padEnd(width)}  ${describeDeletion(entry, now)}\n`));
			io.stderr('To restore them, run: gsp restore <branch>...\n');
		}
		return 'ok';
	} catch (error) {
		if (options.json) {
			printJsonGitError(io, options.rpc, error);
		}
		context.ui.showErrorMessage(...describeGitFailure(toErrorMessage(error), { failed: true }));
		return 'failed';
	}
}
