import { toErrorMessage } from './errors';
import type { StateStore } from './state-store';

/** A branch deleted by Git Sweep Pro, kept so the deletion can be undone. */
export type DeletedBranch = {
	readonly branch: string;
	/** Full SHA of the branch tip, read just before the deletion. */
	readonly sha: string;
	/** ISO-8601 timestamp. */
	readonly deletedAt: string;
	readonly source: DeletionSource;
	/** Linked worktree removed together with the branch, if any. */
	readonly worktree?: string;
	/** Full ref of the branch's upstream (e.g. "refs/remotes/origin/x"), if it had one. */
	readonly upstream?: string;
};

export type DeletionSource = 'sweep' | 'post-pr';

/** What the code deleting a branch knows about the deletion. */
export type Deletion = Omit<DeletedBranch, 'deletedAt' | 'source'>;

export type DeletionLog = {
	/** Recorded deletions, newest first. */
	list: () => readonly DeletedBranch[];
	record: (entry: Omit<DeletedBranch, 'deletedAt'>) => Promise<void>;
	/** Drops every deletion of `branch`: once restored, older deletions of that name are outdated. */
	forget: (branch: string) => Promise<void>;
};

/** State key of the log, in the store shared by every worktree of a repository. */
export const DELETION_LOG_KEY = 'git-sweep-pro.deletedBranches';

/** Oldest entries are dropped beyond this many. */
export const MAX_DELETION_LOG_ENTRIES = 100;

const SOURCES: readonly DeletionSource[] = ['sweep', 'post-pr'];

/**
 * Accepts only well-formed entries: the state file can be edited by hand, and
 * restoring passes the name and SHA to git. A name starting with "-" would be
 * read as an option, and Git never creates such a branch anyway.
 */
function isDeletedBranch(value: unknown): value is DeletedBranch {
	const entry = value as Partial<Record<keyof DeletedBranch, unknown>> | null;
	return (
		typeof entry === 'object' &&
		entry !== null &&
		typeof entry.branch === 'string' &&
		/^[^-\s]\S*$/.test(entry.branch) &&
		typeof entry.sha === 'string' &&
		/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.sha) &&
		typeof entry.deletedAt === 'string' &&
		!Number.isNaN(Date.parse(entry.deletedAt)) &&
		SOURCES.includes(entry.source as DeletionSource) &&
		(entry.worktree === undefined || typeof entry.worktree === 'string') &&
		(entry.upstream === undefined || (typeof entry.upstream === 'string' && /^refs\/\S+$/.test(entry.upstream)))
	);
}

/** The deletion log, kept in `store` under {@link DELETION_LOG_KEY}. Malformed entries are dropped on the next write. */
export function createDeletionLog(store: StateStore, now: () => Date = () => new Date()): DeletionLog {
	const list = (): DeletedBranch[] => {
		const stored = store.get<unknown>(DELETION_LOG_KEY);
		return Array.isArray(stored) ? stored.filter(isDeletedBranch) : [];
	};
	return {
		list,
		record: async (entry) => {
			const recorded: DeletedBranch = { ...entry, deletedAt: now().toISOString() };
			await store.update(DELETION_LOG_KEY, [recorded, ...list()].slice(0, MAX_DELETION_LOG_ENTRIES));
		},
		forget: async (branch) => {
			await store.update(DELETION_LOG_KEY, list().filter((entry) => entry.branch !== branch));
		},
	};
}

export type DeletionRecorder = {
	readonly record: (deletion: Deletion) => Promise<void>;
	/** Branches recorded so far, in deletion order. */
	readonly recorded: readonly string[];
};

/**
 * Records each deletion in `log`, best effort: failing to write the log is
 * reported in the output but never turns a successful deletion into a failure.
 */
export function createDeletionRecorder(log: DeletionLog, source: DeletionSource, warn: (line: string) => void): DeletionRecorder {
	const recorded: string[] = [];
	return {
		recorded,
		record: async (deletion) => {
			try {
				await log.record({ ...deletion, source });
				recorded.push(deletion.branch);
			} catch (error) {
				warn(`[warning] Could not record the deletion of ${deletion.branch}, so it cannot be restored: ${toErrorMessage(error)}`);
			}
		},
	};
}

/** Newest deletion of each branch name (a name can be deleted, recreated and deleted again). */
export function latestDeletions(entries: readonly DeletedBranch[]): DeletedBranch[] {
	const seen = new Set<string>();
	return entries.filter((entry) => !seen.has(entry.branch) && seen.add(entry.branch));
}

/** "just now", "3 min ago", "5 h ago", "2 d ago": compact enough for a picker. */
export function formatAge(deletedAt: string, now: Date): string {
	const minutes = Math.max(0, Math.round((now.getTime() - new Date(deletedAt).getTime()) / 60000));
	if (minutes < 1) {
		return 'just now';
	}
	if (minutes < 60) {
		return `${minutes} min ago`;
	}
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** One line describing a deletion, e.g. "abc1234 · deleted 5 min ago by sweep". */
export function describeDeletion(entry: DeletedBranch, now: Date): string {
	return `${entry.sha.slice(0, 7)} · deleted ${formatAge(entry.deletedAt, now)} by ${entry.source}`;
}
