/// <reference types="jest" />

/**
 * MIGRATION 058 AND THE DELIVERY CLAIM, AGAINST A REAL POSTGRESQL: the column lands (and replays as a
 * no-op) with every existing row reading false, and `claimQueuedDelivery` hands ONE delivery of a row
 * to one caller. The concurrency is the whole mechanism and a mock can only restate it: here a second
 * session holds the claim, and the claim under test is seen WAITING behind it (`pg_blocking_pids`,
 * never a clock) before the holder commits - then answers false - or rolls back - then answers true.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads:
 * skipped without it, and run by the `test-chat-delivery-integration` job in `ci.yml`, which refuses
 * a skip. Works in a throwaway schema.
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/db bun run test -- 058_queued_message_delivery_ran
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { settledFlag } from '../testing/lockWait';
import { untilBlockedBehind } from '../testing/lockBehind';
import {
  LOCK_QUEUED_DELIVERY_SQL,
  MARK_QUEUED_DELIVERY_SQL,
  claimQueuedDelivery,
} from '../utils/queued-delivery-claim';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '058_queued_message_delivery_ran.sql'), 'utf8');

maybe('migration 058 (queued_message.deliveryRan) against PostgreSQL', () => {
  jest.setTimeout(60_000);
  const schema = `it_058_${Date.now()}`;
  let admin: Client;
  let ds: DataSource;
  /** The row queued before the migration ran, as both estates hold their queue. */
  let before: string;

  /** A second session on the same schema, to hold the claim the one under test must wait for. */
  const connect = async () => {
    const client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`SET search_path TO ${schema}`);
    return client;
  };
  const queue = async (): Promise<string> => {
    const [row] = (await ds.query(
      `INSERT INTO queued_message ("recipientId", "deviceId", proto, "isWelcome")
       VALUES ('u2', 'd2', 'V0VMQ09NRQ==', true) RETURNING id`
    )) as { id: string }[];
    return row.id;
  };
  const claim = (id: string) => ds.transaction((m) => claimQueuedDelivery(m, id));
  const ran = async (id: string): Promise<boolean | undefined> =>
    (
      (await ds.query(`SELECT "deliveryRan" FROM queued_message WHERE id = $1`, [id])) as {
        deliveryRan: boolean;
      }[]
    )[0]?.deliveryRan;
  /** A delivery that has claimed `id` in another session and is still publishing (open transaction). */
  const holdClaim = async (id: string) => {
    const holder = await connect();
    await holder.query('BEGIN');
    const locked = await holder.query(LOCK_QUEUED_DELIVERY_SQL, [id]);
    expect(locked.rows).toEqual([{ deliveryRan: false }]);
    await holder.query(MARK_QUEUED_DELIVERY_SQL, [id]);
    return holder;
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      synchronize: false,
      installExtensions: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    // The queue's columns this probe touches, as they stand before 058.
    await ds.query(
      `CREATE TABLE queued_message (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         "recipientId" varchar(255) NOT NULL, "deviceId" varchar NOT NULL, proto varchar,
         "isWelcome" boolean, "createdAt" timestamp NOT NULL DEFAULT now())`
    );
    before = await queue();
    // Applied TWICE: the deploy ledger replays a file whose successor failed.
    await ds.query(MIGRATION);
    await ds.query(MIGRATION);
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('reads false on a row queued before it, which is "no delivery recorded"', async () => {
    await expect(ran(before)).resolves.toBe(false);
  });

  it('hands a row to one delivery, and answers every later one already_ran', async () => {
    const id = await queue();

    await expect(claim(id)).resolves.toBe('claimed');
    await expect(claim(id)).resolves.toBe('already_ran');
    await expect(ran(id)).resolves.toBe(true);
  });

  it('a claim of a row whose delivery is RUNNING waits for it, then answers already_ran once it committed', async () => {
    const id = await queue();
    const holder = await holdClaim(id);
    try {
      const second = claim(id);
      await untilBlockedBehind(admin, holder, {
        what: 'the second delivery claim',
        settled: settledFlag(second),
      });
      await holder.query('COMMIT');

      await expect(second).resolves.toBe('already_ran');
    } finally {
      await holder.end();
    }
  });

  it('a claim of a row whose delivery ROLLED BACK (threw, or its process died) is claimed', async () => {
    const id = await queue();
    const holder = await holdClaim(id);
    try {
      const second = claim(id);
      await untilBlockedBehind(admin, holder, {
        what: 'the second delivery claim',
        settled: settledFlag(second),
      });
      await holder.query('ROLLBACK');

      await expect(second).resolves.toBe('claimed');
      await expect(ran(id)).resolves.toBe(true);
    } finally {
      await holder.end();
    }
  });

  it('answers gone for a row already acknowledged - nothing is left to deliver', async () => {
    const id = await queue();
    await ds.query(`DELETE FROM queued_message WHERE id = $1`, [id]);

    await expect(claim(id)).resolves.toBe('gone');
  });

  it('a claim waiting on a delivery whose row is then ACKNOWLEDGED answers gone', async () => {
    const id = await queue();
    const holder = await connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`DELETE FROM queued_message WHERE id = $1`, [id]);
      const second = claim(id);
      await untilBlockedBehind(admin, holder, {
        what: 'the delivery claim',
        settled: settledFlag(second),
      });
      await holder.query('COMMIT');

      await expect(second).resolves.toBe('gone');
    } finally {
      await holder.end();
    }
  });
});
