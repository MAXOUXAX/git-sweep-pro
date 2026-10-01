/** Extracts a human-readable message from anything thrown. */
export function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Maps a failed git invocation to the message shown to the user: well-known
 * environment problems (not a repository, git missing) get a dedicated
 * explanation, anything else is reported with `genericPrefix`.
 */
export function describeGitFailure(message: string, genericPrefix: string): string {
	const lowerMessage = message.toLowerCase();
	if (lowerMessage.includes('not a git repository')) {
		return 'Git Sweep Pro: The selected workspace folder is not a Git repository.';
	}
	if (lowerMessage.includes('command not found') || lowerMessage.includes('enoent')) {
		return 'Git Sweep Pro: Git is not installed or not available in PATH.';
	}
	return `${genericPrefix} ${message}`;
}

/** True when `git pull` failed only because the branch has no upstream configured. */
export function isNoUpstreamError(message: string): boolean {
	return /no upstream|no tracking|please specify.*branch/i.test(message);
}
