import * as fs from 'node:fs';
import * as path from 'node:path';
import { describeGitFailure, toErrorMessage } from '../core/errors';
import { runGitCommand, type CommandResult } from '../core/git-command';
import { runPostPullRequestWorkflow } from '../core/post-pull-request-workflow';
import { findStaleBranches } from '../core/stale-branches';
import type { SweepSettings } from '../core/sweep-logic';
import { runSweepWorkflow, type SweepWorkflowDeps, type WorkflowOutcome } from '../core/sweep-workflow';
import type { StateStore } from '../core/sync-with-upstream-state';
import {
	runSyncWithUpstreamResumeWorkflow,
	runSyncWithUpstreamWorkflow,
	type SyncWithUpstreamDeps,
} from '../core/sync-with-upstream-workflow';
import { EXIT, parseArgs, USAGE, UsageError, type CliOptions } from './args';
import { createFrontend } from './frontend';
import type { CliIo } from './io';
import { createFileStateStore, createMemoryStateStore, stateFilePath } from './state-store';

/** git config key holding extra protected-branch globs (multi-valued). */
export const PROTECTED_CONFIG_KEY = 'git-sweep-pro.protected';

type RunGit = (args: string[], cwd: string) => Promise<CommandResult>;

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

async function tryGit(runGit: RunGit, args: string[], cwd: string): Promise<string | undefined> {
	try {
		return (await runGit(args, cwd)).stdout.trim();
	} catch {
		return undefined;
	}
}

/**
 * Runs the `git-sweep-pro` CLI and resolves to its exit code. All process I/O
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
	const runGit: RunGit = (args, cwd) => runGitCommand(args, cwd, { appendLine: frontend.trace });
	const workspaceRoot = (await tryGit(runGit, ['rev-parse', '--show-toplevel'], requestedDir)) || requestedDir;
	const configProtected = (await tryGit(runGit, ['config', '--get-all', PROTECTED_CONFIG_KEY], workspaceRoot)) ?? '';

	const settings: SweepSettings = {
		defaultMode: options.force ? 'forceDelete' : options.dryRun ? 'dryRun' : 'safeDelete',
		protectedBranches: [...options.protect, ...configProtected.split('\n').filter((line) => line.trim())],
		autoFetchPrune: options.fetch,
		confirmBeforeDelete: options.confirm,
	};

	const deps: SweepWorkflowDeps = {
		getWorkspaceRoot: () => workspaceRoot,
		getSettings: () => settings,
		output: frontend.output,
		runGitCommand: runGit,
		ui: frontend.ui,
	};

	frontend.intro?.(`git sweep-pro ${options.command}`);
	const outcome = await runCommand(options, workspaceRoot, deps, io);
	frontend.outro?.(outcome);
	return EXIT_CODES[outcome];
}

async function runCommand(options: CliOptions, workspaceRoot: string, deps: SweepWorkflowDeps, io: CliIo): Promise<WorkflowOutcome> {
	switch (options.command) {
		case 'sweep':
			return runSweepWorkflow({ dryRun: options.dryRun, forceDelete: options.force }, deps);
		case 'list':
			return runList(workspaceRoot, deps, options, io);
		case 'post-pr':
			return runPostPullRequestWorkflow(deps);
		case 'sync':
		case 'resume': {
			const gitDir = await tryGit(deps.runGitCommand, ['rev-parse', '--absolute-git-dir'], workspaceRoot);
			const store: StateStore = gitDir ? createFileStateStore(stateFilePath(gitDir)) : createMemoryStateStore();
			const syncDeps: SyncWithUpstreamDeps = {
				...deps,
				workspaceState: store,
				fileExists: (p) => fs.existsSync(p),
				readFileUtf8: (p) => fs.readFileSync(p, 'utf8'),
			};
			return options.command === 'sync' ? runSyncWithUpstreamWorkflow(syncDeps) : runSyncWithUpstreamResumeWorkflow(syncDeps);
		}
		case 'help':
		case 'version':
			return 'ok';
	}
}

/** `list`: prints stale branches without touching them (`--json` for scripts). */
async function runList(root: string, deps: SweepWorkflowDeps, options: CliOptions, io: CliIo): Promise<WorkflowOutcome> {
	try {
		const { stale, protected: protectedStale, current, worktrees } = await findStaleBranches(root, deps);

		if (options.json) {
			const json = { stale, protected: protectedStale, current: current ?? null, worktrees: Object.fromEntries(worktrees) };
			io.stdout(`${JSON.stringify(json, null, 2)}\n`);
		} else if (stale.length === 0 && protectedStale.length === 0 && current === undefined) {
			io.stderr('No stale branches found.\n');
		} else {
			stale.forEach((branch) => {
				const worktree = worktrees.get(branch);
				io.stdout(worktree ? `${branch} (worktree ${worktree})\n` : `${branch}\n`);
			});
			if (current !== undefined) {
				io.stdout(`${current} (current branch)\n`);
			}
			protectedStale.forEach((branch) => io.stdout(`${branch} (protected)\n`));
		}
		return 'ok';
	} catch (error) {
		deps.ui.showErrorMessage(...describeGitFailure(toErrorMessage(error), { failed: true }));
		return 'failed';
	}
}
