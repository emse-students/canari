/// <reference types="jest" />

/**
 * MIGRATION 048 AND THE SENT-FRAME RECEIPT, AGAINST A REAL POSTGRESQL: the table lands and replays as
 * a no-op, a second claim of one id answers the first copy's receive time, and two concurrent claims
 * of one id serialise on the primary key - the second waits for the first, then finds its committed
 * row, or inserts its own when the first rolled back. That last pair is the whole mechanism
 * (`claimSentFrameReceipt`), and a mock can only restate it; here a second session holds the key.
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
import {
  claimSentFrameReceipt,
  deleteSentFrameReceiptsBefore,
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
      `INSERT INTO dm_sent_frame_receipt ("groupId", "senderId", "senderDeviceId", "messageId", "receivedAt")
       VALUES ($1, $2, $3, $4, $5)`,
      [GROUP, k.senderId, k.senderDeviceId, k.messageId, k.receivedAt]
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

    expect(again).toEqual({
      kind: 'repeat',
      firstReceivedAt: new Date('2026-11-13T10:00:00.000Z'),
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
        firstReceivedAt: first.receivedAt,
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
