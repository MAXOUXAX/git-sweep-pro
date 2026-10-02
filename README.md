# Git Sweep Pro

**Safely detect and prune the local Git branches whose remote upstream is gone** — the leftovers from merged, squashed, or rebased pull requests — without ever touching your local-only work.

After a pull request is merged and its remote branch is deleted, the matching local branch lingers forever. Git Sweep Pro finds exactly those branches, shows them in a checklist you control, and deletes only what you confirm.

## Why Git Sweep Pro

- **Precise, not aggressive** — it only targets branches whose upstream tracking is *gone*. Local-only branches you never pushed are never listed.
- **You stay in control** — every candidate appears in a multi-select list with quick actions to select all, clear all, or invert your selection; before anything is deleted you get a summary (detected, selected, mode) and a confirmation.
- **Clear outcomes** — after a run you see exactly how many branches were deleted, skipped, and failed.
- **Finds merged branches too (opt-in)** — with `gitSweepPro.includeMergedBranches` (`--merged`), local branches whose work already landed on the default branch are offered as well, even if they were never pushed. Squash merges are recognized by comparing the branch's combined patch with the default branch's history.
- **Handles squash & rebase merges** — detection is based on the remote branch being gone, not on commit reachability, so branches merged via squash or rebase are still found. When a safe delete refuses them (their commits were rewritten), Git Sweep Pro offers a one-click force-delete for exactly those branches.
- **Worktree aware** — branches checked out in another `git worktree` are shown with their worktree and left unselected; picking one removes that worktree first (only if it has no uncommitted changes). Worktrees whose folder was deleted are pruned automatically.
- **Multi-root aware** — when several open folders are Git repositories, it asks which one to operate on and remembers your choice for the session.
- **Transparent** — every git command it runs and its output is written to the `Git Sweep` output channel, so there are no surprises.
- **Scriptable** — the same engine is available as the `git sweep-pro` command line, with safe defaults for unattended runs.

## Getting started

1. Install the extension.
2. Open a folder that is a Git repository.
3. Open the Command Palette (`Ctrl/Cmd+Shift+P`) and run **Git Sweep Pro: Sweep Stale Branches**.
4. Pick a mode, review the detected branches (use the title-bar actions to select all, clear, or invert), review the summary, and confirm.

Prefer to look before you leap? Run **Git Sweep Pro: Preview Stale Branches (Dry Run)** first — it reports what *would* be deleted without changing anything.

## Commands

All commands are available from the Command Palette under the **Git Sweep Pro** category.

| Command | ID | What it does |
| --- | --- | --- |
| **Sweep Stale Branches** | `git-sweep-pro.run` | Prompts for a mode (safe delete `-d`, force delete `-D`, or dry run), then shows stale branches in a multi-select list (everything pre-selected) with quick actions to select all, clear all, or invert. Shows a summary before deleting and a deleted/skipped/failed breakdown after. |
| **Preview Stale Branches (Dry Run)** | `git-sweep-pro.dryRun` | Runs the dry-run flow directly: logs what would be deleted without deleting anything. |
| **Post Pull Request Cleanup** | `git-sweep-pro.postPullRequest` | Checkout a local or remote branch, then delete the previous branch, prune, run the sweep, and pull. |
| **Sync Branch With Upstream** | `git-sweep-pro.syncWithUpstream` | Keeps your feature branch up to date with a base branch (`main`, `develop`, …): stashes local changes, pulls the base, rebases the current branch onto it, force-pushes with `--force-with-lease`, then restores the stash. Pauses on rebase conflicts. |
| **Resume Sync With Upstream** | `git-sweep-pro.syncWithUpstreamResume` | Resumes a paused sync after you resolve rebase conflicts, or retries a failed force-push and finishes the cleanup. |
| **Restore Deleted Branches** | `git-sweep-pro.restore` | Undo: pick among the branches Git Sweep Pro deleted, and recreate them at the commit they pointed to. |

## Command line

The extension ships a `git-sweep-pro` command line, and every editor command runs through it: the extension starts the CLI and renders its prompts with VS Code pickers and dialogs. What you can do in the editor, you can do in a terminal or a script.

In VS Code's integrated terminals it is on the `PATH` automatically (setting `gitSweepPro.cli.addToTerminalPath`) and runs on VS Code's own runtime, so Node.js is not required. Because the executable is named `git-sweep-pro`, Git also exposes it as a subcommand:

```sh
git sweep-pro                 # detect, pick, confirm and delete stale branches
git sweep-pro --dry-run       # show what would be deleted
git sweep-pro --merged        # also offer branches already (squash-)merged into main
git sweep-pro list --json     # machine-readable list, nothing is deleted
git sweep-pro -y -p 'release/*'   # non-interactive, with a protected pattern
git sweep-pro post-pr main    # after a merged PR: switch to main, clean up, pull
git sweep-pro sync origin/main    # rebase onto origin/main and force-push (with lease)
git sweep-pro sync --continue     # resume after resolving rebase conflicts
git sweep-pro restore feature/x   # undo: recreate a branch deleted by git-sweep-pro
git sweep-pro restore --json      # list the deletions that can be restored
```

Outside VS Code, run it with Node.js (`node <extension dir>/dist/cli/main.js`) or install it from a checkout of this repository with `npm install -g`.

Without a terminal attached (CI, scripts), prompts keep their defaults and confirmations are **refused** unless `--yes` is passed, so an unattended run never deletes anything by surprise. Protected patterns can also be stored per repository with `git config --add git-sweep-pro.protected 'release/*'`.

| Exit code | Meaning |
| --- | --- |
| `0` | Success (including "nothing to do" and a declined confirmation) |
| `1` | A step failed; details are on stderr |
| `2` | Invalid arguments |
| `3` | `sync` or `resume` stopped on rebase conflicts; resolve them and run `sync --continue` |

Run `git sweep-pro --help` for every option. A sync paused on conflicts is recorded in the repository's Git directory, so it can be resumed from either the terminal or the editor.

## Worktrees

Git Sweep Pro understands [`git worktree`](https://git-scm.com/docs/git-worktree):

- **Sweep** never tries to delete the branch checked out in the worktree you run it from, or in the main worktree; it tells you which stale branches it skipped for that reason. Stale branches checked out in *other* worktrees are listed with their location but not pre-selected; selecting one runs `git worktree remove` (which refuses if the worktree has uncommitted changes or is locked) before deleting the branch. `--yes` never selects them for you.
- **`list`** shows the worktree of each stale branch, and marks the stale branches that are checked out here or in the main worktree. With `--json`, `worktrees` maps each branch to its worktree path, and `checkedOut` lists the branches that a sweep from here skips.
- Worktrees whose directory was deleted are pruned (`git worktree prune`) along with `git fetch -p`, so their branches become sweepable again.
- **Post Pull Request Cleanup** in a linked worktree: when the branch to switch to (typically `main`) is checked out in another worktree, it switches to a detached HEAD at the same commit instead, then deletes the merged branch and sweeps.
- **Restore Deleted Branches** recreates a branch whose worktree a sweep removed, and prints the `git worktree add` command that recreates the worktree.
- **Sync With Upstream** can rebase onto a local branch checked out in another worktree (it is used as is, without pulling; pick its remote branch for the latest version). A paused sync is tracked per worktree.

## Safety model

Git Sweep Pro is built to make destructive operations feel trustworthy. It never deletes a branch you didn't approve.

- **Only "gone upstream" branches are pre-selected.** Detection uses structured `git for-each-ref` output (stable across Git versions and locales) to find local branches whose remote tracking reference no longer exists. Branches without an upstream are only offered when `gitSweepPro.includeMergedBranches` is enabled and their work is already on the default branch, and even then you must select them yourself.
- **Safe delete by default.** The default mode uses `git branch -d`, which Git itself refuses to run on branches with unmerged commits. Force delete (`git branch -D`) is opt-in per run, and is offered as a follow-up only for the specific branches a safe delete rejected.
- **You confirm before deletion.** A confirmation dialog is shown before branches are removed (configurable via `gitSweepPro.confirmBeforeDelete`).
- **Protected branches can never be deleted.** Configure glob patterns in `gitSweepPro.protectedBranches` to guarantee branches like `main`, `develop`, or `release/*` are excluded from every sweep.
- **Deletions can be undone.** Every branch Git Sweep Pro deletes is recorded (name, commit and upstream) in the repository's Git directory, shared by all its worktrees. **Restore Deleted Branches** (`git sweep-pro restore`) recreates them, as long as Git has not garbage-collected their commits (by default two weeks after they became unreachable). Restore never overwrites a branch whose name is in use again, and tracks the upstream again only if it still exists. The 100 most recent deletions are kept.
- **Nothing is hidden.** Every executed command and its result is written to the `Git Sweep` output channel.

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `gitSweepPro.defaultMode` | `dryRun` \| `safeDelete` \| `forceDelete` | `safeDelete` | Execution mode presented first in the **Sweep Stale Branches** mode picker. |
| `gitSweepPro.protectedBranches` | `string[]` | `[]` | Glob patterns for branches that must never be deleted (e.g. `main`, `develop`, `release/*`). `*` matches any characters, `?` matches a single character. |
| `gitSweepPro.autoFetchPrune` | `boolean` | `true` | Run `git fetch -p` before detecting stale branches. Disable to operate on the local ref state only. |
| `gitSweepPro.confirmBeforeDelete` | `boolean` | `true` | Show a confirmation dialog before deleting the selected branches. |
| `gitSweepPro.includeMergedBranches` | `boolean` | `false` | Also offer local branches already merged — including rebase- and squash-merged — into the remote default branch even though their upstream is not gone (never pushed, or remote branch kept). Listed but never pre-selected. CLI: `--merged`. |
| `gitSweepPro.cli.addToTerminalPath` | `boolean` | `true` | Put the bundled `git-sweep-pro` CLI (also `git sweep-pro`) on the `PATH` of integrated terminals. |

## Requirements

- Git 2.23 or newer must be installed and available on your `PATH`.
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
