/**
 * Key-value store persisted across runs (a paused sync, the deleted-branch
 * log). Setting a key to `undefined` removes it.
 */
export type StateStore = {
	get: <T>(key: string) => T | undefined;
	update: (key: string, value: unknown) => PromiseLike<void>;
};
