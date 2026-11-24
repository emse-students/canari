import { mergeReactions } from '$lib/utils/chat/messageReactions';
import { casMergeMessages, type RevisedRow, type RevisedRowStore } from './messageCas';
import type { MessageMove, StoredMessage } from './types';

/**
 * MOVING A MESSAGE ROW TO ANOTHER CONVERSATION LOSES NOTHING, EVEN WHEN THE DESTINATION ALREADY
 * HOLDS ONE UNDER THE SAME ID (`IStorage.moveMessages`, the one way a row changes conversation).
 *
 * A row is keyed by `(conversationId, id)`, so a move can meet a row the destination already holds
 * under that id: a history bundle or a replayed copy of the joined group landed beside the old
 * group's row during a 1:1 re-key, or the boot merge folds a thread whose row the survivor already
 * holds. The two are the SAME message seen twice, and each may hold what the other lacks - this
 * device's own proofs, a tombstone or an edit, reactions, the recorded 410 of a reel, the reason a
 * send never went. So the source is UNITED onto the destination ({@link uniteMovedRow}, convergent)
 * through the compare-and-set, and only then deleted, and only while it is still the row that was
 * read. A row one side cannot open is never united and never deleted: it stays where it is.
 *
 * TERMINATION IS A PROOF, as in the compare-and-set (`messageCas.ts`): a round repeats for a row only
 * when another writer committed to its source between this round's read and its delete.
 */

/** What a backend provides for {@link moveMessageRows}, beyond the compare-and-set's own two halves. */
export interface MovableRowStore extends RevisedRowStore {
  /**
   * Re-keys each named row of `from` that `to` does not hold onto `to`, atomically per row; the ids
   * moved, and the ids still under `from` because `to` holds a row under them (`collided`).
   */
  rekeyAbsent(
    from: string,
    to: string,
    ids: readonly string[]
  ): Promise<{ moved: string[]; collided: string[] }>;
  /** Deletes each row of `conversationId` only while its token is still the one read; the ids deleted. */
  deleteIfUnchanged(
    conversationId: string,
    rows: ReadonlyArray<{ id: string; rev: number; stamp: string }>
  ): Promise<Set<string>>;
}

/** The one implementation of `IStorage.moveMessages` (see the module header). */
export async function moveMessageRows(
  store: MovableRowStore,
  from: string,
  to: string,
  ids: readonly string[],
  deviceKeyB64: string
): Promise<MessageMove> {
  const out: MessageMove = { moved: [], alreadyThere: [], kept: [] };
  let pending = [...new Set(ids)];
  if (pending.length === 0 || from === to) return out;
  let round = 0;
  while (pending.length > 0) {
    round++;
    const { moved, collided } = await store.rekeyAbsent(from, to, pending);
    out.moved.push(...moved);
    if (collided.length === 0) break;
    const { rows: sources } = await store.read(from, collided, deviceKeyB64);
    const readable = collided.filter((id) => sources.has(id));
    const united = await casMergeMessages(
      store,
      to,
      readable,
      (current) => uniteMovedRow(current, (sources.get(current.id) as RevisedRow).msg),
      deviceKeyB64
    );
    const deleted = await store.deleteIfUnchanged(
      from,
      [...united].map((id) => {
        const { rev, stamp } = sources.get(id) as RevisedRow;
        return { id, rev, stamp };
      })
    );
    out.alreadyThere.push(...deleted);
    // A row one side cannot open is neither united nor deleted - it stays under `from`.
    out.kept.push(...collided.filter((id) => !united.has(id)));
    // Written to since it was read: read, united and deleted again.
    pending = [...united].filter((id) => !deleted.has(id));
    if (pending.length > 0) {
      console.debug(
        `[DB] move round ${round}: ${pending.length} source row(s) of ${from.slice(0, 8)}... changed since read - united again`
      );
    }
  }
  if (out.kept.length > 0) {
    console.warn(
      `[DB] ${out.kept.length} message row(s) of ${from.slice(0, 8)}... NOT moved to ${to.slice(0, 8)}...: both hold the id and one side does not open on this device - left under ${from.slice(0, 8)}...`
    );
  }
  console.debug(
    `[DB] moved ${out.moved.length} message row(s) from ${from.slice(0, 8)}... to ${to.slice(0, 8)}... (${out.alreadyThere.length} united with the row already there)`
  );
  return out;
}

/** The later of two optional instants for an edit; an absent one loses. */
const editedAtOf = (m: StoredMessage): number => (m.isEdited ? (m.editedAt ?? 0) : -1);

/**
 * Which of two copies of one message holds its BODY: a tombstone beats a body (a deletion is final),
 * a delivered copy beats a notification preview, the later edit beats an earlier one or none; on a
 * tie the row already at the destination.
 */
function bodyHolder(there: StoredMessage, moving: StoredMessage): StoredMessage {
  if (!!there.isDeleted !== !!moving.isDeleted) return there.isDeleted ? there : moving;
  if (there.isDeleted) return there.deleteProof || !moving.deleteProof ? there : moving;
  if (!!there.isFcmPreview !== !!moving.isFcmPreview) return there.isFcmPreview ? moving : there;
  return editedAtOf(moving) > editedAtOf(there) ? moving : there;
}

/**
 * Two stored copies of ONE message united into the row kept under the destination's key: the body
 * (and the proofs of those bytes) from {@link bodyHolder}; every reaction of both (the convergent
 * set, `mergeReactions`); the first recorded 410; a send's unsent reason and server time from
 * whichever holds one; the original's author proof from either, unless the body is a tombstone,
 * which purges it. Pure; the key (`conversationId`, `id`, `timestamp`) is the destination's.
 */
export function uniteMovedRow(there: StoredMessage, moving: StoredMessage): StoredMessage {
  const body = bodyHolder(there, moving);
  const other = body === there ? moving : there;
  const united: StoredMessage = {
    ...body,
    id: there.id,
    conversationId: there.conversationId,
    timestamp: there.timestamp,
  };
  if (!body.isDeleted && !united.authorship && other.authorship) {
    united.authorship = other.authorship;
  }
  if (
    united.restoredUnverified &&
    !other.restoredUnverified &&
    other.content === body.content &&
    !other.isFcmPreview
  ) {
    delete united.restoredUnverified;
  }
  const reactions =
    there.reactions || moving.reactions
      ? (mergeReactions(there.reactions ?? [], moving.reactions ?? []) ?? there.reactions ?? [])
      : undefined;
  if (reactions) united.reactions = reactions;
  const purged = [there.mediaPurgedAt, moving.mediaPurgedAt].filter(
    (at): at is number => typeof at === 'number'
  );
  if (purged.length > 0) united.mediaPurgedAt = Math.min(...purged);
  const unsent = there.unsentReason ?? moving.unsentReason;
  if (unsent) united.unsentReason = unsent;
  const serverTimestamp = there.serverTimestamp ?? moving.serverTimestamp;
  if (serverTimestamp !== undefined) united.serverTimestamp = serverTimestamp;
  return united;
}
