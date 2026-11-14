import { createHash } from 'crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { QueuedMessage } from '../entities/queued-message.entity';
import { PAYLOAD_RELATION, materializeDeliveries } from './queued-payload';

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
  return { kind: 'repeat', first: await readSentFrameReceipt(m, groupId, key) };
}

/** The receipt of `key` in `groupId` as committed now, or `null` when there is none. */
export async function readSentFrameReceipt(
  m: EntityManager,
  groupId: string,
  key: Omit<SentFrameKey, 'receivedAt' | 'protoSha256'>
): Promise<FirstCopy | null> {
  const [first] = (await m.query(
    `SELECT "receivedAt", "protoSha256", "settled" FROM dm_sent_frame_receipt WHERE ${WHERE_KEY}`,
    keyOf(groupId, key)
  )) as { receivedAt: Date | string; protoSha256: string; settled: boolean }[];
  return first
    ? {
        receivedAt: new Date(first.receivedAt),
        protoSha256: first.protoSha256,
        settled: first.settled,
      }
    : null;
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

/**
 * The advisory-lock key of one message's send: the first 8 bytes of a SHA-256 over the receipt's
 * primary key, as the signed 64-bit integer `pg_advisory_lock` takes (a decimal string, so no
 * precision is lost on the way to PostgreSQL).
 */
export function sentFrameLockKey(
  groupId: string,
  key: Omit<SentFrameKey, 'receivedAt' | 'protoSha256'>
): string {
  const digest = createHash('sha256').update(keyOf(groupId, key).join('\u0000')).digest();
  return digest.readBigInt64BE(0).toString();
}

/** A send's hold on its message's advisory lock: `held`, and how to give it back. */
export interface SentFrameLock {
  held: boolean;
  release(): Promise<void>;
}

/**
 * Tries to take the SESSION advisory lock of one message's send, on ONE dedicated connection held
 * until {@link SentFrameLock.release}.
 *
 * THE LOCK IS THE PROOF THAT A SEND IS ALIVE, never a clock. A send naming a `messageId` holds it
 * from before it claims the receipt until after it settled it (`settled`), so a send that cannot
 * take it knows another send of the same id is running right now; one that takes it and finds an
 * unsettled receipt knows the send that wrote it is GONE - its process died, and PostgreSQL ends a
 * dead session's locks with the session.
 *
 * ONE CONNECTION, BECAUSE A SESSION LOCK BELONGS TO ITS SESSION. Taken through the pool, the lock
 * and its unlock could land on two different connections, and a pooled connection handed back still
 * holding it would refuse every later send of that id. So the query runner is held for the whole
 * hold; and if the unlock fails, the connection is DESTROYED rather than returned to the pool, which
 * ends the session and its lock with it.
 */
export async function takeSentFrameLock(
  dataSource: DataSource,
  groupId: string,
  key: Omit<SentFrameKey, 'receivedAt' | 'protoSha256'>,
  onUnlockFailed: (e: unknown) => void
): Promise<SentFrameLock> {
  const lockKey = sentFrameLockKey(groupId, key);
  const runner = dataSource.createQueryRunner();
  let held = false;
  try {
    await runner.connect();
    const [row] = (await runner.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [
      lockKey,
    ])) as { locked: boolean }[];
    held = row?.locked === true;
  } catch (e) {
    await runner.release();
    throw e;
  }
  if (!held) {
    await runner.release();
    return { held: false, release: async () => undefined };
  }
  return {
    held: true,
    release: async () => {
      try {
        await runner.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]);
        await runner.release();
      } catch (e) {
        onUnlockFailed(e);
        // `release()` would return the session to the pool still holding the lock; releasing WITH
        // an error makes the pool destroy the client, and the session's locks end with it.
        await (
          runner as unknown as { releasePostgresConnection(err: unknown): Promise<void> }
        ).releasePostgresConnection(e);
      }
    },
  };
}

/**
 * The first copy's rows STILL QUEUED: the group's rows from this sender's device dated at the first
 * copy's receive instant whose ciphertext is the first copy's (`protoSha256`) - read with their
 * shared payload joined and materialised, so an inline row and a key-group row compare alike. A
 * copy already pulled and acknowledged is gone from the queue, and so from this answer; another
 * frame received at the same instant has another ciphertext, and is not one of them.
 */
export async function findFirstCopyRows(
  m: EntityManager,
  groupId: string,
  senderId: string,
  senderDeviceId: string,
  first: FirstCopy,
  logger: { error(message: string): void },
  traceId: string
): Promise<QueuedMessage[]> {
  const stored = await m.getRepository(QueuedMessage).find({
    where: { groupId, senderId, senderDeviceId, createdAt: first.receivedAt },
    relations: PAYLOAD_RELATION,
  });
  return materializeDeliveries(stored, logger, traceId).filter(
    (row) => !!row.proto && protoSha256(row.proto) === first.protoSha256
  );
}
