import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommandResult } from './git-command';

const execFileAsync = promisify(execFile);

/**
 * Runs the GitHub CLI with `args`. Rejects like `execFile`: `code` is
 * `'ENOENT'` when `gh` is not installed, otherwise its exit code.
 */
export type RunGh = (args: readonly string[]) => Promise<CommandResult>;

/** `gh` in `cwd`, never prompting, with a timeout so an offline run cannot hang. */
export function createGhRunner(cwd: string): RunGh {
	const env = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
	return async (args) => {
		const { stdout, stderr } = await execFileAsync('gh', args, { cwd, env, timeout: 20000, maxBuffer: 32 * 1024 * 1024 });
		return { stdout, stderr };
	};
}

export type GitHubRepo = {
	readonly host: string;
	readonly owner: string;
	readonly name: string;
};

/**
 * Reads a GitHub repository out of a remote URL: HTTPS, SSH (`git@host:o/r`)
 * or `ssh://` forms. Only hosts that look like GitHub (github.com, GitHub
 * Enterprise) are accepted, so `gh` is never asked about a GitLab remote.
 */
export function parseGitHubRemote(url: string): GitHubRepo | undefined {
	const match = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/*$/i.exec(url.trim());
	if (!match) {
		return undefined;
	}
	const [, rawHost, owner, name] = match;
	const host = rawHost.toLowerCase() === 'ssh.github.com' ? 'github.com' : rawHost.toLowerCase();
	return host.includes('github') || host.endsWith('.ghe.com') ? { host, owner, name } : undefined;
}

export type PullRequestState = 'open' | 'merged' | 'closed';

export type PullRequest = {
	readonly number: number;
	readonly state: PullRequestState;
	/** Last head commit GitHub knows for the pull request. */
	readonly headSha: string;
	/** Branch it targets (or was merged into), e.g. "main". */
	readonly baseRef: string;
};

/**
 * Why the GitHub signal was not used. `too-many-open-prs`: more open pull
 * requests than gsp lists, so one of them may be missing.
 */
export type GitHubSkipReason =
	| 'disabled'
	| 'no-remote'
	| 'not-github'
	| 'gh-missing'
	| 'gh-unauthenticated'
	| 'offline'
	| 'gh-failed'
	| 'too-many-open-prs';

/** What `gh` and Go's HTTP client print when GitHub cannot be reached. */
const OFFLINE_ERROR = /error connecting to|dial tcp|no such host|network is unreachable|connection refused|i\/o timeout|TLS handshake timeout/i;

export type GitHubSignal = {
	readonly repo: GitHubRepo;
	/** The most recent pull requests, any state. */
	readonly pullRequests: readonly PullRequest[];
	/**
	 * Pull requests GitHub associates with a commit (cached; empty once the API
	 * budget is spent or on error). Only candidates: GitHub also lists pull
	 * requests whose final head no longer contains the commit.
	 */
	readonly pullRequestsOf: (sha: string) => Promise<readonly PullRequest[]>;
	/** Whether GitHub says `head` is `commit` or contains it (false once the API budget is spent or on error). */
	readonly contains: (head: string, commit: string) => Promise<boolean>;
	/** API calls made by {@link pullRequestsOf} and {@link contains} so far. */
	readonly apiCalls: () => number;
};

export type GitHubSignalResult =
	| { readonly ok: true; readonly signal: GitHubSignal }
	| { readonly ok: false; readonly reason: GitHubSkipReason; readonly detail?: string };

export type GitHubSignalOptions = {
	/** How many recent pull requests to list. */
	readonly limit?: number;
	/** Per-commit API lookups allowed in one run. */
	readonly apiBudget?: number;
};

function repoArg({ host, owner, name }: GitHubRepo): string {
	return host === 'github.com' ? `${owner}/${name}` : `${host}/${owner}/${name}`;
}

function firstLine(text: string | undefined): string | undefined {
	return text?.split('\n').find((line) => line.trim())?.trim();
}

function skipReason(error: unknown): { reason: GitHubSkipReason; detail?: string } {
	const failure = error as Error & { code?: unknown; stderr?: string; killed?: boolean };
	if (failure.code === 'ENOENT') {
		return { reason: 'gh-missing' };
	}
	const detail = firstLine(failure.stderr) ?? firstLine(failure.message);
	// Killed: the runner's timeout ran out, which only a slow or missing network explains.
	if (failure.killed || OFFLINE_ERROR.test(detail ?? '')) {
		return { reason: 'offline', detail };
	}
	// gh exits with 4 when authentication is required.
	if (failure.code === 4 || /gh auth login|not logged in|authentication/i.test(detail ?? '')) {
		return { reason: 'gh-unauthenticated', detail };
	}
	return { reason: 'gh-failed', detail };
}

type ListedPullRequest = { number: number; state: string; headRefOid: string; baseRefName: string };
type ApiPullRequest = { number: number; state: string; merged_at: string | null; head: { sha: string }; base: { ref: string } };

/**
 * Lists the repository's recent pull requests with `gh`, matched later by
 * commit SHA, never by branch name. Fails soft: a missing or unauthenticated
 * `gh`, or a network error, comes back as the reason the signal is skipped.
 * Nothing is written, locally or on GitHub.
 */
export async function loadGitHubSignal(
	runGh: RunGh,
	repo: GitHubRepo,
	{ limit = 300, apiBudget = 25 }: GitHubSignalOptions = {}
): Promise<GitHubSignalResult> {
	let listed: ListedPullRequest[];
	try {
		const { stdout } = await runGh([
			'pr',
			'list',
			'--repo',
			repoArg(repo),
			'--state',
			'all',
			'--limit',
			String(limit),
			'--json',
			'number,state,headRefOid,baseRefName',
		]);
		listed = JSON.parse(stdout) as ListedPullRequest[];
	} catch (error) {
		return { ok: false, ...skipReason(error) };
	}
	const pullRequests = listed.map(({ number, state, headRefOid, baseRefName }) => ({
		number,
		state: state.toLowerCase() as PullRequestState,
		headSha: headRefOid,
		baseRef: baseRefName,
	}));

	const cache = new Map<string, Promise<readonly PullRequest[]>>();
	let calls = 0;
	const lookUp = async (sha: string): Promise<readonly PullRequest[]> => {
		if (calls >= apiBudget) {
			return [];
		}
		calls++;
		try {
			const { stdout } = await runGh(['api', '--hostname', repo.host, `repos/${repo.owner}/${repo.name}/commits/${sha}/pulls`]);
			return (JSON.parse(stdout) as ApiPullRequest[]).map((pr) => ({
				number: pr.number,
				state: pr.merged_at ? 'merged' : (pr.state as PullRequestState),
				headSha: pr.head.sha,
				baseRef: pr.base.ref,
			}));
		} catch {
			// Unknown to GitHub (never pushed), rate limited or offline: no proof.
			return [];
		}
	};
	const contains = async (head: string, commit: string): Promise<boolean> => {
		if (calls >= apiBudget) {
			return false;
		}
		calls++;
		try {
			// `compare/<base>...<head>` is "ahead" when head contains base, "identical" when they are the same commit.
			const { stdout } = await runGh(['api', '--hostname', repo.host, `repos/${repo.owner}/${repo.name}/compare/${commit}...${head}`, '--jq', '.status']);
			return ['ahead', 'identical'].includes(stdout.trim());
		} catch {
			return false;
		}
	};
	const pullRequestsOf = (sha: string) => {
		let found = cache.get(sha);
		if (!found) {
			found = lookUp(sha);
			cache.set(sha, found);
		}
		return found;
	};
	return { ok: true, signal: { repo, pullRequests, pullRequestsOf, contains, apiCalls: () => calls } };
}

/** An open pull request, with where its head lives. */
export type OpenPullRequest = PullRequest & {
	/** Head branch name, in the head repository. */
	readonly headRef: string;
	/** Owner of the head repository, e.g. the fork's owner; null when GitHub does not say (deleted fork). */
	readonly headOwner: string | null;
	/** The repository it is open on: the one asked about, or its parent when that one is a fork. */
	readonly on: 'repo' | 'parent';
};

export type OpenPullRequestsResult =
	| { readonly ok: true; readonly pullRequests: readonly OpenPullRequest[]; readonly parent: GitHubRepo | null }
	| { readonly ok: false; readonly reason: GitHubSkipReason; readonly detail?: string };

type ListedOpenPullRequest = ListedPullRequest & { headRefName: string; headRepositoryOwner: { login: string } | null };

/**
 * Every open pull request that may use a branch of `repo`: those open on it,
 * and, when it is a fork, those open on its parent from it. All or nothing:
 * when one list fails or may be cut short (`limit` reached), the result says
 * why, as no branch can then be shown not to be the head or base of one.
 */
export async function loadOpenPullRequests(runGh: RunGh, repo: GitHubRepo, { limit = 1000 }: { limit?: number } = {}): Promise<OpenPullRequestsResult> {
	const list = async (target: GitHubRepo, on: OpenPullRequest['on']): Promise<OpenPullRequest[]> => {
		const { stdout } = await runGh([
			'pr',
			'list',
			'--repo',
			repoArg(target),
			'--state',
			'open',
			'--limit',
			String(limit),
			'--json',
			'number,state,headRefOid,headRefName,headRepositoryOwner,baseRefName',
		]);
		const listed = JSON.parse(stdout) as ListedOpenPullRequest[];
		if (listed.length >= limit) {
			throw Object.assign(new Error(`more than ${limit} open pull requests on ${repoArg(target)}`), { tooMany: true });
		}
		return listed.map((pr) => ({
			number: pr.number,
			state: 'open',
			headSha: pr.headRefOid,
			baseRef: pr.baseRefName,
			headRef: pr.headRefName,
			headOwner: pr.headRepositoryOwner?.login ?? null,
			on,
		}));
	};
	try {
		const { stdout } = await runGh(['repo', 'view', repoArg(repo), '--json', 'isFork,parent']);
		const view = JSON.parse(stdout) as { isFork: boolean; parent: { name: string; owner: { login: string } } | null };
		const parent = view.isFork && view.parent ? { host: repo.host, owner: view.parent.owner.login, name: view.parent.name } : null;
		const own = await list(repo, 'repo');
		const fromParent = parent ? (await list(parent, 'parent')).filter((pr) => pr.headOwner?.toLowerCase() === repo.owner.toLowerCase()) : [];
		return { ok: true, pullRequests: [...own, ...fromParent], parent };
	} catch (error) {
		if ((error as { tooMany?: boolean }).tooMany) {
			return { ok: false, reason: 'too-many-open-prs', detail: (error as Error).message };
		}
		return { ok: false, ...skipReason(error) };
	}
}
