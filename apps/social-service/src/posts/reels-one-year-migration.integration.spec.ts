/**
 * Migration 158 (owner, 2026-11-09: a CanaReel lives one year) against a REAL PostgreSQL: the live
 * reels published under the month are re-dated to `createdAt + 365 days`, and NOTHING else moves - a
 * post, a live replay (`kind = 'replay'`, its own three days), a reel already past its month (its blob
 * may be gone) and a reel already on the year all keep their expiry. A second run changes nothing.
 *
 * GATED on `SOCIAL_IT_DATABASE_URL` like every integration file (CI's `test-social-integration`
 * fails on a skipped test); the ONE-COPY check below runs everywhere.
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://admin:password@localhost:5432/auth_db bun run test -- reels-one-year-migration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { REEL_RETENTION_DAYS } from './reel.constants';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '158_reels_live_one_year.sql'),
  'utf8'
);

describe('migration 158 - the lifetime it writes', () => {
  it('is the lifetime a new reel gets, so the old reels and the new ones end alike', () => {
    const days = [...MIGRATION.matchAll(/interval '(\d+) days'/g)].map((m) => Number(m[1]));
    // The two intervals of the statement itself (the comment's rollback names the old month).
    expect(days.filter((d) => d !== 30)).toEqual([REEL_RETENTION_DAYS, REEL_RETENTION_DAYS]);
  });

  it("names kind = 'reel' in its WHERE and never a replay", () => {
    const statement = MIGRATION.slice(MIGRATION.indexOf('UPDATE posts\n'));
    expect(statement).toMatch(/WHERE kind = 'reel'/);
    expect(statement).not.toMatch(/replay/);
  });
});

maybe('migration 158 against PostgreSQL', () => {
  const schema = `reel_year_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;

  const CREATED = '2026-11-01T00:00:00Z';
  const ids = {
    liveReel: '00000000-0000-4000-8000-000000000001',
    deadReel: '00000000-0000-4000-8000-000000000002',
    replay: '00000000-0000-4000-8000-000000000003',
    post: '00000000-0000-4000-8000-000000000004',
    yearReel: '00000000-0000-4000-8000-000000000005',
  };

  const expiryOf = async (id: string): Promise<string | null> => {
    const { rows } = await client.query<{ e: string | null }>(
      `SELECT to_char("expiresAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS e FROM posts WHERE id = $1`,
      [id]
    );
    return rows[0].e;
  };

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    // The columns the statement reads, with no kind CHECK: `replay` rows exist once migration 156
    // has widened it, and this file must hold whichever lands first.
    await client.query(`CREATE TABLE posts (
      id uuid PRIMARY KEY, kind varchar(16) NOT NULL DEFAULT 'post',
      "durationMs" integer NULL, "expiresAt" timestamptz NULL, "createdAt" timestamptz NOT NULL)`);
    const insert = (id: string, kind: string, expires: string | null, created = CREATED) =>
      client.query(
        `INSERT INTO posts (id, kind, "durationMs", "expiresAt", "createdAt") VALUES ($1, $2, $3, $4, $5)`,
        [id, kind, kind === 'post' ? null : 30_000, expires, created]
      );
    // A reel published a week ago under the month: still live, so it moves to the year.
    // (Dated from the database's clock, which the migration's `now()` reads.)
    await insert(ids.liveReel, 'reel', CREATED);
    await client.query(
      `UPDATE posts SET "createdAt" = date_trunc('second', now()) - interval '7 days',
                        "expiresAt" = date_trunc('second', now()) + interval '23 days'
        WHERE id = $1`,
      [ids.liveReel]
    );
    // A reel past its month that the worker has not reached: dead, left to the worker.
    await insert(ids.deadReel, 'reel', '2026-01-31T00:00:00Z', '2026-01-01T00:00:00Z');
    // A live replay: three days, its own lifetime.
    await insert(ids.replay, 'replay', '2099-01-04T00:00:00Z', '2099-01-01T00:00:00Z');
    await insert(ids.post, 'post', null);
    // A reel published under the new rule: already on the year.
    await insert(ids.yearReel, 'reel', '2027-11-01T00:00:00Z');
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('moves a live reel to createdAt + 365 days, and nothing else', async () => {
    const { rows: before } = await client.query<{ c: string }>(
      `SELECT to_char(("createdAt" + interval '365 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS c FROM posts WHERE id = $1`,
      [ids.liveReel]
    );
    await client.query(MIGRATION);

    expect(await expiryOf(ids.liveReel)).toBe(before[0].c);
    expect(await expiryOf(ids.deadReel)).toBe('2026-01-31T00:00:00');
    expect(await expiryOf(ids.replay)).toBe('2099-01-04T00:00:00');
    expect(await expiryOf(ids.post)).toBeNull();
    expect(await expiryOf(ids.yearReel)).toBe('2027-11-01T00:00:00');
  });

  it('changes nothing on a second run (a deploy that fails midway re-runs the file)', async () => {
    const snapshot = await client.query(`SELECT id, "expiresAt" FROM posts ORDER BY id`);
    const res = await client.query(MIGRATION);
    expect(res.rowCount).toBe(0);
    const again = await client.query(`SELECT id, "expiresAt" FROM posts ORDER BY id`);
    expect(again.rows).toEqual(snapshot.rows);
  });
});
