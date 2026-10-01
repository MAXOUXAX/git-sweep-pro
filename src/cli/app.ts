import * as fs from 'node:fs';
import * as path from 'node:path';
import { describeGitFailure, toErrorMessage } from '../core/errors';
import { runGitCommand, type CommandResult } from '../core/git-command';
import { runPostPullRequestWorkflow } from '../core/post-pull-request-workflow';
import { GONE_REFS_ARGS, isProtectedBranch, parseGoneBranchRefs, type SweepSettings } from '../core/sweep-logic';
import { runSweepWorkflow, type SweepWorkflowDeps, type WorkflowUi } from '../core/sweep-workflow';
import { MEMENTO_KEY, type StateStore } from '../core/sync-with-upstream-state';
import {
	runSyncWithUpstreamResumeWorkflow,
	runSyncWithUpstreamWorkflow,
	type SyncWithUpstreamDeps,
} from '../core/sync-with-upstream-workflow';
import { parseArgs, USAGE, UsageError, type CliOptions } from './args';
import type { CliIo } from './io';
import { createRpcUi } from './rpc-ui';
import { createFileStateStore, createMemoryStateStore, stateFilePath } from './state-store';
import { createTerminalUi } from './terminal-ui';

/** Exit codes, documented in the README. */
export const EXIT = {
	ok: 0,
	failed: 1,
	usage: 2,
	/** A sync stopped on rebase conflicts; run `resume` once they are resolved. */
	paused: 3,
} as const;

/** git config key holding extra protected-branch globs (multi-valued). */
export const PROTECTED_CONFIG_KEY = 'git-sweep-pro.protected';

type RunGit = (args: string[], cwd: string) => Promise<CommandResult>;
type CliDeps = SweepWorkflowDeps & { readonly ui: WorkflowUi & { readonly errorCount: () => number } };

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

	// Three front ends: RPC for the extension, interactive widgets for a human,
	// plain text for pipes and CI.
	const rpcUi = options.rpc ? createRpcUi(io) : undefined;
	const prompter = !rpcUi && io.interactive ? await io.loadPrompter?.() : undefined;
	const terminalUi = rpcUi
		? undefined
		: createTerminalUi(io, { yes: options.yes, presetPick: options.positionals[0], spinners: !options.verbose }, prompter);

	// In a terminal, git traces only show with --verbose, and so does the
	// session chatter that the prompts already convey.
	const traceLine = (line: string): void => {
		if (rpcUi) {
			rpcUi.log(line);
		} else if (options.verbose) {
			io.stderr(`${line}\n`);
		}
	};
	const workflowLine = (line: string): void => {
		if (rpcUi) {
			rpcUi.log(line);
		} else if (options.verbose || !/^(---|Workspace:|Mode:)/.test(line)) {
			terminalUi?.detail(line);
		}
	};

	const runGit: RunGit = (args, cwd) => runGitCommand(args, cwd, { appendLine: traceLine });
	const workspaceRoot = (await tryGit(runGit, ['rev-parse', '--show-toplevel'], requestedDir)) || requestedDir;
	const configProtected = (await tryGit(runGit, ['config', '--get-all', PROTECTED_CONFIG_KEY], workspaceRoot)) ?? '';

	const settings: SweepSettings = {
		defaultMode: options.force ? 'forceDelete' : options.dryRun ? 'dryRun' : 'safeDelete',
		protectedBranches: [...options.protect, ...configProtected.split('\n').filter((line) => line.trim())],
		autoFetchPrune: options.fetch,
		confirmBeforeDelete: options.confirm,
	};

	const deps: CliDeps = {
		getWorkspaceRoot: () => workspaceRoot,
		getSettings: () => settings,
		output: {
			show: (preserveFocus) => rpcUi?.showOutput(preserveFocus),
			appendLine: workflowLine,
		},
		runGitCommand: runGit,
		ui: (rpcUi ?? terminalUi)!,
	};

	prompter?.intro(`git sweep-pro ${options.command}`);
	const code = await runCommand(options, workspaceRoot, deps, io);
	prompter?.outro(
		code === EXIT.ok
			? 'Done.'
			: code === EXIT.paused
				? 'Paused: resolve the conflicts, then run "git sweep-pro sync --continue".'
				: 'Finished with errors.'
	);
	return code;
}

async function runCommand(options: CliOptions, workspaceRoot: string, deps: CliDeps, io: CliIo): Promise<number> {
	switch (options.command) {
		case 'list':
			return runList(workspaceRoot, deps, options, io);
		case 'sweep':
			await runSweepWorkflow({ dryRun: options.dryRun, forceDelete: options.force }, deps);
			break;
		case 'post-pr':
			await runPostPullRequestWorkflow(deps);
			break;
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
			await (options.command === 'sync'
				? runSyncWithUpstreamWorkflow(syncDeps)
				: runSyncWithUpstreamResumeWorkflow(syncDeps));
			if (deps.ui.errorCount() === 0 && store.get(MEMENTO_KEY) !== undefined) {
				return EXIT.paused;
			}
			break;
		}
	}

	return deps.ui.errorCount() > 0 ? EXIT.failed : EXIT.ok;
}

/** `list`: prints stale branches without touching them (`--json` for scripts). */
async function runList(root: string, deps: CliDeps, options: CliOptions, io: CliIo): Promise<number> {
	const { protectedBranches, autoFetchPrune } = deps.getSettings();
	try {
		if (autoFetchPrune) {
			await deps.runGitCommand(['fetch', '-p'], root);
		}
		const gone = parseGoneBranchRefs((await deps.runGitCommand([...GONE_REFS_ARGS], root)).stdout);
		const isProtected = (branch: string) => isProtectedBranch(branch, protectedBranches);
		const stale = gone.filter((branch) => !isProtected(branch));
		const protectedStale = gone.filter(isProtected);

		if (options.json) {
			io.stdout(`${JSON.stringify({ stale, protected: protectedStale }, null, 2)}\n`);
		} else if (gone.length === 0) {
			io.stderr('No stale branches found.\n');
		} else {
			stale.forEach((branch) => io.stdout(`${branch}\n`));
			protectedStale.forEach((branch) => io.stdout(`${branch} (protected)\n`));
		}
		return EXIT.ok;
	} catch (error) {
		deps.ui.showErrorMessage(describeGitFailure(toErrorMessage(error), 'Git Sweep Pro failed:'));
		return EXIT.failed;
	}
}
