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
 * THE IDS WITH POSITIVE EVIDENCE OF HAVING ENDED: the rows the list itself marks `removed`. Handed to
 * the native side once each, so a conversation that was already `removed` when the page restored
 * (the watcher above only sees a transition) still loses its banner.
 *
 * **NEVER AN ABSENCE.** A destructive control takes an allowlist of what it may touch, not "whatever
 * the page does not list": the list is NOT the complete set at boot (a first DM from a new
 * correspondent reaches it only through the FCM cache, after the catch-up; a restore that failed
 * still reads as restored; a salon appears in `channelWorkspaces` only once its community answers),
 * so reasoning from a row's absence ended banners of live conversations. Only a `removed` row, or the
 * ledger of a conversation known gone, names an ending.
 */
export function removedConversationIds(rows: Iterable<WatchedConversation>): string[] {
  const removed: string[] = [];
  for (const row of rows) {
    if (row.id && row.lifecycle === 'removed') removed.push(row.id);
  }
  return removed;
}
