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
};

/** Why the GitHub signal was not used. */
export type GitHubSkipReason = 'disabled' | 'no-remote' | 'not-github' | 'gh-missing' | 'gh-unauthenticated' | 'gh-failed';

export type GitHubSignal = {
	readonly repo: GitHubRepo;
	/** The most recent pull requests, any state. */
	readonly pullRequests: readonly PullRequest[];
	/** Pull requests GitHub associates with a commit (cached; empty once the API budget is spent or on error). */
	readonly pullRequestsOf: (sha: string) => Promise<readonly PullRequest[]>;
	/** API calls made by {@link pullRequestsOf} so far. */
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
	const failure = error as Error & { code?: unknown; stderr?: string };
	if (failure.code === 'ENOENT') {
		return { reason: 'gh-missing' };
	}
	const detail = firstLine(failure.stderr) ?? firstLine(failure.message);
	// gh exits with 4 when authentication is required.
	if (failure.code === 4 || /gh auth login|not logged in|authentication/i.test(detail ?? '')) {
		return { reason: 'gh-unauthenticated', detail };
	}
	return { reason: 'gh-failed', detail };
}

type ListedPullRequest = { number: number; state: string; headRefOid: string };
type ApiPullRequest = { number: number; state: string; merged_at: string | null; head: { sha: string } };

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
			'number,state,headRefOid',
		]);
		listed = JSON.parse(stdout) as ListedPullRequest[];
	} catch (error) {
		return { ok: false, ...skipReason(error) };
	}
	const pullRequests = listed.map(({ number, state, headRefOid }) => ({
		number,
		state: state.toLowerCase() as PullRequestState,
		headSha: headRefOid,
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
			}));
		} catch {
			// Unknown to GitHub (never pushed), rate limited or offline: no proof.
			return [];
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
	return { ok: true, signal: { repo, pullRequests, pullRequestsOf, apiCalls: () => calls } };
}
