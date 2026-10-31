# Change Log

All notable changes to the "git-sweep-pro" extension are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org) and the changelog is generated automatically from [Conventional Commits](https://www.conventionalcommits.org).

## [2.1.1](https://github.com/MAXOUXAX/git-sweep-pro/compare/v2.1.0...v2.1.1) (2026-10-31)


### Bug Fixes

* **clean:** count husky's generated hooks as regenerable ([#39](https://github.com/MAXOUXAX/git-sweep-pro/issues/39)) ([2524539](https://github.com/MAXOUXAX/git-sweep-pro/commit/2524539d25a55ce3185ff66dbf8551ac0b8f1640))

# [2.1.0](https://github.com/MAXOUXAX/git-sweep-pro/compare/v2.0.1...v2.1.0) (2026-10-29)


### Features

* keep new branches and worktrees in use out of the sweep ([#37](https://github.com/MAXOUXAX/git-sweep-pro/issues/37)) ([f8b36c2](https://github.com/MAXOUXAX/git-sweep-pro/commit/f8b36c2d2542d58741c7fe85ba2b20b50d5b39e6))

## [2.0.1](https://github.com/MAXOUXAX/git-sweep-pro/compare/v2.0.0...v2.0.1) (2026-10-29)


### Bug Fixes

* **git:** let git output more than 1 MB before failing a command ([#34](https://github.com/MAXOUXAX/git-sweep-pro/issues/34)) ([eda2b20](https://github.com/MAXOUXAX/git-sweep-pro/commit/eda2b20a75fb8f3229ccf10df5f153c76009bb48))

# [2.0.0](https://github.com/MAXOUXAX/git-sweep-pro/compare/v1.4.0...v2.0.0) (2026-10-29)


* feat(cli)!: make gsp clean the one command that cleans a repository ([#26](https://github.com/MAXOUXAX/git-sweep-pro/issues/26)) ([04fde97](https://github.com/MAXOUXAX/git-sweep-pro/commit/04fde971e9f3747d11417b294c83b2f48b6011ea))
* feat(post-pr)!: finish a merged pull request from any worktree, with proof ([#27](https://github.com/MAXOUXAX/git-sweep-pro/issues/27)) ([c420789](https://github.com/MAXOUXAX/git-sweep-pro/commit/c4207898b7872c95b79a2d6704c734b97972576f))


### Bug Fixes

* **clean:** two remote cleanup gaps found in the release review ([#32](https://github.com/MAXOUXAX/git-sweep-pro/issues/32)) ([0c9f12b](https://github.com/MAXOUXAX/git-sweep-pro/commit/0c9f12bfe2c3311646ebe40d5c8efee11949add0))


### Features

* **clean:** clean merged remote branches, worktree list states, default-protected names ([#28](https://github.com/MAXOUXAX/git-sweep-pro/issues/28)) ([3b263a8](https://github.com/MAXOUXAX/git-sweep-pro/commit/3b263a8b8724052860437b28bf90601527cf2c8c))
* **detection:** classify every local branch as dead or alive with a proof ([#25](https://github.com/MAXOUXAX/git-sweep-pro/issues/25)) ([3c759f5](https://github.com/MAXOUXAX/git-sweep-pro/commit/3c759f597a2cbbaa00d99f3fd92d20123d4d6faa))
* make coding agents use gsp correctly by default ([#30](https://github.com/MAXOUXAX/git-sweep-pro/issues/30)) ([65d18c5](https://github.com/MAXOUXAX/git-sweep-pro/commit/65d18c527ad3e3227fcd7f31e1ca422cde0012a8))
* **vscode:** extension parity with the 2.0 CLI ([#29](https://github.com/MAXOUXAX/git-sweep-pro/issues/29)) ([77a4ea7](https://github.com/MAXOUXAX/git-sweep-pro/commit/77a4ea7a55dc9f7b5de9b5c4e2198b1eb1d35047))


### BREAKING CHANGES

* gsp, gsp sweep and gsp list now run gsp clean (list is
clean --dry-run). Without a terminal, clean prints the plan and changes
nothing unless --yes is given, and exits 5 when deletions were planned but
not applied. --yes no longer escalates to git branch -D: branches with
unpushed or unmerged work need --force. Merged branches are always
candidates, so --merged is a deprecated no-op. list --json now emits the
schema 2 clean document instead of stale/protected/checkedOut/merged.
A cancelled prompt exits 4 and a confirmation refused for lack of --yes
exits 5; neither exits 0 any more. To migrate, run gsp clean --json to
read the plan, and gsp clean --yes (adding --force for named branches
with unpushed work) to apply it.

* fix(detection): refuse patch-id proofs when a merge adds work of its own

git cherry only lists non-merge commits, so a branch whose merge commit
adds code (a conflict resolution, an "evil merge") came out rebase-merged
or commits-merged once its other commits landed, losing that code.

The branch's merges are now checked with a combined diff: when one
changes something neither parent has, the patch-id, patch-id prefix and
per-commit proofs are refused. The file-state proof of the whole branch
still applies, since it compares the content the merges produced.

* fix(clean): leave hint placeholders unquoted and drop repeated reasons

* test(clean): cover the safety rules, the report and the remote fallbacks

* docs: document gsp clean, its JSON schema, safety rules and exit codes

* fix(clean): say that nothing was deleted when the picker is cancelled

* test(e2e): expect the clean summary from the extension commands

* perf(detection): skip costly proofs that cannot apply to plain branches

Every alive branch with several commits ran the per-commit proof, about
four git calls per commit. It now runs only for branches with merges or
with commits already on the base, the integration branches it is for.

The squash proof also stops before reading any tree when nothing on the
base touched the branch's files, and the merge check first asks once
whether any local branch has merges at all.

On 60 branches of three commits each, the analysis goes from 606 to 307
git calls.

* fix(detection): keep a branch alive when its analysis fails, alone

One failing git command rejected the whole analysis. Each branch is now
analysed on its own: one whose analysis throws comes out alive, with the
new `analysis-failed` reason and the error in an `error` evidence, and
the other branches keep their verdicts.

* fix(detection): never fetch missing objects of a partial clone

Reading a blob a partial clone lacks made git fetch it, writing objects
during a read-only analysis. Every git call of the analysis now runs with
`--no-lazy-fetch` when git supports it (2.44+): it is the command-line
form of GIT_NO_LAZY_FETCH=1, which the analysis cannot set through its git
runner. A missing object then fails that branch's analysis, which stays
alive.

A worktree whose status cannot be read now counts as dirty rather than
clean.

* fix(detection): attach branches being rebased or bisected to their worktree

A rebase or a bisect detaches HEAD, so `git worktree list` showed the
worktree as detached and the branch it works on looked free to delete.

For each detached worktree, the analysis now reads the branch from the
worktree's git dir (rebase-merge/head-name, rebase-apply/head-name,
BISECT_START), attaches the worktree to it and reports the operation in
the new `worktree.inProgress` field ('rebase', 'bisect' or null).

* docs(detection): say unpushed commits are only exact after a pruning fetch

* refactor(clean): split the workflow into an inspect and an apply step

post-pr needs the same fetch, analysis and deletions as clean without its picker, so the steps are exported on their own.

* feat(post-pr)!: finish a merged pull request from any worktree, with proof

gsp post-pr [<branch>] [--into <default>] deletes the merged branch only
when the analysis proves its work is in the default branch, with the rules
of gsp clean --yes; otherwise it changes nothing on it, says why and exits
with 5. --force deletes a branch that is not merged, never a protected one.

It works where agents stand: run from the branch's linked worktree, it
removes that worktree, carries on from the main checkout and reports where
to continue (nextCwd); when the branch is checked out in the main checkout,
that checkout is switched to the default branch first, unless it has
uncommitted changes. The default branch is fast-forwarded where it is
checked out when that worktree is clean, or moved as a ref when it is
checked out nowhere. The clean step that follows uses proof-only rules.

--dry-run, and runs without a terminal and without --yes, only plan and
write nothing. --json prints one schema-2 document. A plan that cannot see
the merge yet because it is not fetched says so instead of suggesting
--force.
* post-pr no longer takes the branch to switch to. Its
positional argument is now the merged branch; "gsp post-pr main" still
works, with a deprecation note. A branch that is not proven merged is no
longer force-deleted: pass --force. Without a terminal, post-pr needs --yes
to change anything.

* docs(post-pr): document finishing a merged pull request and its JSON

* feat(clean): point the current and main-checkout branches at gsp post-pr

post-pr now leaves the worktree before deleting a branch checked out there, so it is the one command that resolves both skips.

* fix(clean): keep branches being rebased, worktrees with ignored files, and give hints that lose nothing

Adopt the analysis of #25: a branch being rebased or bisected is skipped
(rebase-in-progress, bisect-in-progress) whatever the flags, and a failed
analysis reads as such. A linked worktree holding ignored files that a
build does not recreate is skipped as ignored-files, with the files listed;
--force lifts it. The dirty-worktree hint stashes the changes instead of
removing the worktree, post-pr is only suggested for a dead current branch,
deleteMerged=false gets no hint, and an empty branch that had an upstream
reads as already in the base.

* fix(clean): plan before any write, then delete only what was approved and is still proven

The picker and the --yes path now work on a read-only plan. Once it is
approved, gsp fetches, prunes, analyses again and holds the result to the
plan: a branch that changed is skipped as plan-changed, one whose worktree
changed as worktree-changed, and after a failed fetch one proven only by
remote-tracking refs as fetch-failed. Unmerged branches deleted with a
compare-and-swap on the analysed commit. Git's own error line is reported,
the fetch warning is printed once, ls-remote only turns branches alive for
their unmerged commits into upstream-gone, and branches needing --force are
only offered with --force, never pre-selected.

* fix(cli): print the command that applies exactly the plan shown, and JSON errors

The apply command names the planned branches (up to 10), or repeats the
patterns, and keeps -C, --protect, --no-github and --no-fetch. With --json
a fatal error is one JSON document. The help says what exit code 5 means
for clean and for the commands that need a confirmation.

* fix(vscode): name the run modes after what they offer

* docs: document the plan-then-apply order, ignored files and the new skip reasons

* test(post-pr): cover the decision on the merged branch and the wording

* feat(clean): let --yes delete what the fetch proves in the same run

* fix(clean): ask to save ignored files before forcing a worktree removal

* fix(post-pr): print a JSON error document when it stops early, as clean does

* fix(clean): delete nothing when the default branch changes during the fetch

The fetch no longer forces remote.<name>.followRemoteHEAD=always, and when
the default branch found after the fetch differs from the plan's, every
deletion is skipped as plan-changed. The plan's default branch is never
deleted.

* fix(clean): count a folder as regenerable only when Git reports it whole

An ignored file under a tracked folder named build or dist is no longer
regenerable, secret-like names never are, and the ignored build and cache
folders are searched for .env, key and .npmrc files before a worktree goes.

* fix(clean): see untracked files even when status.showUntrackedFiles hides them

* fix(clean): check a worktree against the ignored files the plan showed

The last check before removing a worktree compared counts with the
analysis made after the fetch, so a file replacing one the plan showed
went unnoticed. It now compares paths with the plan, and the worktree
path too.

* fix(clean): blame the failed fetch, and never say nothing to clean when exiting 5

A planned deletion that only ls-remote proved is skipped as fetch-failed
when the fetch fails, not plan-changed. The summary names the skips that
another run may lift, and says "Nothing deleted" rather than "Nothing to
clean" when the exit code is 5.

* feat(clean): give the next command in the JSON document

A top-level next field holds the command the terminal output prints: the
one that applies what the plan left, or a dry run to review what changed
while applying. null when nothing gsp can do on its own is left.

* fix(worktree): keep git worktree remove from deleting hidden untracked files

With status.showUntrackedFiles=no, Git's own check before removing a
worktree does not see untracked files, and deletes them. gsp clean and
gsp worktree remove now run it with that setting set back to normal.

* fix(clean): skip worktrees holding submodules instead of failing to remove them

git worktree remove refuses a worktree with checked-out submodules. The
plan now finds them, read-only, the way Git does, and skips the branch as
submodules with a hint to check them first.

* docs: say what exit 5 covers, and what restore leaves out

Exit 5 also covers deletions held back while applying, and the output says
why and what to run next. The README says how a default branch changed by
the fetch is handled, and that restore does not bring back branch settings
other than the upstream.

* fix(clean): only explain a changed default branch when it held a deletion back

* feat(clean): protect main, master, trunk and develop unless named exactly

When the remote's default branch moves, the old one looks merged into the
new one. These names are now kept with reason protected (by default-name),
and naming one exactly on the command line lifts only that protection.

* feat(clean): delete merged branches on the remote with --remote

gsp clean --remote[=<name>] also plans the branches on origin (or the remote
named) whose work is proven on the default branch, with the same proofs as
local branches. It never touches the default branch, protected names, the
head of an open pull request, or a branch a kept local branch tracks.

The plan reads the remote with git ls-remote and writes nothing. Deletions
need --yes, are never forced, and push with a lease on the analysed tip, so
a branch pushed to since is skipped as plan-changed. Each one is recorded:
gsp restore origin/<branch> pushes it back. The JSON document gets a
remoteBranches array and summary.remote; the terminal an "On origin" section.

* feat(worktree): show each worktree's state and clean plan in worktree list

gsp worktree list now gives, per worktree, its head, whether it is the
main one, locked, prunable or dirty, a rebase or bisect in progress, the
ignored files removing it would delete, and what gsp clean would do with
its branch, with the reason and the hint. It reads the same read-only
plan as gsp clean.

--json prints a schema 2 document, {"schema":2,"command":"worktree list",
"worktrees":[...]}, instead of a bare array, so agents no longer scrape
paths out of the human list.

* test(clean): cover --remote from the picker and through the CLI

* docs: show gsp clean --remote among the everyday commands

* fix(post-pr): delete nothing when the default branch changes during the fetch

* refactor: remove the old sweep workflow, which nothing runs any more

It was the last code to fetch with followRemoteHEAD=always and to remove
worktrees without WORKTREE_REMOVE.

* test(post-pr): keep a worktree whose untracked file status.showUntrackedFiles hides

* feat(post-pr): carry on when the merged branch is already deleted

After gh pr merge --delete-branch the local branch is gone. Naming it is
no longer a usage error: gsp says it is already deleted, then updates the
default branch and cleans. In JSON, branch is { name, action: "gone" }.

* feat(post-pr): give the next command in the JSON document

* fix: stop quoting --remote=<name> in suggested commands

An equals sign after the first character means nothing to the shell, so hints like gsp clean --remote=upstream --yes can be pasted as shown.

* fix: keep the whole first line of a remote's error

A push the remote rejects reports 'remote: error: …', sometimes wrapped over several lines. Keep that message without its prefixes, joined back together, instead of the first line cut short.

* fix(restore): tell a local origin/x from x deleted on origin

Deletions were told apart by their label alone, so a local branch literally named origin/x hid the deletion of x on origin. Each kind now has its own key, lists show a remote one as 'origin/x (remote)', and naming one that matches both asks to pick it instead. gsp restore origin/x still restores a remote deletion.

* fix(worktree): align the list columns and keep detached worktrees

The plan column of gsp worktree list now starts at the same place on every line, whatever the state column holds. A detached linked worktree has no branch gsp clean could delete: it is reported as action keep, reason detached, instead of nulls.

* fix(clean): never delete a remote branch that should stay with --remote

Remote branches are now proven against that remote's own default branch,
as its server names it (git ls-remote --symref, in the same call as the
branch list, and again after the fetch), with the pull requests of its own
GitHub repository. A branch merged only into the fork's main is no longer
deleted on upstream, and upstream's default branch is protected even
without a local upstream/HEAD. When the server names no default branch,
every branch there is skipped as remote-default-unknown.

On a GitHub remote, every open pull request is listed (up to 1000), and,
in a fork, those opened from it on the parent repository. A branch that is
the head (by SHA, or by name in its own repository) or the base of one is
kept (open-pr, open-pr-base). When the list cannot be read in full (gh
missing, failing or unauthenticated, too many, or --no-github), nothing
there is deleted (github-unavailable), with a warning and a hint.

Also:
- a bare name lifts the long-lived-name protection locally only; the
  remote branch needs its qualified name (origin/develop), which hints and
  the next command now use;
- branch.<name>.deleteMerged=false protects that branch's upstream too;
- `--remote upstream` suggests --remote=upstream; "No branch named";
- refs of a remote nested in the name ("team/up" in "team") are not its own;
- plan-changed hints keep -C, --no-github, --no-fetch and --remote.

The test fixture's bare remote now has a HEAD, as a real server does.

* docs: explain how --remote finds the default branch and open pull requests

* refactor: remove the merged-branches and default-branch modules

Nothing imports them since the branch analysis replaced them. The real-git
tests that used them now check the analysis instead.

* fix(post-pr): name the update in the reflog, and hint with short refs

The default branch moved as a ref now shows "gsp post-pr" in its reflog,
and the hint to fast-forward a dirty checkout reads origin/main instead of
refs/remotes/origin/main.

* fix(post-pr): exit 5 whenever a plan gives a next command

A plan whose only change is fetching the default branch printed a command
to apply it but exited 0. One rule now decides both: what applying would
change. A kept merged branch still exits 5.

* fix(post-pr): suggest pushing, fetching or --into before --force

A merged branch that is not proven merged no longer gets --force as its
first hint. Unpushed commits point to git push; a remote that has new
commits points to fetching first; a merged pull request with another base,
or another remote branch that holds the tip, points to --into. The skip
label only says "needs --force" when the hint does.

Every command post-pr suggests, the review after the default branch
changed included, now keeps -C, --into, --protect, --no-github and
--no-fetch.

* fix(post-pr): never delete a protected branch named on the command line

"gsp post-pr develop" deleted develop when it was protected and merged.
The positional never lifts protection now: the default branch, as main or
origin/main, a protected branch, or the branch of the main checkout when
gsp runs in another worktree is read as the old "gsp post-pr <default>"
form, and the current branch is finished. With no current branch to
finish, a protected name is a usage error that points to --into. The old
form is recognised after the analysis, so it no longer needs origin/HEAD.

A missing branch counts as already deleted only when gsp deleted it, a
remote branch of that name is still listed, or GitHub shows its pull
request merged. Any other one is a usage error with the code
unknown-branch, which suggests the closest names; so is an unknown --into.

* fix(post-pr): continue in another worktree when the main repository is bare

Once the worktree gsp ran in is removed, nextCwd pointed to the bare
repository. It now points to another worktree, or is null with a message
when there is none.

* fix(post-pr): check the branch has not moved before switching the main checkout

The main checkout was switched away from the merged branch before its tip
was checked, so a branch that moved meanwhile left the checkout switched
for nothing. It is now skipped as plan-changed first.

* docs(post-pr): explain exit 5, the positional and missing branches

For post-pr, 5 also means the branch you asked to finish isn't finished.
The help and the README now say how a protected positional is read, when
a missing branch counts as already deleted, and which hints come before
--force.

* fix(post-pr): suggest fetching before pushing

Right after a merge, a branch whose upstream was pruned holds commits found
nowhere else until the merge is fetched. Hinting git push first would
recreate the remote branch the merge deleted.

* fix(post-pr): finish a named branch even when the main checkout has it

* fix(post-pr): say a named branch has no local branch instead of already deleted

The JSON action becomes "no-local-branch": the branch may still exist on the remote, so "gone" said too much.

* refactor: remove the unused local branch ref parser exports

* fix(restore): say a branch exists on the remote again instead of printing git's rejection

* fix(clean): keep what is kept when the remote's default branch is unknown

* fix(clean): find every open pull request before deleting on a GitHub remote

- Tell a GitHub remote by the URL Git uses (insteadOf applied), with SSH
  host aliases resolved through ssh -G, and by the hosts gh is logged in
  to. With --remote, a host nothing identifies is skipped as
  github-unavailable (unknown-host) unless git-sweep-pro.forge says
  github or none. gh is asked about the resolved host.
- Compare owners with the name GitHub uses today, match SHAs from any
  fork on the parent, and also read the open pull requests on the root
  of the fork network.
- Give gh 60 s to list pull requests, and report a timeout as such.

* fix(clean): refuse --remote on a remote that pushes elsewhere than it fetches from

* test(post-pr): read a default name as the old form without --protect

* fix(clean): compare --remote's fetch and push URLs by repository

A remote that fetches over https and pushes over SSH to the same repository, through pushInsteadOf for instance, is now cleaned. URLs match when they point to the same server, SSH aliases resolved, and the same path, whatever the protocol, the case or a .git suffix.

* feat(rpc): send the --json document as a result event

With --rpc, stdout carries NDJSON events, so an indented JSON document broke the stream. The document, or the JSON error, now arrives as one result event, which the extension's CLI client returns with the exit code.

* feat(vscode): plan and apply clean through the CLI's JSON

Sweep Stale Branches now reads the read-only plan of gsp clean --json over
RPC and shows it in one quick pick: proven deletions selected, skipped and
kept branches below with their reason, and a button that copies the command
fixing a skip. A title-bar toggle offers the branches that need a forced
delete, never selected. After a confirmation, the extension deletes exactly
the picked branches with --yes, and offers Undo in the result.

With gitSweepPro.cleanRemoteBranches, the remote's merged branches get their
own section and confirmation, and are deleted in a second run with
--remote and their qualified names only, so picking a local branch never
deletes the remote one of the same name. gitSweepPro.github maps to
--no-github. The mode dialog is gone: the picker replaces it.

* feat(vscode): finish merged pull requests with a preview

Finish Merged Pull Request (formerly Post Pull Request Cleanup) previews
gsp post-pr --json, then applies it for the same branch. A branch that is
not proven merged is explained, with its fix to copy; when the remote has
commits not fetched yet, it offers to fetch and finish. When the run
removes the worktree this window has open, the result offers to open the
main checkout, and Undo restores from there.

* feat(vscode): add worktree commands

Show Worktrees lists every worktree from gsp worktree list --json, with its
state and what Sweep Stale Branches would do with it, and lets you open,
remove or prune one. Remove Worktree never forces without a second,
explicit confirmation, and blocks on ignored files a build does not
recreate, as gsp clean does. Prune Worktrees forgets the worktrees whose
folder is gone.

* docs: describe the extension's commands and settings for 2.0

* chore: add screenshots for the pull request review

* chore: remove the review screenshots

* feat(worktree)!: check a worktree is safe before gsp worktree remove

gsp worktree remove now makes the checks gsp clean makes before removing
a worktree. It keeps a worktree that is locked, has a rebase or bisect in
progress, has uncommitted changes or untracked files, holds submodules,
or holds ignored files a build does not recreate (it lists them). --force
lifts every check but the lock. A kept worktree exits with 5 and a hint;
--json prints the result as one document.
* gsp worktree remove exits with 5 when it keeps a
worktree, and with 2 when the target is the main worktree, no worktree, or
two different ones (it exited with 1). It now refuses a worktree holding
ignored files such as a .env unless --force is given.

* feat(clean): hold named branches to an expected tip with --expect

* fix(worktree): keep stdout to protocol events in --rpc mode

* feat(agents)!: rewrite the gsp agents note for 2.0, and add --check

The note gsp agents writes into AGENTS.md and CLAUDE.md now gives agents
the exact command for each task: finishing a merged pull request,
cleaning the repository, deleting one branch, removing a scratch
worktree, listing worktrees, cleaning remote branches and undoing a
deletion. It tells them not to use git branch -D, git worktree remove or
git push --delete, and lists the 2.0 exit codes.

gsp agents also replaces an older gsp note without markers (a "Git
cleanup" section about gsp) in place, and says so.

gsp agents --check [file...] reads the instruction files and prints each
line whose advice contradicts gsp, with what to write instead. It changes
nothing, exits with 5 when it found something, and accepts --json.
* the note gsp agents writes no longer describes the 1.x
gsp list --json fields or says --yes force-deletes; rerun gsp agents to
update existing notes.

* docs(help): open with common tasks and give each command its own

gsp help now says what 2.0 covers and opens with the five tasks agents and people run most, before the command list. The worktree, restore and agents help gain their own common tasks, and the help documents the new worktree remove checks, agents --check and their exit codes.

* docs(readme): add a section for coding agents

The README opens with the commands agents need, the note gsp agents writes (to copy into files outside a repository), and documents agents --check, the worktree remove checks and their JSON. The hints intro no longer claims every hint is a command: the ignored-files hint starts with a step taken by hand.

* refactor: remove helpers nothing uses anymore

parseGoneBranchRefs, formatSweepSummary, formatSweepOutcome, describeSweepMode, findOtherWorktreeBranch, findIgnoredFiles, findMainWorktree and modeToCliArgs were only called by their own tests since the 2.0 rewrite.

* test(cli): follow the exit code 5 help as it now wraps

* feat(vscode): let a gsp run be cancelled, or leave its information messages out

* fix(vscode): hold the sweep to the branches and tips the picker showed

Each pick is applied with --expect at the tip the picker showed, and forced
picks go in their own --force run, so proven picks never get --force.

Also in the picker and its result:
- with cleanRemoteBranches on and no remote to pick, the local plan opens
  with a note saying why remote branches are missing;
- unchecking a branch unchecks the remote branch it tracks, and says why;
- the placeholder says Enter deletes when there is no confirmation;
- the force toggle's icon shows its state;
- closing the picker before the plan is read stops it quietly;
- Undo says what it restored, with progress;
- result lists stop at eight names.

* fix(vscode): finish a merged pull request after fetching without crashing

"Fetch and finish" read the window's worktree before computing it. It is
now offered only for a branch not proven yet while the remote has new
commits, and its dialog lists what goes with the branch: its worktree, the
other merged branches and this window's folder. The preview says that any
other branch proven merged after fetching is deleted too, and lists at most
eight names.

* fix(vscode): shorten the picker's note on a remote branch tracked by a kept one

* chore: add screenshots for the pull request review

* chore: remove the review screenshots

* fix(worktree): let ignored symlinks and common tool caches go with a worktree

Git reports a symlinked node_modules without its trailing slash, so it
counted as a file and kept the worktree. Removing a worktree only unlinks
a symlink, so any ignored one is regenerable unless its name looks like a
secret. .vscode-test, .expo, storybook-static, .angular, .nx, .yarn/cache,
.terraform and .eslintcache are caches or downloads too.

* feat!: split --discard-changes from --force

--force now only lifts the proof that a branch's work exists elsewhere,
which gsp restore can undo. Removing a worktree with files that are lost
for good needs --discard-changes, in clean, post-pr and worktree remove:

- clean and post-pr: a worktree holding ignored files a build does not
  recreate goes only with --discard-changes. Dirty worktrees, submodules
  and a rebase in progress stay; their hint stashes or continues first,
  then names gsp worktree remove <path> --discard-changes.
- worktree remove: --discard-changes lifts uncommitted changes, ignored
  files, submodules and a rebase or bisect in progress. A lock is never
  lifted. --force is a usage error there, since it deletes no branch.
- The kept worktree lists what would be lost (changedFiles, ignoredFiles)
  and is no longer printed as an error. Its JSON gains next and nextCwd,
  and a worktree mid-rebase is found by its branch.
- worktree list --json gives each worktree's submodules. The extension
  removes a worktree with --json, maps its double confirmation to
  --discard-changes, says why gsp kept it on exit 5, and its picker's
  force toggle no longer offers worktrees holding ignored files.
- summary.needsDiscardChanges counts ignored-files skips; needsForce now
  counts needs-force only.
* --force no longer removes a worktree holding ignored
files (use --discard-changes), gsp worktree remove rejects --force (use
--discard-changes), and summary.needsForce no longer counts ignored-files
skips (see summary.needsDiscardChanges).

* feat(post-pr): give the safe step of a kept branch's hint as next

When the merged branch is kept, next is now the part of its hint that
loses nothing and needs no approval: stash the changes, push, continue
the rebase. A hint that needs --force, --discard-changes or a person's
hand first leaves next null, as before.

* fix(clean): keep -C, --no-github and --no-fetch in each branch's hint

The next command kept the options of the run, but per-branch hints did
not: run offline or from another directory, a hint ran differently from
the plan it came with.

* test(cli): cover where --discard-changes is accepted

* fix(agents): replace only notes gsp wrote, and leave other sections for review

gsp agents replaced any "Git cleanup" section whose paragraphs mentioned
gsp, so it could delete a person's own text. It now replaces its marked
block, or a section that is word for word a note an older gsp shipped
(1.3.0, 1.3.1, 1.4.0), whitespace aside. Any other such section stays: the
block is added next to it, and gsp agents names its line for review.

- Only one note is replaced; another copy is reported, by gsp agents and
  by --check.
- Code blocks are skipped: their markers, notes and raw Git examples.
- --check judges raw Git by the clause it is in, catches the 1.x
  "gsp post-pr main" form, "gsp worktree remove --force", and the 1.x
  list fields without backticks, and reads a file linked from another once.
- Each line keeps its own line ending; the block takes the file's
  dominant one.
- A CLAUDE.md linked to an AGENTS.md that does not exist yet creates it,
  within the repository; otherwise gsp says why it can't.

* docs(agents): rewrite the note for --discard-changes

The note now says why gsp is safer (it checks no work would be lost, and
gsp restore recreates the branches it deletes), keeps --force for the
branches a person agreed to lose, and tells agents to read why a worktree
was kept before adding --discard-changes, which deletes files for good.
Exit code 5 says to ask before adding either flag, and restore names the
remote form. The README copy follows.

* docs(cli): give agents and restore help their exit codes

* fix(vscode): keep a worktree holding ignored files out of the force picker

The force toggle passes --force, which no longer removes such a worktree:
the branch stays in Skipped with its files, and the confirmation no longer
mentions ignored files it can't delete.

* fix(worktree): keep credentials and secrets found in build output

* fix(clean): name every planned branch in the command that applies a plan

* fix(cli): write the JSON error document for worktree list and restore too

* feat(post-pr): name every other branch in the command that applies a plan

Like gsp clean, the command that applies a post-pr plan no longer reaches
beyond it: --clean <branch> (repeatable) limits the clean step to the
branches named and --no-clean skips it. The next command and the hints on
the merged branch name every other branch the plan deletes, or pass
--no-clean when there is none, and a long command goes on its own line.

* fix(post-pr): ask before deleting a merged branch that only the fetch proves

* test(clean): name every remote branch in the command that applies a plan

* fix(restore): only push a remote branch back to a configured remote

* fix(vscode): finish a merged pull request with only the branches its preview listed

Applying passes --clean for each other branch the preview named, or --no-clean when it named none, so a branch the fetch alone proved since is never deleted without being shown. The preview no longer promises to delete unnamed branches.

* chore: add screenshots for the pull request review

* chore: remove the review screenshots

* fix(agents): report a file agents --check cannot read instead of crashing

* fix(worktree): keep a worktree whose rebase started on a detached HEAD

* fix(worktree): name the ignored files a worktree with submodules would lose

* fix(agents): never write through a dangling link to another link

* fix(worktree): keep ignored symbolic links unless named like a regenerable folder

* fix(vscode): name the ignored files of a worktree kept for its submodules
* **vscode:** gsp, gsp sweep and gsp list now run gsp clean (list is
clean --dry-run). Without a terminal, clean prints the plan and changes
nothing unless --yes is given, and exits 5 when deletions were planned but
not applied. --yes no longer escalates to git branch -D: branches with
unpushed or unmerged work need --force. Merged branches are always
candidates, so --merged is a deprecated no-op. list --json now emits the
schema 2 clean document instead of stale/protected/checkedOut/merged.
A cancelled prompt exits 4 and a confirmation refused for lack of --yes
exits 5; neither exits 0 any more. To migrate, run gsp clean --json to
read the plan, and gsp clean --yes (adding --force for named branches
with unpushed work) to apply it.

* fix(detection): refuse patch-id proofs when a merge adds work of its own

git cherry only lists non-merge commits, so a branch whose merge commit
adds code (a conflict resolution, an "evil merge") came out rebase-merged
or commits-merged once its other commits landed, losing that code.

The branch's merges are now checked with a combined diff: when one
changes something neither parent has, the patch-id, patch-id prefix and
per-commit proofs are refused. The file-state proof of the whole branch
still applies, since it compares the content the merges produced.

* fix(clean): leave hint placeholders unquoted and drop repeated reasons

* test(clean): cover the safety rules, the report and the remote fallbacks

* docs: document gsp clean, its JSON schema, safety rules and exit codes

* fix(clean): say that nothing was deleted when the picker is cancelled

* test(e2e): expect the clean summary from the extension commands

* perf(detection): skip costly proofs that cannot apply to plain branches

Every alive branch with several commits ran the per-commit proof, about
four git calls per commit. It now runs only for branches with merges or
with commits already on the base, the integration branches it is for.

The squash proof also stops before reading any tree when nothing on the
base touched the branch's files, and the merge check first asks once
whether any local branch has merges at all.

On 60 branches of three commits each, the analysis goes from 606 to 307
git calls.

* fix(detection): keep a branch alive when its analysis fails, alone

One failing git command rejected the whole analysis. Each branch is now
analysed on its own: one whose analysis throws comes out alive, with the
new `analysis-failed` reason and the error in an `error` evidence, and
the other branches keep their verdicts.

* fix(detection): never fetch missing objects of a partial clone

Reading a blob a partial clone lacks made git fetch it, writing objects
during a read-only analysis. Every git call of the analysis now runs with
`--no-lazy-fetch` when git supports it (2.44+): it is the command-line
form of GIT_NO_LAZY_FETCH=1, which the analysis cannot set through its git
runner. A missing object then fails that branch's analysis, which stays
alive.

A worktree whose status cannot be read now counts as dirty rather than
clean.

* fix(detection): attach branches being rebased or bisected to their worktree

A rebase or a bisect detaches HEAD, so `git worktree list` showed the
worktree as detached and the branch it works on looked free to delete.

For each detached worktree, the analysis now reads the branch from the
worktree's git dir (rebase-merge/head-name, rebase-apply/head-name,
BISECT_START), attaches the worktree to it and reports the operation in
the new `worktree.inProgress` field ('rebase', 'bisect' or null).

* docs(detection): say unpushed commits are only exact after a pruning fetch

* refactor(clean): split the workflow into an inspect and an apply step

post-pr needs the same fetch, analysis and deletions as clean without its picker, so the steps are exported on their own.

* feat(post-pr)!: finish a merged pull request from any worktree, with proof

gsp post-pr [<branch>] [--into <default>] deletes the merged branch only
when the analysis proves its work is in the default branch, with the rules
of gsp clean --yes; otherwise it changes nothing on it, says why and exits
with 5. --force deletes a branch that is not merged, never a protected one.

It works where agents stand: run from the branch's linked worktree, it
removes that worktree, carries on from the main checkout and reports where
to continue (nextCwd); when the branch is checked out in the main checkout,
that checkout is switched to the default branch first, unless it has
uncommitted changes. The default branch is fast-forwarded where it is
checked out when that worktree is clean, or moved as a ref when it is
checked out nowhere. The clean step that follows uses proof-only rules.

--dry-run, and runs without a terminal and without --yes, only plan and
write nothing. --json prints one schema-2 document. A plan that cannot see
the merge yet because it is not fetched says so instead of suggesting
--force.
* **vscode:** post-pr no longer takes the branch to switch to. Its
positional argument is now the merged branch; "gsp post-pr main" still
works, with a deprecation note. A branch that is not proven merged is no
longer force-deleted: pass --force. Without a terminal, post-pr needs --yes
to change anything.

* docs(post-pr): document finishing a merged pull request and its JSON

* feat(clean): point the current and main-checkout branches at gsp post-pr

post-pr now leaves the worktree before deleting a branch checked out there, so it is the one command that resolves both skips.

* fix(clean): keep branches being rebased, worktrees with ignored files, and give hints that lose nothing

Adopt the analysis of #25: a branch being rebased or bisected is skipped
(rebase-in-progress, bisect-in-progress) whatever the flags, and a failed
analysis reads as such. A linked worktree holding ignored files that a
build does not recreate is skipped as ignored-files, with the files listed;
--force lifts it. The dirty-worktree hint stashes the changes instead of
removing the worktree, post-pr is only suggested for a dead current branch,
deleteMerged=false gets no hint, and an empty branch that had an upstream
reads as already in the base.

* fix(clean): plan before any write, then delete only what was approved and is still proven

The picker and the --yes path now work on a read-only plan. Once it is
approved, gsp fetches, prunes, analyses again and holds the result to the
plan: a branch that changed is skipped as plan-changed, one whose worktree
changed as worktree-changed, and after a failed fetch one proven only by
remote-tracking refs as fetch-failed. Unmerged branches deleted with a
compare-and-swap on the analysed commit. Git's own error line is reported,
the fetch warning is printed once, ls-remote only turns branches alive for
their unmerged commits into upstream-gone, and branches needing --force are
only offered with --force, never pre-selected.

* fix(cli): print the command that applies exactly the plan shown, and JSON errors

The apply command names the planned branches (up to 10), or repeats the
patterns, and keeps -C, --protect, --no-github and --no-fetch. With --json
a fatal error is one JSON document. The help says what exit code 5 means
for clean and for the commands that need a confirmation.

* fix(vscode): name the run modes after what they offer

* docs: document the plan-then-apply order, ignored files and the new skip reasons

* test(post-pr): cover the decision on the merged branch and the wording

* feat(clean): let --yes delete what the fetch proves in the same run

* fix(clean): ask to save ignored files before forcing a worktree removal

* fix(post-pr): print a JSON error document when it stops early, as clean does

* fix(clean): delete nothing when the default branch changes during the fetch

The fetch no longer forces remote.<name>.followRemoteHEAD=always, and when
the default branch found after the fetch differs from the plan's, every
deletion is skipped as plan-changed. The plan's default branch is never
deleted.

* fix(clean): count a folder as regenerable only when Git reports it whole

An ignored file under a tracked folder named build or dist is no longer
regenerable, secret-like names never are, and the ignored build and cache
folders are searched for .env, key and .npmrc files before a worktree goes.

* fix(clean): see untracked files even when status.showUntrackedFiles hides them

* fix(clean): check a worktree against the ignored files the plan showed

The last check before removing a worktree compared counts with the
analysis made after the fetch, so a file replacing one the plan showed
went unnoticed. It now compares paths with the plan, and the worktree
path too.

* fix(clean): blame the failed fetch, and never say nothing to clean when exiting 5

A planned deletion that only ls-remote proved is skipped as fetch-failed
when the fetch fails, not plan-changed. The summary names the skips that
another run may lift, and says "Nothing deleted" rather than "Nothing to
clean" when the exit code is 5.

* feat(clean): give the next command in the JSON document

A top-level next field holds the command the terminal output prints: the
one that applies what the plan left, or a dry run to review what changed
while applying. null when nothing gsp can do on its own is left.

* fix(worktree): keep git worktree remove from deleting hidden untracked files

With status.showUntrackedFiles=no, Git's own check before removing a
worktree does not see untracked files, and deletes them. gsp clean and
gsp worktree remove now run it with that setting set back to normal.

* fix(clean): skip worktrees holding submodules instead of failing to remove them

git worktree remove refuses a worktree with checked-out submodules. The
plan now finds them, read-only, the way Git does, and skips the branch as
submodules with a hint to check them first.

* docs: say what exit 5 covers, and what restore leaves out

Exit 5 also covers deletions held back while applying, and the output says
why and what to run next. The README says how a default branch changed by
the fetch is handled, and that restore does not bring back branch settings
other than the upstream.

* fix(clean): only explain a changed default branch when it held a deletion back

* feat(clean): protect main, master, trunk and develop unless named exactly

When the remote's default branch moves, the old one looks merged into the
new one. These names are now kept with reason protected (by default-name),
and naming one exactly on the command line lifts only that protection.

* feat(clean): delete merged branches on the remote with --remote

gsp clean --remote[=<name>] also plans the branches on origin (or the remote
named) whose work is proven on the default branch, with the same proofs as
local branches. It never touches the default branch, protected names, the
head of an open pull request, or a branch a kept local branch tracks.

The plan reads the remote with git ls-remote and writes nothing. Deletions
need --yes, are never forced, and push with a lease on the analysed tip, so
a branch pushed to since is skipped as plan-changed. Each one is recorded:
gsp restore origin/<branch> pushes it back. The JSON document gets a
remoteBranches array and summary.remote; the terminal an "On origin" section.

* feat(worktree): show each worktree's state and clean plan in worktree list

gsp worktree list now gives, per worktree, its head, whether it is the
main one, locked, prunable or dirty, a rebase or bisect in progress, the
ignored files removing it would delete, and what gsp clean would do with
its branch, with the reason and the hint. It reads the same read-only
plan as gsp clean.

--json prints a schema 2 document, {"schema":2,"command":"worktree list",
"worktrees":[...]}, instead of a bare array, so agents no longer scrape
paths out of the human list.

* test(clean): cover --remote from the picker and through the CLI

* docs: show gsp clean --remote among the everyday commands

* fix(post-pr): delete nothing when the default branch changes during the fetch

* refactor: remove the old sweep workflow, which nothing runs any more

It was the last code to fetch with followRemoteHEAD=always and to remove
worktrees without WORKTREE_REMOVE.

* test(post-pr): keep a worktree whose untracked file status.showUntrackedFiles hides

* feat(post-pr): carry on when the merged branch is already deleted

After gh pr merge --delete-branch the local branch is gone. Naming it is
no longer a usage error: gsp says it is already deleted, then updates the
default branch and cleans. In JSON, branch is { name, action: "gone" }.

* feat(post-pr): give the next command in the JSON document

* fix: stop quoting --remote=<name> in suggested commands

An equals sign after the first character means nothing to the shell, so hints like gsp clean --remote=upstream --yes can be pasted as shown.

* fix: keep the whole first line of a remote's error

A push the remote rejects reports 'remote: error: …', sometimes wrapped over several lines. Keep that message without its prefixes, joined back together, instead of the first line cut short.

* fix(restore): tell a local origin/x from x deleted on origin

Deletions were told apart by their label alone, so a local branch literally named origin/x hid the deletion of x on origin. Each kind now has its own key, lists show a remote one as 'origin/x (remote)', and naming one that matches both asks to pick it instead. gsp restore origin/x still restores a remote deletion.

* fix(worktree): align the list columns and keep detached worktrees

The plan column of gsp worktree list now starts at the same place on every line, whatever the state column holds. A detached linked worktree has no branch gsp clean could delete: it is reported as action keep, reason detached, instead of nulls.

* fix(clean): never delete a remote branch that should stay with --remote

Remote branches are now proven against that remote's own default branch,
as its server names it (git ls-remote --symref, in the same call as the
branch list, and again after the fetch), with the pull requests of its own
GitHub repository. A branch merged only into the fork's main is no longer
deleted on upstream, and upstream's default branch is protected even
without a local upstream/HEAD. When the server names no default branch,
every branch there is skipped as remote-default-unknown.

On a GitHub remote, every open pull request is listed (up to 1000), and,
in a fork, those opened from it on the parent repository. A branch that is
the head (by SHA, or by name in its own repository) or the base of one is
kept (open-pr, open-pr-base). When the list cannot be read in full (gh
missing, failing or unauthenticated, too many, or --no-github), nothing
there is deleted (github-unavailable), with a warning and a hint.

Also:
- a bare name lifts the long-lived-name protection locally only; the
  remote branch needs its qualified name (origin/develop), which hints and
  the next command now use;
- branch.<name>.deleteMerged=false protects that branch's upstream too;
- `--remote upstream` suggests --remote=upstream; "No branch named";
- refs of a remote nested in the name ("team/up" in "team") are not its own;
- plan-changed hints keep -C, --no-github, --no-fetch and --remote.

The test fixture's bare remote now has a HEAD, as a real server does.

* docs: explain how --remote finds the default branch and open pull requests

* refactor: remove the merged-branches and default-branch modules

Nothing imports them since the branch analysis replaced them. The real-git
tests that used them now check the analysis instead.

* fix(post-pr): name the update in the reflog, and hint with short refs

The default branch moved as a ref now shows "gsp post-pr" in its reflog,
and the hint to fast-forward a dirty checkout reads origin/main instead of
refs/remotes/origin/main.

* fix(post-pr): exit 5 whenever a plan gives a next command

A plan whose only change is fetching the default branch printed a command
to apply it but exited 0. One rule now decides both: what applying would
change. A kept merged branch still exits 5.

* fix(post-pr): suggest pushing, fetching or --into before --force

A merged branch that is not proven merged no longer gets --force as its
first hint. Unpushed commits point to git push; a remote that has new
commits points to fetching first; a merged pull request with another base,
or another remote branch that holds the tip, points to --into. The skip
label only says "needs --force" when the hint does.

Every command post-pr suggests, the review after the default branch
changed included, now keeps -C, --into, --protect, --no-github and
--no-fetch.

* fix(post-pr): never delete a protected branch named on the command line

"gsp post-pr develop" deleted develop when it was protected and merged.
The positional never lifts protection now: the default branch, as main or
origin/main, a protected branch, or the branch of the main checkout when
gsp runs in another worktree is read as the old "gsp post-pr <default>"
form, and the current branch is finished. With no current branch to
finish, a protected name is a usage error that points to --into. The old
form is recognised after the analysis, so it no longer needs origin/HEAD.

A missing branch counts as already deleted only when gsp deleted it, a
remote branch of that name is still listed, or GitHub shows its pull
request merged. Any other one is a usage error with the code
unknown-branch, which suggests the closest names; so is an unknown --into.

* fix(post-pr): continue in another worktree when the main repository is bare

Once the worktree gsp ran in is removed, nextCwd pointed to the bare
repository. It now points to another worktree, or is null with a message
when there is none.

* fix(post-pr): check the branch has not moved before switching the main checkout

The main checkout was switched away from the merged branch before its tip
was checked, so a branch that moved meanwhile left the checkout switched
for nothing. It is now skipped as plan-changed first.

* docs(post-pr): explain exit 5, the positional and missing branches

For post-pr, 5 also means the branch you asked to finish isn't finished.
The help and the README now say how a protected positional is read, when
a missing branch counts as already deleted, and which hints come before
--force.

* fix(post-pr): suggest fetching before pushing

Right after a merge, a branch whose upstream was pruned holds commits found
nowhere else until the merge is fetched. Hinting git push first would
recreate the remote branch the merge deleted.

* fix(post-pr): finish a named branch even when the main checkout has it

* fix(post-pr): say a named branch has no local branch instead of already deleted

The JSON action becomes "no-local-branch": the branch may still exist on the remote, so "gone" said too much.

* refactor: remove the unused local branch ref parser exports

* fix(restore): say a branch exists on the remote again instead of printing git's rejection

* fix(clean): keep what is kept when the remote's default branch is unknown

* fix(clean): find every open pull request before deleting on a GitHub remote

- Tell a GitHub remote by the URL Git uses (insteadOf applied), with SSH
  host aliases resolved through ssh -G, and by the hosts gh is logged in
  to. With --remote, a host nothing identifies is skipped as
  github-unavailable (unknown-host) unless git-sweep-pro.forge says
  github or none. gh is asked about the resolved host.
- Compare owners with the name GitHub uses today, match SHAs from any
  fork on the parent, and also read the open pull requests on the root
  of the fork network.
- Give gh 60 s to list pull requests, and report a timeout as such.

* fix(clean): refuse --remote on a remote that pushes elsewhere than it fetches from

* test(post-pr): read a default name as the old form without --protect

* fix(clean): compare --remote's fetch and push URLs by repository

A remote that fetches over https and pushes over SSH to the same repository, through pushInsteadOf for instance, is now cleaned. URLs match when they point to the same server, SSH aliases resolved, and the same path, whatever the protocol, the case or a .git suffix.

* feat(rpc): send the --json document as a result event

With --rpc, stdout carries NDJSON events, so an indented JSON document broke the stream. The document, or the JSON error, now arrives as one result event, which the extension's CLI client returns with the exit code.

* feat(vscode): plan and apply clean through the CLI's JSON

Sweep Stale Branches now reads the read-only plan of gsp clean --json over
RPC and shows it in one quick pick: proven deletions selected, skipped and
kept branches below with their reason, and a button that copies the command
fixing a skip. A title-bar toggle offers the branches that need a forced
delete, never selected. After a confirmation, the extension deletes exactly
the picked branches with --yes, and offers Undo in the result.

With gitSweepPro.cleanRemoteBranches, the remote's merged branches get their
own section and confirmation, and are deleted in a second run with
--remote and their qualified names only, so picking a local branch never
deletes the remote one of the same name. gitSweepPro.github maps to
--no-github. The mode dialog is gone: the picker replaces it.

* feat(vscode): finish merged pull requests with a preview

Finish Merged Pull Request (formerly Post Pull Request Cleanup) previews
gsp post-pr --json, then applies it for the same branch. A branch that is
not proven merged is explained, with its fix to copy; when the remote has
commits not fetched yet, it offers to fetch and finish. When the run
removes the worktree this window has open, the result offers to open the
main checkout, and Undo restores from there.

* feat(vscode): add worktree commands

Show Worktrees lists every worktree from gsp worktree list --json, with its
state and what Sweep Stale Branches would do with it, and lets you open,
remove or prune one. Remove Worktree never forces without a second,
explicit confirmation, and blocks on ignored files a build does not
recreate, as gsp clean does. Prune Worktrees forgets the worktrees whose
folder is gone.

* docs: describe the extension's commands and settings for 2.0

* chore: add screenshots for the pull request review

* chore: remove the review screenshots

* feat(clean): hold named branches to an expected tip with --expect

* fix(worktree): keep stdout to protocol events in --rpc mode

* feat(vscode): let a gsp run be cancelled, or leave its information messages out

* fix(vscode): hold the sweep to the branches and tips the picker showed

Each pick is applied with --expect at the tip the picker showed, and forced
picks go in their own --force run, so proven picks never get --force.

Also in the picker and its result:
- with cleanRemoteBranches on and no remote to pick, the local plan opens
  with a note saying why remote branches are missing;
- unchecking a branch unchecks the remote branch it tracks, and says why;
- the placeholder says Enter deletes when there is no confirmation;
- the force toggle's icon shows its state;
- closing the picker before the plan is read stops it quietly;
- Undo says what it restored, with progress;
- result lists stop at eight names.

* fix(vscode): finish a merged pull request after fetching without crashing

"Fetch and finish" read the window's worktree before computing it. It is
now offered only for a branch not proven yet while the remote has new
commits, and its dialog lists what goes with the branch: its worktree, the
other merged branches and this window's folder. The preview says that any
other branch proven merged after fetching is deleted too, and lists at most
eight names.

* fix(vscode): shorten the picker's note on a remote branch tracked by a kept one

* chore: add screenshots for the pull request review

* chore: remove the review screenshots

* fix(worktree): keep credentials and secrets found in build output

* fix(clean): name every planned branch in the command that applies a plan

* fix(cli): write the JSON error document for worktree list and restore too

* feat(post-pr): name every other branch in the command that applies a plan

Like gsp clean, the command that applies a post-pr plan no longer reaches
beyond it: --clean <branch> (repeatable) limits the clean step to the
branches named and --no-clean skips it. The next command and the hints on
the merged branch name every other branch the plan deletes, or pass
--no-clean when there is none, and a long command goes on its own line.

* fix(post-pr): ask before deleting a merged branch that only the fetch proves

* test(clean): name every remote branch in the command that applies a plan

* fix(restore): only push a remote branch back to a configured remote

* fix(vscode): finish a merged pull request with only the branches its preview listed

Applying passes --clean for each other branch the preview named, or --no-clean when it named none, so a branch the fetch alone proved since is never deleted without being shown. The preview no longer promises to delete unnamed branches.

* chore: add screenshots for the pull request review

* chore: remove the review screenshots
* **clean:** gsp, gsp sweep and gsp list now run gsp clean (list is
clean --dry-run). Without a terminal, clean prints the plan and changes
nothing unless --yes is given, and exits 5 when deletions were planned but
not applied. --yes no longer escalates to git branch -D: branches with
unpushed or unmerged work need --force. Merged branches are always
candidates, so --merged is a deprecated no-op. list --json now emits the
schema 2 clean document instead of stale/protected/checkedOut/merged.
A cancelled prompt exits 4 and a confirmation refused for lack of --yes
exits 5; neither exits 0 any more. To migrate, run gsp clean --json to
read the plan, and gsp clean --yes (adding --force for named branches
with unpushed work) to apply it.

* fix(detection): refuse patch-id proofs when a merge adds work of its own

git cherry only lists non-merge commits, so a branch whose merge commit
adds code (a conflict resolution, an "evil merge") came out rebase-merged
or commits-merged once its other commits landed, losing that code.

The branch's merges are now checked with a combined diff: when one
changes something neither parent has, the patch-id, patch-id prefix and
per-commit proofs are refused. The file-state proof of the whole branch
still applies, since it compares the content the merges produced.

* fix(clean): leave hint placeholders unquoted and drop repeated reasons

* test(clean): cover the safety rules, the report and the remote fallbacks

* docs: document gsp clean, its JSON schema, safety rules and exit codes

* fix(clean): say that nothing was deleted when the picker is cancelled

* test(e2e): expect the clean summary from the extension commands

* perf(detection): skip costly proofs that cannot apply to plain branches

Every alive branch with several commits ran the per-commit proof, about
four git calls per commit. It now runs only for branches with merges or
with commits already on the base, the integration branches it is for.

The squash proof also stops before reading any tree when nothing on the
base touched the branch's files, and the merge check first asks once
whether any local branch has merges at all.

On 60 branches of three commits each, the analysis goes from 606 to 307
git calls.

* fix(detection): keep a branch alive when its analysis fails, alone

One failing git command rejected the whole analysis. Each branch is now
analysed on its own: one whose analysis throws comes out alive, with the
new `analysis-failed` reason and the error in an `error` evidence, and
the other branches keep their verdicts.

* fix(detection): never fetch missing objects of a partial clone

Reading a blob a partial clone lacks made git fetch it, writing objects
during a read-only analysis. Every git call of the analysis now runs with
`--no-lazy-fetch` when git supports it (2.44+): it is the command-line
form of GIT_NO_LAZY_FETCH=1, which the analysis cannot set through its git
runner. A missing object then fails that branch's analysis, which stays
alive.

A worktree whose status cannot be read now counts as dirty rather than
clean.

* fix(detection): attach branches being rebased or bisected to their worktree

A rebase or a bisect detaches HEAD, so `git worktree list` showed the
worktree as detached and the branch it works on looked free to delete.

For each detached worktree, the analysis now reads the branch from the
worktree's git dir (rebase-merge/head-name, rebase-apply/head-name,
BISECT_START), attaches the worktree to it and reports the operation in
the new `worktree.inProgress` field ('rebase', 'bisect' or null).

* docs(detection): say unpushed commits are only exact after a pruning fetch

* refactor(clean): split the workflow into an inspect and an apply step

post-pr needs the same fetch, analysis and deletions as clean without its picker, so the steps are exported on their own.

* feat(post-pr)!: finish a merged pull request from any worktree, with proof

gsp post-pr [<branch>] [--into <default>] deletes the merged branch only
when the analysis proves its work is in the default branch, with the rules
of gsp clean --yes; otherwise it changes nothing on it, says why and exits
with 5. --force deletes a branch that is not merged, never a protected one.

It works where agents stand: run from the branch's linked worktree, it
removes that worktree, carries on from the main checkout and reports where
to continue (nextCwd); when the branch is checked out in the main checkout,
that checkout is switched to the default branch first, unless it has
uncommitted changes. The default branch is fast-forwarded where it is
checked out when that worktree is clean, or moved as a ref when it is
checked out nowhere. The clean step that follows uses proof-only rules.

--dry-run, and runs without a terminal and without --yes, only plan and
write nothing. --json prints one schema-2 document. A plan that cannot see
the merge yet because it is not fetched says so instead of suggesting
--force.
* **clean:** post-pr no longer takes the branch to switch to. Its
positional argument is now the merged branch; "gsp post-pr main" still
works, with a deprecation note. A branch that is not proven merged is no
longer force-deleted: pass --force. Without a terminal, post-pr needs --yes
to change anything.

* docs(post-pr): document finishing a merged pull request and its JSON

* feat(clean): point the current and main-checkout branches at gsp post-pr

post-pr now leaves the worktree before deleting a branch checked out there, so it is the one command that resolves both skips.

* fix(clean): keep branches being rebased, worktrees with ignored files, and give hints that lose nothing

Adopt the analysis of #25: a branch being rebased or bisected is skipped
(rebase-in-progress, bisect-in-progress) whatever the flags, and a failed
analysis reads as such. A linked worktree holding ignored files that a
build does not recreate is skipped as ignored-files, with the files listed;
--force lifts it. The dirty-worktree hint stashes the changes instead of
removing the worktree, post-pr is only suggested for a dead current branch,
deleteMerged=false gets no hint, and an empty branch that had an upstream
reads as already in the base.

* fix(clean): plan before any write, then delete only what was approved and is still proven

The picker and the --yes path now work on a read-only plan. Once it is
approved, gsp fetches, prunes, analyses again and holds the result to the
plan: a branch that changed is skipped as plan-changed, one whose worktree
changed as worktree-changed, and after a failed fetch one proven only by
remote-tracking refs as fetch-failed. Unmerged branches deleted with a
compare-and-swap on the analysed commit. Git's own error line is reported,
the fetch warning is printed once, ls-remote only turns branches alive for
their unmerged commits into upstream-gone, and branches needing --force are
only offered with --force, never pre-selected.

* fix(cli): print the command that applies exactly the plan shown, and JSON errors

The apply command names the planned branches (up to 10), or repeats the
patterns, and keeps -C, --protect, --no-github and --no-fetch. With --json
a fatal error is one JSON document. The help says what exit code 5 means
for clean and for the commands that need a confirmation.

* fix(vscode): name the run modes after what they offer

* docs: document the plan-then-apply order, ignored files and the new skip reasons

* test(post-pr): cover the decision on the merged branch and the wording

* feat(clean): let --yes delete what the fetch proves in the same run

* fix(clean): ask to save ignored files before forcing a worktree removal

* fix(post-pr): print a JSON error document when it stops early, as clean does

* fix(clean): delete nothing when the default branch changes during the fetch

The fetch no longer forces remote.<name>.followRemoteHEAD=always, and when
the default branch found after the fetch differs from the plan's, every
deletion is skipped as plan-changed. The plan's default branch is never
deleted.

* fix(clean): count a folder as regenerable only when Git reports it whole

An ignored file under a tracked folder named build or dist is no longer
regenerable, secret-like names never are, and the ignored build and cache
folders are searched for .env, key and .npmrc files before a worktree goes.

* fix(clean): see untracked files even when status.showUntrackedFiles hides them

* fix(clean): check a worktree against the ignored files the plan showed

The last check before removing a worktree compared counts with the
analysis made after the fetch, so a file replacing one the plan showed
went unnoticed. It now compares paths with the plan, and the worktree
path too.

* fix(clean): blame the failed fetch, and never say nothing to clean when exiting 5

A planned deletion that only ls-remote proved is skipped as fetch-failed
when the fetch fails, not plan-changed. The summary names the skips that
another run may lift, and says "Nothing deleted" rather than "Nothing to
clean" when the exit code is 5.

* feat(clean): give the next command in the JSON document

A top-level next field holds the command the terminal output prints: the
one that applies what the plan left, or a dry run to review what changed
while applying. null when nothing gsp can do on its own is left.

* fix(worktree): keep git worktree remove from deleting hidden untracked files

With status.showUntrackedFiles=no, Git's own check before removing a
worktree does not see untracked files, and deletes them. gsp clean and
gsp worktree remove now run it with that setting set back to normal.

* fix(clean): skip worktrees holding submodules instead of failing to remove them

git worktree remove refuses a worktree with checked-out submodules. The
plan now finds them, read-only, the way Git does, and skips the branch as
submodules with a hint to check them first.

* docs: say what exit 5 covers, and what restore leaves out

Exit 5 also covers deletions held back while applying, and the output says
why and what to run next. The README says how a default branch changed by
the fetch is handled, and that restore does not bring back branch settings
other than the upstream.

* fix(clean): only explain a changed default branch when it held a deletion back

* feat(clean): protect main, master, trunk and develop unless named exactly

When the remote's default branch moves, the old one looks merged into the
new one. These names are now kept with reason protected (by default-name),
and naming one exactly on the command line lifts only that protection.

* feat(clean): delete merged branches on the remote with --remote

gsp clean --remote[=<name>] also plans the branches on origin (or the remote
named) whose work is proven on the default branch, with the same proofs as
local branches. It never touches the default branch, protected names, the
head of an open pull request, or a branch a kept local branch tracks.

The plan reads the remote with git ls-remote and writes nothing. Deletions
need --yes, are never forced, and push with a lease on the analysed tip, so
a branch pushed to since is skipped as plan-changed. Each one is recorded:
gsp restore origin/<branch> pushes it back. The JSON document gets a
remoteBranches array and summary.remote; the terminal an "On origin" section.

* feat(worktree): show each worktree's state and clean plan in worktree list

gsp worktree list now gives, per worktree, its head, whether it is the
main one, locked, prunable or dirty, a rebase or bisect in progress, the
ignored files removing it would delete, and what gsp clean would do with
its branch, with the reason and the hint. It reads the same read-only
plan as gsp clean.

--json prints a schema 2 document, {"schema":2,"command":"worktree list",
"worktrees":[...]}, instead of a bare array, so agents no longer scrape
paths out of the human list.

* test(clean): cover --remote from the picker and through the CLI

* docs: show gsp clean --remote among the everyday commands

* fix(post-pr): delete nothing when the default branch changes during the fetch

* refactor: remove the old sweep workflow, which nothing runs any more

It was the last code to fetch with followRemoteHEAD=always and to remove
worktrees without WORKTREE_REMOVE.

* test(post-pr): keep a worktree whose untracked file status.showUntrackedFiles hides

* feat(post-pr): carry on when the merged branch is already deleted

After gh pr merge --delete-branch the local branch is gone. Naming it is
no longer a usage error: gsp says it is already deleted, then updates the
default branch and cleans. In JSON, branch is { name, action: "gone" }.

* feat(post-pr): give the next command in the JSON document

* fix: stop quoting --remote=<name> in suggested commands

An equals sign after the first character means nothing to the shell, so hints like gsp clean --remote=upstream --yes can be pasted as shown.

* fix: keep the whole first line of a remote's error

A push the remote rejects reports 'remote: error: …', sometimes wrapped over several lines. Keep that message without its prefixes, joined back together, instead of the first line cut short.

* fix(restore): tell a local origin/x from x deleted on origin

Deletions were told apart by their label alone, so a local branch literally named origin/x hid the deletion of x on origin. Each kind now has its own key, lists show a remote one as 'origin/x (remote)', and naming one that matches both asks to pick it instead. gsp restore origin/x still restores a remote deletion.

* fix(worktree): align the list columns and keep detached worktrees

The plan column of gsp worktree list now starts at the same place on every line, whatever the state column holds. A detached linked worktree has no branch gsp clean could delete: it is reported as action keep, reason detached, instead of nulls.

* fix(clean): never delete a remote branch that should stay with --remote

Remote branches are now proven against that remote's own default branch,
as its server names it (git ls-remote --symref, in the same call as the
branch list, and again after the fetch), with the pull requests of its own
GitHub repository. A branch merged only into the fork's main is no longer
deleted on upstream, and upstream's default branch is protected even
without a local upstream/HEAD. When the server names no default branch,
every branch there is skipped as remote-default-unknown.

On a GitHub remote, every open pull request is listed (up to 1000), and,
in a fork, those opened from it on the parent repository. A branch that is
the head (by SHA, or by name in its own repository) or the base of one is
kept (open-pr, open-pr-base). When the list cannot be read in full (gh
missing, failing or unauthenticated, too many, or --no-github), nothing
there is deleted (github-unavailable), with a warning and a hint.

Also:
- a bare name lifts the long-lived-name protection locally only; the
  remote branch needs its qualified name (origin/develop), which hints and
  the next command now use;
- branch.<name>.deleteMerged=false protects that branch's upstream too;
- `--remote upstream` suggests --remote=upstream; "No branch named";
- refs of a remote nested in the name ("team/up" in "team") are not its own;
- plan-changed hints keep -C, --no-github, --no-fetch and --remote.

The test fixture's bare remote now has a HEAD, as a real server does.

* docs: explain how --remote finds the default branch and open pull requests

* refactor: remove the merged-branches and default-branch modules

Nothing imports them since the branch analysis replaced them. The real-git
tests that used them now check the analysis instead.

* fix(post-pr): name the update in the reflog, and hint with short refs

The default branch moved as a ref now shows "gsp post-pr" in its reflog,
and the hint to fast-forward a dirty checkout reads origin/main instead of
refs/remotes/origin/main.

* fix(post-pr): exit 5 whenever a plan gives a next command

A plan whose only change is fetching the default branch printed a command
to apply it but exited 0. One rule now decides both: what applying would
change. A kept merged branch still exits 5.

* fix(post-pr): suggest pushing, fetching or --into before --force

A merged branch that is not proven merged no longer gets --force as its
first hint. Unpushed commits point to git push; a remote that has new
commits points to fetching first; a merged pull request with another base,
or another remote branch that holds the tip, points to --into. The skip
label only says "needs --force" when the hint does.

Every command post-pr suggests, the review after the default branch
changed included, now keeps -C, --into, --protect, --no-github and
--no-fetch.

* fix(post-pr): never delete a protected branch named on the command line

"gsp post-pr develop" deleted develop when it was protected and merged.
The positional never lifts protection now: the default branch, as main or
origin/main, a protected branch, or the branch of the main checkout when
gsp runs in another worktree is read as the old "gsp post-pr <default>"
form, and the current branch is finished. With no current branch to
finish, a protected name is a usage error that points to --into. The old
form is recognised after the analysis, so it no longer needs origin/HEAD.

A missing branch counts as already deleted only when gsp deleted it, a
remote branch of that name is still listed, or GitHub shows its pull
request merged. Any other one is a usage error with the code
unknown-branch, which suggests the closest names; so is an unknown --into.

* fix(post-pr): continue in another worktree when the main repository is bare

Once the worktree gsp ran in is removed, nextCwd pointed to the bare
repository. It now points to another worktree, or is null with a message
when there is none.

* fix(post-pr): check the branch has not moved before switching the main checkout

The main checkout was switched away from the merged branch before its tip
was checked, so a branch that moved meanwhile left the checkout switched
for nothing. It is now skipped as plan-changed first.

* docs(post-pr): explain exit 5, the positional and missing branches

For post-pr, 5 also means the branch you asked to finish isn't finished.
The help and the README now say how a protected positional is read, when
a missing branch counts as already deleted, and which hints come before
--force.

* fix(post-pr): suggest fetching before pushing

Right after a merge, a branch whose upstream was pruned holds commits found
nowhere else until the merge is fetched. Hinting git push first would
recreate the remote branch the merge deleted.

* fix(post-pr): finish a named branch even when the main checkout has it

* fix(post-pr): say a named branch has no local branch instead of already deleted

The JSON action becomes "no-local-branch": the branch may still exist on the remote, so "gone" said too much.

* refactor: remove the unused local branch ref parser exports

* fix(restore): say a branch exists on the remote again instead of printing git's rejection

* fix(clean): keep what is kept when the remote's default branch is unknown

* fix(clean): find every open pull request before deleting on a GitHub remote

- Tell a GitHub remote by the URL Git uses (insteadOf applied), with SSH
  host aliases resolved through ssh -G, and by the hosts gh is logged in
  to. With --remote, a host nothing identifies is skipped as
  github-unavailable (unknown-host) unless git-sweep-pro.forge says
  github or none. gh is asked about the resolved host.
- Compare owners with the name GitHub uses today, match SHAs from any
  fork on the parent, and also read the open pull requests on the root
  of the fork network.
- Give gh 60 s to list pull requests, and report a timeout as such.

* fix(clean): refuse --remote on a remote that pushes elsewhere than it fetches from

* test(post-pr): read a default name as the old form without --protect

* fix(clean): compare --remote's fetch and push URLs by repository

A remote that fetches over https and pushes over SSH to the same repository, through pushInsteadOf for instance, is now cleaned. URLs match when they point to the same server, SSH aliases resolved, and the same path, whatever the protocol, the case or a .git suffix.

* fix(worktree): keep credentials and secrets found in build output

* fix(clean): name every planned branch in the command that applies a plan

* fix(cli): write the JSON error document for worktree list and restore too

* feat(post-pr): name every other branch in the command that applies a plan

Like gsp clean, the command that applies a post-pr plan no longer reaches
beyond it: --clean <branch> (repeatable) limits the clean step to the
branches named and --no-clean skips it. The next command and the hints on
the merged branch name every other branch the plan deletes, or pass
--no-clean when there is none, and a long command goes on its own line.

* fix(post-pr): ask before deleting a merged branch that only the fetch proves

* test(clean): name every remote branch in the command that applies a plan

* fix(restore): only push a remote branch back to a configured remote
* gsp, gsp sweep and gsp list now run gsp clean (list is
clean --dry-run). Without a terminal, clean prints the plan and changes
nothing unless --yes is given, and exits 5 when deletions were planned but
not applied. --yes no longer escalates to git branch -D: branches with
unpushed or unmerged work need --force. Merged branches are always
candidates, so --merged is a deprecated no-op. list --json now emits the
schema 2 clean document instead of stale/protected/checkedOut/merged.
A cancelled prompt exits 4 and a confirmation refused for lack of --yes
exits 5; neither exits 0 any more. To migrate, run gsp clean --json to
read the plan, and gsp clean --yes (adding --force for named branches
with unpushed work) to apply it.

* fix(detection): refuse patch-id proofs when a merge adds work of its own

git cherry only lists non-merge commits, so a branch whose merge commit
adds code (a conflict resolution, an "evil merge") came out rebase-merged
or commits-merged once its other commits landed, losing that code.

The branch's merges are now checked with a combined diff: when one
changes something neither parent has, the patch-id, patch-id prefix and
per-commit proofs are refused. The file-state proof of the whole branch
still applies, since it compares the content the merges produced.

* fix(clean): leave hint placeholders unquoted and drop repeated reasons

* test(clean): cover the safety rules, the report and the remote fallbacks

* docs: document gsp clean, its JSON schema, safety rules and exit codes

* fix(clean): say that nothing was deleted when the picker is cancelled

* test(e2e): expect the clean summary from the extension commands

* perf(detection): skip costly proofs that cannot apply to plain branches

Every alive branch with several commits ran the per-commit proof, about
four git calls per commit. It now runs only for branches with merges or
with commits already on the base, the integration branches it is for.

The squash proof also stops before reading any tree when nothing on the
base touched the branch's files, and the merge check first asks once
whether any local branch has merges at all.

On 60 branches of three commits each, the analysis goes from 606 to 307
git calls.

* fix(detection): keep a branch alive when its analysis fails, alone

One failing git command rejected the whole analysis. Each branch is now
analysed on its own: one whose analysis throws comes out alive, with the
new `analysis-failed` reason and the error in an `error` evidence, and
the other branches keep their verdicts.

* fix(detection): never fetch missing objects of a partial clone

Reading a blob a partial clone lacks made git fetch it, writing objects
during a read-only analysis. Every git call of the analysis now runs with
`--no-lazy-fetch` when git supports it (2.44+): it is the command-line
form of GIT_NO_LAZY_FETCH=1, which the analysis cannot set through its git
runner. A missing object then fails that branch's analysis, which stays
alive.

A worktree whose status cannot be read now counts as dirty rather than
clean.

* fix(detection): attach branches being rebased or bisected to their worktree

A rebase or a bisect detaches HEAD, so `git worktree list` showed the
worktree as detached and the branch it works on looked free to delete.

For each detached worktree, the analysis now reads the branch from the
worktree's git dir (rebase-merge/head-name, rebase-apply/head-name,
BISECT_START), attaches the worktree to it and reports the operation in
the new `worktree.inProgress` field ('rebase', 'bisect' or null).

* docs(detection): say unpushed commits are only exact after a pruning fetch

* refactor(clean): split the workflow into an inspect and an apply step

post-pr needs the same fetch, analysis and deletions as clean without its picker, so the steps are exported on their own.

* feat(post-pr)!: finish a merged pull request from any worktree, with proof

gsp post-pr [<branch>] [--into <default>] deletes the merged branch only
when the analysis proves its work is in the default branch, with the rules
of gsp clean --yes; otherwise it changes nothing on it, says why and exits
with 5. --force deletes a branch that is not merged, never a protected one.

It works where agents stand: run from the branch's linked worktree, it
removes that worktree, carries on from the main checkout and reports where
to continue (nextCwd); when the branch is checked out in the main checkout,
that checkout is switched to the default branch first, unless it has
uncommitted changes. The default branch is fast-forwarded where it is
checked out when that worktree is clean, or moved as a ref when it is
checked out nowhere. The clean step that follows uses proof-only rules.

--dry-run, and runs without a terminal and without --yes, only plan and
write nothing. --json prints one schema-2 document. A plan that cannot see
the merge yet because it is not fetched says so instead of suggesting
--force.
* post-pr no longer takes the branch to switch to. Its
positional argument is now the merged branch; "gsp post-pr main" still
works, with a deprecation note. A branch that is not proven merged is no
longer force-deleted: pass --force. Without a terminal, post-pr needs --yes
to change anything.

* docs(post-pr): document finishing a merged pull request and its JSON

* feat(clean): point the current and main-checkout branches at gsp post-pr

post-pr now leaves the worktree before deleting a branch checked out there, so it is the one command that resolves both skips.

* fix(clean): keep branches being rebased, worktrees with ignored files, and give hints that lose nothing

Adopt the analysis of #25: a branch being rebased or bisected is skipped
(rebase-in-progress, bisect-in-progress) whatever the flags, and a failed
analysis reads as such. A linked worktree holding ignored files that a
build does not recreate is skipped as ignored-files, with the files listed;
--force lifts it. The dirty-worktree hint stashes the changes instead of
removing the worktree, post-pr is only suggested for a dead current branch,
deleteMerged=false gets no hint, and an empty branch that had an upstream
reads as already in the base.

* fix(clean): plan before any write, then delete only what was approved and is still proven

The picker and the --yes path now work on a read-only plan. Once it is
approved, gsp fetches, prunes, analyses again and holds the result to the
plan: a branch that changed is skipped as plan-changed, one whose worktree
changed as worktree-changed, and after a failed fetch one proven only by
remote-tracking refs as fetch-failed. Unmerged branches deleted with a
compare-and-swap on the analysed commit. Git's own error line is reported,
the fetch warning is printed once, ls-remote only turns branches alive for
their unmerged commits into upstream-gone, and branches needing --force are
only offered with --force, never pre-selected.

* fix(cli): print the command that applies exactly the plan shown, and JSON errors

The apply command names the planned branches (up to 10), or repeats the
patterns, and keeps -C, --protect, --no-github and --no-fetch. With --json
a fatal error is one JSON document. The help says what exit code 5 means
for clean and for the commands that need a confirmation.

* fix(vscode): name the run modes after what they offer

* docs: document the plan-then-apply order, ignored files and the new skip reasons

* test(post-pr): cover the decision on the merged branch and the wording

* feat(clean): let --yes delete what the fetch proves in the same run

* fix(clean): ask to save ignored files before forcing a worktree removal

* fix(post-pr): print a JSON error document when it stops early, as clean does

* fix(clean): delete nothing when the default branch changes during the fetch

The fetch no longer forces remote.<name>.followRemoteHEAD=always, and when
the default branch found after the fetch differs from the plan's, every
deletion is skipped as plan-changed. The plan's default branch is never
deleted.

* fix(clean): count a folder as regenerable only when Git reports it whole

An ignored file under a tracked folder named build or dist is no longer
regenerable, secret-like names never are, and the ignored build and cache
folders are searched for .env, key and .npmrc files before a worktree goes.

* fix(clean): see untracked files even when status.showUntrackedFiles hides them

* fix(clean): check a worktree against the ignored files the plan showed

The last check before removing a worktree compared counts with the
analysis made after the fetch, so a file replacing one the plan showed
went unnoticed. It now compares paths with the plan, and the worktree
path too.

* fix(clean): blame the failed fetch, and never say nothing to clean when exiting 5

A planned deletion that only ls-remote proved is skipped as fetch-failed
when the fetch fails, not plan-changed. The summary names the skips that
another run may lift, and says "Nothing deleted" rather than "Nothing to
clean" when the exit code is 5.

* feat(clean): give the next command in the JSON document

A top-level next field holds the command the terminal output prints: the
one that applies what the plan left, or a dry run to review what changed
while applying. null when nothing gsp can do on its own is left.

* fix(worktree): keep git worktree remove from deleting hidden untracked files

With status.showUntrackedFiles=no, Git's own check before removing a
worktree does not see untracked files, and deletes them. gsp clean and
gsp worktree remove now run it with that setting set back to normal.

* fix(clean): skip worktrees holding submodules instead of failing to remove them

git worktree remove refuses a worktree with checked-out submodules. The
plan now finds them, read-only, the way Git does, and skips the branch as
submodules with a hint to check them first.

* docs: say what exit 5 covers, and what restore leaves out

Exit 5 also covers deletions held back while applying, and the output says
why and what to run next. The README says how a default branch changed by
the fetch is handled, and that restore does not bring back branch settings
other than the upstream.

* fix(clean): only explain a changed default branch when it held a deletion back

* fix(post-pr): delete nothing when the default branch changes during the fetch

* refactor: remove the old sweep workflow, which nothing runs any more

It was the last code to fetch with followRemoteHEAD=always and to remove
worktrees without WORKTREE_REMOVE.

* test(post-pr): keep a worktree whose untracked file status.showUntrackedFiles hides

* feat(post-pr): carry on when the merged branch is already deleted

After gh pr merge --delete-branch the local branch is gone. Naming it is
no longer a usage error: gsp says it is already deleted, then updates the
default branch and cleans. In JSON, branch is { name, action: "gone" }.

* feat(post-pr): give the next command in the JSON document

* refactor: remove the merged-branches and default-branch modules

Nothing imports them since the branch analysis replaced them. The real-git
tests that used them now check the analysis instead.

* fix(post-pr): name the update in the reflog, and hint with short refs

The default branch moved as a ref now shows "gsp post-pr" in its reflog,
and the hint to fast-forward a dirty checkout reads origin/main instead of
refs/remotes/origin/main.

* fix(post-pr): exit 5 whenever a plan gives a next command

A plan whose only change is fetching the default branch printed a command
to apply it but exited 0. One rule now decides both: what applying would
change. A kept merged branch still exits 5.

* fix(post-pr): suggest pushing, fetching or --into before --force

A merged branch that is not proven merged no longer gets --force as its
first hint. Unpushed commits point to git push; a remote that has new
commits points to fetching first; a merged pull request with another base,
or another remote branch that holds the tip, points to --into. The skip
label only says "needs --force" when the hint does.

Every command post-pr suggests, the review after the default branch
changed included, now keeps -C, --into, --protect, --no-github and
--no-fetch.

* fix(post-pr): never delete a protected branch named on the command line

"gsp post-pr develop" deleted develop when it was protected and merged.
The positional never lifts protection now: the default branch, as main or
origin/main, a protected branch, or the branch of the main checkout when
gsp runs in another worktree is read as the old "gsp post-pr <default>"
form, and the current branch is finished. With no current branch to
finish, a protected name is a usage error that points to --into. The old
form is recognised after the analysis, so it no longer needs origin/HEAD.

A missing branch counts as already deleted only when gsp deleted it, a
remote branch of that name is still listed, or GitHub shows its pull
request merged. Any other one is a usage error with the code
unknown-branch, which suggests the closest names; so is an unknown --into.

* fix(post-pr): continue in another worktree when the main repository is bare

Once the worktree gsp ran in is removed, nextCwd pointed to the bare
repository. It now points to another worktree, or is null with a message
when there is none.

* fix(post-pr): check the branch has not moved before switching the main checkout

The main checkout was switched away from the merged branch before its tip
was checked, so a branch that moved meanwhile left the checkout switched
for nothing. It is now skipped as plan-changed first.

* docs(post-pr): explain exit 5, the positional and missing branches

For post-pr, 5 also means the branch you asked to finish isn't finished.
The help and the README now say how a protected positional is read, when
a missing branch counts as already deleted, and which hints come before
--force.

* fix(post-pr): suggest fetching before pushing

Right after a merge, a branch whose upstream was pruned holds commits found
nowhere else until the merge is fetched. Hinting git push first would
recreate the remote branch the merge deleted.

* fix(post-pr): finish a named branch even when the main checkout has it

* fix(post-pr): say a named branch has no local branch instead of already deleted

The JSON action becomes "no-local-branch": the branch may still exist on the remote, so "gone" said too much.

* refactor: remove the unused local branch ref parser exports

* fix(worktree): keep credentials and secrets found in build output

* fix(clean): name every planned branch in the command that applies a plan

* fix(cli): write the JSON error document for worktree list and restore too

* feat(post-pr): name every other branch in the command that applies a plan

Like gsp clean, the command that applies a post-pr plan no longer reaches
beyond it: --clean <branch> (repeatable) limits the clean step to the
branches named and --no-clean skips it. The next command and the hints on
the merged branch name every other branch the plan deletes, or pass
--no-clean when there is none, and a long command goes on its own line.

* fix(post-pr): ask before deleting a merged branch that only the fetch proves
* gsp, gsp sweep and gsp list now run gsp clean (list is
clean --dry-run). Without a terminal, clean prints the plan and changes
nothing unless --yes is given, and exits 5 when deletions were planned but
not applied. --yes no longer escalates to git branch -D: branches with
unpushed or unmerged work need --force. Merged branches are always
candidates, so --merged is a deprecated no-op. list --json now emits the
schema 2 clean document instead of stale/protected/checkedOut/merged.
A cancelled prompt exits 4 and a confirmation refused for lack of --yes
exits 5; neither exits 0 any more. To migrate, run gsp clean --json to
read the plan, and gsp clean --yes (adding --force for named branches
with unpushed work) to apply it.

* fix(detection): refuse patch-id proofs when a merge adds work of its own

git cherry only lists non-merge commits, so a branch whose merge commit
adds code (a conflict resolution, an "evil merge") came out rebase-merged
or commits-merged once its other commits landed, losing that code.

The branch's merges are now checked with a combined diff: when one
changes something neither parent has, the patch-id, patch-id prefix and
per-commit proofs are refused. The file-state proof of the whole branch
still applies, since it compares the content the merges produced.

* fix(clean): leave hint placeholders unquoted and drop repeated reasons

* test(clean): cover the safety rules, the report and the remote fallbacks

* docs: document gsp clean, its JSON schema, safety rules and exit codes

* fix(clean): say that nothing was deleted when the picker is cancelled

* test(e2e): expect the clean summary from the extension commands

* perf(detection): skip costly proofs that cannot apply to plain branches

Every alive branch with several commits ran the per-commit proof, about
four git calls per commit. It now runs only for branches with merges or
with commits already on the base, the integration branches it is for.

The squash proof also stops before reading any tree when nothing on the
base touched the branch's files, and the merge check first asks once
whether any local branch has merges at all.

On 60 branches of three commits each, the analysis goes from 606 to 307
git calls.

* fix(detection): keep a branch alive when its analysis fails, alone

One failing git command rejected the whole analysis. Each branch is now
analysed on its own: one whose analysis throws comes out alive, with the
new `analysis-failed` reason and the error in an `error` evidence, and
the other branches keep their verdicts.

* fix(detection): never fetch missing objects of a partial clone

Reading a blob a partial clone lacks made git fetch it, writing objects
during a read-only analysis. Every git call of the analysis now runs with
`--no-lazy-fetch` when git supports it (2.44+): it is the command-line
form of GIT_NO_LAZY_FETCH=1, which the analysis cannot set through its git
runner. A missing object then fails that branch's analysis, which stays
alive.

A worktree whose status cannot be read now counts as dirty rather than
clean.

* fix(detection): attach branches being rebased or bisected to their worktree

A rebase or a bisect detaches HEAD, so `git worktree list` showed the
worktree as detached and the branch it works on looked free to delete.

For each detached worktree, the analysis now reads the branch from the
worktree's git dir (rebase-merge/head-name, rebase-apply/head-name,
BISECT_START), attaches the worktree to it and reports the operation in
the new `worktree.inProgress` field ('rebase', 'bisect' or null).

* docs(detection): say unpushed commits are only exact after a pruning fetch

* fix(clean): keep branches being rebased, worktrees with ignored files, and give hints that lose nothing

Adopt the analysis of #25: a branch being rebased or bisected is skipped
(rebase-in-progress, bisect-in-progress) whatever the flags, and a failed
analysis reads as such. A linked worktree holding ignored files that a
build does not recreate is skipped as ignored-files, with the files listed;
--force lifts it. The dirty-worktree hint stashes the changes instead of
removing the worktree, post-pr is only suggested for a dead current branch,
deleteMerged=false gets no hint, and an empty branch that had an upstream
reads as already in the base.

* fix(clean): plan before any write, then delete only what was approved and is still proven

The picker and the --yes path now work on a read-only plan. Once it is
approved, gsp fetches, prunes, analyses again and holds the result to the
plan: a branch that changed is skipped as plan-changed, one whose worktree
changed as worktree-changed, and after a failed fetch one proven only by
remote-tracking refs as fetch-failed. Unmerged branches deleted with a
compare-and-swap on the analysed commit. Git's own error line is reported,
the fetch warning is printed once, ls-remote only turns branches alive for
their unmerged commits into upstream-gone, and branches needing --force are
only offered with --force, never pre-selected.

* fix(cli): print the command that applies exactly the plan shown, and JSON errors

The apply command names the planned branches (up to 10), or repeats the
patterns, and keeps -C, --protect, --no-github and --no-fetch. With --json
a fatal error is one JSON document. The help says what exit code 5 means
for clean and for the commands that need a confirmation.

* fix(vscode): name the run modes after what they offer

* docs: document the plan-then-apply order, ignored files and the new skip reasons

* feat(clean): let --yes delete what the fetch proves in the same run

* fix(clean): ask to save ignored files before forcing a worktree removal

* fix(clean): delete nothing when the default branch changes during the fetch

The fetch no longer forces remote.<name>.followRemoteHEAD=always, and when
the default branch found after the fetch differs from the plan's, every
deletion is skipped as plan-changed. The plan's default branch is never
deleted.

* fix(clean): count a folder as regenerable only when Git reports it whole

An ignored file under a tracked folder named build or dist is no longer
regenerable, secret-like names never are, and the ignored build and cache
folders are searched for .env, key and .npmrc files before a worktree goes.

* fix(clean): see untracked files even when status.showUntrackedFiles hides them

* fix(clean): check a worktree against the ignored files the plan showed

The last check before removing a worktree compared counts with the
analysis made after the fetch, so a file replacing one the plan showed
went unnoticed. It now compares paths with the plan, and the worktree
path too.

* fix(clean): blame the failed fetch, and never say nothing to clean when exiting 5

A planned deletion that only ls-remote proved is skipped as fetch-failed
when the fetch fails, not plan-changed. The summary names the skips that
another run may lift, and says "Nothing deleted" rather than "Nothing to
clean" when the exit code is 5.

* feat(clean): give the next command in the JSON document

A top-level next field holds the command the terminal output prints: the
one that applies what the plan left, or a dry run to review what changed
while applying. null when nothing gsp can do on its own is left.

* fix(worktree): keep git worktree remove from deleting hidden untracked files

With status.showUntrackedFiles=no, Git's own check before removing a
worktree does not see untracked files, and deletes them. gsp clean and
gsp worktree remove now run it with that setting set back to normal.

* fix(clean): skip worktrees holding submodules instead of failing to remove them

git worktree remove refuses a worktree with checked-out submodules. The
plan now finds them, read-only, the way Git does, and skips the branch as
submodules with a hint to check them first.

* docs: say what exit 5 covers, and what restore leaves out

Exit 5 also covers deletions held back while applying, and the output says
why and what to run next. The README says how a default branch changed by
the fetch is handled, and that restore does not bring back branch settings
other than the upstream.

* fix(clean): only explain a changed default branch when it held a deletion back

* fix(worktree): keep credentials and secrets found in build output

* fix(clean): name every planned branch in the command that applies a plan

* fix(cli): write the JSON error document for worktree list and restore too

# [1.4.0](https://github.com/MAXOUXAX/git-sweep-pro/compare/v1.3.1...v1.4.0) (2026-10-03)


### Features

* add a gsp worktree command ([#23](https://github.com/MAXOUXAX/git-sweep-pro/issues/23)) ([9dfd0a8](https://github.com/MAXOUXAX/git-sweep-pro/commit/9dfd0a8796cf915903805526b9a126d13a7a8cc9))

## [1.3.1](https://github.com/MAXOUXAX/git-sweep-pro/compare/v1.3.0...v1.3.1) (2026-10-02)


### Bug Fixes

* **cli:** support explicit non-interactive agent workflows ([#22](https://github.com/MAXOUXAX/git-sweep-pro/issues/22)) ([9a84d36](https://github.com/MAXOUXAX/git-sweep-pro/commit/9a84d36a6c9929d414645bcb195db9eb2b9ed61d))

# [1.3.0](https://github.com/MAXOUXAX/git-sweep-pro/compare/v1.2.0...v1.3.0) (2026-10-02)


### Bug Fixes

* address the review of the 1.3.0 release ([#19](https://github.com/MAXOUXAX/git-sweep-pro/issues/19)) ([d38e4ce](https://github.com/MAXOUXAX/git-sweep-pro/commit/d38e4cee7f527f7de25988a7fc8d9fa288fd9eae))
* address the second review of the 1.3.0 release ([#20](https://github.com/MAXOUXAX/git-sweep-pro/issues/20)) ([9f99cf3](https://github.com/MAXOUXAX/git-sweep-pro/commit/9f99cf32659c15af15aa459aeeaaefca57870f2d))
* handle additional release review edge cases ([#21](https://github.com/MAXOUXAX/git-sweep-pro/issues/21)) ([a6f983a](https://github.com/MAXOUXAX/git-sweep-pro/commit/a6f983a70a7ba80c3a4156b74ff268a7ffd49ed7))


### Features

* gsp, instructions for coding agents, and Homebrew install ([#17](https://github.com/MAXOUXAX/git-sweep-pro/issues/17)) ([5505a05](https://github.com/MAXOUXAX/git-sweep-pro/commit/5505a05b84562b2aa9239325c359a26da949a3bb))
* optionally offer local branches already merged into the default branch ([#13](https://github.com/MAXOUXAX/git-sweep-pro/issues/13)) ([63d21da](https://github.com/MAXOUXAX/git-sweep-pro/commit/63d21da970e5231a45b3acbe3bc39dc84e002aea))
* record deleted branches and add a restore (undo) command ([#12](https://github.com/MAXOUXAX/git-sweep-pro/issues/12)) ([fad672c](https://github.com/MAXOUXAX/git-sweep-pro/commit/fad672c37bdf3eca0ae109a0d0a6ba84ad5f9a6a))
* ship a git-sweep-pro CLI and run every extension command through it ([#10](https://github.com/MAXOUXAX/git-sweep-pro/issues/10)) ([9e4c450](https://github.com/MAXOUXAX/git-sweep-pro/commit/9e4c450ef369bf0ba3f4cf5ab142f0dea8644429))
* support git worktrees across sweep, post-PR cleanup and sync ([#11](https://github.com/MAXOUXAX/git-sweep-pro/issues/11)) ([6601421](https://github.com/MAXOUXAX/git-sweep-pro/commit/6601421ff7d19189ca3ba5f459a9550a94d708d7))

# [1.2.0](https://github.com/MAXOUXAX/git-sweep-pro/compare/v1.1.0...v1.2.0) (2026-07-04)


### Features

* add safety settings (protected branches, confirm, default mode, auto fetch/prune) ([9547129](https://github.com/MAXOUXAX/git-sweep-pro/commit/95471292b4a91db087fe1502e126b4d91b013507))
* force-delete squash/rebase-merged branches that safe delete refuses ([6135465](https://github.com/MAXOUXAX/git-sweep-pro/commit/6135465d0a3c5c56de22f4a0b7b6257c12688449))
* multi-root workspace support with repository selection ([8bd80e6](https://github.com/MAXOUXAX/git-sweep-pro/commit/8bd80e66eb05dba420a166d3a69906cd2d6951d4))
* **sweep:** add summary preview, picker quick actions, and detailed outcome ([adebe5a](https://github.com/MAXOUXAX/git-sweep-pro/commit/adebe5a7fed679d260a4048894caa6cfda09d56c))

# [1.1.0](https://github.com/MAXOUXAX/git-sweep-pro/compare/v1.0.1...v1.1.0) (2026-07-04)


### Bug Fixes

* force C locale for git so parsed tokens are locale-stable ([c90c337](https://github.com/MAXOUXAX/git-sweep-pro/commit/c90c337a65827784794f2190e0c723d0629f29e6))


### Features

* detect stale branches via structured git refs ([1d95f2e](https://github.com/MAXOUXAX/git-sweep-pro/commit/1d95f2ebb58e60222bb9a78400a61f08cede750e))

## [1.0.1](https://github.com/MAXOUXAX/git-sweep-pro/compare/v1.0.0...v1.0.1) (2026-07-03)


### Bug Fixes

* **ci:** compile before coverage and reject empty coverage data ([83fd405](https://github.com/MAXOUXAX/git-sweep-pro/commit/83fd4059695f102c1267d76b5c7f5622474d7e79))

# 1.0.0 (2026-07-03)


### Features

* add coverage reporting and improve git command handling ([b0aeea3](https://github.com/MAXOUXAX/git-sweep-pro/commit/b0aeea35ac984f489fe05bbeba844aeeba6be340))
* add icon ([8c8db32](https://github.com/MAXOUXAX/git-sweep-pro/commit/8c8db32b983bcf136297556ad4f2c60441e0de4d))
* add Post Pull Request command ([#5](https://github.com/MAXOUXAX/git-sweep-pro/issues/5)) ([26f1090](https://github.com/MAXOUXAX/git-sweep-pro/commit/26f1090b01ff3c8c36177a394036504399924b7d))
* add Sync With Upstream commands and workflow ([#6](https://github.com/MAXOUXAX/git-sweep-pro/issues/6)) ([2195eb4](https://github.com/MAXOUXAX/git-sweep-pro/commit/2195eb43a630726a1366a0cebbd0c125b74a18fe)), closes [#4](https://github.com/MAXOUXAX/git-sweep-pro/issues/4)
* promote Git Sweep Pro to first stable release ([52ca683](https://github.com/MAXOUXAX/git-sweep-pro/commit/52ca683e369c01b5a34d89007fd60f53bfc015d8))


### BREAKING CHANGES

* mark the first stable 1.0.0 release with automated publishing to the VS Code Marketplace and Open VSX.

# Change Log

All notable changes to the "git-sweep-pro" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- New commands: `Sync With Upstream` and `Sync With Upstream (Resume)` — keep a feature branch up to date with a base branch (stash, pull, rebase, `--force-with-lease` push, conflict pause/resume).
- Initial release
