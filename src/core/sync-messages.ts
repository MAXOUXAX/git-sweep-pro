/**
 * Centralized user-visible strings for the Sync With Upstream workflow.
 * Kept in English to match command palette titles in package.json. Front
 * ends add their own framing (the product name in VS Code), and progress
 * titles get their ellipsis or spinner there too.
 */

/** How to resume a paused sync, in the editor and in a terminal. */
const RESUME = '"Resume Sync With Upstream" (gsp resume)';

export const syncMessages = {
	// runSyncWorkflow
	couldNotDetermineBranch: 'Could not determine current branch (detached HEAD?).',
	noBranchesForSync: 'No other branches available for sync.',
	pickBranchTitle: 'Sync With Upstream: Choose branch to sync with',
	pickBranchPlaceholder: 'Local or remote branch',
	operationCancelled: 'Operation cancelled.',
	fetchingRemotes: 'Fetching remotes',
	creatingTempBranch: (ref: string) => `Creating temporary branch for ${ref}`,
	pulling: (ref: string) => `Pulling ${ref}`,
	checkingOut: (ref: string) => `Checking out ${ref}`,
	returningTo: (branch: string) => `Returning to ${branch}`,
	rebasing: (ref: string) => `Rebasing onto ${ref}`,
	forcePush: 'Force push',
	recoveringStash: 'Recovering stash',
	rebaseConflicts: `Rebase conflicts. Resolve them, then run ${RESUME} to continue.`,
	pushFailed: (msg: string) =>
		`Push failed: ${msg}. Run ${RESUME} to retry.`,
	rebaseOkStashFailed: 'Rebase succeeded but stash pop failed. Use "git stash pop" manually.',
	cannotSyncOntoItself: (branch: string) =>
		`"${branch}" is the current branch. Choose a different branch to sync with.`,
	stashNotRestored: (ref: string) =>
		`Your stashed changes were NOT restored. Recover them with: git stash apply ${ref}`,
	stashNotRestoredUnknownRef: 'Your stashed changes were NOT restored. Run "git stash list" and apply the "gsp-sync-with-upstream" entry.',
	stashPopFailed: 'Stash could not be recovered. Use "git stash pop" manually.',
	syncedWith: (branch: string, upstream: string) => `${branch} synced with ${upstream}.`,
	syncedSuccess: (branch: string) => `${branch} synced successfully.`,

	// runResumeWorkflow
	noRebaseNothingToResume: 'No rebase in progress and no saved state. Nothing to resume.',
	rebaseInOtherWorkspace: 'A rebase is in progress in another workspace. Open the correct folder.',
	couldNotDetermineRebaseBranch: 'Could not determine branch for in-progress rebase.',
	remainingConflicts: `Conflicts remain. Resolve them and run ${RESUME} again.`,
	rebaseOkPushFailed: (msg: string) => `Rebase OK but push failed: ${msg}`,
	rebaseContinue: 'Rebase --continue',
	rebaseAlreadyInProgress: `A rebase is already in progress. Run ${RESUME} to continue.`,
	rebaseNotStartedByExtension: 'A rebase is in progress, but it was not started by Sync With Upstream. Finish it manually (git rebase --continue / --abort).',
	rebaseBranchMismatch: (expected: string, actual: string) =>
		`The rebase in progress is on "${actual}", but the paused sync was for "${expected}". Finish the current rebase manually, then run ${RESUME} again.`,

	// output panel
	outputHeader: '--- Sync With Upstream ---',
	outputResumeHeader: '--- Sync With Upstream: Resume ---',
	outputRebasePaused: '--- Rebase paused (conflicts) ---',
	outputComplete: '--- Sync With Upstream complete ---',
	outputFailed: '--- Sync With Upstream failed ---',
	outputResumeComplete: '--- Resume complete ---',
	outputSessionEnded: '--- Sync With Upstream session ended ---',
	nothingToResume: 'Nothing to resume.',
	infoPullSkipped: '[info] Pull skipped (already up to date or no upstream).',
	infoPullSkippedLocal: '[info] Pull skipped.',
	infoTempBranchNotDeleted: (branch: string) => `[info] Temporary branch ${branch} not deleted.`,
	infoLocalBranchSynced: (local: string, remote: string) => `Local branch ${local} synced with ${remote}.`,
	infoUpdateSkipped: (branch: string) => `[info] Update of ${branch} skipped.`,
	infoUpdateSkippedSameBranch: (branch: string) =>
		`[info] Skipping local branch update: ${branch} is the synced branch.`,
	infoUpdateSkippedExisting: (branch: string) =>
		`[info] Skipping local branch update: ${branch} exists (would discard local commits). Create manually if needed.`,
	infoNoRebaseInProgress:
		'[info] No rebase in progress (already completed manually?). Proceeding to push and cleanup.',
	infoStateSavedForResume: `[info] State saved. Run ${RESUME} to retry the push.`,
	infoStashKeptForResume:
		`[info] Stash not restored yet; ${RESUME} will restore it.`,
	infoStashUnknownRef:
		'[info] Stash not restored and its ref could not be identified. Check "git stash list" for the "gsp-sync-with-upstream" entry.',
	infoStashRefOnFailure: (ref: string) =>
		`[info] Stash not restored. Recover manually: git stash list, then git stash apply ${ref} or git stash pop ${ref}`,
	infoUpstreamInOtherWorktree: (ref: string) =>
		`[info] ${ref} is checked out in another worktree, so it was not pulled; rebasing onto it as it is. Pick its remote branch to rebase onto the latest version.`,
	infoCleanupAttempted: '[info] Attempting cleanup after error...',
} as const;
