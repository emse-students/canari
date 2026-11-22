/**
 * WHICH CONVERSATIONS ENDED BETWEEN TWO LOOKS AT THE LIST - the one seam that retires their native
 * notifications.
 *
 * Opening the app no longer clears banners (owner, 2026-11-21: "N'effacer que les lues"), so a
 * banner for a conversation that is deleted, left, excluded from, or whose salon or community is
 * gone would stand for good unless the event that ends it takes it down. That event has a dozen
 * writers (`retireConversation`, `purgeConversation`, three salon handlers each deleting the row, a
 * community deletion, sign-out) - enumerating them is how one is missed, so this watches the LIST
 * they all write to: a conversation ENDED when its id was active and now is absent or `removed`.
 *
 * KEYED BY THE CONVERSATION'S ID, never by its map key: a re-keyed conversation (one row moved to
 * another key) still has the same id and has not ended. PURE, so the matrix is asserted.
 */

/** What the watcher remembers of a conversation: its lifecycle, by id. */
export type KnownConversations = ReadonlyMap<string, string>;

/** The minimal row the watcher reads. */
export interface WatchedConversation {
  id: string;
  lifecycle?: string;
}

/** The snapshot of `rows`: every id that is still a live conversation, with its lifecycle. */
export function snapshotConversations(rows: Iterable<WatchedConversation>): Map<string, string> {
  const known = new Map<string, string>();
  for (const row of rows) {
    if (row.id) known.set(row.id, row.lifecycle ?? 'active');
  }
  return known;
}

/**
 * The ids that ENDED between `previous` and `next`: present and not `removed` before; absent or
 * `removed` now. An id never seen before is not an ending, nor one that was already `removed`.
 */
export function endedConversationIds(
  previous: KnownConversations,
  next: KnownConversations
): string[] {
  const ended: string[] = [];
  for (const [id, lifecycle] of previous) {
    if (lifecycle === 'removed') continue;
    const now = next.get(id);
    if (now === undefined || now === 'removed') ended.push(id);
  }
  return ended;
}

/**
 * One look at the list, from the watcher: what ENDED since the last look and what to remember.
 *
 * **SIGNED OUT, NOTHING ENDED.** A lost session (`reportMlsSessionLost`, the resume that finds no
 * native session) tears the live session down and clears the conversation map in the same tick that
 * `isLoggedIn` goes false: every id "vanishes" although nothing ended, and ending them would delete
 * every unread banner of an account that is only reconnecting. While not signed in the watcher
 * therefore ends nothing and forgets what it knew, so the list the next sign-in restores is a first
 * look, never a comparison with the one that was torn down.
 */
export function watchEndings(
  signedIn: boolean,
  previous: KnownConversations,
  next: KnownConversations
): { ended: string[]; known: KnownConversations } {
  if (!signedIn) return { ended: [], known: new Map() };
  return { ended: endedConversationIds(previous, next), known: next };
}
