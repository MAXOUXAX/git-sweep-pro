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
- **The VS Code extension mirrors the CLI** through the same JSON schema, including worktree commands.

## Release workflow for 2.0

Work lands as a stack of pull requests into `release/2.0.0` (squash merge each), then `release/2.0.0` is rebase-merged into `main` so semantic-release publishes a single 2.0.0.
