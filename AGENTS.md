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
- **Ignored files in a worktree block its removal, unless they are regenerable** (settled 2026-10-26). `git worktree remove` deletes ignored files and `gsp restore` can't bring them back. A worktree with ignored files outside known regenerable folders (dependencies, build output, caches) is skipped with reason `ignored-files` and the list of files; `--force` lifts it.
- **The VS Code extension mirrors the CLI** through the same JSON schema, including worktree commands.

## Implementation decisions (taken during the build, not yet reviewed by Maxence)

- For a proven branch, gsp may fall back to `git branch -D` after checking the tip has not moved, because `-d` cannot see squash merges.
- A merged pull request only proves a branch dead when it was merged into the default branch.
- **Hints never suggest losing data first.** A skip caused by uncommitted changes points to committing or stashing them, not to a forced removal.
- **Exit 5 means "more could be cleaned with your approval"**: deletions planned but not applied, or branches that need `--force`. Skips that need the user to act elsewhere (current branch, dirty worktree) don't change the exit code.

## Release workflow for 2.0

Work lands as a stack of pull requests into `release/2.0.0` (squash merge each), then `release/2.0.0` is rebase-merged into `main` so semantic-release publishes a single 2.0.0.
