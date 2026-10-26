import type { CommandName } from './args';

const EXIT_CODES = `Exit codes:
  0  Done, or nothing to do
  1  At least one action failed (details in the output)
  2  Invalid arguments, or a branch, remote or worktree that does not exist
  3  Sync paused on conflicts: resolve them, then run "gsp resume"
  4  Cancelled at a prompt
  5  clean, post-pr: some planned deletions were not applied; the output
     says why and what to run next. For post-pr, 5 also means the branch
     you asked to finish isn't finished. worktree remove: the worktree was
     kept, and the output says why. agents --check: it found outdated
     advice. Other commands: a confirmation was needed but nobody could
     answer; rerun with --yes`;

const GLOBAL_OPTIONS = `  -C <path>          Run as if started in <path>
      --non-interactive
                     Never prompt, even in a terminal
  -v, --verbose      Show every git command and its output
  -h, --help         Show this help`;

export const USAGE = `Usage: gsp [command] [options]

Clean up a Git repository: delete the branches and worktrees whose work is
already merged or pushed, locally and on the remote, and finish merged pull
requests. Every branch deletion can be undone.
Also available as "git-sweep-pro" and "git sweep-pro".

Common tasks:
  gsp post-pr --yes            After merging a pull request
  gsp clean --yes              Clean the repository
  gsp clean --json             Preview the plan as JSON, change nothing
  gsp worktree remove <path>   Remove a worktree, if nothing would be lost
  gsp restore <branch>         Undo a deletion

Commands:
  clean [<branch>...]
                     Delete merged branches and their worktrees (default).
                     "sweep" is an alias; "list" is "clean --dry-run"
  worktree list      List every worktree, its state, and what clean would
                     do with its branch
  worktree prune     Forget the worktrees whose directory is gone
  worktree remove <path|branch>
                     Remove one linked worktree, if nothing would be lost
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
      --expect <branch>=<sha>
                     Delete <branch> only if its tip is still <sha>, the
                     commit a plan showed (repeatable; <remote>/<branch> on
                     the remote). Names the branch too. A branch that moved
                     or is gone is skipped as plan-changed
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
  gsp clean --yes --expect feature/x=<sha> Apply exactly what a plan showed
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
                     Remove one linked worktree, with the checks gsp clean
                     makes: it keeps a worktree that is locked, has a rebase
                     or bisect in progress, uncommitted changes or untracked
                     files, submodules, or ignored files a build does not
                     recreate (a .env, notes), and says why. Its branch
                     stays; the main worktree is never removed

Options:
      --json         worktree list, worktree remove: print one JSON
                     document, for scripts and agents
      --no-fetch     worktree list: no "git ls-remote", use the local
                     remote-tracking refs
      --no-github    worktree list: do not ask GitHub through gh
  -n, --dry-run      worktree prune: only print what would be forgotten
  -f, --force        worktree remove: remove it anyway, deleting what it
                     holds. Unlock a locked one first with
                     "git worktree unlock <path>"
${GLOBAL_OPTIONS}

Common tasks:
  gsp worktree list --json                 Every worktree and its state
  gsp worktree remove /tmp/review          Remove a scratch worktree
  gsp worktree remove /tmp/review --force  Also discard what it holds
  gsp worktree prune                       Forget worktrees already deleted

${EXIT_CODES}`;

const POST_PR_HELP = `Usage: gsp post-pr [<branch>] [options]

Finish a merged pull request: delete <branch> (the current branch when
omitted) and the linked worktree it is checked out in, fast-forward the
default branch, then clean the other merged branches as "gsp clean --yes"
would.

<branch> is deleted only when its work is proven to be in the default
branch, with the rules of "gsp clean". Otherwise nothing is changed on it,
gsp says why and what may prove it (fetching, pushing, --into), and exits
with 5; the same when its worktree has uncommitted changes. A <branch> that
has no local branch is reported as such, and the rest goes on, when
gsp deleted it, a remote branch of that name is still listed, or GitHub
shows its pull request merged (gh pr merge --delete-branch deletes it).
Any other missing <branch> is an error (exit 2).

<branch> never names a protected branch: "gsp post-pr main", the old form
naming the branch to go back to, still finishes the current branch, with a
deprecation note. So does any other protected branch. Any other <branch>
is the one to finish, wherever it is checked out.
Works from any worktree:
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
${GLOBAL_OPTIONS}

Common tasks:
  gsp restore --json           List the deletions that can be undone
  gsp restore feature/x        Recreate feature/x`;

const AGENTS_HELP = `Usage: gsp agents [file...] [options]
       gsp agents --check [file...] [options]

Add a short note about gsp to AGENTS.md (Codex, Cursor, GitHub Copilot,
OpenCode) and/or CLAUDE.md (Claude Code), at the repository's root. Without
file names, pick them. Running it again updates its own note, or replaces
an older one, and leaves the rest alone.

With --check, read the files (any file named, or the repository's AGENTS.md
and CLAUDE.md) and print each line whose advice contradicts gsp, such as
"git branch -D" or "git worktree remove", with what to write instead.
Changes nothing; exits with 5 when it found something.

Options:
      --check        Report outdated advice instead of writing the note
      --json         With --check: print the findings as one JSON document
${GLOBAL_OPTIONS}

Common tasks:
  gsp agents AGENTS.md CLAUDE.md       Add or update the note
  gsp agents --check                   Find outdated advice
  gsp agents --check ~/.claude/CLAUDE.md
                                       Check a file outside the repository`;

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
