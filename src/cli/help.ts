import type { CommandName } from './args';

const EXIT_CODES = `Exit codes:
  0  Done, or nothing to do
  1  At least one action failed (details in the output)
  2  Invalid arguments, or a branch or remote that does not exist
  3  Sync paused on conflicts: resolve them, then run "gsp resume"
  4  Cancelled at a prompt
  5  clean: some planned deletions were not applied; the output says why
     and what to run next. Other commands: a confirmation was needed
     but nobody could answer; rerun with --yes`;

const GLOBAL_OPTIONS = `  -C <path>          Run as if started in <path>
      --non-interactive
                     Never prompt, even in a terminal
  -v, --verbose      Show every git command and its output
  -h, --help         Show this help`;

export const USAGE = `Usage: gsp [command] [options]

Delete the local branches whose work is already merged or pushed, and the
worktrees they leave behind. Every deletion can be undone.
Also available as "git-sweep-pro" and "git sweep-pro".

Commands:
  clean [<branch>...]
                     Delete merged branches and their worktrees (default).
                     "sweep" is an alias; "list" is "clean --dry-run"
  worktree list      List every worktree, its state, and what clean would
                     do with its branch
  worktree prune     Forget the worktrees whose directory is gone
  worktree remove <path|branch>
                     Remove one linked worktree
  post-pr [branch]   After a merged pull request: switch to [branch], delete
                     the old branch, clean, then pull
  sync [upstream]    Rebase the current branch onto [upstream], then
                     force-push with a lease
  resume             Continue a sync paused on conflicts
  restore [branch...]
                     Recreate branches deleted by gsp
  agents [file...]   Tell coding agents about gsp in AGENTS.md or CLAUDE.md
  help [command], version

Run "gsp <command> --help" for the options of one command.

Common tasks:
  gsp clean --dry-run          See what would be deleted, change nothing
  gsp clean --yes              Delete every branch proven merged
  gsp clean --json             The plan as JSON, for scripts and agents
  gsp restore <branch>         Undo a deletion

${EXIT_CODES}`;

const CLEAN_HELP = `Usage: gsp clean [<branch>...] [options]
Aliases: gsp, gsp sweep, gsp list (= gsp clean --dry-run)

Delete the local branches whose work already exists elsewhere, and the
linked worktrees they are checked out in. With branch names or globs
("feature/*"), only those branches are considered.

A branch is deleted only with a proof that its work exists elsewhere: it is
merged, squash- or rebase-merged into the default branch, it is the head of
a merged pull request, or its upstream is gone and every commit is on a
remote. Branches with work found nowhere else need --force.

Never deleted: the default branch, protected branches, a branch named
main, master, trunk or develop unless named exactly, branches with
"branch.<name>.deleteMerged" set to false, a branch being rebased or
bisected, the current branch, a branch checked out in the main worktree or
in a dirty or locked worktree, and a branch another kept branch tracks.
A worktree holding ignored files that a build does not recreate (a .env,
notes) is kept too, unless --force is given.

Without a terminal, gsp clean prints the plan and changes nothing unless
--yes is given. In a terminal, it lets you pick the branches first. The
plan writes nothing; once approved, gsp fetches, checks again, and deletes
only what was approved and is still proven.

Options:
  -n, --dry-run      Print the plan and change nothing (no fetch, no prune)
  -y, --yes          Apply the plan without asking
  -f, --force        Also delete branches with unpushed or unmerged work
                     (named exactly, or listed as needing --force), and
                     worktrees holding ignored files
      --json         Print the plan or the result as one JSON document
      --remote[=<name>]
                     Also delete the branches on <name> (origin by default)
                     whose work is merged into its own default branch; never
                     forced, and only with --yes. Name them <name>/<branch>
                     On a host gsp can't tell is GitHub, set
                     "git config git-sweep-pro.forge none" (or "github")
  -p, --protect <glob>
                     Never delete branches matching <glob> (repeatable; also
                     read from "git config --get-all git-sweep-pro.protected")
      --no-fetch     Use the local remote-tracking refs: no fetch, no
                     "git ls-remote"
      --no-github    Do not ask GitHub (through gh) for merged pull requests
      --no-confirm   Do not ask for confirmation after the picker
${GLOBAL_OPTIONS}

Common tasks:
  gsp clean --yes                          Clean the repository
  gsp clean --json                         Preview the plan as JSON
  gsp clean feature/x --yes                Delete one branch, if proven merged
  gsp clean feature/x --yes --force        Delete a branch with unpushed work
  gsp clean --remote --yes                 Also delete merged branches on origin
  gsp restore feature/x                    Undo a deletion

${EXIT_CODES}`;

const WORKTREE_HELP = `Usage: gsp worktree <list|prune|remove> [options]

  worktree list      List every worktree with its branch, its state (main,
                     locked, prunable, dirty, rebase or bisect in progress,
                     ignored files) and what gsp clean would do with its
                     branch. Read-only
  worktree prune     Forget the registrations whose directory is gone; never
                     touches an existing worktree
  worktree remove <path|branch>
                     Remove one linked worktree, refusing the main one

Options:
      --json         worktree list: print one JSON document, for scripts
                     and agents
      --no-fetch     worktree list: no "git ls-remote", use the local
                     remote-tracking refs
      --no-github    worktree list: do not ask GitHub through gh
  -n, --dry-run      worktree prune: only print what would be forgotten
  -f, --force        worktree remove: also remove a dirty worktree. Unlock
                     a locked one first with "git worktree unlock <path>"
${GLOBAL_OPTIONS}`;

const POST_PR_HELP = `Usage: gsp post-pr [branch] [options]

After a merged pull request: switch to [branch] (the default branch when
omitted), delete the branch you were on, clean the other stale branches,
then pull.

Options:
  -y, --yes          Confirm every prompt
      --no-fetch     Skip "git fetch --prune"
${GLOBAL_OPTIONS}`;

const SYNC_HELP = `Usage: gsp sync [upstream] [options]

Rebase the current branch onto [upstream] (its upstream when omitted), then
force-push with --force-with-lease. Local changes are stashed and restored.
On conflicts, gsp stops with exit code 3: resolve them, stage the files,
then run "gsp resume".

Options:
  -y, --yes          Confirm every prompt
      --continue     Same as "gsp resume"
${GLOBAL_OPTIONS}`;

const RESUME_HELP = `Usage: gsp resume [options]

Continue a sync paused on conflicts, once they are resolved and staged.
Same as "gsp sync --continue".

Options:
${GLOBAL_OPTIONS}`;

const RESTORE_HELP = `Usage: gsp restore [branch...] [options]

Recreate branches deleted by gsp at their last commit, tracking their
upstream again when it still exists. Without branch names, pick among the
recent deletions, or list them when nobody can pick.

Options:
      --json         Without branch names: print the recoverable deletions
${GLOBAL_OPTIONS}`;

const AGENTS_HELP = `Usage: gsp agents [file...] [options]

Add a short note about gsp to AGENTS.md (Codex, Cursor, GitHub Copilot,
OpenCode) and/or CLAUDE.md (Claude Code). Without file names, pick them.
Running it again updates its own block and leaves the rest alone.

Options:
${GLOBAL_OPTIONS}`;

const HELP: Partial<Record<CommandName, string>> = {
	clean: CLEAN_HELP,
	sweep: CLEAN_HELP,
	list: CLEAN_HELP,
	worktree: WORKTREE_HELP,
	'post-pr': POST_PR_HELP,
	sync: SYNC_HELP,
	resume: RESUME_HELP,
	restore: RESTORE_HELP,
	agents: AGENTS_HELP,
};

/** The help of one command, or the overview. */
export function helpFor(topic: CommandName | undefined): string {
	return (topic && HELP[topic]) ?? USAGE;
}
