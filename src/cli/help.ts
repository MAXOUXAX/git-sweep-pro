import type { CommandName } from './args';

const EXIT_CODES = `Exit codes:
  0  Done, or nothing to do
  1  At least one action failed (details in the output)
  2  Invalid arguments, or a branch that does not exist
  3  Sync paused on conflicts: resolve them, then run "gsp resume"
  4  Cancelled at a prompt
  5  Deletions planned but not applied (no --yes, --dry-run, or --force
     missing): nothing was changed. For post-pr: also when the merged
     branch was not deleted`;

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
  worktree list      List every worktree with its branch and state
  worktree prune     Forget the worktrees whose directory is gone
  worktree remove <path|branch>
                     Remove one linked worktree
  post-pr [<branch>] After a merged pull request: delete its branch and
                     worktree, update the default branch, then clean
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
  gsp post-pr --yes            Finish the merged pull request of this branch
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

Never deleted: the default branch, protected branches, branches with
"branch.<name>.deleteMerged" set to false, the current branch, a branch
checked out in the main worktree or in a dirty or locked worktree, and a
branch another kept branch tracks.

Without a terminal, gsp clean prints the plan and changes nothing unless
--yes is given. In a terminal, it lets you pick the branches first.

Options:
  -n, --dry-run      Print the plan and change nothing (no fetch, no prune)
  -y, --yes          Apply the plan without asking
  -f, --force        Also delete branches with unpushed or unmerged work
                     (named exactly, or listed as needing --force)
      --json         Print the plan or the result as one JSON document
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
  gsp restore feature/x                    Undo a deletion

${EXIT_CODES}`;

const WORKTREE_HELP = `Usage: gsp worktree <list|prune|remove> [options]

  worktree list      List every worktree with its branch and state (main,
                     linked, locked, prunable)
  worktree prune     Forget the registrations whose directory is gone; never
                     touches an existing worktree
  worktree remove <path|branch>
                     Remove one linked worktree, refusing the main one

Options:
      --json         worktree list: print a JSON array
  -n, --dry-run      worktree prune: only print what would be forgotten
  -f, --force        worktree remove: also remove a dirty worktree. Unlock
                     a locked one first with "git worktree unlock <path>"
${GLOBAL_OPTIONS}`;

const POST_PR_HELP = `Usage: gsp post-pr [<branch>] [options]

Finish a merged pull request: delete <branch> (the current branch when
omitted) and the linked worktree it is checked out in, fast-forward the
default branch, then clean the other merged branches as "gsp clean --yes"
would.

<branch> is deleted only when its work is proven to be in the default
branch, with the rules of "gsp clean". Otherwise nothing is changed on it,
gsp says why, and exits with 5. Works from any worktree:
  - run from the branch's own linked worktree, gsp removes it, carries on
    from the main checkout and tells you where to "cd" next;
  - when the branch is checked out in the main checkout, that checkout is
    switched to the default branch first (never when it has uncommitted
    changes);
  - the default branch is fast-forwarded where it is checked out, when that
    worktree is clean, or as a ref when it is checked out nowhere.

Without a terminal, gsp post-pr prints the plan and changes nothing unless
--yes is given.

Options:
      --into <branch>  The branch the pull request was merged into (default:
                     the default branch)
  -n, --dry-run      Print the plan and change nothing (no fetch, no switch)
  -y, --yes          Apply without asking
  -f, --force        Delete <branch> even when it is not proven merged
      --json         Print the plan or the result as one JSON document
  -p, --protect <glob>
                     Never delete branches matching <glob> (repeatable)
      --no-fetch     Use the local remote-tracking refs: no fetch, no
                     "git ls-remote"
      --no-github    Do not ask GitHub (through gh) for merged pull requests
      --no-confirm   Do not ask for confirmation in a terminal
${GLOBAL_OPTIONS}

Common tasks:
  gsp post-pr --yes                After merging, from the branch's worktree
                                   (or the main checkout, on that branch)
  gsp post-pr feature/x --yes      After merging, from the main checkout or
                                   any other worktree
  gsp post-pr --dry-run            Preview, change nothing
  gsp restore feature/x            Undo the deletion

${EXIT_CODES}`;

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
