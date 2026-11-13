import type { StoredMessage, StoredMessageMerge } from './types';

/**
 * THE COMPARE-AND-SET EVERY REWRITE OF A STORED MESSAGE GOES THROUGH (review of #2936, P1).
 *
 * A rewrite used to read the row, await (decrypting, the caller's own work), and write the whole row
 * back - so a tombstone another writer stored in between was overwritten with the copy read before
 * it, permanently. Each message row now carries a revision (`rev`), raised by EVERY write, and a
 * rewrite applies only while the revision is still the one it read: on IndexedDB a get, a compare and
 * a put in one readwrite transaction (the payload sealed before it opens), on SQLite
 * `UPDATE ... WHERE rev = ? AND iv = ?`. A row that moved is read again and merged again.
 *
 * THE TOKEN IS THE REVISION AND THE ROW'S IV, AND THAT CLOSES ABA. A revision alone can repeat: a
 * row deleted and inserted again starts over, and rewritten as often reaches the revision a stale
 * reader holds. The iv cannot repeat - every seal draws a fresh 96-bit nonce, and AES-GCM under one
 * key REQUIRES that it never does (a repeat would already be a break of the encryption, not of this
 * check). So a compare that also holds the iv it read matches only the very write it read, whatever
 * happened to the row in between; nothing is seeded, counted or stored for it.
 *
 * TERMINATION IS A PROOF, NOT A CLOCK: a retry happens only when another writer COMMITTED a new
 * revision of that row between this one's read and its write. With finitely many writers the rounds
 * end - and there is no bound to tune, no timer to be wrong.
 */

/**
 * A stored row as read for a compare-and-set: the row, the revision it was read at, and the iv of
 * the write it read (`stamp`, opaque to the loop) - the token the write must still find.
 */
export interface RevisedRow {
  msg: StoredMessage;
  rev: number;
  stamp: string;
}

/** One write of {@link RevisedRowStore.writeIfUnchanged}: the row, and the token it was read at. */
export interface RevisedWrite {
  msg: StoredMessage;
  rev: number;
  stamp: string;
}

/** What a backend provides for {@link casMergeMessages}. */
export interface RevisedRowStore {
  /**
   * The rows under `ids` with their revision - scoped to `conversationId` when one is given (a row of
   * another conversation reads as absent, said at warn unless `foreignExpected`). An absent or
   * unreadable row is simply not in the map.
   */
  read(
    conversationId: string | null,
    ids: readonly string[],
    deviceKeyB64: string,
    foreignExpected: boolean
  ): Promise<{ rows: Map<string, RevisedRow> }>;
  /** Writes each row only while its token is still `rev` and `stamp`; resolves with the ids written. */
  writeIfUnchanged(
    conversationId: string | null,
    writes: ReadonlyArray<RevisedWrite>,
    deviceKeyB64: string
  ): Promise<Set<string>>;
}

/**
 * Rewrites the rows under `ids` from their current state with `merge`, one compare-and-set round at
 * a time, until every row is written, left (`merge` returned `null`) or gone. Resolves with the ids
 * written. A merged row keeps its identity: `merge` cannot move a row to another id or conversation.
 */
export async function casMergeMessages(
  store: RevisedRowStore,
  conversationId: string | null,
  ids: readonly string[],
  merge: StoredMessageMerge,
  deviceKeyB64: string,
  foreignExpected = false
): Promise<Set<string>> {
  const written = new Set<string>();
  let pending = [...new Set(ids)];
  let round = 0;
  while (pending.length > 0) {
    const { rows } = await store.read(conversationId, pending, deviceKeyB64, foreignExpected);
    const writes: RevisedWrite[] = [];
    for (const id of pending) {
      const current = rows.get(id);
      if (!current) continue;
      const next = merge(current.msg);
      if (!next) continue;
      writes.push({
        msg: { ...next, id: current.msg.id, conversationId: current.msg.conversationId },
        rev: current.rev,
        stamp: current.stamp,
      });
    }
    if (writes.length === 0) break;
    const ok = await store.writeIfUnchanged(conversationId, writes, deviceKeyB64);
    for (const id of ok) written.add(id);
    pending = writes.map((w) => w.msg.id).filter((id) => !ok.has(id));
    if (pending.length > 0) {
      round++;
      // Expected, and the reason this exists: say it, with the count, so a storm is visible.
      console.log(
        `[DB] ${pending.length} message row(s) were rewritten by another writer between read and write - merged again onto theirs (round ${round})`
      );
    }
  }
  return written;
}
