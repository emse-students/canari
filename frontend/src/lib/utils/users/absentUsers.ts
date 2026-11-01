import { SvelteSet } from 'svelte/reactivity';

/** Same normalisation as the name directory: ids compare trimmed and lower-cased. */
const normalizeUserId = (userId: string): string => userId.trim().toLowerCase();

/**
 * Ids the server answered do not exist (a deleted or erased account). REACTIVE, so a link drawn
 * before the answer arrived is withdrawn when it does. Its own module so that a surface that only
 * needs this one fact does not import the whole name directory.
 */
const absentUsers = new SvelteSet<string>();

/** Records that the server answered `userId` does not exist. Called by the name lookup. */
export function noteAbsentUser(userId: string): void {
  absentUsers.add(normalizeUserId(userId));
}

/**
 * Whether the server has answered that this account does not exist. A fact learned from a lookup,
 * so `false` means "not known to be gone", never "exists": a surface that links to a profile calls
 * this to stop offering a page that has nobody on it. Reactive, as a `$derived` may read it.
 */
export function isAbsentUser(userId: string): boolean {
  return absentUsers.has(normalizeUserId(userId));
}

/** Forgets every absent id - for tests, which share the module between cases. */
export function forgetAbsentUsers(): void {
  absentUsers.clear();
}
