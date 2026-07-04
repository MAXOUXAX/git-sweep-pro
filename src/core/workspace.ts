export type UriLike = {
	readonly fsPath: string;
};

export type DocumentLike = {
	readonly uri: unknown;
};

export type ActiveEditorLike = {
	readonly document: DocumentLike;
};

export type WorkspaceFolderLike = {
	readonly uri: UriLike;
};

type WorkspaceResolverParams = {
	readonly activeEditor: ActiveEditorLike | undefined;
	readonly getWorkspaceFolder: (uri: unknown) => WorkspaceFolderLike | undefined;
	readonly workspaceFolders: readonly WorkspaceFolderLike[] | undefined;
};

export function resolveWorkspaceRoot(params: WorkspaceResolverParams): string | undefined {
	const { activeEditor, getWorkspaceFolder, workspaceFolders } = params;

	if (activeEditor) {
		const folder = getWorkspaceFolder(activeEditor.document.uri);
		if (folder) {
			return folder.uri.fsPath;
		}
	}

	return workspaceFolders?.[0]?.uri.fsPath;
}

export type RepoFolder = {
	readonly fsPath: string;
	readonly name: string;
};

export type RepositoryResolution =
	| { readonly kind: 'resolved'; readonly fsPath: string | undefined }
	| { readonly kind: 'cancelled' };

/**
 * Orders repository candidates so the most relevant one is surfaced first in a
 * picker: the last selected repository, then the active-editor's repository,
 * then the remaining folders in their original order. The sort is stable.
 */
export function orderRepoCandidates(
	candidates: readonly RepoFolder[],
	lastSelected: string | undefined,
	activeRepoRoot: string | undefined
): RepoFolder[] {
	const priority = (folder: RepoFolder): number => {
		if (lastSelected && folder.fsPath === lastSelected) {
			return 0;
		}
		if (activeRepoRoot && folder.fsPath === activeRepoRoot) {
			return 1;
		}
		return 2;
	};

	return candidates
		.map((folder, index) => ({ folder, index }))
		.sort((a, b) => priority(a.folder) - priority(b.folder) || a.index - b.index)
		.map((entry) => entry.folder);
}

export type ResolveRepositoryParams = {
	/** All open workspace folders. */
	readonly folders: readonly RepoFolder[];
	/** Root derived from the active editor / first folder (may not be a repo). */
	readonly activeRepoRoot: string | undefined;
	/** Returns true when the given folder is inside a Git working tree. */
	readonly isGitRepo: (fsPath: string) => Promise<boolean>;
	readonly getLastSelected: () => string | undefined;
	readonly setLastSelected: (fsPath: string) => void;
	/** Prompts the user to choose among multiple repositories. */
	readonly promptForRepo: (candidates: readonly RepoFolder[]) => Promise<RepoFolder | undefined>;
};

/**
 * Resolves which repository a command should operate on.
 *
 * - No workspace folder is a Git repository: falls back to the active-editor
 *   root (letting the caller surface the usual "not a Git repository" error).
 * - Exactly one repository: uses it without prompting.
 * - Multiple repositories: prompts the user, surfacing the remembered/active
 *   repository first, and persists the choice.
 */
export async function resolveTargetRepository(params: ResolveRepositoryParams): Promise<RepositoryResolution> {
	const { folders, activeRepoRoot, isGitRepo, getLastSelected, setLastSelected, promptForRepo } = params;

	const candidates: RepoFolder[] = [];
	for (const folder of folders) {
		if (await isGitRepo(folder.fsPath)) {
			candidates.push(folder);
		}
	}

	if (candidates.length === 0) {
		return { kind: 'resolved', fsPath: activeRepoRoot };
	}

	if (candidates.length === 1) {
		setLastSelected(candidates[0].fsPath);
		return { kind: 'resolved', fsPath: candidates[0].fsPath };
	}

	const ordered = orderRepoCandidates(candidates, getLastSelected(), activeRepoRoot);
	const chosen = await promptForRepo(ordered);
	if (!chosen) {
		return { kind: 'cancelled' };
	}

	setLastSelected(chosen.fsPath);
	return { kind: 'resolved', fsPath: chosen.fsPath };
}

