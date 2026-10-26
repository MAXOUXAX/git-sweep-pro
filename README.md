# Git Sweep Pro

Delete the local branches whose work is already merged or pushed, and the worktrees they leave behind. `gsp` proves each branch is safe to delete (merged, squash- or rebase-merged, the head of a merged pull request, or every commit on a remote) and keeps everything else. Every deletion can be undone.

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
gsp clean --dry-run     # see the plan, change nothing
gsp clean               # pick the branches to delete, in a terminal
gsp clean --yes         # delete every branch proven merged
gsp clean feature/x --yes            # delete one branch, if proven merged
gsp clean feature/x --yes --force    # delete a branch with unpushed work
gsp clean --json        # the plan as JSON, for scripts and agents
gsp worktree list       # every worktree, its branch and its state
gsp worktree prune      # forget worktree registrations whose directory is gone
gsp worktree remove <path|branch>   # remove one linked worktree
gsp post-pr main        # after a merged PR: switch to main, delete the old branch, clean, pull
gsp sync origin/main    # rebase onto origin/main, then force-push with a lease
gsp resume              # continue a sync after resolving its conflicts
gsp restore feature/x   # undo: recreate a deleted branch at its last commit
```

`gsp` alone runs `gsp clean`. `gsp sweep` is an alias of `gsp clean`, and `gsp list` of `gsp clean --dry-run`. `gsp help` lists every command, and `gsp <command> --help` shows the options of one.

`gsp clean` takes branch names or globs (`gsp clean 'feature/*'`): only those branches are considered. A name that matches no local branch is an error (exit code 2).

### Plan, then apply

Without a terminal, `gsp clean` prints the plan and changes nothing unless you pass `--yes`. In a terminal, it shows a picker with every planned deletion selected; branches that need `--force` are listed but not selected. `--dry-run` always plans only.

Planning is read-only: no fetch, no prune, no change to refs, objects, config or worktrees. To find the branches deleted on the remote, it reads `git ls-remote --heads`. With `--no-fetch`, or when the remote cannot be reached, it uses the local remote-tracking refs, and the JSON says so in `checks.remote`.

Applying runs `git fetch --prune` first (skipped with `--no-fetch`), forgets worktree registrations whose directory is gone, analyses the branches again, then deletes.

### What gets deleted

`--yes` deletes a branch only with proof that its work exists elsewhere:

- it is merged into the default branch, or points at a commit already on it;
- each of its commits has an equivalent patch there (rebase merge);
- the default branch reached the exact content of every file it changed (squash merge);
- its tip is the head of a merged pull request (GitHub, through `gh`, when it is signed in; `--no-github` turns it off);
- its upstream is gone and every commit is on a remote.

A branch with commits found nowhere else is skipped with `needs-force`. Only `--force` deletes it, and only `--force` on a branch you name deletes a branch whose work is not merged. A glob never forces.

Whatever the flags, `gsp clean` never deletes:

- the default branch, or a protected branch (`--protect 'release/*'`, `git config --add git-sweep-pro.protected 'release/*'`, or the `gitSweepPro.protectedBranches` setting);
- a branch with `branch.<name>.deleteMerged` set to `false`;
- the current branch, or a branch checked out in the main worktree;
- a branch checked out in a worktree that is locked or has uncommitted changes;
- a branch that another kept local branch uses as its upstream.

A dead branch checked out in a clean, unlocked linked worktree is deleted with its worktree (`git worktree remove`, never `--force`). Each skipped branch comes with a hint: the exact command that resolves it.

Every deletion is recorded: `gsp restore <branch>` recreates any of the last 100 deleted branches, tracking its upstream again if it still exists, until Git garbage-collects its commits (two weeks by default).

### Output

One line per branch, then one summary line:

```text
deleted feature/empty   no commits beyond origin/main
deleted feature/squash  squash-merged into origin/main, removed worktree /work/wt-squash
skip    feature/gone    needs --force (upstream origin/feature/gone is gone, 2 commits found nowhere else) → gsp clean feature/gone --yes --force
keep    feature/wip     1 commit not merged into origin/main
keep    main            default branch
2 deleted (1 empty, 1 squash-merged) · 1 skipped (1 needs --force) · restore with gsp restore feature/empty feature/squash
```

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done, or nothing to do |
| 1 | At least one action failed; the output says which |
| 2 | Invalid arguments, or a branch that does not exist |
| 3 | Sync paused on conflicts. Resolve them, stage the files, then run `gsp resume` |
| 4 | Cancelled at a prompt |
| 5 | Deletions planned but not applied: no `--yes`, `--dry-run`, or `--force` missing. Nothing was changed by those |

## With coding agents

Codex, Claude Code, Cursor, GitHub Copilot and OpenCode can clean up the workspace for you. Tell them `gsp` exists:

```sh
gsp agents
```

It asks which instruction files to update, `AGENTS.md` (Codex, Cursor, GitHub Copilot, OpenCode) and/or `CLAUDE.md` (Claude Code). Running it again updates its own block and leaves the rest of the file alone. To set up both files without a picker: `gsp agents AGENTS.md CLAUDE.md --non-interactive`.

Agents read the plan, then apply it when authorized:

```sh
gsp clean --json                  # the plan; exit code 5 when there is something to delete
gsp clean --json --yes            # apply it; the result, with a restore command
gsp restore --json                # list recoverable deletions
gsp restore feature/x --non-interactive
```

`--non-interactive` never prompts, even in a pseudo-terminal. It does not grant permission to delete: only `--yes` does.

### JSON

`--json` works with `clean` (and `sweep`, `list`), `worktree list` and `restore` without branch names. It writes one JSON document to stdout; progress and warnings go to stderr.

`gsp clean --json` writes a versioned document (`schema` is 2):

```json
{
  "schema": 2,
  "mode": "plan",
  "checks": {
    "base": { "name": "main", "ref": "refs/remotes/origin/main", "remote": "origin", "tip": "8ed204b…", "source": "remote-head" },
    "fetched": false,
    "github": { "used": false, "reason": "gh-unauthenticated" },
    "durationMs": 115,
    "remote": { "source": "ls-remote", "remotes": ["origin"] }
  },
  "branches": [
    {
      "name": "feature/squash",
      "tip": "a4d8464…",
      "action": "delete",
      "reason": "squash-merged",
      "verdict": "dead",
      "verdictReason": "squash-merged",
      "evidence": { "method": "file-state", "base": "refs/remotes/origin/main", "squashCommit": "8ed204b…", "files": 1, "patchIdCommits": 0 },
      "unpushedCommits": 0,
      "upstream": "origin/feature/squash",
      "upstreamState": "gone",
      "worktree": { "path": "/work/wt-squash", "isMain": false, "dirty": false, "locked": false, "prunable": false },
      "needsForce": false,
      "hint": "gsp clean feature/squash --yes"
    }
  ],
  "worktreesPruned": [],
  "restore": null,
  "summary": { "delete": 1, "deleted": 0, "failed": 0, "skipped": 0, "kept": 1, "needsForce": 0, "reasons": { "squash-merged": 1 } }
}
```

| Field | Values |
| --- | --- |
| `mode` | `plan` (nothing changed) or `apply` |
| `checks.remote.source` | `fetch` (apply), `ls-remote` (plan), or `local-refs` with a `reason`: `no-fetch`, `no-remote` or `unreachable` |
| `branches[].action` | `delete`, `keep` (its work exists nowhere else) or `skip` (a rule or a missing flag stops it) |
| `branches[].reason` | For `skip`: `protected`, `delete-merged-false`, `current-branch`, `main-worktree`, `locked-worktree`, `dirty-worktree`, `needs-force`, `tracked-by-kept-branch`, `not-selected`. Otherwise the same as `verdictReason` |
| `branches[].verdictReason` | Dead: `empty`, `merged`, `rebase-merged`, `squash-merged`, `pr-merged`, `commits-merged`, `upstream-gone`. Alive: `default-branch`, `open-pr`, `unmerged-commits`, `no-base` |
| `branches[].hint` | The command that resolves a skip or applies a planned deletion; `null` when there is nothing to do, and for protected branches |
| `branches[].result` | Apply mode, deleted branches only: `deleted`, `worktree-removed` (the worktree went, the branch did not: see `error`) or `failed` (nothing changed: see `error`) |
| `worktreesPruned` | Registrations whose directory is gone: pruned (apply) or to prune (plan) |
| `restore` | `gsp restore <names>` for the branches deleted by this run, or `null` |

Other JSON outputs:

| Command | JSON value |
| --- | --- |
| `gsp worktree list --json` | Array of worktrees, each with `path`, `branch` (`null` when detached) and `state` (`main`, `linked`, `prunable` or `locked`) |
| `gsp restore --json` | Array of recoverable deletion records, including `branch`, `sha`, `deletedAt` and `source` |

`sync` rebases and force-pushes with a lease. `post-pr` switches branches, deletes the old branch, cleans and pulls. Agents should run these commands only when authorized.

## In VS Code

Every command runs the same CLI, rendered with VS Code pickers and dialogs. Open the Command Palette and type **Git Sweep Pro**:

| Command | Does |
| --- | --- |
| Sweep Stale Branches | Pick a mode, then `gsp clean`: pick branches, confirm |
| Preview Stale Branches (Dry Run) | `gsp clean --dry-run` |
| Post Pull Request Cleanup | `gsp post-pr` |
| Sync Branch With Upstream / Resume Sync With Upstream | `gsp sync` / `gsp resume` |
| Restore Deleted Branches | `gsp restore` |
| Add Instructions for Coding Agents | `gsp agents` |

| Setting | Default | |
| --- | --- | --- |
| `gitSweepPro.defaultMode` | `safeDelete` | Mode offered first: `dryRun`, `safeDelete` or `forceDelete` (`--force`) |
| `gitSweepPro.protectedBranches` | `[]` | Globs never deleted (`*` and `?`) |
| `gitSweepPro.autoFetchPrune` | `true` | Run `git fetch -p` first |
| `gitSweepPro.confirmBeforeDelete` | `true` | Ask before deleting |
| `gitSweepPro.includeMergedBranches` | `false` | Deprecated: merged branches are always offered |
| `gitSweepPro.cli.addToTerminalPath` | `true` | Put `gsp` on the integrated terminals' `PATH` |

Every git command and its output goes to the **Git Sweep** output channel.

Requires VS Code 1.92 or newer, and Git 2.23 or newer.

## License

[GNU GPL v3.0](./LICENCE)
