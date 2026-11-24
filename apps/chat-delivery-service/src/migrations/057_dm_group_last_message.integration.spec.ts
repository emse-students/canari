/// <reference types="jest" />

/**
 * MIGRATION 057 AGAINST A REAL POSTGRESQL: the table lands (and replays as a no-op), the note only
 * moves forward, it goes with its conversation (ON DELETE CASCADE), and - the reason it is a table
 * of its own - writing it never waits on the `FOR SHARE` a concurrent send holds on the group row.
 * The contrast case proves the probe can see a conflict: an UPDATE of `dm_groups`, which is what
 * the first build of this note was, times out behind that same lock.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads:
 * skipped without it, and run by the `test-chat-delivery-integration` job in `ci.yml`, which refuses
 * a skip. Works in a throwaway schema.
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/db bun run test -- 057_dm_group_last_message
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { NOTE_LAST_MESSAGE_SQL } from '../services/messaging.service';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '057_dm_group_last_message.sql'), 'utf8');

const GROUP = '57575757-5757-4575-8575-575757575757';

/** The columns of `dm_groups` this probe touches; the migration needs only its primary key. */
const GROUPS_TABLE = `CREATE TABLE dm_groups (id uuid PRIMARY KEY, name varchar NULL)`;

maybe('migration 057 (dm_group_last_message) against PostgreSQL', () => {
  const schema = `it_057_${Date.now()}`;
  let admin: Client;
  let a: Client;
  let b: Client;

  /** A session on the throwaway schema. */
  const session = async (): Promise<Client> => {
    const c = new Client({ connectionString: URL, options: `-c search_path=${schema}` });
    await c.connect();
    return c;
  };

  const noted = async (): Promise<Date | null> => {
    const rows = (
      await a.query(`SELECT "lastMessageAt" FROM dm_group_last_message WHERE "groupId" = $1`, [
        GROUP,
      ])
    ).rows as { lastMessageAt: Date }[];
    return rows[0]?.lastMessageAt ?? null;
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    a = await session();
    b = await session();
    await a.query(GROUPS_TABLE);
    // Applied TWICE: the deploy ledger replays a file whose successor failed.
    await a.query(MIGRATION);
    await a.query(MIGRATION);
  });

  beforeEach(async () => {
    await a.query(`DELETE FROM dm_groups`);
    await a.query(`INSERT INTO dm_groups (id, name) VALUES ($1, 'Promo')`, [GROUP]);
  });

  afterAll(async () => {
    await a?.end();
    await b?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('moves the note forward only, whatever order the sends land in', async () => {
    await a.query(NOTE_LAST_MESSAGE_SQL, [GROUP, new Date(2_000_000)]);
    await a.query(NOTE_LAST_MESSAGE_SQL, [GROUP, new Date(1_000_000)]);
    expect((await noted())?.getTime()).toBe(2_000_000);
    await a.query(NOTE_LAST_MESSAGE_SQL, [GROUP, new Date(3_000_000)]);
    expect((await noted())?.getTime()).toBe(3_000_000);
  });

  it('goes with its conversation: deleting the group row deletes the note', async () => {
    await a.query(NOTE_LAST_MESSAGE_SQL, [GROUP, new Date(2_000_000)]);
    await a.query(`DELETE FROM dm_groups WHERE id = $1`, [GROUP]);
    expect(await noted()).toBeNull();
  });

  it('never waits on the FOR SHARE a concurrent send holds on the group row', async () => {
    await a.query('BEGIN');
    await a.query(`SELECT id FROM dm_groups WHERE id = $1 FOR SHARE`, [GROUP]);
    try {
      await b.query(`SET lock_timeout = '1s'`);
      await expect(
        b.query(NOTE_LAST_MESSAGE_SQL, [GROUP, new Date(4_000_000)])
      ).resolves.toBeDefined();
      // THE CONTRAST, so a probe that saw no conflict is a probe that could have: the first build's
      // UPDATE of the group row waits for that same lock and gives up.
      await expect(
        b.query(`UPDATE dm_groups SET name = 'x' WHERE id = $1`, [GROUP])
      ).rejects.toThrow(/lock timeout/);
    } finally {
      await a.query('ROLLBACK');
      await b.query(`RESET lock_timeout`);
    }
  });
});
