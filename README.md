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
gsp worktree list       # every worktree, its state, and what clean would do
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

Without a terminal, `gsp clean` prints the plan and changes nothing unless you pass `--yes`; it ends with the command that applies exactly that plan. In a terminal, it shows a picker with every planned deletion selected; with `--force`, branches that need it are listed too, never selected. `--dry-run` always plans only.

Planning is read-only: no fetch, no prune, no change to refs, objects, config or worktrees. To find the branches deleted on the remote, it reads `git ls-remote --heads`. With `--no-fetch`, or when the remote cannot be reached, it uses the local remote-tracking refs, and the JSON says so in `checks.remote`.

The plan is made first, read-only, even when applying. Once you approve it (picker and confirmation, or `--yes`), `gsp clean` runs `git fetch --prune` (skipped with `--no-fetch`), and analyses the branches again. From the picker, it deletes only the branches you picked that are still proven. With `--yes`, it deletes every branch proven after the fetch, within the branches and `--protect` patterns you gave and never beyond what needs `--force`, so a squash merge the fetch reveals is cleaned in the same run. Either way, a branch the plan deleted but that is no longer proven is skipped with `plan-changed`, and one whose worktree changed with `worktree-changed`. Then it forgets the worktree registrations whose directory is gone. Cancelling the picker changes nothing.

If the fetch fails, a branch proven only by its gone upstream is skipped with `fetch-failed`: the local remote-tracking refs may be out of date.

The fetch follows your `remote.<name>.followRemoteHEAD` setting. If it changes the default branch, every proof the plan showed was made against another branch: nothing is deleted, each planned deletion is skipped with `plan-changed`, and `gsp clean --dry-run` shows the new plan. The default branch the plan was made on is never deleted.

### What gets deleted

`--yes` deletes a branch only with proof that its work exists elsewhere:

- it is merged into the default branch, or points at a commit already on it;
- each of its commits has an equivalent patch there (rebase merge);
- the default branch reached the exact content of every file it changed (squash merge);
- its tip is the head of a merged pull request (GitHub, through `gh`, when it is signed in; `--no-github` turns it off);
- its upstream is gone and every commit is on a remote.

A branch with commits found nowhere else is skipped with `needs-force`. Only `--force` deletes it, and only `--force` on a branch you name deletes a branch whose work is not merged. A glob never turns an unmerged branch into a candidate.

Whatever the flags, `gsp clean` never deletes:

- the default branch, or a protected branch (`--protect 'release/*'`, `git config --add git-sweep-pro.protected 'release/*'`, or the `gitSweepPro.protectedBranches` setting);
- a branch named `main`, `master`, `trunk` or `develop`, unless you name it exactly (`gsp clean master`): when the remote's default branch moves, the old one looks merged into the new one. Naming it lifts only this protection: it still needs a proof;
- a branch with `branch.<name>.deleteMerged` set to `false`;
- a branch being rebased or bisected, in any worktree;
- the current branch, or a branch checked out in the main worktree;
- a branch checked out in a worktree that is locked, has uncommitted changes or holds checked-out submodules (`git worktree remove` refuses those without `--force`);
- a branch that another kept local branch uses as its upstream.

A dead branch checked out in a clean, unlocked linked worktree is deleted with its worktree (`git worktree remove`, never `--force`). Each skipped branch comes with a hint: the exact command that resolves it. A hint never suggests losing work first: for uncommitted changes, it stashes them, and for ignored files, it asks you to move what you need out of the worktree before forcing.

Removing a worktree deletes its ignored files, and `gsp restore` cannot bring them back. A worktree holding ignored files is skipped with `ignored-files`, and the plan lists them, unless they are all regenerable: a build or an install recreates them. Only `--force` removes it anyway, once you have moved what you need out of it. These folders are regenerable, at any depth, when the whole folder is ignored:

`node_modules`, `.pnpm-store`, `vendor/bundle`, `dist`, `build`, `out`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.cache`, `.parcel-cache`, `.vite`, `coverage`, `target`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.venv`, `venv`, `.gradle`, `.dart_tool`, `DerivedData`

and so are `*.tsbuildinfo` and `.DS_Store` files. An ignored file inside a tracked folder with one of these names (`tools/build/credentials.json`) is not.

Secret-like files are never regenerable, wherever they are: `.env`, `.env.*`, `*.pem`, `*.key`, `*credentials*`, `*secret*`, `.npmrc` and `.netrc`. Inside an ignored build or cache folder, `gsp clean` also looks for `.env`, `.env.*`, `*.pem`, `*.key`, `.npmrc` and `.netrc` files (a compiler never writes one there). Dependency folders (`node_modules`, `.pnpm-store`, `vendor/bundle`, `.venv`, `venv`) are not searched: packages ship such files of their own.

Every deletion is recorded: `gsp restore <branch>` recreates any of the last 100 deleted branches, tracking its upstream again if it still exists, until Git garbage-collects its commits (two weeks by default). Like after `git branch -D`, the rest of the branch's configuration (its description, `pushRemote`, `rebase` and other `branch.<name>.*` settings) is not restored.

### Branches on the remote

`gsp clean --remote` also plans the branches on `origin` (`--remote=<name>` for another remote, or the only one when there is no `origin`). It deletes them only with `--yes`, never with `--force`, and only when their work is proven on the default branch: the tip is on it, each commit has an equivalent patch there, the default branch reached the content of every file it changed, or it is the head of a pull request merged into the default branch (matched by SHA).

It never deletes there the default branch (or the remote's `HEAD`), a protected branch or name, the head of an open pull request, or a branch a kept local branch tracks. A local branch deleted in the same run no longer holds its upstream, so both go together. Branch names and globs apply to remote names too.

The plan reads the remote with `git ls-remote`, and changes nothing. A tip this repository has not fetched yet cannot be proven: the branch is kept until the next run. Once approved, `gsp clean` fetches, checks again, then deletes each branch with `git push --force-with-lease=refs/heads/<branch>:<tip> <remote> :refs/heads/<branch>`: a branch someone pushed to since it was analysed is skipped with `plan-changed`.

Each remote deletion is recorded too: `gsp restore origin/<branch>` pushes it back at its recorded commit, unless a branch of that name exists there again.

### Output

One line per branch, then one summary line:

```text
deleted feature/empty   already in origin/main
deleted feature/squash  squash-merged into origin/main, removed worktree /work/wt-squash
skip    feature/gone    needs --force (upstream origin/feature/gone is gone, 2 commits found nowhere else) → gsp clean feature/gone --yes --force
keep    feature/wip     1 commit not merged into origin/main
keep    main            default branch
2 deleted (1 empty, 1 squash-merged) · 1 skipped (1 needs --force) · restore with gsp restore feature/empty feature/squash
```

With `--remote`, an "On origin" section follows, in the same format, and the summary line ends with what happened there, for instance `on origin: 3 deleted`.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done, or nothing to do |
| 1 | At least one action failed; the output says which |
| 2 | Invalid arguments, or a branch or remote that does not exist |
| 3 | Sync paused on conflicts. Resolve them, stage the files, then run `gsp resume` |
| 4 | Cancelled at a prompt |
| 5 | `clean`: some planned deletions were not applied; the output says why and what to run next (`next` in the JSON). `sync`, `agents`, `restore`, `post-pr`: a confirmation was needed but nobody could answer; rerun with `--yes` |

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
gsp clean --json --remote --yes   # also delete the merged branches on origin
gsp restore --json                # list recoverable deletions
gsp restore feature/x --non-interactive
```

`--non-interactive` never prompts, even in a pseudo-terminal. It does not grant permission to delete: only `--yes` does.

### JSON

`--json` works with `clean` (and `sweep`, `list`), `worktree list` and `restore` without branch names. It writes one JSON document to stdout; progress and warnings go to stderr. A fatal error is still one document, `{ "schema": 2, "error": { "message": "…", "code": "…" } }`, with `code` one of `usage`, `no-such-directory`, `unknown-branch`, `unknown-remote`, `not-a-repository` or `failed`.

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
      "worktree": { "path": "/work/wt-squash", "isMain": false, "dirty": false, "locked": false, "prunable": false, "inProgress": null, "ignoredFiles": { "count": 0, "sample": [] }, "submodules": false },
      "needsForce": false,
      "hint": "gsp clean feature/squash --yes"
    }
  ],
  "worktreesPruned": [],
  "restore": null,
  "summary": { "delete": 1, "deleted": 0, "failed": 0, "skipped": 0, "kept": 1, "needsForce": 0, "reasons": { "squash-merged": 1 } },
  "next": "gsp clean feature/squash --yes"
}
```

| Field | Values |
| --- | --- |
| `mode` | `plan` (nothing changed) or `apply` |
| `checks.remote.source` | `fetch` (apply), `ls-remote` (plan), or `local-refs` with a `reason`: `no-fetch`, `no-remote` or `unreachable` |
| `branches[].action` | `delete`, `keep` (its work exists nowhere else) or `skip` (a rule or a missing flag stops it) |
| `branches[].reason` | For `skip`: `protected`, `delete-merged-false`, `rebase-in-progress`, `bisect-in-progress`, `current-branch`, `main-worktree`, `locked-worktree`, `dirty-worktree`, `submodules`, `ignored-files`, `needs-force`, `tracked-by-kept-branch`, `not-selected`, and while applying `plan-changed`, `fetch-failed`, `worktree-changed`. Otherwise the same as `verdictReason` |
| `branches[].verdictReason` | Dead: `empty`, `merged`, `rebase-merged`, `squash-merged`, `pr-merged`, `commits-merged`, `upstream-gone`. Alive: `default-branch`, `open-pr`, `unmerged-commits`, `no-base`, `analysis-failed` (`evidence` is `{ "method": "error", "message" }`) |
| `branches[].worktree` | `null`, or `path`, `isMain`, `dirty`, `locked`, `prunable`, `inProgress` (`rebase`, `bisect` or `null`) and `ignoredFiles`: `{ count, sample }` for the ignored files removing it would delete (at most 10 in `sample`; a trailing `/` is a whole folder), and `submodules`: whether it holds submodules. Both are `null` when they were not looked for |
| `branches[].protected` | Why it is kept whatever its verdict, or `null`: `{ "by": "default-branch" }`, `{ "by": "pattern", "pattern" }`, `{ "by": "branch-config", "key" }` (`deleteMerged` is false) or `{ "by": "default-name" }` (`main`, `master`, `trunk` or `develop`, not named exactly) |
| `branches[].hint` | The command that resolves a skip or applies a planned deletion; for `ignored-files`, it first says what to do by hand: `move what you need out of <path>, then: <command>`. `null` when there is nothing to do, and for `protected` (except `default-name`: `gsp clean <name>`) and `delete-merged-false` |
| `branches[].result` | Apply mode, deleted branches only: `deleted`, `worktree-removed` (the worktree went, the branch did not: see `error`) or `failed` (nothing changed: see `error`) |
| `remoteBranches` | With `--remote` only: the branches on that remote, each with `remote`, `name`, `tip`, `action`, `reason`, `verdict`, `verdictReason`, `evidence`, `protected`, `trackedBy` (the local branches whose upstream it is), `hint`, and once applied `result` (`deleted` or `failed`, with `error`). `reason` for `skip`: `protected`, `tracked-by-kept-branch`, and while applying `plan-changed` (it moved since it was analysed) or `fetch-failed` |
| `summary.remote` | With `--remote` only: `{ remote, delete, deleted, failed, skipped, kept }` for its branches |
| `worktreesPruned` | Registrations whose directory is gone: pruned (apply) or to prune (plan) |
| `restore` | `gsp restore <names>` for the branches deleted by this run (`<remote>/<name>` for a remote one), or `null` |
| `next` | The command to run next, the one the terminal output prints: it applies the planned deletions not carried out, or, when some changed while applying, plans again within the same branches and options (`--dry-run`) so you can review them. `null` when nothing is left, or when what is left needs `--force` or your action: each branch's `hint` says what to do |

Other JSON outputs:

| Command | JSON value |
| --- | --- |
| `gsp worktree list --json` | `{ "schema": 2, "command": "worktree list", "worktrees": [...] }`, main worktree first. Each has `path`, `branch` (during a rebase or a bisect, the branch being worked on; `null` when detached), `head`, `isMain`, `locked`, `prunable`, `dirty`, `inProgress` (`rebase`, `bisect` or `null`), `ignoredFiles` (`{ count, sample }`, as in `gsp clean`; `null` for the main worktree and a prunable one), and what `gsp clean` would do with its branch: `verdict`, `verdictReason`, `action`, `reason` and `hint`, as in `gsp clean --json` (all `null` without a branch). Read-only, like a plan |
| `gsp restore --json` | Array of recoverable deletion records, including `branch`, `sha`, `deletedAt`, `source`, and `remote` for a branch deleted on a remote |

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
