import * as fs from 'node:fs';
import * as path from 'node:path';
import { isAgentFile, runAgentsWorkflow } from '../core/agent-instructions';
import { createDeletionLog, describeDeletion } from '../core/deletion-log';
import { describeGitFailure, toErrorMessage } from '../core/errors';
import { runGitCommand } from '../core/git-command';
import { describeMergedBranch } from '../core/merged-branches';
import { runPostPullRequestWorkflow } from '../core/post-pull-request-workflow';
import { inspectDeletions, runRestoreWorkflow } from '../core/restore-workflow';
import { findStaleBranches, noBranchesFound } from '../core/stale-branches';
import { runSweepWorkflow } from '../core/sweep-workflow';
import { runResumeWorkflow } from '../core/sync-resume-workflow';
import type { SyncContext } from '../core/sync-state';
import { runSyncWorkflow } from '../core/sync-workflow';
import type { WorkflowContext, WorkflowOutcome } from '../core/workflow';
import { EXIT, parseArgs, USAGE, UsageError, type CliOptions } from './args';
import { createFrontend, type Frontend } from './frontend';
import type { CliIo } from './io';
import { createFileStateStore, stateFilePath } from './state-store';

/** git config key holding extra protected-branch globs (multi-valued). */
export const PROTECTED_CONFIG_KEY = 'git-sweep-pro.protected';

const EXIT_CODES: Record<WorkflowOutcome, number> = {
	ok: EXIT.ok,
	cancelled: EXIT.ok,
	failed: EXIT.failed,
	paused: EXIT.paused,
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
			io.stderr(`error: ${error.message}\n\n${USAGE}\n`);
			return EXIT.usage;
		}
		throw error;
	}

	if (options.command === 'help') {
		io.stdout(`${USAGE}\n`);
		return EXIT.ok;
	}
	if (options.command === 'version') {
		io.stdout(`${readVersion()}\n`);
		return EXIT.ok;
	}

	const requestedDir = path.resolve(io.cwd, options.cwd ?? '.');
	if (!fs.existsSync(requestedDir)) {
		io.stderr(`error: no such directory: ${requestedDir}\n`);
		return EXIT.failed;
	}

	const frontend = await createFrontend(options, io);
	frontend.intro?.(`gsp ${options.command}`);
	const outcome = await runCommand(options, requestedDir, frontend, io);
	frontend.outro?.(outcome);
	if (options.nonInteractive && outcome === 'cancelled') {
		return EXIT.cancelled;
	}
	return EXIT_CODES[outcome];
}

async function runCommand(options: CliOptions, dir: string, frontend: Frontend, io: CliIo): Promise<WorkflowOutcome> {
	let repository: Repository;
	try {
		repository = await openRepository(dir, frontend.trace);
	} catch (error) {
		frontend.ui.showErrorMessage(...describeGitFailure(toErrorMessage(error)));
		return 'failed';
	}

	const { root, gitDir, commonDir, protectedPatterns } = repository;
	const context: WorkflowContext = {
		root,
		settings: {
			protectedBranches: [...options.protect, ...protectedPatterns],
			autoFetchPrune: options.fetch,
			confirmBeforeDelete: options.confirm,
			includeMergedBranches: options.merged,
		},
		git: (args) => runGitCommand(args, root, { appendLine: frontend.trace }),
		output: frontend.output,
		ui: frontend.ui,
		// Branches are shared by every worktree, and so is their undo history.
		deletionLog: createDeletionLog(createFileStateStore(stateFilePath(commonDir))),
	};

	const [requested] = options.positionals;
	switch (options.command) {
		case 'sweep':
			return runSweepWorkflow(context, options.mode);
		case 'list':
			return runList(context, options, io);
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
		case 'help':
		case 'version':
			return 'ok';
	}
}

/** `list`: prints stale branches without touching them (`--json` for scripts). */
async function runList(context: WorkflowContext, options: CliOptions, io: CliIo): Promise<WorkflowOutcome> {
	try {
		const found = await findStaleBranches(context);
		const { stale, protected: protectedStale, checkedOut, merged, worktrees } = found;
		const withWorktree = (branch: string, note?: string) => {
			const worktree = worktrees.get(branch);
			const notes = [note, worktree && `worktree ${worktree}`].filter(Boolean);
			return notes.length > 0 ? `${branch} (${notes.join(', ')})\n` : `${branch}\n`;
		};

		if (options.json) {
			const json = { stale, protected: protectedStale, checkedOut, merged, worktrees: Object.fromEntries(worktrees) };
			io.stdout(`${JSON.stringify(json, null, 2)}\n`);
		} else if (stale.length === 0 && protectedStale.length === 0 && checkedOut.length === 0 && merged.length === 0) {
			io.stderr(`${noBranchesFound(context.settings, found)}\n`);
		} else {
			stale.forEach((branch) => io.stdout(withWorktree(branch)));
			merged.forEach((branch) => io.stdout(withWorktree(branch.name, describeMergedBranch(branch))));
			checkedOut.forEach((branch) =>
				io.stdout(branch.where === 'current' ? `${branch.name} (current branch)\n` : `${branch.name} (main worktree ${branch.worktreePath})\n`)
			);
			protectedStale.forEach((branch) => io.stdout(`${branch} (protected)\n`));
		}
		return 'ok';
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
