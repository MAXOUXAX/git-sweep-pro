import type { AliveReason, DeadReason } from './branch-analysis';
import { actionLabel, CLEAN_SCHEMA, describeAction, type CleanAction, type CleanBranch, type IgnoredFiles } from './clean-plan';
import { runCleanWorkflow, type CleanContext } from './clean-workflow';
import { listIgnoredFiles, summarizeIgnored } from './ignored-files';
import { parseWorktrees } from './worktrees';

/** One worktree, as `gsp worktree list --json` reports it. */
export type WorktreeEntry = {
	readonly path: string;
	/** Checked-out branch; during a rebase or a bisect, the branch being worked on. Null when detached otherwise. */
	readonly branch: string | null;
	/** Commit checked out, or null when Git does not report one (a prunable registration may not). */
	readonly head: string | null;
	readonly isMain: boolean;
	readonly locked: boolean;
	/** Its directory is gone: `gsp worktree prune` forgets it. */
	readonly prunable: boolean;
	/** Uncommitted changes or untracked files; false for a prunable one. */
	readonly dirty: boolean;
	readonly inProgress: 'rebase' | 'bisect' | null;
	/** The ignored files removing it would delete, regenerable ones left out; null for the main or a prunable one. */
	readonly ignoredFiles: IgnoredFiles | null;
	/**
	 * What the analysis found about the branch, and what `gsp clean` would do
	 * with it. A detached worktree has no branch to clean: `keep`, reason
	 * `detached`, verdict null; a main or prunable one without a branch: all null.
	 */
	readonly verdict: 'dead' | 'alive' | null;
	readonly verdictReason: DeadReason | AliveReason | null;
	readonly action: CleanAction | null;
	/** As in `gsp clean --json`: the skip reason for `skip`, otherwise the verdict reason; `detached` for a detached worktree. */
	readonly reason: CleanBranch['reason'] | 'detached' | null;
	readonly hint: string | null;
};

/** The `--json` document of `gsp worktree list`. */
export type WorktreeListDocument = {
	readonly schema: typeof CLEAN_SCHEMA;
	readonly command: 'worktree list';
	readonly worktrees: readonly WorktreeEntry[];
};

export type WorktreeListOptions = {
	readonly fetch: boolean;
	readonly github: boolean;
	readonly protectedPatterns: readonly string[];
};

/** The commit each worktree has checked out, by path, from `git worktree list --porcelain`. */
function parseHeads(porcelain: string): Map<string, string> {
	const heads = new Map<string, string>();
	for (const block of porcelain.split(/\n\s*\n/)) {
		const lines = block.trim().split('\n');
		const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
		const head = lines.find((line) => line.startsWith('HEAD '))?.slice('HEAD '.length);
		if (path && head) {
			heads.set(path, head);
		}
	}
	return heads;
}

/**
 * Every worktree with its state, and what `gsp clean` would do with the branch
 * checked out there: the same plan, read-only (no fetch, no prune, no write;
 * remote branches are read with `git ls-remote` unless `fetch` is false).
 */
export async function listWorktreeStates(
	context: CleanContext,
	options: WorktreeListOptions
): Promise<{ document: WorktreeListDocument; branches: readonly CleanBranch[] }> {
	const { git } = context;
	const { report } = await runCleanWorkflow(context, {
		patterns: [],
		dryRun: true,
		yes: false,
		force: false,
		fetch: options.fetch,
		github: options.github,
		protectedPatterns: options.protectedPatterns,
		canPrompt: false,
		confirm: false,
	});
	const porcelain = (await git(['worktree', 'list', '--porcelain'])).stdout;
	const heads = parseHeads(porcelain);
	// A branch being rebased or bisected is attached to its worktree, though HEAD is detached there.
	const branchAt = new Map(report.branches.flatMap((branch) => (branch.worktree ? [[branch.worktree.path, branch] as const] : [])));

	const worktrees = await Promise.all(
		parseWorktrees(porcelain).map(async (worktree): Promise<WorktreeEntry> => {
			const branch = branchAt.get(worktree.path);
			const isMain = worktree.state === 'main';
			const prunable = worktree.state === 'prunable';
			const dirty = prunable
				? false
				: (branch?.worktree?.dirty ??
					(await git(['-C', worktree.path, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal']).then(
						(result) => result.stdout.trim().length > 0,
						() => true
					)));
			const ignoredFiles =
				isMain || prunable
					? null
					: (branch?.worktree?.ignoredFiles ??
						(await listIgnoredFiles(git, worktree.path).then(
							(files) => summarizeIgnored(files),
							() => null
						)));
			// Linked and on no branch: gsp clean never removes it.
			const detached = !branch && !worktree.branch && !isMain && !prunable;
			return {
				path: worktree.path,
				branch: worktree.branch ?? branch?.name ?? null,
				head: heads.get(worktree.path) ?? null,
				isMain,
				locked: worktree.state === 'locked',
				prunable,
				dirty,
				inProgress: branch?.worktree?.inProgress ?? null,
				ignoredFiles,
				verdict: branch?.verdict ?? null,
				verdictReason: branch?.verdictReason ?? null,
				action: branch?.action ?? (detached ? 'keep' : null),
				reason: branch?.reason ?? (detached ? 'detached' : null),
				hint: branch?.hint ?? null,
			};
		})
	);
	return { document: { schema: CLEAN_SCHEMA, command: 'worktree list', worktrees }, branches: report.branches };
}

/**
 * One line per worktree: path, branch, its state when it is not a plain
 * linked worktree, then what `gsp clean` would do, e.g.
 * "/work/wt  feature/x  delete  squash-merged into origin/main". `branches`
 * are the planned branches {@link listWorktreeStates} returns.
 */
export function formatWorktreeLines(document: WorktreeListDocument, branches: readonly CleanBranch[]): string[] {
	const byName = new Map(branches.map((branch) => [branch.name, branch]));
	const nameOf = (worktree: WorktreeEntry) => worktree.branch ?? `(detached at ${worktree.head?.slice(0, 7) ?? 'unknown'})`;
	const rows = document.worktrees.map((worktree) => {
		const states = [
			...(worktree.isMain ? ['main'] : []),
			...(worktree.locked ? ['locked'] : []),
			...(worktree.prunable ? ['prunable'] : []),
			...(worktree.dirty ? ['dirty'] : []),
			...(worktree.inProgress ? [`${worktree.inProgress} in progress`] : []),
			...(worktree.ignoredFiles?.count ? [`${worktree.ignoredFiles.count} ignored`] : []),
		];
		const branch = worktree.branch ? byName.get(worktree.branch) : undefined;
		const plan = branch
			? `${actionLabel(branch).padEnd(8)}${describeAction(branch)}`
			: worktree.reason === 'detached'
				? `${'keep'.padEnd(8)}detached, no branch to clean`
				: '';
		return [worktree.path, nameOf(worktree), states.length > 0 ? `[${states.join(', ')}]` : '', plan];
	});
	// Every column but the last padded to its widest cell, so the plans line up.
	const widths = [0, 1, 2].map((column) => Math.max(0, ...rows.map((row) => row[column].length)));
	return rows.map((row) =>
		row
			.map((cell, column) => (column < widths.length ? cell.padEnd(widths[column]) : cell))
			.filter((_cell, column) => column < 2 || column >= widths.length || widths[column] > 0)
			.join('  ')
			.trimEnd()
	);
}
