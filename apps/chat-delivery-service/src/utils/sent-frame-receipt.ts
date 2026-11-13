import { createHash } from 'crypto';
import type { EntityManager } from 'typeorm';

/**
 * The record a send writes beside its queued copies: this sender's device sent `messageId` into
 * the group, received at `receivedAt`, as the ciphertext whose SHA-256 is `protoSha256`
 * (`dm_sent_frame_receipt`, migration 048).
 */
export interface SentFrameKey {
  senderId: string;
  senderDeviceId: string;
  messageId: string;
  receivedAt: Date;
  protoSha256: string;
}

/**
 * The first copy of a message, as its receipt holds it: when it was received, which ciphertext it
 * was (every queued copy and its history entry carry exactly that one), and whether the send that
 * wrote it finished delivering it (`settled`).
 */
export interface FirstCopy {
  receivedAt: Date;
  protoSha256: string;
  settled: boolean;
}

/**
 * What {@link claimSentFrameReceipt} found: the id is new and now recorded, or it was recorded
 * before - with its first copy, or `null` when that row was gone by the time it was read back
 * (only a sweep deletes one: the retention window, the account's erasure).
 */
export type SentFrameClaim = { kind: 'claimed' } | { kind: 'repeat'; first: FirstCopy | null };

/** The SHA-256 of a base64 ciphertext as hex - how a receipt names the exact frame it recorded. */
export function protoSha256(proto: string): string {
  return createHash('sha256').update(proto).digest('hex');
}

/** The primary key of a receipt, in the column order every statement below uses. */
function keyOf(groupId: string, key: Omit<SentFrameKey, 'receivedAt' | 'protoSha256'>): string[] {
  return [groupId, key.senderId, key.senderDeviceId, key.messageId];
}

const WHERE_KEY = `"groupId" = $1 AND "senderId" = $2 AND "senderDeviceId" = $3 AND "messageId" = $4`;

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
  const id = keyOf(groupId, key);
  const inserted = (await m.query(
    `INSERT INTO dm_sent_frame_receipt ("groupId", "senderId", "senderDeviceId", "messageId", "receivedAt", "protoSha256")
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING "messageId"`,
    [...id, key.receivedAt, key.protoSha256]
  )) as unknown[];
  if (inserted.length > 0) return { kind: 'claimed' };
  const [first] = (await m.query(
    `SELECT "receivedAt", "protoSha256", "settled" FROM dm_sent_frame_receipt WHERE ${WHERE_KEY}`,
    id
  )) as { receivedAt: Date | string; protoSha256: string; settled: boolean }[];
  return {
    kind: 'repeat',
    first: first
      ? {
          receivedAt: new Date(first.receivedAt),
          protoSha256: first.protoSha256,
          settled: first.settled,
        }
      : null,
  };
}

/**
 * Marks the receipt SETTLED once the send that wrote it has run its delivery steps (history append,
 * live delivery, push). Returns false when the row was not there to mark.
 */
export async function markSentFrameSettled(
  m: EntityManager,
  groupId: string,
  key: Omit<SentFrameKey, 'receivedAt' | 'protoSha256'>
): Promise<boolean> {
  const [, updated] = (await m.query(
    `UPDATE dm_sent_frame_receipt SET "settled" = true WHERE ${WHERE_KEY}`,
    keyOf(groupId, key)
  )) as [unknown[], number];
  return updated > 0;
}

/**
 * Takes the settlement of an UNSETTLED receipt for one repeat, atomically: true for exactly one
 * caller, which then finishes the delivery the first send may not have reached; false when the
 * receipt is settled already (by the first send, or by another repeat that took it first).
 */
export async function takeSentFrameSettlement(
  m: EntityManager,
  groupId: string,
  key: Omit<SentFrameKey, 'receivedAt' | 'protoSha256'>
): Promise<boolean> {
  // TypeORM answers an UPDATE as `[rows, rowCount]`: the count is what says whether this caller
  // flipped the flag, and a concurrent repeat blocks on the row lock and then matches nothing.
  const [, taken] = (await m.query(
    `UPDATE dm_sent_frame_receipt SET "settled" = true WHERE ${WHERE_KEY} AND "settled" = false`,
    keyOf(groupId, key)
  )) as [unknown[], number];
  return taken > 0;
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
