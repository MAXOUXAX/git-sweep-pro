import { runSyncFlow } from './sync-with-upstream-sync-flow';
import type { SyncWithUpstreamDeps } from './sync-with-upstream-state';

export type PostPullRequestDeps = SyncWithUpstreamDeps;

/**
 * Returns the default branch name (e.g. "main") from the first remote's HEAD ref, or undefined.
 * Discovers the remote dynamically via refs/remotes/<remote>/HEAD; does not assume "origin".
 */
async function getDefaultBranchName(runGit: (args: string[]) => Promise<{ stdout: string; stderr: string }>): Promise<string | undefined> {
	try {
		const list = await runGit(['for-each-ref', '--format=%(refname)', 'refs/remotes/*/HEAD']);
		const firstRef = list.stdout.trim().split(/\r?\n/)[0];
		if (!firstRef) {
			return undefined;
		}
		const match = firstRef.match(/^refs\/remotes\/([^/]+)\/HEAD$/);
		if (!match) {
			return undefined;
		}
		const remoteName = match[1];
		const r = await runGit(['rev-parse', '--abbrev-ref', firstRef]);
		const out = r.stdout.trim();
		const prefix = `${remoteName}/`;
		return out.startsWith(prefix) ? out.slice(prefix.length) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Post Pull Request: after merging the current branch into another one (e.g. dev → main),
 * keep the current branch and bring it up to date by rebasing it onto the selected branch
 * and force-pushing it. It does NOT delete the current branch.
 *
 * The heavy lifting (pull the target, stash, rebase, conflict resume, --force-with-lease)
 * is delegated to the Sync With Upstream flow; this command just pre-selects the default
 * branch as the rebase target and uses post-PR wording.
 */
export async function runPostPullRequestWorkflow(deps: PostPullRequestDeps): Promise<void> {
	const workspaceRoot = deps.getWorkspaceRoot();
	const defaultBranch = workspaceRoot
		? await getDefaultBranchName((args) => deps.runGitCommand(args, workspaceRoot))
		: undefined;

	await runSyncFlow(deps, {
		preselectBranch: defaultBranch,
		pickBranchTitle: 'Post Pull Request: Branch to rebase onto',
		pickBranchPlaceholder: defaultBranch
			? `Rebase the current branch onto ${defaultBranch}, then force-push`
			: 'Rebase the current branch onto the selected branch, then force-push',
	});
}
