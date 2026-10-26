import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommandResult, RunGit } from './git-command';
import type { GitHubRepo, RunGh } from './github-signal';

const execFileAsync = promisify(execFile);

/** Runs `ssh` with `args`; rejects like `execFile`. */
export type RunSsh = (args: readonly string[]) => Promise<CommandResult>;

/** `ssh`, with a short timeout: `ssh -G` only reads the configuration, it never connects. */
export function createSshRunner(): RunSsh {
	return async (args) => {
		const { stdout, stderr } = await execFileAsync('ssh', args, { timeout: 5000, maxBuffer: 1024 * 1024 });
		return { stdout, stderr };
	};
}

/** `git config git-sweep-pro.forge`: `github` says the remotes are on GitHub, `none` that they are not. */
export type ForgeSetting = 'github' | 'none';

/** Hosts known not to be GitHub: their pull requests are never looked for. */
const OTHER_FORGES = new Set(['gitlab.com', 'bitbucket.org']);

/**
 * Where a remote lives: on GitHub (`repo`), somewhere known not to be GitHub
 * (a local path, `file://`, GitLab, Bitbucket, or `git-sweep-pro.forge none`),
 * or on a `host` nothing tells apart.
 */
export type Forge =
	| { readonly kind: 'github'; readonly repo: GitHubRepo }
	| { readonly kind: 'other' }
	| { readonly kind: 'unknown'; readonly host: string };

export type RemoteUrl =
	| { readonly local: true }
	| { readonly local: false; readonly host: string; readonly ssh: boolean; readonly owner?: string; readonly name?: string };

/**
 * Reads a remote URL: `scheme://[user@]host[:port]/path`, the SSH form
 * `[user@]host:path`, or else a local path. `owner` and `name` are the last
 * two segments of the path, without `.git`.
 */
export function parseRemoteUrl(url: string): RemoteUrl {
	const trimmed = url.trim();
	const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:]*)(?::\d*)?(\/.*)?$/i.exec(trimmed);
	// A one-letter "host" is a Windows drive: C:\repo.
	const scp = scheme ? null : /^(?:[^@/:]+@)?([^/:]{2,}):(?!\/\/)(.*)$/.exec(trimmed);
	if (scheme?.[1].toLowerCase() === 'file' || (!scheme && !scp) || (scheme && !scheme[2])) {
		return { local: true };
	}
	const [host, path, ssh] = scheme ? [scheme[2], scheme[3] ?? '', /ssh/i.test(scheme[1])] : [scp![1], scp![2], true];
	const segments = path.replace(/\.git\/*$|\/+$/g, '').split('/').filter(Boolean);
	const [owner, name] = segments.length >= 2 ? segments.slice(-2) : [];
	return { local: false, host: host.toLowerCase(), ssh, ...(owner && name ? { owner, name } : {}) };
}

/** The `hostname` that `ssh -G` resolved an alias to. */
export function parseSshHostname(output: string): string | undefined {
	const line = output.split('\n').find((candidate) => /^hostname\s/i.test(candidate));
	return line?.slice('hostname'.length).trim().toLowerCase() || undefined;
}

const isGitHubHost = (host: string) => host.includes('github') || host.endsWith('.ghe.com');

/** Whether `gh` is logged in to `host`, which then is a GitHub server. */
async function ghLoggedIn(gh: RunGh, host: string): Promise<boolean> {
	try {
		const { stdout } = await gh(['auth', 'status', '--hostname', host, '--json', 'hosts']);
		const hosts = (JSON.parse(stdout) as { hosts?: Record<string, { state?: string }[]> }).hosts ?? {};
		return (hosts[host] ?? []).some((account) => account.state === 'success');
	} catch {
		return false;
	}
}

type ForgeContext = { readonly git: RunGit; readonly gh?: RunGh; readonly ssh?: RunSsh };

async function forgeOfUrl({ gh, ssh }: ForgeContext, url: string, setting: ForgeSetting | undefined): Promise<Forge> {
	const parsed = parseRemoteUrl(url);
	if (parsed.local) {
		return { kind: 'other' };
	}
	let host = parsed.host;
	if (parsed.ssh && ssh && !host.startsWith('-')) {
		// An alias from ~/.ssh/config ("git@work:org/repo"): unresolved, the alias stays the host.
		host = await ssh(['-G', host]).then(
			({ stdout }) => parseSshHostname(stdout) ?? host,
			() => host
		);
	}
	if (host === 'ssh.github.com') {
		host = 'github.com';
	}
	const repo = parsed.owner && parsed.name ? { host, owner: parsed.owner, name: parsed.name } : undefined;
	if (setting === 'github' || isGitHubHost(host)) {
		return repo ? { kind: 'github', repo } : { kind: 'unknown', host };
	}
	if (OTHER_FORGES.has(host)) {
		return { kind: 'other' };
	}
	return repo && gh && (await ghLoggedIn(gh, host)) ? { kind: 'github', repo } : { kind: 'unknown', host };
}

/**
 * Tells whether `remote` is on GitHub. Its URL is read as configured and as
 * Git uses it (`insteadOf` applied); an SSH host goes through `ssh -G`, so an
 * alias resolves to the server's name. It is on GitHub when either URL is,
 * whether by name (github.com, GitHub Enterprise) or because `gh` is logged
 * in to its host; it is elsewhere only when both are known to be.
 */
export async function identifyForge(context: ForgeContext, remote: string, configuredUrl: string | undefined, setting?: ForgeSetting): Promise<Forge> {
	if (setting === 'none') {
		return { kind: 'other' };
	}
	const used = await context.git(['remote', 'get-url', remote]).then(
		({ stdout }) => stdout.trim(),
		() => ''
	);
	const urls = [...new Set([configuredUrl, used].filter((url): url is string => Boolean(url)))];
	const forges = await Promise.all(urls.map((url) => forgeOfUrl(context, url, setting)));
	return forges.find((forge) => forge.kind === 'github') ?? forges.find((forge) => forge.kind === 'unknown') ?? { kind: 'other' };
}
