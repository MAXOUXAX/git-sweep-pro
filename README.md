# Git Sweep Pro

Safely identify and prune local branches that are gone on the remote.

## What it does

- Runs `git fetch -p` to prune stale remote refs.
- Detects local tracked branches whose upstream is missing, using structured `git for-each-ref` output (stable across Git versions and locales).
- Protects local-only work by only targeting branches with gone upstream tracking.
- Handles **squash and rebase merges**: because detection is based on the remote branch being gone (not commit reachability), such branches are still found. When a safe `git branch -d` refuses them (their commits were rewritten), Git Sweep Pro offers a one-click force-delete for exactly those branches.
- Lets you choose safe deletion (`git branch -d`) or force deletion (`git branch -D`).
- Supports dry-run mode (logs what would be deleted, without deleting).

## Commands

- `Git Sweep Pro: Run` (`git-sweep-pro.run`)
	- Prompts for mode:
		- Delete (safe `-d`)
		- Delete (force `-D`)
		- Dry Run
	- Shows stale branches in a multi-select list with all branches pre-selected.

- `Git Sweep Pro: Dry Run` (`git-sweep-pro.dryRun`)
	- Runs the dry-run flow directly.

- `Git Sweep Pro: Post Pull Request` (`git-sweep-pro.postPullRequest`)
	- Shows local and remote branches to checkout.
	- After checkout: deletes the previous branch, prunes, runs the main sweep, then pulls.

- `Git Sweep Pro: Sync With Upstream` (`git-sweep-pro.syncWithUpstream`)
	- Keeps your feature branch up to date with a base branch (`main`, `develop`, etc.).
	- Stashes local changes, pulls the selected branch, rebases the current branch onto it, force-pushes (`--force-with-lease`), then restores the stash.
	- On rebase conflicts, the flow pauses; resolve them and run `Sync With Upstream (Resume)` to continue.

- `Git Sweep Pro: Sync With Upstream (Resume)` (`git-sweep-pro.syncWithUpstreamResume`)
	- Resumes a paused sync: after you resolved rebase conflicts (continues the rebase, force-pushes, restores the stash), or after a failed force-push (retries the push and finishes the cleanup).

## UX and logging

- Uses a progress notification while fetching and pruning remotes.
- Uses multi-select quick pick so you can uncheck any branches you want to keep.
- Writes all executed git commands and results to the `Git Sweep` output channel.
- Shows clear success and error notifications when finished.

## Settings

- `gitSweepPro.defaultMode` (`safeDelete` | `forceDelete` | `dryRun`, default `safeDelete`)
	- Execution mode presented first in the `Run` command's mode picker.
- `gitSweepPro.protectedBranches` (string[], default `[]`)
	- Glob patterns for branches that must never be deleted (e.g. `main`, `develop`, `release/*`). `*` matches any characters and `?` matches a single character.
- `gitSweepPro.autoFetchPrune` (boolean, default `true`)
	- Run `git fetch -p` before detecting stale branches. Disable to operate on the local ref state only.
- `gitSweepPro.confirmBeforeDelete` (boolean, default `true`)
	- Show a confirmation dialog before deleting the selected branches.

## Requirements

- Git must be installed and available in `PATH`.
- Open a workspace folder that is a Git repository.

## Notes

- If no stale tracked branches are found, the extension exits cleanly.
- If the workspace is not a Git repository, the extension reports a friendly error.
