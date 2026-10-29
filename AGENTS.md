# Agent notes

## Product decisions (gsp 2.0)

Settled by Maxence on 2026-10-26.

- **Agent-first CLI, released as 2.0 (breaking).** One obvious command, `gsp clean [<branch>…]`, cleans a repository; `sweep` and `list` stay as aliases. Without a TTY it prints the plan and changes nothing unless `--yes` is passed.
- **`--yes` never forces.** It deletes only branches whose work is proven to exist elsewhere: ancestor of the default branch, squash- or rebase-merged, head of a merged pull request, or tip reachable from a remote ref. Anything else needs `--force`.
- **Machine-readable everywhere.** Every command accepts `--json` and emits a versioned schema with, per branch, the action, a reason code, the evidence and a hint with the exact command to resolve a skip. Exit codes are documented and distinct (nothing to do, plan not applied, partial failure, usage error).
- **Plan mode is read-only.** No fetch with prune, no worktree prune and no object writes when only planning.
- **GitHub signal is automatic when `gh` is authenticated** (merged PR head SHAs, matched by SHA, never by name); `--no-github` turns it off.
- **Remote branch cleanup is opt-in** with `--remote`, shows the plan first and requires `--yes`.
- **Stay independent of `git branch --delete-merged` (Git 2.56)**: it cannot see squash merges. Mirror its safety rules instead: honour `branch.<name>.deleteMerged=false`, never delete a branch another kept local branch tracks, accept its pattern arguments.
- **Ignored files in a worktree block its removal, unless they are regenerable** (settled 2026-10-26). `git worktree remove` deletes ignored files and `gsp restore` can't bring them back. A worktree with ignored files outside known regenerable folders (dependencies, build output, caches) is skipped with reason `ignored-files` and the list of files.
- **`--force` and `--discard-changes` are separate** (settled 2026-10-26), in `clean`, `post-pr` and `worktree remove`. `--force` only lifts the merge proof (unpushed or unmerged work on a branch, restorable with `gsp restore`). Losing uncommitted changes or non-regenerable ignored files in a worktree needs `--discard-changes`, and the hint lists what would be lost.
- **The VS Code extension mirrors the CLI** through the same JSON schema, including worktree commands.
- **A branch that never carried a commit of its own is not finished work** (settled 2026-10-29). Agents and parallel sessions create a branch and a worktree before their first commit, so "no commit ahead of the default branch" doesn't prove a branch dead. The automatic sweep (`gsp clean --yes`, `post-pr`) keeps such a branch and its worktree, and the plan lists it apart from merged branches. `--include-empty` deletes them; naming the branch on the command line is enough too.
- **A worktree in use is never removed by a sweep** (settled 2026-10-29): locked with `git worktree lock` (the recommended way to protect an agent's worktree, honoured everywhere, including `gsp worktree remove`), or a process running inside it. No time-based signal: besides these, only facts about the work count (uncommitted changes, commits not pushed or not in the default branch).

## Implementation decisions (taken during the build, not yet reviewed by Maxence)

- For a proven branch, gsp may fall back to `git branch -D` after checking the tip has not moved, because `-d` cannot see squash merges.
- A merged pull request only proves a branch dead when it was merged into the default branch.
- **Hints never suggest losing data first.** A skip caused by uncommitted changes points to committing or stashing them, not to a forced removal.
- **Exit 5 means "more could be cleaned with your approval"**: deletions planned but not applied, or branches that need `--force`. Skips that need the user to act elsewhere (current branch, dirty worktree) don't change the exit code.
- `--yes` without a picker applies whatever is proven after the fetch, within the requested scope (patterns, `--protect`) and never beyond the `--force` rules. Only branches a person picked in the picker are held to the plan they saw.
- A branch needing `--force` is never offered or pre-selected in the picker without `--force`.
- Local branches named `main`, `master`, `trunk` or `develop` are protected by default, besides the detected default branch, so a moved `origin/HEAD` can't get them deleted; naming one exactly on the command line lifts it.
- Secret-like files (`.env*`, `*.pem`, `*.key`, `.npmrc`, `.netrc`, `*credentials*`, `*secret*`) are never regenerable, even inside ignored build or cache folders, except `*credentials*`/`*secret*` files with a code extension there (compiled code such as `dist/auth/credentials.js`); dependency folders are not searched.
- `--remote` never force-deletes: it pushes the deletion with a lease on the analysed SHA; a rejected lease is reported as `plan-changed`. Without `origin`, it uses the only remote, else it's a usage error. `branch.<name>.deleteMerged=false` also protects that branch's upstream on the remote.
- On a GitHub remote, `--remote` deletes nothing when the GitHub signal is unavailable or `--no-github` is passed (open PRs can't be checked). The base branch of an open PR is kept like its head. Naming `develop` lifts its default-name protection locally only; the remote needs the qualified form `origin/develop`.
- `post-pr` exits 5 whenever the merged branch it was asked to finish is kept (dirty, ignored files, mid-rebase, not proven): for post-pr, 5 means "not finished". Its positional never lifts protection; a protected name there is read as the old `gsp post-pr <default>` form.
- `--remote` fails closed on hosts it can't classify: unless the remote is known not to be GitHub (local path, `file://`, gitlab.com, bitbucket.org) or `git config git-sweep-pro.forge none` says so, an unresolvable GitHub status skips deletions as `github-unavailable`. URLs are resolved with `insteadOf` and SSH aliases. `--remote` refuses a remote whose push URL points to another repository than its fetch URL (same host and full path, after rewrites and SSH aliases).
- `post-pr --clean <branch>` (repeatable) limits its clean step to the named branches and `--no-clean` skips it, so its `next` and hints name exactly what they delete, like `gsp clean`'s apply command.
- An ignored symlink counts as regenerable only when it is named like a regenerable folder or file (e.g. a linked `node_modules`); any other ignored symlink keeps the worktree.
- The extension offers `--remote` and the worktree list in 2.0.
- **Telling "never committed" from "commits merged"**: a branch with no commit ahead of the default branch is `merged` when a merge commit brought its tip in, or when its reflog records a commit made on it (`commit`, `cherry-pick`, `revert`, `am`, a merge commit, or a rebase that replayed commits past its `onto`) that its tip still contains. Otherwise it is `empty` and skipped as `never-committed`: a new branch, one created at an older commit, rebased or reset onto the default branch, or with no reflog left (`core.logAllRefUpdates` off, expired). When unsure, keep. A remote branch with no commit ahead has no reflog to read: always `never-committed`.
- `never-committed` is lifted by `--include-empty`, by naming the branch, or by picking it (offered, never pre-selected); not by `--force`, which lifts the merge proof only. It doesn't change the exit code, so an agent is never invited to delete another agent's new branch.
- **Worktree in use**: a process whose current directory is inside the worktree (`/proc` on Linux, `lsof` elsewhere), gsp's own process and its ancestors left out. Checked in the plan and again right before each removal; no flag lifts it. Fail-open: when processes can't be read (Windows, `lsof` missing, failing or over 5 s), the worktree is treated as unused and `checks.processes` says why, since failing closed would stop every worktree cleanup there; `git worktree lock` is the protection that always holds. The branch `post-pr` is asked to finish is not held by processes: the person finishing it is often still in its worktree.
- A lock is never lifted by a flag, in `gsp worktree remove` too (`--discard-changes` included): the hint is `git worktree unlock <path>`, as Git itself needs `-f -f`.
- `--json` schema stays 2: new reason codes and fields are additions.

## Release workflow for 2.0

Work lands as a stack of pull requests into `release/2.0.0` (squash merge each), then `release/2.0.0` is rebase-merged into `main` so semantic-release publishes a single 2.0.0.
