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
 * KEYED BY THE CONVERSATION'S ID, never by its map key. A re-key that only moves the map key keeps
 * the id, but the two re-keys that matter (a Welcome folding a duplicate DM onto the joined group,
 * the boot merge) CHANGE the id: the old id vanishes while the thread, and its unread messages,
 * live on under the new one. The native layer cannot re-tag a banner, so the re-key is passed to
 * the watcher as a FACT ({@link recordRekey}), never inferred, and the old id's banners stay.
 *
 * **A `removed` ROW ENDS BANNERS ONLY ON POSITIVE EVIDENCE.** A Welcome can re-admit a row that
 * was marked `removed` by a miss (a refused send, a failed membership check), so the lifecycle
 * alone is not proof. Under principle 2 a stale notice is the safer error: only the writers that
 * hold a confirmed ending (a Remove commit, an announced exclusion, a deletion the server
 * reported) say so, through {@link confirmEnding}. The absence of a row keeps ending banners
 * (purge, salon and community deletions), as it did. PURE once the facts are given, so the matrix
 * is asserted.
 */

/** Ids whose row was re-keyed onto another id, noted since the watcher last looked. */
const rekeyedAway = new Set<string>();
/** Ids whose `removed` transition carried positive evidence, noted since the watcher last looked. */
const confirmedEndings = new Set<string>();

/** The facts the watcher is given besides the two lists. */
export interface EndingFacts {
  /** Old ids of re-keyed rows: the conversation continues under another id. */
  rekeyed: ReadonlySet<string>;
  /** Ids whose `removed` is confirmed by a Remove commit, an announcement or a server deletion. */
  confirmed: ReadonlySet<string>;
}

/** Notes that the row `oldId` continues under another id: its banners are not ended. */
export function recordRekey(oldId: string): void {
  if (oldId) rekeyedAway.add(oldId);
}

/** Notes that the row `id` was retired on positive evidence: its banners may be ended. */
export function confirmEnding(id: string): void {
  if (id) confirmedEndings.add(id);
}

/** Hands the noted facts to the watcher and forgets them: each look consumes what led up to it. */
export function takeEndingFacts(): EndingFacts {
  const facts = { rekeyed: new Set(rekeyedAway), confirmed: new Set(confirmedEndings) };
  rekeyedAway.clear();
  confirmedEndings.clear();
  return facts;
}

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
 * The ids that ENDED between `previous` and `next`: present and not `removed` before; absent now
 * (unless re-keyed onto another id) or `removed` now WITH a confirmed ending. An id never seen
 * before is not an ending, nor one that was already `removed`.
 */
export function endedConversationIds(
  previous: KnownConversations,
  next: KnownConversations,
  facts: EndingFacts = { rekeyed: new Set(), confirmed: new Set() }
): string[] {
  const ended: string[] = [];
  for (const [id, lifecycle] of previous) {
    if (lifecycle === 'removed') continue;
    const now = next.get(id);
    if (now === undefined) {
      if (!facts.rekeyed.has(id)) ended.push(id);
    } else if (now === 'removed' && facts.confirmed.has(id)) {
      ended.push(id);
    }
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
  next: KnownConversations,
  facts: EndingFacts = { rekeyed: new Set(), confirmed: new Set() }
): { ended: string[]; known: KnownConversations } {
  if (!signedIn) return { ended: [], known: new Map() };
  return { ended: endedConversationIds(previous, next, facts), known: next };
}
