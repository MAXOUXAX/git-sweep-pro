import type { CleanBranch, CleanDocument, CleanRemoteBranch } from '../../core/clean-plan';
import type { PostPrDocument } from '../../core/post-pull-request-plan';
import type { WorktreeEntry } from '../../core/worktree-list';
import type { CliRunResult } from '../../vscode/cli-client';
import type { CleanPick, CleanPickerOptions, CommandDeps, CommandUi, Confirmation, PickOption } from '../../vscode/command-ui';
import type { GspClient, JsonRun } from '../../vscode/gsp-client';

/** A local branch as `gsp clean --json` reports it; a proven, planned deletion by default. */
export function branch(overrides: Partial<CleanBranch> & Pick<CleanBranch, 'name'>): CleanBranch {
	return {
		tip: 'a4d8464',
		action: 'delete',
		reason: 'squash-merged',
		verdict: 'dead',
		verdictReason: 'squash-merged',
		evidence: { method: 'ancestor', base: 'refs/remotes/origin/main' },
		unpushedCommits: 0,
		upstream: null,
		upstreamState: 'none',
		worktree: null,
		protected: null,
		needsForce: false,
		hint: null,
		...overrides,
	};
}

export function remoteBranch(overrides: Partial<CleanRemoteBranch> & Pick<CleanRemoteBranch, 'name'>): CleanRemoteBranch {
	return {
		remote: 'origin',
		tip: 'b5e9575',
		action: 'delete',
		reason: 'merged',
		verdict: 'dead',
		verdictReason: 'merged',
		evidence: { method: 'ancestor', base: 'refs/remotes/origin/main' },
		protected: null,
		trackedBy: [],
		hint: null,
		...overrides,
	};
}

export function cleanDocument(branches: readonly CleanBranch[], overrides: Partial<CleanDocument> = {}): CleanDocument {
	return {
		schema: 2,
		mode: 'plan',
		checks: {
			base: { name: 'main', ref: 'refs/remotes/origin/main', remote: 'origin', tip: '8ed204b', source: 'remote-head' },
			fetched: false,
			github: { used: false, reason: 'disabled' },
			durationMs: 1,
			remote: { source: 'ls-remote', remotes: ['origin'] },
		} as CleanDocument['checks'],
		branches,
		worktreesPruned: [],
		restore: null,
		summary: { delete: 0, deleted: 0, failed: 0, skipped: 0, kept: 0, needsForce: branches.filter((b) => b.reason === 'needs-force' || b.reason === 'ignored-files').length, reasons: {} },
		next: null,
		...overrides,
	};
}

export function worktreeEntry(overrides: Partial<WorktreeEntry> & Pick<WorktreeEntry, 'path'>): WorktreeEntry {
	return {
		branch: null,
		head: 'c0ffee1234',
		isMain: false,
		locked: false,
		prunable: false,
		dirty: false,
		inProgress: null,
		ignoredFiles: { count: 0, sample: [] },
		verdict: null,
		verdictReason: null,
		action: null,
		reason: null,
		hint: null,
		...overrides,
	};
}

export function postPrDocument(overrides: Partial<PostPrDocument> = {}): PostPrDocument {
	return {
		schema: 2,
		command: 'post-pr',
		mode: 'plan',
		branch: null,
		worktree: { path: null, removed: false, switched: false },
		defaultBranch: { name: 'main', from: 'aaa', to: 'aaa', upstream: 'origin/main', where: '/repo', updated: false, remoteAhead: false, reason: 'up-to-date', hint: null },
		clean: cleanDocument([]),
		nextCwd: null,
		restore: null,
		next: null,
		...overrides,
	};
}

type JsonReply = JsonRun<unknown> | ((args: readonly string[]) => JsonRun<unknown>);

/** A fake gsp: answers each `--json` run with the next queued reply, and records every call. */
export function createFakeClient(replies: JsonReply[] = []) {
	const calls: { readonly cwd: string; readonly args: readonly string[]; readonly json: boolean }[] = [];
	const runResults: CliRunResult[] = [];
	const client: GspClient = {
		json: async <T>(cwd: string, args: readonly string[]) => {
			calls.push({ cwd, args, json: true });
			const reply = replies.shift();
			if (!reply) {
				throw new Error(`unexpected gsp ${args.join(' ')} --json`);
			}
			return (typeof reply === 'function' ? reply(args) : reply) as JsonRun<T>;
		},
		run: async (cwd, args) => {
			calls.push({ cwd, args, json: false });
			return runResults.shift() ?? { exitCode: 0, errorShown: false };
		},
	};
	return { client, calls, runResults };
}

export const ok = <T>(document: T, exitCode = 0): JsonRun<T> => ({ kind: 'document', exitCode, document });

/** A fake VS Code UI: scripted answers, recorded prompts. */
export function createFakeUi(script: {
	pick?: (options: CleanPickerOptions, document: CleanDocument | undefined) => CleanPick;
	confirm?: (confirmation: Confirmation) => boolean;
	notify?: (message: string, actions: readonly string[]) => string | undefined;
	pickOne?: (items: readonly PickOption<unknown>[], title: string) => unknown;
} = {}) {
	const confirms: Confirmation[] = [];
	const notices: { kind: string; message: string; actions: readonly string[] }[] = [];
	const pickers: { options: CleanPickerOptions; document: CleanDocument | undefined }[] = [];
	const picks: { title: string; items: readonly PickOption<unknown>[] }[] = [];
	const copied: string[] = [];
	const opened: { path: string; newWindow: boolean }[] = [];
	const progress: string[] = [];
	let outputShown = 0;
	const ui: CommandUi = {
		pickCleanup: async (options) => {
			const document = await options.plan;
			pickers.push({ options, document });
			if (script.pick) {
				return script.pick(options, document);
			}
			return document ? { kind: 'picked', entries: [] } : { kind: 'closed' };
		},
		pickOne: async <T>({ title, items }: { title: string; items: readonly PickOption<T>[] }) => {
			picks.push({ title, items });
			return script.pickOne?.(items, title) as T | undefined;
		},
		confirm: async (confirmation) => {
			confirms.push(confirmation);
			return script.confirm?.(confirmation) ?? true;
		},
		notify: async (kind, message, actions = []) => {
			notices.push({ kind, message, actions });
			return script.notify?.(message, actions);
		},
		withProgress: (title, task) => {
			progress.push(title);
			return task();
		},
		copy: async (text) => {
			copied.push(text);
		},
		openFolder: async (path, newWindow) => {
			opened.push({ path, newWindow });
		},
		showOutput: () => {
			outputShown++;
		},
	};
	return { ui, confirms, notices, pickers, picks, copied, opened, progress, outputShown: () => outputShown };
}

export function deps(client: GspClient, ui: CommandUi, windowFolders: readonly string[] = ['/repo']): CommandDeps {
	return { client, ui, windowFolders: () => windowFolders };
}
