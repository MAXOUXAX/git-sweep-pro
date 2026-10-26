import { createHash } from 'node:crypto';
import type { RunGit } from './git-command';
import { loadGitHubSignal, parseGitHubRemote, type GitHubSignal, type GitHubSkipReason, type PullRequest, type RunGh } from './github-signal';
import { branchMatchesPattern, isProtectedBranch } from './sweep-logic';
import { parseWorktrees } from './worktrees';

/*
 * Read-only branch analysis: decides, for every local branch, whether its
 * work already exists somewhere else (dead) or not (alive), and keeps the
 * proof. Every Git command used here only reads: no fetch, no prune, no ref,
 * config or object writes, and `status` runs without optional locks.
 */

/** Where the upstream of a branch stands: set and present, deleted on the remote, or not set. */
export type UpstreamState = 'tracking' | 'gone' | 'none';

/**
 * Why a branch is dead:
 * - `empty`: it points at a commit of the base's own history, so it adds nothing;
 * - `merged`: its tip is reachable from the base (a merge commit brought it in);
 * - `rebase-merged`: each of its commits has exactly the same patch on the base, whitespace included, and its merges add nothing;
 * - `squash-merged`: the base reached the exact content of every file it changed;
 * - `pr-merged`: its tip is the head of a pull request merged into the default branch, or behind it;
 * - `commits-merged`: each of its own commits is proven merged separately, and its merges add nothing (integration branches);
 * - `upstream-gone`: its upstream was deleted. Not a proof by itself: see `unpushedCommits`.
 */
export type DeadReason = 'empty' | 'merged' | 'rebase-merged' | 'squash-merged' | 'pr-merged' | 'commits-merged' | 'upstream-gone';

/**
 * Why a branch is alive:
 * - `default-branch`: it is the branch everything is compared with;
 * - `open-pr`: its tip is the head of an open pull request;
 * - `unmerged-commits`: some of its work is found nowhere else;
 * - `no-base`: no default branch was found to compare it with;
 * - `analysis-failed`: a Git command failed while looking for a proof (see the evidence).
 */
export type AliveReason = 'default-branch' | 'open-pr' | 'unmerged-commits' | 'no-base' | 'analysis-failed';

/** How one commit of an integration branch was proven merged. */
export type CommitProof = {
	readonly commit: string;
	readonly method: 'patch-id' | 'file-state' | 'pull-request';
	/** For `file-state`: the base commit where its content landed. */
	readonly squashCommit?: string;
	/** For `pull-request`: the merged pull request it belongs to. */
	readonly pullRequest?: number;
};

/** The facts behind a verdict. `base` is the full ref compared with, e.g. "refs/remotes/origin/main". */
export type Evidence =
	| { readonly method: 'ancestor'; readonly base: string }
	| { readonly method: 'patch-id'; readonly base: string; readonly commits: number }
	| {
			readonly method: 'file-state';
			readonly base: string;
			readonly squashCommit: string;
			readonly files: number;
			/** Oldest commits of the branch already on the base by patch id; the squash covers the rest. */
			readonly patchIdCommits: number;
	  }
	| {
			readonly method: 'pull-request';
			readonly pullRequest: number;
			readonly state: 'merged' | 'open';
			readonly headSha: string;
			/**
			 * `head`: the tip is the PR head; `ancestor`: the PR head, present locally, contains it;
			 * `api`: GitHub lists the tip in the PR and its compare API confirms the PR head contains it.
			 */
			readonly match: 'head' | 'ancestor' | 'api';
	  }
	| { readonly method: 'commits'; readonly base: string; readonly commits: number; readonly proofs: readonly CommitProof[] }
	| { readonly method: 'upstream-gone'; readonly upstream: string }
	| { readonly method: 'unique-commits'; readonly base: string; readonly commits: number }
	/** The analysis of this branch failed: `message` is the first line Git printed. */
	| { readonly method: 'error'; readonly message: string };

/** Why a branch must be kept whatever its verdict. */
export type Protection =
	| { readonly by: 'default-branch' }
	/** `branch.<name>.deleteMerged` is false (the Git 2.56 opt-out). */
	| { readonly by: 'branch-config'; readonly key: string }
	| { readonly by: 'pattern'; readonly pattern: string };

export type BranchWorktree = {
	readonly path: string;
	readonly isMain: boolean;
	/** Uncommitted changes or untracked files. */
	readonly dirty: boolean;
	readonly locked: boolean;
	/** Its directory is gone: Git still registers it until `git worktree prune`. */
	readonly prunable: boolean;
};

export type BranchAnalysis = {
	readonly name: string;
	readonly tip: string;
	/** Checked out in the worktree the analysis runs in. */
	readonly current: boolean;
	/** Short upstream name, e.g. "origin/feature", or null. */
	readonly upstream: string | null;
	readonly upstreamState: UpstreamState;
	readonly worktree: BranchWorktree | null;
	readonly verdict: 'dead' | 'alive';
	readonly reason: DeadReason | AliveReason;
	readonly evidence: Evidence | null;
	/**
	 * Commits reachable from the tip but from no remote-tracking ref and not
	 * from the base, that no proof covers: 0 for every proven branch. A dead
	 * `upstream-gone` branch with unpushed commits holds work found nowhere else.
	 * Also 0 when counting failed, which makes the branch `analysis-failed`.
	 */
	readonly unpushedCommits: number;
	readonly protected: Protection | null;
	/** Other local branches whose upstream is this one: it must not be deleted while they are kept. */
	readonly upstreamOf: readonly string[];
};

/** How the base was found: the remote's HEAD, a usual name on a remote, a local branch, or the caller. */
export type BaseSource = 'remote-head' | 'remote-branch' | 'local-branch' | 'option';

export type AnalysisBase = {
	/** Branch name without the remote, e.g. "main". */
	readonly name: string;
	/** Full ref, e.g. "refs/remotes/origin/main" or "refs/heads/main". */
	readonly ref: string;
	readonly remote: string | null;
	readonly tip: string;
	readonly source: BaseSource;
};

export type GitHubCheck =
	| { readonly used: true; readonly repo: string; readonly pullRequests: number; readonly apiCalls: number }
	| { readonly used: false; readonly reason: GitHubSkipReason; readonly detail?: string };

export type AnalysisChecks = {
	/** Null when no default branch was found: only `upstream-gone` can then make a branch dead. */
	readonly base: AnalysisBase | null;
	/** Whether the caller fetched before analysing; this module never fetches. */
	readonly fetched: boolean;
	readonly github: GitHubCheck;
	readonly durationMs: number;
};

export type BranchAnalysisResult = {
	readonly checks: AnalysisChecks;
	readonly branches: readonly BranchAnalysis[];
};

export type AnalyzeContext = {
	/** Runs git in the repository; only read commands are sent. */
	readonly git: RunGit;
	/** Runs `gh`; without it, the GitHub signal is skipped as `gh-missing`. */
	readonly gh?: RunGh;
};

export type AnalyzeOptions = {
	/** Only classify the branches matching one of these patterns (`*` and `?` wildcards); all by default. */
	readonly branches?: readonly string[];
	/** Protected-branch patterns, added to the `git-sweep-pro.protected` config. */
	readonly protectedPatterns?: readonly string[];
	/** Set to false to skip GitHub (`--no-github`). */
	readonly github?: boolean;
	/** Full ref to compare with instead of the detected default branch. */
	readonly base?: string;
	/** Reported in the checks: whether the caller fetched first. */
	readonly fetched?: boolean;
};

/** Squash proofs give up beyond this many changed files. */
const MAX_PROOF_FILES = 1000;
/** Base commits searched for a squash, newest first. */
const MAX_SQUASH_CANDIDATES = 200;
/** Base commits searched for the first-parent history (`empty` vs `merged`). */
const MAX_FIRST_PARENT = 10000;
/** Integration proofs give up beyond this many unique commits. */
const MAX_INTEGRATION_COMMITS = 50;
/** Concurrent branch classifications; each runs a few Git commands. */
const CONCURRENCY = 6;

const ZERO_OID = /^0+$/;

const lines = (output: string): string[] =>
	output
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);

async function mapWithLimit<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++;
			results[index] = await task(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

type Ref = {
	readonly name: string;
	readonly oid: string;
	readonly upstream: string;
	readonly track: string;
	readonly head: boolean;
	readonly symref: string;
};

const REFS_FORMAT = '%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track)%00%(HEAD)%00%(symref)';

function parseRefs(output: string): Map<string, Ref> {
	const refs = new Map<string, Ref>();
	for (const line of output.split('\n')) {
		const [name, oid = '', upstream = '', track = '', head = '', symref = ''] = line.split('\0');
		if (name) {
			refs.set(name, { name, oid, upstream, track, head: head === '*', symref });
		}
	}
	return refs;
}

type GitConfig = {
	readonly remotes: ReadonlyMap<string, string>;
	readonly defaultBranch: string | undefined;
	readonly protectedPatterns: readonly string[];
	/** Branch names with `branch.<name>.deleteMerged` set to false. */
	readonly keepMerged: ReadonlySet<string>;
};

const FALSE_VALUE = /^(false|no|off|0)$/i;

/** Parses `git config --list -z`: `key\nvalue` entries, NUL-separated; keys are lower-cased except subsections. */
function parseConfig(output: string): GitConfig {
	const remotes = new Map<string, string>();
	const protectedPatterns: string[] = [];
	const keepMerged = new Set<string>();
	let defaultBranch: string | undefined;
	for (const entry of output.split('\0')) {
		const newline = entry.indexOf('\n');
		const key = newline < 0 ? entry : entry.slice(0, newline);
		const value = newline < 0 ? 'true' : entry.slice(newline + 1);
		const [section] = key.split('.', 1);
		const variable = key.slice(key.lastIndexOf('.') + 1);
		const subsection = key.slice(section.length + 1, key.length - variable.length - 1);
		if (section === 'remote' && variable === 'url' && subsection && !remotes.has(subsection)) {
			remotes.set(subsection, value);
		} else if (key === 'init.defaultbranch') {
			defaultBranch = value;
		} else if (key === 'git-sweep-pro.protected') {
			protectedPatterns.push(value);
		} else if (section === 'branch' && variable === 'deletemerged' && subsection) {
			if (FALSE_VALUE.test(value)) {
				keepMerged.add(subsection);
			} else {
				keepMerged.delete(subsection);
			}
		}
	}
	return { remotes, defaultBranch, protectedPatterns, keepMerged };
}

/**
 * Finds the branch to compare with: the remote's HEAD (origin first), else a
 * usual default name (`init.defaultBranch`, main, master) on a remote, else
 * the same names locally, which also covers repositories without a remote.
 */
function resolveBase(refs: ReadonlyMap<string, Ref>, config: GitConfig, override?: string): AnalysisBase | undefined {
	if (override !== undefined) {
		const ref = refs.get(override);
		if (!ref) {
			return undefined;
		}
		const remote = /^refs\/remotes\/([^/]+)\//.exec(override)?.[1] ?? null;
		const name = override.replace(remote ? `refs/remotes/${remote}/` : /^refs\/heads\//, '');
		return { name, ref: override, remote, tip: ref.oid, source: 'option' };
	}
	const remoteNames = new Set([...config.remotes.keys()]);
	for (const ref of refs.keys()) {
		const remote = /^refs\/remotes\/([^/]+)\//.exec(ref)?.[1];
		if (remote) {
			remoteNames.add(remote);
		}
	}
	const remotes = [...remoteNames].sort((a, b) => Number(b === 'origin') - Number(a === 'origin'));
	for (const remote of remotes) {
		const target = refs.get(`refs/remotes/${remote}/HEAD`)?.symref ?? '';
		const prefix = `refs/remotes/${remote}/`;
		const tip = refs.get(target)?.oid;
		if (target.startsWith(prefix) && tip) {
			return { name: target.slice(prefix.length), ref: target, remote, tip, source: 'remote-head' };
		}
	}
	const names = [...new Set([config.defaultBranch, 'main', 'master'].filter((name): name is string => Boolean(name)))];
	for (const remote of remotes) {
		for (const name of names) {
			const ref = `refs/remotes/${remote}/${name}`;
			const tip = refs.get(ref)?.oid;
			if (tip) {
				return { name, ref, remote, tip, source: 'remote-branch' };
			}
		}
	}
	for (const name of names) {
		const ref = `refs/heads/${name}`;
		const tip = refs.get(ref)?.oid;
		if (tip) {
			return { name, ref, remote: null, tip, source: 'local-branch' };
		}
	}
	return undefined;
}

type RawChange = { readonly path: string; readonly state: string };

/**
 * Parses `--raw -z --no-abbrev` changes (`:<modes> <oids> <status>\0<path>\0`)
 * into each path's new state: "<mode> <oid>", or "" when deleted.
 */
function parseRawChanges(tokens: readonly string[]): RawChange[] {
	const changes: RawChange[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index].replace(/^\n/, '');
		if (!token.startsWith(':')) {
			continue;
		}
		const [, mode = '', , oid = ''] = token.slice(1).split(' ');
		const path = tokens[++index] ?? '';
		changes.push({ path, state: ZERO_OID.test(oid) ? '' : `${mode} ${oid}` });
	}
	return changes;
}

/** Parses `ls-tree -r -z`: `<mode> <type> <oid>\t<path>` entries. */
function parseTree(output: string): Map<string, string> {
	const files = new Map<string, string>();
	for (const entry of output.split('\0')) {
		const tab = entry.indexOf('\t');
		if (tab > 0) {
			const [mode, , oid] = entry.slice(0, tab).split(' ');
			files.set(entry.slice(tab + 1), `${mode} ${oid}`);
		}
	}
	return files;
}

/** Shows commits as `commit <sha>` and their patch, the same way whatever the user's diff and log configuration. */
const PATCH_ARGS = [
	'--format=commit %H',
	'--patch',
	'--no-color',
	'--no-ext-diff',
	'--no-textconv',
	'--no-renames',
	'--no-relative',
	'--no-show-signature',
	'--full-index',
	'--src-prefix=a/',
	'--dst-prefix=b/',
];

type Patch = { readonly key: string; readonly paths: readonly string[] };

/**
 * Parses {@link PATCH_ARGS} output into each commit's patch, reduced to what
 * makes it the same change anywhere in history: hunk positions and blob ids
 * are dropped (they move with the surrounding file), whitespace is kept.
 * Blob ids stay for binary files, whose changes the diff does not show.
 */
function parsePatches(output: string): Map<string, Patch> {
	const commits: Array<{ sha: string; files: string[][] }> = [];
	for (const line of output.split('\n')) {
		const header = /^commit ([0-9a-f]{40,64})$/.exec(line);
		if (header) {
			commits.push({ sha: header[1], files: [] });
		} else if (line.startsWith('diff --git ')) {
			commits.at(-1)?.files.push([line]);
		} else if (line) {
			commits.at(-1)?.files.at(-1)?.push(line);
		}
	}
	return new Map(
		commits.map(({ sha, files }) => {
			const paths: string[] = [];
			const hash = createHash('sha256');
			for (const file of files) {
				// "diff --git a/<path> b/<path>": renames are off, so both paths are the same.
				const names = file[0].slice('diff --git '.length);
				const length = (names.length - 5) / 2;
				if (Number.isInteger(length) && names.slice(2 + length) === ` b/${names.slice(2, 2 + length)}`) {
					paths.push(names.slice(2, 2 + length));
				}
				const binary = file.some((line) => line.startsWith('Binary files '));
				for (const line of file) {
					if (line.startsWith('@@')) {
						hash.update('@@\n');
					} else if (binary || !line.startsWith('index ')) {
						hash.update(`${line}\n`);
					}
				}
			}
			return [sha, { key: hash.digest('hex'), paths }] as const;
		})
	);
}

type Verdict = { readonly verdict: 'dead' | 'alive'; readonly reason: DeadReason | AliveReason; readonly evidence: Evidence | null };

/** A merged pull request containing a commit, and how that was established. */
type PullRequestMatch = { readonly pullRequest: PullRequest; readonly match: 'head' | 'ancestor' | 'api' };

/**
 * Everything one analysis run shares between branches: the base, and lazily
 * computed, cached lookups (first-parent history, merged pull requests).
 */
class Prover {
	private firstParent: Promise<ReadonlySet<string>> | undefined;
	private pullRequestCommits: Promise<ReadonlyMap<string, PullRequest>> | undefined;
	private anyMerges: Promise<boolean> | undefined;
	private readonly verdicts = new Map<string, Promise<Verdict>>();

	constructor(
		private readonly git: RunGit,
		readonly base: AnalysisBase,
		private readonly github: GitHubSignal | undefined
	) {}

	/** The verdict of a tip, computed once however many branches point at it. */
	verdictOf(tip: string, isAncestor: boolean): Promise<Verdict> {
		let verdict = this.verdicts.get(tip);
		if (!verdict) {
			verdict = proveTip(this.git, this, tip, isAncestor);
			this.verdicts.set(tip, verdict);
		}
		return verdict;
	}

	private gitRead(args: readonly string[]): Promise<string> {
		return this.git(args).then((result) => result.stdout);
	}

	/** Whether `commit` is on the base's own (first-parent) history, searched back {@link MAX_FIRST_PARENT} commits. */
	isOnFirstParentLine(commit: string): Promise<boolean> {
		this.firstParent ??= this.gitRead(['rev-list', '--first-parent', `--max-count=${MAX_FIRST_PARENT}`, this.base.ref]).then(
			(output) => new Set(lines(output))
		);
		return this.firstParent.then((set) => set.has(commit));
	}

	/**
	 * The squash proof: is there a commit on the base's first-parent history,
	 * after `since`, where every file changed between `from` and `to` has
	 * exactly its content at `to`? Replays the base's changes to those files
	 * (diffed against the first parent, so merges count too) from the oldest
	 * candidate, and compares after each commit. Requires every file.
	 */
	async fileStateProof(from: string, to: string, since: string): Promise<{ squashCommit: string; files: number } | undefined> {
		const wanted = new Map(
			parseRawChanges((await this.gitRead(['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', from, to])).split('\0')).map(
				(change) => [change.path, change.state]
			)
		);
		if (wanted.size === 0 || wanted.size > MAX_PROOF_FILES) {
			// No net change would match any base commit; too many files is too costly.
			return undefined;
		}
		const paths = [...wanted.keys()];
		const log = await this.gitRead([
			'--literal-pathspecs',
			'log',
			'-z',
			'--first-parent',
			'--diff-merges=first-parent',
			'--raw',
			'--no-renames',
			'--no-abbrev',
			'--format=commit %H %P',
			`--max-count=${MAX_SQUASH_CANDIDATES}`,
			`^${since}`,
			this.base.ref,
			'--',
			...paths,
		]);
		const commits: Array<{ sha: string; parent: string | undefined; tokens: string[] }> = [];
		for (const token of log.split('\0')) {
			const header = /^\n?commit (\S+)(?: (\S+))?/.exec(token);
			if (header) {
				commits.push({ sha: header[1], parent: header[2], tokens: [] });
			} else {
				commits.at(-1)?.tokens.push(token);
			}
		}
		commits.reverse();
		const changes = commits.map((commit) => parseRawChanges(commit.tokens));
		// Cheap gate before reading any tree: every wanted state must show up in the base's changes
		// (when none touched the files since `since`, the change cannot have landed).
		// Only sound when the log is complete: a capped one may start after the squash.
		const complete = commits.length < MAX_SQUASH_CANDIDATES;
		const reached = new Set(changes.flat().map((change) => `${change.path}\0${change.state}`));
		if (complete && paths.some((path) => !reached.has(`${path}\0${wanted.get(path)}`))) {
			return undefined;
		}

		// The state just before the oldest candidate.
		const start = commits[0].parent;
		const state = start
			? parseTree(await this.gitRead(['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree', start, '--', ...paths]))
			: new Map<string, string>();
		const matches = () => paths.every((path) => (state.get(path) ?? '') === wanted.get(path));
		if (start && !complete && matches()) {
			return { squashCommit: start, files: paths.length };
		}
		for (const [index, commit] of commits.entries()) {
			for (const change of changes[index]) {
				if (change.state) {
					state.set(change.path, change.state);
				} else {
					state.delete(change.path);
				}
			}
			if (matches()) {
				return { squashCommit: commit.sha, files: paths.length };
			}
		}
		return undefined;
	}

	/**
	 * Whether a pull request proves its commits merged: merged into the default
	 * branch. One merged into another branch only moved them there.
	 */
	private isMergedIntoBase(pr: PullRequest): boolean {
		return pr.state === 'merged' && pr.baseRef === this.base.name;
	}

	/** Whether `head` contains `commit`, or undefined when either is missing locally. */
	private async isAncestor(commit: string, head: string): Promise<boolean | undefined> {
		try {
			await this.git(['merge-base', '--is-ancestor', commit, head]);
			return true;
		} catch (error) {
			return (error as { code?: unknown }).code === 1 ? false : undefined;
		}
	}

	/**
	 * Commits of the merged pull requests whose heads exist locally, mapped to
	 * their pull request (computed once, only when a proof needs it).
	 */
	private mergedPullRequestCommits(): Promise<ReadonlyMap<string, PullRequest>> {
		this.pullRequestCommits ??= (async () => {
			const merged = (this.github?.pullRequests ?? []).filter((pr) => this.isMergedIntoBase(pr));
			if (merged.length === 0) {
				return new Map();
			}
			const byHead = new Map(merged.map((pr) => [pr.headSha, pr]));
			const present = lines(await this.gitRead(['rev-list', '--no-walk', '--ignore-missing', ...byHead.keys()]));
			if (present.length === 0) {
				return new Map();
			}
			// %S names the head each commit was reached from.
			const log = await this.gitRead(['log', '--format=%H %S', '--source', ...present, '--not', this.base.ref]);
			return new Map(
				lines(log).flatMap((line) => {
					const [commit, head] = line.split(' ');
					const pr = byHead.get(head);
					return pr ? [[commit, pr] as const] : [];
				})
			);
		})();
		return this.pullRequestCommits;
	}

	/**
	 * Proves `commit` belongs to a pull request merged into the default branch:
	 * its head, or behind its final head. The API only finds candidates; the
	 * final head must contain the commit, checked locally when the head is
	 * here, else with GitHub's compare API.
	 */
	async pullRequestProof(commit: string, useApi: boolean): Promise<PullRequestMatch | undefined> {
		const { github } = this;
		if (!github) {
			return undefined;
		}
		const head = github.pullRequests.find((pr) => this.isMergedIntoBase(pr) && pr.headSha === commit);
		if (head) {
			return { pullRequest: head, match: 'head' };
		}
		const contained = (await this.mergedPullRequestCommits()).get(commit);
		if (contained) {
			return { pullRequest: contained, match: 'ancestor' };
		}
		if (!useApi) {
			return undefined;
		}
		for (const pullRequest of (await github.pullRequestsOf(commit)).filter((pr) => this.isMergedIntoBase(pr))) {
			if (pullRequest.headSha === commit) {
				return { pullRequest, match: 'head' };
			}
			const local = await this.isAncestor(commit, pullRequest.headSha);
			if (local) {
				return { pullRequest, match: 'ancestor' };
			}
			if (local === undefined && (await github.contains(pullRequest.headSha, commit))) {
				return { pullRequest, match: 'api' };
			}
		}
		return undefined;
	}

	/**
	 * Keeps a `git cherry` "-" only when a base commit has exactly the same
	 * patch. Git's patch ids ignore whitespace: indenting a line into a block
	 * would pass for the same line landed with another indentation.
	 */
	async exactCherry(tip: string, cherry: ReadonlyMap<string, boolean>): Promise<Map<string, boolean>> {
		const exact = new Map([...cherry.keys()].map((commit) => [commit, false]));
		const hinted = [...cherry].filter(([, upstream]) => upstream).map(([commit]) => commit);
		if (hinted.length === 0) {
			return exact;
		}
		const own = parsePatches(await this.gitRead(['-c', 'core.quotePath=false', 'show', ...PATCH_ARGS, ...hinted]));
		const paths = [...new Set([...own.values()].flatMap((patch) => patch.paths))];
		if (paths.length === 0) {
			return exact;
		}
		const upstream = parsePatches(
			await this.gitRead(['-c', 'core.quotePath=false', '--literal-pathspecs', 'log', '--no-merges', ...PATCH_ARGS, this.base.ref, '--not', tip, '--', ...paths])
		);
		const keys = new Set([...upstream.values()].map((patch) => patch.key));
		for (const commit of hinted) {
			const patch = own.get(commit);
			exact.set(commit, patch !== undefined && keys.has(patch.key));
		}
		return exact;
	}

	/**
	 * The branch's merge commits, and whether one of them changes something
	 * neither parent has (a conflict resolution, an "evil merge"): git cherry
	 * never looks at merges, so patch ids alone would miss that work.
	 */
	async mergesOf(tip: string): Promise<{ merges: number; ownChanges: boolean }> {
		// One look at every local branch first: most repositories have no merge off the base at all.
		this.anyMerges ??= this.gitRead(['rev-list', '--merges', '--max-count=1', '--branches', '--not', this.base.ref]).then((output) => output.trim() !== '');
		if (!(await this.anyMerges)) {
			return { merges: 0, ownChanges: false };
		}
		const output = await this.gitRead([
			'log',
			'--merges',
			'--cc',
			'--format=commit %H',
			'--no-color',
			'--no-ext-diff',
			'--no-textconv',
			'--no-relative',
			'--no-show-signature',
			tip,
			'--not',
			this.base.ref,
		]);
		const headers = lines(output).filter((line) => /^commit [0-9a-f]{40,64}$/.test(line));
		return { merges: headers.length, ownChanges: lines(output).length > headers.length };
	}

	openPullRequest(commit: string): PullRequest | undefined {
		return this.github?.pullRequests.find((pr) => pr.state === 'open' && pr.headSha === commit);
	}

	/**
	 * The integration proof: every unique non-merge commit is proven on its
	 * own. A merged-in branch head (a merge parent) proven by file state or a
	 * pull request covers all its commits at once; the rest are tried one by
	 * one (file state of the commit alone, pull request). Gives up at the
	 * first commit nothing proves.
	 */
	async commitsProof(tip: string, mergeBase: string, cherry: ReadonlyMap<string, boolean>): Promise<CommitProof[] | undefined> {
		const unique = [...cherry.keys()];
		if (unique.length === 0 || unique.length > MAX_INTEGRATION_COMMITS) {
			return undefined;
		}
		const proofs = new Map<string, CommitProof>();
		for (const [commit, upstream] of cherry) {
			if (upstream) {
				proofs.set(commit, { commit, method: 'patch-id' });
			}
		}
		// Cheapest first: local pull request heads, then file state, then the GitHub API.
		const proveAlone = async (commit: string): Promise<boolean> => {
			const local = await this.pullRequestProof(commit, false);
			const squash = local ? undefined : await this.fileStateProof(`${commit}^`, commit, mergeBase);
			const pr = local ?? (squash ? undefined : await this.pullRequestProof(commit, true));
			if (squash) {
				proofs.set(commit, { commit, method: 'file-state', squashCommit: squash.squashCommit });
			} else if (pr) {
				proofs.set(commit, { commit, method: 'pull-request', pullRequest: pr.pullRequest.number });
			}
			return proofs.has(commit);
		};

		// The branch's own commits and their parents, to find merged-in heads and what each one brings.
		const parents = new Map(
			lines(await this.gitRead(['rev-list', '--parents', tip, '--not', this.base.ref])).map((line) => {
				const [commit, ...rest] = line.split(' ');
				return [commit, rest] as const;
			})
		);
		const reachable = (head: string): string[] => {
			const seen = new Set<string>();
			const pending = [head];
			for (let commit = pending.pop(); commit !== undefined; commit = pending.pop()) {
				if (!seen.has(commit) && parents.has(commit)) {
					seen.add(commit);
					pending.push(...(parents.get(commit) ?? []));
				}
			}
			return [...seen];
		};
		const heads = [...new Set([...parents.values()].filter((rest) => rest.length > 1).flat())].filter((head) => parents.has(head));
		for (const head of heads) {
			const covered = reachable(head).filter((commit) => cherry.has(commit) && !proofs.has(commit));
			if (covered.length === 0) {
				continue;
			}
			const headBase = (await this.gitRead(['merge-base', this.base.ref, head])).trim();
			const squash = await this.fileStateProof(headBase, head, mergeBase);
			const pr = squash ? undefined : await this.pullRequestProof(head, false);
			for (const commit of covered) {
				if (squash) {
					proofs.set(commit, { commit, method: 'file-state', squashCommit: squash.squashCommit });
				} else if (pr) {
					proofs.set(commit, { commit, method: 'pull-request', pullRequest: pr.pullRequest.number });
				} else if (!(await proveAlone(commit))) {
					return undefined;
				}
			}
		}
		for (const commit of unique) {
			if (!proofs.has(commit) && !(await proveAlone(commit))) {
				return undefined;
			}
		}
		return unique.map((commit) => proofs.get(commit) as CommitProof);
	}
}

/** Parses `git cherry`: each unique non-merge commit, true when a patch with the same (whitespace-blind) id is upstream ("-"). */
function parseCherry(output: string): Map<string, boolean> {
	return new Map(lines(output).map((line) => [line.slice(2), line.startsWith('-')] as const));
}

/**
 * The squash proof for a whole branch, from its merge base; or, when its
 * oldest commits are already on the base by patch id (a branch started from
 * a release branch that was later rebase-merged), from the last of them,
 * provided patch ids cover the branch's merges.
 */
async function squashProof(
	git: RunGit,
	prover: Prover,
	base: AnalysisBase,
	tip: string,
	mergeBase: string,
	cherry: ReadonlyMap<string, boolean>,
	patchIdsCover: () => Promise<boolean>
): Promise<{ squashCommit: string; files: number; patchIdCommits: number } | undefined> {
	const fromMergeBase = await prover.fileStateProof(mergeBase, tip, mergeBase);
	if (fromMergeBase) {
		return { ...fromMergeBase, patchIdCommits: 0 };
	}
	// git cherry lists the oldest commit first.
	const commits = [...cherry];
	const prefix = commits.findIndex(([, upstream]) => !upstream);
	if (prefix <= 0 || !(await patchIdsCover())) {
		return undefined;
	}
	const last = commits[prefix - 1][0];
	// Sound only if everything the prefix brings is upstream: no other commit hides behind it.
	const behind = lines((await git(['rev-list', '--no-merges', last, '--not', base.ref])).stdout);
	if (behind.some((commit) => !cherry.get(commit))) {
		return undefined;
	}
	const fromPrefix = await prover.fileStateProof(last, tip, mergeBase);
	return fromPrefix && { ...fromPrefix, patchIdCommits: prefix };
}

/** The verdict a tip earns on its own merits, whatever branch points at it. */
async function proveTip(git: RunGit, prover: Prover, tip: string, isAncestor: boolean): Promise<Verdict> {
	const { base } = prover;
	const ancestor: Evidence = { method: 'ancestor', base: base.ref };
	if (tip === base.tip) {
		return { verdict: 'dead', reason: 'empty', evidence: ancestor };
	}
	if (isAncestor) {
		return { verdict: 'dead', reason: (await prover.isOnFirstParentLine(tip)) ? 'empty' : 'merged', evidence: ancestor };
	}

	let mergeBase: string | undefined;
	try {
		mergeBase = (await git(['merge-base', base.ref, tip])).stdout.trim() || undefined;
	} catch {
		// Unrelated histories: only a pull request or a gone upstream can tell.
	}
	const cherry = mergeBase ? await prover.exactCherry(tip, parseCherry((await git(['cherry', base.ref, tip, mergeBase])).stdout)) : new Map<string, boolean>();
	const unmerged = [...cherry.values()].filter((upstream) => !upstream).length;
	// Patch ids and per-commit proofs only see non-merge commits: they hold when no merge adds work of its own.
	let merges: Promise<{ merges: number; ownChanges: boolean }> | undefined;
	const mergesOf = () => (merges ??= prover.mergesOf(tip));
	const patchIdsCover = async () => !(await mergesOf()).ownChanges;
	if (mergeBase && cherry.size > 0 && unmerged === 0 && (await patchIdsCover())) {
		return { verdict: 'dead', reason: 'rebase-merged', evidence: { method: 'patch-id', base: base.ref, commits: cherry.size } };
	}
	const squash = mergeBase ? await squashProof(git, prover, base, tip, mergeBase, cherry, patchIdsCover) : undefined;
	if (squash) {
		return { verdict: 'dead', reason: 'squash-merged', evidence: { method: 'file-state', base: base.ref, ...squash } };
	}
	const pr = await prover.pullRequestProof(tip, true);
	if (pr) {
		const { number, headSha } = pr.pullRequest;
		return { verdict: 'dead', reason: 'pr-merged', evidence: { method: 'pull-request', pullRequest: number, state: 'merged', headSha, match: pr.match } };
	}
	// A single commit is the tip itself: already tried above. The per-commit proof is costly: only for
	// integration branches (with merges) and branches partly on the base already.
	const integrates = async () => [...cherry.values()].some(Boolean) || (await mergesOf()).merges > 0;
	const proofs =
		mergeBase && cherry.size > 1 && (await integrates()) && (await patchIdsCover()) ? await prover.commitsProof(tip, mergeBase, cherry) : undefined;
	if (proofs) {
		return { verdict: 'dead', reason: 'commits-merged', evidence: { method: 'commits', base: base.ref, commits: proofs.length, proofs } };
	}
	const open = prover.openPullRequest(tip);
	if (open) {
		return {
			verdict: 'alive',
			reason: 'open-pr',
			evidence: { method: 'pull-request', pullRequest: open.number, state: 'open', headSha: open.headSha, match: 'head' },
		};
	}
	return { verdict: 'alive', reason: 'unmerged-commits', evidence: { method: 'unique-commits', base: base.ref, commits: unmerged || cherry.size } };
}

/**
 * A branch's verdict: its tip's (shared by every branch at the same commit),
 * unless it is the default branch, or its upstream is gone and nothing proves it.
 */
async function classify(prover: Prover | undefined, ref: Ref, name: string, ancestors: ReadonlySet<string>): Promise<Verdict> {
	const gone: Verdict | undefined =
		ref.track === '[gone]'
			? { verdict: 'dead', reason: 'upstream-gone', evidence: { method: 'upstream-gone', upstream: shortRef(ref.upstream) } }
			: undefined;
	if (!prover) {
		return gone ?? { verdict: 'alive', reason: 'no-base', evidence: null };
	}
	if (name === prover.base.name) {
		return { verdict: 'alive', reason: 'default-branch', evidence: null };
	}
	const verdict = await prover.verdictOf(ref.oid, ancestors.has(ref.name));
	return verdict.verdict === 'alive' && gone ? gone : verdict;
}

/** A branch whose analysis failed stays alive: no proof was found. */
function failedVerdict(error: unknown): Verdict {
	const failure = error as Error & { stderr?: string };
	const message = [failure.stderr, failure.message].flatMap((text) => text?.split('\n') ?? []).find((line) => line.trim()) ?? String(error);
	return { verdict: 'alive', reason: 'analysis-failed', evidence: { method: 'error', message: message.trim() } };
}

function shortRef(ref: string): string {
	return ref.replace(/^refs\/(heads|remotes)\//, '');
}

async function loadGitHub(
	context: AnalyzeContext,
	options: AnalyzeOptions,
	config: GitConfig,
	base: AnalysisBase | undefined
): Promise<{ signal?: GitHubSignal; check: GitHubCheck }> {
	if (options.github === false) {
		return { check: { used: false, reason: 'disabled' } };
	}
	const remote = base?.remote ?? (config.remotes.has('origin') ? 'origin' : [...config.remotes.keys()][0]);
	const url = remote === undefined ? undefined : config.remotes.get(remote);
	if (url === undefined) {
		return { check: { used: false, reason: 'no-remote' } };
	}
	const repo = parseGitHubRemote(url);
	if (!repo) {
		return { check: { used: false, reason: 'not-github', detail: url } };
	}
	if (!context.gh) {
		return { check: { used: false, reason: 'gh-missing' } };
	}
	const loaded = await loadGitHubSignal(context.gh, repo);
	if (!loaded.ok) {
		return { check: { used: false, reason: loaded.reason, ...(loaded.detail ? { detail: loaded.detail } : {}) } };
	}
	return { signal: loaded.signal, check: { used: true, repo: `${repo.owner}/${repo.name}`, pullRequests: loaded.signal.pullRequests.length, apiCalls: 0 } };
}

/**
 * Runs `git` so that it never fetches the objects a partial clone lacks:
 * `--no-lazy-fetch` (Git 2.44+, which also sets GIT_NO_LAZY_FETCH for the
 * commands Git runs in turn). Reading a missing object then fails, and the
 * branch stays alive (`analysis-failed`). Older versions have no way to stop it.
 */
async function withoutLazyFetch(git: RunGit): Promise<RunGit> {
	const version = await git(['version']).then(
		(result) => /(\d+)\.(\d+)/.exec(result.stdout),
		() => null
	);
	const [major, minor] = version ? [Number(version[1]), Number(version[2])] : [0, 0];
	return major > 2 || (major === 2 && minor >= 44) ? (args) => git(['--no-lazy-fetch', ...args]) : git;
}

/**
 * Classifies every local branch as dead (its work exists elsewhere, with the
 * proof) or alive, without writing anything to the repository. Fetching is
 * the caller's concern. GitHub is asked automatically when `gh` is available
 * and the remote is on GitHub, unless `options.github` is false.
 */
export async function analyzeBranches(context: AnalyzeContext, options: AnalyzeOptions = {}): Promise<BranchAnalysisResult> {
	const started = Date.now();
	const git = await withoutLazyFetch(context.git);
	const [refsOutput, configOutput, worktreesOutput] = await Promise.all([
		git(['for-each-ref', `--format=${REFS_FORMAT}`, 'refs/heads', 'refs/remotes']).then((result) => result.stdout),
		git(['config', '--list', '-z']).then(
			(result) => result.stdout,
			() => ''
		),
		git(['worktree', 'list', '--porcelain']).then((result) => result.stdout),
	]);
	const refs = parseRefs(refsOutput);
	const config = parseConfig(configOutput);
	const base = resolveBase(refs, config, options.base);
	const locals = [...refs.values()].filter((ref) => ref.name.startsWith('refs/heads/'));
	const nameOf = (ref: Ref) => ref.name.slice('refs/heads/'.length);
	const selected = options.branches ? locals.filter((ref) => options.branches?.some((pattern) => branchMatchesPattern(nameOf(ref), pattern))) : locals;

	const [ancestors, github] = await Promise.all([
		base
			? git(['for-each-ref', `--merged=${base.ref}`, '--format=%(refname)', 'refs/heads']).then((result) => new Set(lines(result.stdout)))
			: Promise.resolve(new Set<string>()),
		loadGitHub(context, options, config, base),
	]);
	const prover = base && new Prover(git, base, github.signal);
	// One branch failing does not fail the others.
	const verdicts = await mapWithLimit(selected, CONCURRENCY, (ref) => classify(prover, ref, nameOf(ref), ancestors).catch(failedVerdict));

	const proven = (verdict: Verdict) => verdict.verdict === 'dead' && verdict.reason !== 'upstream-gone';
	const unpushed = await mapWithLimit(selected, CONCURRENCY, async (ref, index) => {
		if (proven(verdicts[index])) {
			return 0;
		}
		try {
			return Number((await git(['rev-list', '--count', ref.oid, '--not', '--remotes', ...(base ? [base.ref] : [])])).stdout.trim());
		} catch (error) {
			verdicts[index] = failedVerdict(error);
			return 0;
		}
	});

	const worktrees = parseWorktrees(worktreesOutput);
	const worktreeOf = new Map(worktrees.filter((worktree) => worktree.branch).map((worktree) => [worktree.branch as string, worktree]));
	const dirty = new Map(
		await mapWithLimit(
			selected.flatMap((ref) => {
				const worktree = worktreeOf.get(nameOf(ref));
				return worktree && worktree.state !== 'prunable' ? [worktree.path] : [];
			}),
			CONCURRENCY,
			async (path) => {
				// No optional locks: status must not refresh and rewrite the index. Unknown counts as dirty.
				const dirty = await git(['-C', path, '--no-optional-locks', 'status', '--porcelain']).then(
					(result) => result.stdout.trim().length > 0,
					() => true
				);
				return [path, dirty] as const;
			}
		)
	);

	const patterns = [...(options.protectedPatterns ?? []), ...config.protectedPatterns];
	const protection = (name: string): Protection | null => {
		if (base && name === base.name) {
			return { by: 'default-branch' };
		}
		if (config.keepMerged.has(name)) {
			return { by: 'branch-config', key: `branch.${name}.deleteMerged` };
		}
		const pattern = patterns.find((candidate) => isProtectedBranch(name, [candidate]));
		return pattern === undefined ? null : { by: 'pattern', pattern: pattern.trim() };
	};

	const branches = selected.map((ref, index): BranchAnalysis => {
		const name = nameOf(ref);
		const worktree = worktreeOf.get(name);
		return {
			name,
			tip: ref.oid,
			current: ref.head,
			upstream: ref.upstream ? shortRef(ref.upstream) : null,
			upstreamState: !ref.upstream ? 'none' : ref.track === '[gone]' ? 'gone' : 'tracking',
			worktree: worktree
				? {
						path: worktree.path,
						isMain: worktree.state === 'main',
						dirty: dirty.get(worktree.path) ?? false,
						locked: worktree.state === 'locked',
						prunable: worktree.state === 'prunable',
					}
				: null,
			...verdicts[index],
			unpushedCommits: unpushed[index],
			protected: protection(name),
			upstreamOf: locals.filter((other) => other.upstream === ref.name).map(nameOf),
		};
	});

	const githubCheck: GitHubCheck =
		github.check.used && github.signal ? { ...github.check, apiCalls: github.signal.apiCalls() } : github.check;
	return {
		checks: { base: base ?? null, fetched: options.fetched ?? false, github: githubCheck, durationMs: Date.now() - started },
		branches,
	};
}
