/**
 * Key-value store persisted across runs (a paused sync, the deleted-branch
 * log), shared by every gsp process working on the repository.
 */
export type StateStore = {
	get: <T>(key: string) => T | undefined;
	/**
	 * Replaces the value of `key` with what `change` returns from its current
	 * value, as one step no other process can interleave with: a concurrent
	 * update is never lost. Returning `undefined` removes the key.
	 */
	update: <T>(key: string, change: (current: T | undefined) => T | undefined) => PromiseLike<void>;
};
