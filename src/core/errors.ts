import type { NoticeOptions } from './workflow';

/** Extracts a human-readable message from anything thrown. */
export function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Git's own reason for a failed command: the first meaningful line of its
 * stderr, without the "fatal:" or "error:" prefix, rather than Node's
 * "Command failed: git …". Falls back to the error message.
 */
export function gitFailureReason(error: unknown): string {
	const stderr = (error as { stderr?: unknown } | null)?.stderr;
	const lines = [typeof stderr === 'string' ? stderr : '', toErrorMessage(error)].flatMap((text) => text.split('\n')).map((line) => line.trim());
	const line = lines.find((candidate) => candidate && !candidate.startsWith('Command failed:')) ?? lines.find(Boolean) ?? toErrorMessage(error);
	return line.replace(/^(fatal|error):\s*/i, '');
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
