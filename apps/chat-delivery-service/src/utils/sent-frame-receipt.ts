import type { EntityManager } from 'typeorm';

/**
 * The record a send writes beside its queued copies: this sender's device sent `messageId` into
 * the group, received at `receivedAt` (`dm_sent_frame_receipt`, migration 048).
 */
export interface SentFrameKey {
  senderId: string;
  senderDeviceId: string;
  messageId: string;
  receivedAt: Date;
}

/**
 * What {@link claimSentFrameReceipt} found: the id is new and now recorded, or it was recorded
 * before - with the first copy's receive time, or `null` when that row was gone by the time it was
 * read back (only a sweep deletes one: the retention window, the account's erasure).
 */
export type SentFrameClaim = { kind: 'claimed' } | { kind: 'repeat'; firstReceivedAt: Date | null };

/**
 * Records `key` for `groupId` in the caller's transaction `m`, or reports that it was recorded
 * before.
 *
 * THE PRIMARY KEY IS THE WHOLE MECHANISM. `ON CONFLICT DO NOTHING` makes two concurrent claims of
 * one id serialise on the key: the second waits for the first transaction, and then either finds its
 * committed row (a repeat) or, the first having rolled back, inserts its own. No read-then-write
 * window and no clock - and a claim made in a transaction that is then refused leaves nothing behind.
 */
export async function claimSentFrameReceipt(
  m: EntityManager,
  groupId: string,
  key: SentFrameKey
): Promise<SentFrameClaim> {
  const id = [groupId, key.senderId, key.senderDeviceId, key.messageId];
  const inserted = (await m.query(
    `INSERT INTO dm_sent_frame_receipt ("groupId", "senderId", "senderDeviceId", "messageId", "receivedAt")
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING "messageId"`,
    [...id, key.receivedAt]
  )) as unknown[];
  if (inserted.length > 0) return { kind: 'claimed' };
  const [first] = (await m.query(
    `SELECT "receivedAt" FROM dm_sent_frame_receipt
      WHERE "groupId" = $1 AND "senderId" = $2 AND "senderDeviceId" = $3 AND "messageId" = $4`,
    id
  )) as { receivedAt: Date | string }[];
  return { kind: 'repeat', firstReceivedAt: first ? new Date(first.receivedAt) : null };
}

/**
 * Deletes the receipts received before `before`, and returns how many went. They age out with the
 * queued copies they stand for (the retention window): past it there is no copy left to duplicate.
 */
export async function deleteSentFrameReceiptsBefore(
  m: EntityManager,
  before: Date
): Promise<number> {
  const [, removed] = (await m.query(`DELETE FROM dm_sent_frame_receipt WHERE "receivedAt" < $1`, [
    before,
  ])) as [unknown[], number];
  return removed;
}
