# Git Sweep Pro

Safely identify and prune local branches that are gone on the remote.

## What it does

- Runs `git fetch -p` to prune stale remote refs.
- Detects local tracked branches whose upstream is missing (`: gone]` in `git branch -vv`).
- Protects local-only work by only targeting branches with gone upstream tracking.
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
	- After merging your branch into another one (e.g. `dev` → `main`), keeps the current branch and brings it up to date: rebases it onto the selected branch (after pulling that branch) and force-pushes it.
	- Pre-selects the default branch as the rebase target. Never deletes the current branch.
	- On rebase conflicts, resolve them and run `Sync With Upstream (Resume)` to continue. To delete stale branches, use the Sweep commands.

## UX and logging

- Uses a progress notification while fetching and pruning remotes.
- Uses multi-select quick pick so you can uncheck any branches you want to keep.
- Writes all executed git commands and results to the `Git Sweep` output channel.
- Shows clear success and error notifications when finished.

## Requirements

- Git must be installed and available in `PATH`.
- Open a workspace folder that is a Git repository.

## Notes

- If no stale tracked branches are found, the extension exits cleanly.
- If the workspace is not a Git repository, the extension reports a friendly error.
