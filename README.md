# Git Sweep Pro

**Safely detect and prune the local Git branches whose remote upstream is gone** — the leftovers from merged, squashed, or rebased pull requests — without ever touching your local-only work.

After a pull request is merged and its remote branch is deleted, the matching local branch lingers forever. Git Sweep Pro finds exactly those branches, shows them in a checklist you control, and deletes only what you confirm.

## Why Git Sweep Pro

- **Precise, not aggressive** — it only targets branches whose upstream tracking is *gone*. Local-only branches you never pushed are never listed.
- **You stay in control** — every candidate appears in a multi-select list; uncheck anything you want to keep, and confirm before anything is deleted.
- **Handles squash & rebase merges** — detection is based on the remote branch being gone, not on commit reachability, so branches merged via squash or rebase are still found. When a safe delete refuses them (their commits were rewritten), Git Sweep Pro offers a one-click force-delete for exactly those branches.
- **Multi-root aware** — when several open folders are Git repositories, it asks which one to operate on and remembers your choice for the session.
- **Transparent** — every git command it runs and its output is written to the `Git Sweep` output channel, so there are no surprises.

## Getting started

1. Install the extension.
2. Open a folder that is a Git repository.
3. Open the Command Palette (`Ctrl/Cmd+Shift+P`) and run **Git Sweep Pro: Sweep Stale Branches**.
4. Pick a mode, review the detected branches, uncheck any you want to keep, and confirm.

Prefer to look before you leap? Run **Git Sweep Pro: Preview Stale Branches (Dry Run)** first — it reports what *would* be deleted without changing anything.

## Commands

All commands are available from the Command Palette under the **Git Sweep Pro** category.

| Command | ID | What it does |
| --- | --- | --- |
| **Sweep Stale Branches** | `git-sweep-pro.run` | Prompts for a mode (safe delete `-d`, force delete `-D`, or dry run), then shows stale branches in a multi-select list with everything pre-selected. |
| **Preview Stale Branches (Dry Run)** | `git-sweep-pro.dryRun` | Runs the dry-run flow directly: logs what would be deleted without deleting anything. |
| **Post Pull Request Cleanup** | `git-sweep-pro.postPullRequest` | Checkout a local or remote branch, then delete the previous branch, prune, run the sweep, and pull. |
| **Sync Branch With Upstream** | `git-sweep-pro.syncWithUpstream` | Keeps your feature branch up to date with a base branch (`main`, `develop`, …): stashes local changes, pulls the base, rebases the current branch onto it, force-pushes with `--force-with-lease`, then restores the stash. Pauses on rebase conflicts. |
| **Resume Sync With Upstream** | `git-sweep-pro.syncWithUpstreamResume` | Resumes a paused sync after you resolve rebase conflicts, or retries a failed force-push and finishes the cleanup. |

## Safety model

Git Sweep Pro is built to make destructive operations feel trustworthy. It never deletes a branch you didn't approve.

- **Only "gone upstream" branches are candidates.** Detection uses structured `git for-each-ref` output (stable across Git versions and locales) to find local branches whose remote tracking reference no longer exists. Branches without an upstream are never touched.
- **Safe delete by default.** The default mode uses `git branch -d`, which Git itself refuses to run on branches with unmerged commits. Force delete (`git branch -D`) is opt-in per run, and is offered as a follow-up only for the specific branches a safe delete rejected.
- **You confirm before deletion.** A confirmation dialog is shown before branches are removed (configurable via `gitSweepPro.confirmBeforeDelete`).
- **Protected branches can never be deleted.** Configure glob patterns in `gitSweepPro.protectedBranches` to guarantee branches like `main`, `develop`, or `release/*` are excluded from every sweep.
- **Nothing is hidden.** Every executed command and its result is written to the `Git Sweep` output channel.

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `gitSweepPro.defaultMode` | `dryRun` \| `safeDelete` \| `forceDelete` | `safeDelete` | Execution mode presented first in the **Sweep Stale Branches** mode picker. |
| `gitSweepPro.protectedBranches` | `string[]` | `[]` | Glob patterns for branches that must never be deleted (e.g. `main`, `develop`, `release/*`). `*` matches any characters, `?` matches a single character. |
| `gitSweepPro.autoFetchPrune` | `boolean` | `true` | Run `git fetch -p` before detecting stale branches. Disable to operate on the local ref state only. |
| `gitSweepPro.confirmBeforeDelete` | `boolean` | `true` | Show a confirmation dialog before deleting the selected branches. |

## Requirements

- Git must be installed and available on your `PATH`.
- The open workspace folder must be a Git repository.

## Troubleshooting

**"Not a Git repository" (or similar).**
Open a folder that contains a `.git` directory. In a multi-root workspace, make sure at least one open folder is a Git repository — Git Sweep Pro will prompt you to choose which one to operate on.

**No branches are found even though I expect some.**
A branch is only a candidate when its upstream tracking reference is *gone*. Check that:

- the branch was actually pushed and its remote branch has since been deleted;
- `gitSweepPro.autoFetchPrune` is enabled (default) so stale remote refs are pruned first — or run `git fetch -p` manually;
- the branch isn't excluded by a `gitSweepPro.protectedBranches` pattern.

**A branch won't delete with safe delete.**
`git branch -d` refuses branches with commits that aren't merged into the current history — common after a squash or rebase merge. Git Sweep Pro detects this and offers a one-click force-delete (`git branch -D`) for exactly those branches. You can also set `gitSweepPro.defaultMode` to `forceDelete`.

**Sync With Upstream paused on conflicts.**
Resolve the rebase conflicts in your working tree, then run **Git Sweep Pro: Resume Sync With Upstream** to continue the rebase, force-push, and restore your stash.

**I want to see exactly what happened.**
Open the **Git Sweep** output channel (View → Output → *Git Sweep*). Every git command and its output is logged there.

## License

Released under the [GNU GPL v3.0](./LICENCE).
