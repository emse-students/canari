/// <reference types="jest" />

/**
 * MIGRATION 048 AND THE SENT-FRAME RECEIPT, AGAINST A REAL POSTGRESQL: the table lands and replays as
 * a no-op, a second claim of one id answers the first copy's receive time, and two concurrent claims
 * of one id serialise on the primary key - the second waits for the first, then finds its committed
 * row, or inserts its own when the first rolled back. That last pair is the whole mechanism
 * (`claimSentFrameReceipt`), and a mock can only restate it; here a second session holds the key.
 * The second block reads a first copy back from the queue by the receipt's instant.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads:
 * skipped without it, and run by the `test-chat-delivery-integration` job in `ci.yml`, which refuses
 * a skip. Works in a throwaway schema.
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/db bun run test -- 048_sent_frame_receipt
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { SentFrameReceipt } from '../entities/sent-frame-receipt.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { QueuedPayload } from '../entities/queued-payload.entity';
import { saveWithSharedPayload } from '../utils/queued-payload';
import {
  claimSentFrameReceipt,
  deleteSentFrameReceiptsBefore,
  findFirstCopyRows,
  markSentFrameSettled,
  protoSha256,
  readSentFrameReceipt,
  takeSentFrameLock,
  takeSentFrameSettlement,
  type SentFrameKey,
} from '../utils/sent-frame-receipt';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '048_sent_frame_receipt.sql'), 'utf8');

const GROUP = '44444444-4444-4444-8444-444444444444';

maybe('migration 048 (dm_sent_frame_receipt) against PostgreSQL', () => {
  jest.setTimeout(60_000);
  const schema = `sent_frame_receipt_it_${Date.now()}`;
  const options = { extra: { options: `-c search_path=${schema}` } };
  let admin: Client;
  let ds: DataSource;

  const key = (messageId: string, at: string, deviceId = 'd1'): SentFrameKey => ({
    senderId: 'u1',
    senderDeviceId: deviceId,
    messageId,
    receivedAt: new Date(at),
    protoSha256: protoSha256(`ciphertext of ${messageId} at ${at}`),
  });
  const claim = (k: SentFrameKey) => ds.transaction((m) => claimSentFrameReceipt(m, GROUP, k));
  /** A second session on the same schema, to hold the key a claim must wait for. */
  const connect = async () => {
    const client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`SET search_path TO ${schema}`);
    return client;
  };
  /** Resolves once a session is blocked behind `holder`. Polled, never timed. */
  const untilBlockedBy = async (holder: Client) => {
    const [{ pid }] = (await holder.query(`SELECT pg_backend_pid() AS pid`)).rows as Array<{
      pid: number;
    }>;
    for (;;) {
      const [{ waiting }] = (
        await admin.query(
          `SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
          [pid]
        )
      ).rows as Array<{ waiting: number }>;
      if (waiting >= 1) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  /** Inserts `k` from another session inside an open transaction, and hands the session back. */
  const holdKey = async (k: SentFrameKey) => {
    const holder = await connect();
    await holder.query('BEGIN');
    await holder.query(
      `INSERT INTO dm_sent_frame_receipt ("groupId", "senderId", "senderDeviceId", "messageId", "receivedAt", "protoSha256")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [GROUP, k.senderId, k.senderDeviceId, k.messageId, k.receivedAt, k.protoSha256]
    );
    return holder;
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [SentFrameReceipt],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      ...options,
    });
    await ds.initialize();
    // Applied TWICE: the deploy ledger replays a file whose successor failed.
    await ds.query(MIGRATION);
    await ds.query(MIGRATION);
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('is read by the entity as written by the migration', async () => {
    await expect(ds.getRepository(SentFrameReceipt).count()).resolves.toBe(0);
  });

  it('claims a new id, and answers its repeat with the first receive time', async () => {
    await expect(claim(key('m-1', '2026-11-13T10:00:00.000Z'))).resolves.toEqual({
      kind: 'claimed',
    });

    const again = await claim(key('m-1', '2026-11-13T10:00:12.000Z'));

    // The FIRST copy: its time and its ciphertext, not the repeat's - and not settled yet.
    expect(again).toEqual({
      kind: 'repeat',
      first: {
        receivedAt: new Date('2026-11-13T10:00:00.000Z'),
        protoSha256: key('m-1', '2026-11-13T10:00:00.000Z').protoSha256,
        settled: false,
      },
    });
  });

  it('claims the same id from another device of the sender', async () => {
    await claim(key('m-2', '2026-11-13T10:01:00.000Z'));

    await expect(claim(key('m-2', '2026-11-13T10:01:01.000Z', 'd2'))).resolves.toEqual({
      kind: 'claimed',
    });
  });

  it('a concurrent claim waits for the first, and is a repeat once it commits', async () => {
    const first = key('m-3', '2026-11-13T10:02:00.000Z');
    const holder = await holdKey(first);
    try {
      const second = claim(key('m-3', '2026-11-13T10:02:05.000Z'));
      await untilBlockedBy(holder);
      await holder.query('COMMIT');

      await expect(second).resolves.toEqual({
        kind: 'repeat',
        first: { receivedAt: first.receivedAt, protoSha256: first.protoSha256, settled: false },
      });
    } finally {
      await holder.end();
    }
  });

  it('a concurrent claim waits for the first, and claims once it rolls back', async () => {
    const holder = await holdKey(key('m-4', '2026-11-13T10:03:00.000Z'));
    try {
      const second = claim(key('m-4', '2026-11-13T10:03:05.000Z'));
      await untilBlockedBy(holder);
      await holder.query('ROLLBACK');

      await expect(second).resolves.toEqual({ kind: 'claimed' });
    } finally {
      await holder.end();
    }
  });

  it('a claim made in a transaction that is refused leaves no receipt behind', async () => {
    await expect(
      ds.transaction(async (m) => {
        await claimSentFrameReceipt(m, GROUP, key('m-5', '2026-11-13T10:04:00.000Z'));
        throw new Error('refused after the claim');
      })
    ).rejects.toThrow('refused after the claim');

    await expect(claim(key('m-5', '2026-11-13T10:04:09.000Z'))).resolves.toEqual({
      kind: 'claimed',
    });
  });

  it('a settled receipt reads settled, and its settlement cannot be taken', async () => {
    const k = key('m-6', '2026-11-13T10:05:00.000Z');
    await claim(k);
    await expect(markSentFrameSettled(ds.manager, GROUP, k)).resolves.toBe(true);

    await expect(claim(k)).resolves.toEqual(
      expect.objectContaining({ first: expect.objectContaining({ settled: true }) })
    );
    await expect(takeSentFrameSettlement(ds.manager, GROUP, k)).resolves.toBe(false);
  });

  it('the settlement of an unsettled receipt is taken by exactly one of two repeats', async () => {
    const k = key('m-7', '2026-11-13T10:06:00.000Z');
    await claim(k);

    const taken = await Promise.all([
      takeSentFrameSettlement(ds.manager, GROUP, k),
      takeSentFrameSettlement(ds.manager, GROUP, k),
    ]);

    expect(taken.filter(Boolean)).toHaveLength(1);
  });

  it('the retention sweep deletes the receipts older than its bound, and only those', async () => {
    await claim(key('m-old', '2026-08-01T00:00:00.000Z'));

    const removed = await deleteSentFrameReceiptsBefore(
      ds.manager,
      new Date('2026-09-01T00:00:00.000Z')
    );

    expect(removed).toBe(1);
    await expect(claim(key('m-1', '2026-11-13T11:00:00.000Z'))).resolves.toEqual(
      expect.objectContaining({ kind: 'repeat' })
    );
  });
});

/**
 * THE FIRST COPY IS FOUND BY THE RECEIPT'S INSTANT, ACROSS TWO COLUMN TYPES. A repeat that finishes
 * an interrupted first send reads its queued copies by `createdAt = receipt.receivedAt` - a
 * `timestamp without time zone` (`queued_message.createdAt`, a `CreateDateColumn`) compared with an
 * instant read back from a `timestamptz` (`dm_sent_frame_receipt.receivedAt`). A mock compares two
 * `Date`s and cannot see a lost offset or a truncated fraction; here both rows go through the real
 * writes - the inline save and the shared-payload save - and are read back as `findFirstCopyRows`
 * reads them.
 */
maybe('the receipt finds its first copy in the queue, against PostgreSQL', () => {
  jest.setTimeout(60_000);
  const schema = `sent_frame_first_copy_it_${Date.now()}`;
  let admin: Client;
  let ds: DataSource;
  const logger = { error: jest.fn() };

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [QueuedMessage, QueuedPayload],
      synchronize: true,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    await ds.query(MIGRATION);
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  /**
   * One send as the service writes it: the copies and the receipt in ONE transaction, every copy
   * dated at the receipt's instant - a millisecond instant that is not on a second boundary.
   */
  const sendOnce = async (messageId: string, proto: string, shared: boolean) => {
    const receivedAt = new Date();
    const k: SentFrameKey = {
      senderId: 'u1',
      senderDeviceId: 'd1',
      messageId,
      receivedAt,
      protoSha256: protoSha256(proto),
    };
    await ds.transaction(async (m) => {
      const rows = ['d2', 'd3'].map((deviceId) =>
        m.getRepository(QueuedMessage).create({
          recipientId: 'u2',
          deviceId,
          senderId: 'u1',
          senderDeviceId: 'd1',
          groupId: GROUP,
          proto,
          createdAt: receivedAt,
          addressed: false,
        })
      );
      if (shared) await saveWithSharedPayload(m, GROUP, rows);
      else await m.getRepository(QueuedMessage).save(rows);
      await expect(claimSentFrameReceipt(m, GROUP, k)).resolves.toEqual({ kind: 'claimed' });
    });
    const first = await readSentFrameReceipt(ds.manager, GROUP, k);
    expect(first).not.toBeNull();
    return first as NonNullable<typeof first>;
  };

  it.each([
    ['an inline save', false],
    ['a shared-payload save', true],
  ])("finds the copies of %s by the receipt's receivedAt", async (_label, shared) => {
    const proto = Buffer.from(`ciphertext ${String(shared)} ${Date.now()}`).toString('base64');
    const first = await sendOnce(`first-copy-${String(shared)}`, proto, shared);

    const rows = await findFirstCopyRows(ds.manager, GROUP, 'u1', 'd1', first, logger, 'it');

    expect(rows.map((r) => r.deviceId).sort()).toEqual(['d2', 'd3']);
    expect(rows.every((r) => r.proto === proto)).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("a message's advisory lock is held by one session at a time, and freed by its release", async () => {
    const id = { senderId: 'u1', senderDeviceId: 'd1', messageId: 'locked' };
    const unlockFailed = jest.fn();

    const first = await takeSentFrameLock(ds, GROUP, id, unlockFailed);
    const second = await takeSentFrameLock(ds, GROUP, id, unlockFailed);
    const other = await takeSentFrameLock(ds, GROUP, { ...id, messageId: 'other' }, unlockFailed);

    expect([first.held, second.held, other.held]).toEqual([true, false, true]);
    await first.release();
    await other.release();
    const third = await takeSentFrameLock(ds, GROUP, id, unlockFailed);
    expect(third.held).toBe(true);
    await third.release();
    expect(unlockFailed).not.toHaveBeenCalled();
  });

  it('does not take the copies of another frame received at the same instant', async () => {
    const proto = Buffer.from(`ciphertext same-instant ${Date.now()}`).toString('base64');
    const first = await sendOnce('same-instant', proto, false);

    const rows = await findFirstCopyRows(
      ds.manager,
      GROUP,
      'u1',
      'd1',
      { ...first, protoSha256: protoSha256('another frame') },
      logger,
      'it'
    );

    expect(rows).toEqual([]);
  });
});
