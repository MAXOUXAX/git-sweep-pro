import type { NoticeOptions } from './workflow';

/** Extracts a human-readable message from anything thrown. */
export function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const NOT_A_REPOSITORY = 'This folder is not a Git repository.';

/**
 * Maps a failed git invocation to the arguments of an error notification:
 * well-known environment problems (not a repository, git missing) get a
 * dedicated explanation, anything else is reported as is with `options`.
 */
export function describeGitFailure(message: string, options?: NoticeOptions): [message: string, options?: NoticeOptions] {
	const lowerMessage = message.toLowerCase();
	if (lowerMessage.includes('not a git repository')) {
		return [NOT_A_REPOSITORY];
	}
	if (lowerMessage.includes('command not found') || lowerMessage.includes('enoent')) {
		return ['Git is not installed or not available in PATH.'];
	}
	return options ? [message, options] : [message];
}

/** True when `git pull` failed only because the branch has no upstream configured. */
export function isNoUpstreamError(message: string): boolean {
	return /no upstream|no tracking|please specify.*branch/i.test(message);
}
