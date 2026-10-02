# Git Sweep Pro

Delete the local branches you no longer need, safely. `gsp` finds the branches whose remote branch is gone (merged, squashed or rebased pull requests), lets you pick, and deletes only what you confirm. Every deletion can be undone.

It is a command line for you and your coding agents, and a VS Code extension.

## Install

**Terminal** (macOS and Linux, needs Node.js, which Homebrew installs):

```sh
brew tap maxouxax/git-sweep-pro https://github.com/MAXOUXAX/git-sweep-pro
brew install git-sweep-pro
```

**VS Code**: install [Git Sweep Pro](https://marketplace.visualstudio.com/items?itemName=MAXOUXAX.git-sweep-pro) from the Marketplace or [Open VSX](https://open-vsx.org/extension/MAXOUXAX/git-sweep-pro). Its integrated terminals get `gsp` too, running on VS Code's own runtime.

The CLI also answers to `git-sweep-pro` and `git sweep-pro`.

## Use

```sh
gsp                     # pick stale branches, confirm, delete
gsp --dry-run           # show what would be deleted
gsp --merged            # also offer branches already merged into main, even squash-merged
gsp list --json         # what a sweep would offer, for scripts
gsp post-pr main        # after a merged PR: switch to main, delete the old branch, sweep, pull
gsp sync origin/main    # rebase onto origin/main, then force-push with a lease
gsp resume              # continue a sync after resolving its conflicts
gsp restore feature/x   # undo: recreate a deleted branch at its last commit
```

`gsp help` lists every command and option.

## With coding agents

Codex, Claude Code, Cursor, GitHub Copilot and OpenCode can clean up the workspace for you. Tell them `gsp` exists:

```sh
gsp agents
```

It asks which instruction files to update, `AGENTS.md` (Codex, Cursor, GitHub Copilot, OpenCode) and/or `CLAUDE.md` (Claude Code), and adds this note:

```md
<!-- BEGIN:git-sweep-pro -->
## Git cleanup

Use the `gsp` CLI to clean up the Git workspace. Run `gsp help` to see its commands.
<!-- END:git-sweep-pro -->
```

Running it again updates the note in place and leaves the rest of the file alone. `gsp agents AGENTS.md CLAUDE.md` skips the question.

Without a terminal, as when an agent runs it, every prompt takes its safe default and confirmations are refused unless `--yes` is passed. `gsp --yes` deletes the pre-selected stale branches only. Exit codes: `0` done, `1` failed, `2` invalid arguments, `3` sync paused on conflicts.

## Safety

- **Only gone branches are pre-selected.** Other branches are offered only with `--merged`, when their work is already on the default branch, and you select them yourself.
- **Safe delete first.** `git branch -d` refuses unmerged work. Force delete (`-D`) is opt-in, or offered afterward for exactly the branches a squash or rebase merge left behind.
- **Protected branches are never deleted:** `--protect 'release/*'`, `git config --add git-sweep-pro.protected 'release/*'`, or the `gitSweepPro.protectedBranches` setting.
- **Deletions can be undone.** `gsp restore` recreates any of the last 100 deleted branches, tracking its upstream again if it still exists, until Git garbage-collects its commits (two weeks by default).
- **Worktree aware.** Branches checked out in another worktree are never pre-selected; selecting one removes its worktree first, and only if it has no uncommitted changes.

## In VS Code

Every command runs the same CLI, rendered with VS Code pickers and dialogs. Open the Command Palette and type **Git Sweep Pro**:

| Command | Does |
| --- | --- |
| Sweep Stale Branches | Pick a mode, pick branches, confirm |
| Preview Stale Branches (Dry Run) | Show what would be deleted |
| Post Pull Request Cleanup | `gsp post-pr` |
| Sync Branch With Upstream / Resume Sync With Upstream | `gsp sync` / `gsp resume` |
| Restore Deleted Branches | `gsp restore` |
| Add Instructions for Coding Agents | `gsp agents` |

| Setting | Default | |
| --- | --- | --- |
| `gitSweepPro.defaultMode` | `safeDelete` | Mode offered first: `dryRun`, `safeDelete` or `forceDelete` |
| `gitSweepPro.protectedBranches` | `[]` | Globs never deleted (`*` and `?`) |
| `gitSweepPro.autoFetchPrune` | `true` | Run `git fetch -p` first |
| `gitSweepPro.confirmBeforeDelete` | `true` | Ask before deleting |
| `gitSweepPro.includeMergedBranches` | `false` | Also offer merged branches (`--merged`) |
| `gitSweepPro.cli.addToTerminalPath` | `true` | Put `gsp` on the integrated terminals' `PATH` |

Every git command and its output goes to the **Git Sweep** output channel.

Requires VS Code 1.92 or newer, and Git 2.23 or newer.

## License

[GNU GPL v3.0](./LICENCE)
