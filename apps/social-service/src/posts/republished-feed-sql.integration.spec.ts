/**
 * THE CLAUSES OF THE FEEDS THAT LIST WHAT ASSOCIATIONS REPUBLISH, against a REAL PostgreSQL
 * (`republished-feed-sql.ts`), with the real visibility schema (migrations 071, 072, 073, 078).
 *
 * The cases are the user's (2026-10-24): a member's post the BDE republished is IN "Associations",
 * as ONE row, placed at the republication; a post published by one association and carried by
 * another is one row too, at the later date; a post carried by two associations is still one row,
 * at the latest republication; a member's post nobody carried stays out. And the review's: a
 * republication by an association the reader cannot see neither admits a post nor moves it. In
 * "Suivis", only a FOLLOWED association's republication admits and places a post.
 * `posts.service.republished-feed.spec.ts` proves each arm is built from these clauses.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every integration spec here: skipped without a database,
 * never passing. CI's `test-social-integration` sets it and fails on a skipped test. Everything
 * happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import {
  inAssociationsFeedSql,
  republishedFeedAtSql,
  republishedForViewerSql,
} from './republished-feed-sql';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (file: string) => readFileSync(join(__dirname, '..', 'migrations', file), 'utf8');

// Associations. The reader is a member of BDE and BDS, and of nothing else; HIDDEN has no rule, so
// it reaches its own members only - the reader does not see it.
const BDE = '00000000-0000-4000-8000-00000000b0de';
const BDS = '00000000-0000-4000-8000-00000000b0d5';
const HIDDEN = '00000000-0000-4000-8000-00000000b1dd';

// Posts: `posts.id` is a uuid, as in production (migration 073's foreign key requires it).
const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NAME: Record<string, string> = {
  [P(1)]: 'bde-own',
  [P(2)]: 'member-reposted',
  [P(3)]: 'member-alone',
  [P(4)]: 'bds-reposted',
  [P(5)]: 'member-twice',
  [P(6)]: 'member-hidden-repost',
  [P(7)]: 'bde-hidden-repost',
};

maybe('the republished-feed clauses against PostgreSQL', () => {
  const schema = `repub_feed_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;

  /** The ids the clause keeps for `reader`, newest placement first, with their placement. */
  async function feed(where: string, at: string, params: unknown[]) {
    const res = await client.query<{ id: string; at: Date }>(
      `SELECT posts.id, ${at} AS at FROM posts WHERE ${where} ORDER BY ${at} DESC, posts.id DESC`,
      params
    );
    return res.rows.map((r) => ({ name: NAME[r.id], at: r.at.toISOString() }));
  }

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    // What the visibility predicate and migration 071 read, with the production types.
    await client.query(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]');
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL, slug varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', archived boolean NOT NULL DEFAULT false,
        "isBDE" boolean NOT NULL DEFAULT false);
      CREATE TABLE posts (id uuid PRIMARY KEY, "associationId" uuid NULL,
        "publishedAt" timestamptz NOT NULL);
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions int NOT NULL DEFAULT 0);
    `);
    await client.query(
      `INSERT INTO associations (id, name, slug) VALUES ($1, 'BDE', 'bde'), ($2, 'BDS', 'bds'),
         ($3, 'HIDDEN', 'hidden')`,
      [BDE, BDS, HIDDEN]
    );
    await client.query(migration('071_spaces.sql'));
    await client.query(migration('072_drop_is_bde.sql'));
    await client.query(migration('073_republications.sql'));
    await client.query(migration('078_read_grants.sql'));
    // No rule anywhere: an association is seen by its members alone, so membership decides.
    await client.query(`DELETE FROM association_audiences`);
    await client.query(`INSERT INTO users (id) VALUES ('reader')`);
    await client.query(
      `INSERT INTO association_members ("associationId", "userId") VALUES ($1, 'reader'), ($2, 'reader')`,
      [BDE, BDS]
    );
    const posts: Array<[number, string | null, string]> = [
      [1, BDE, '2026-10-02T12:00:00Z'], // the BDE's own, carried by nobody
      [2, null, '2026-10-01T12:00:00Z'], // a member's, republished by the BDE on day 4
      [3, null, '2026-10-03T12:00:00Z'], // a member's nobody carried
      [4, BDS, '2026-10-01T08:00:00Z'], // the BDS's, republished by the BDE on day 5
      [5, null, '2026-10-01T09:00:00Z'], // a member's, by the BDS on day 2 and the BDE on day 6
      [6, null, '2026-10-01T10:00:00Z'], // a member's, carried by HIDDEN alone on day 7
      [7, BDE, '2026-10-01T11:00:00Z'], // the BDE's, carried by HIDDEN on day 8
    ];
    for (const [n, associationId, publishedAt] of posts) {
      await client.query(
        `INSERT INTO posts (id, "associationId", "publishedAt") VALUES ($1, $2, $3)`,
        [P(n), associationId, publishedAt]
      );
    }
    const reposts: Array<[number, string, string]> = [
      [2, BDE, '2026-10-04T12:00:00Z'],
      [4, BDE, '2026-10-05T12:00:00Z'],
      [5, BDS, '2026-10-02T09:00:00Z'],
      [5, BDE, '2026-10-06T09:00:00Z'],
      [6, HIDDEN, '2026-10-07T12:00:00Z'],
      [7, HIDDEN, '2026-10-08T12:00:00Z'],
    ];
    for (const [n, associationId, republishedAt] of reposts) {
      await client.query(
        `INSERT INTO post_republications ("postId", "associationId", "republishedBy", "republishedAt")
           VALUES ($1, $2, 'officer', $3)`,
        [P(n), associationId, republishedAt]
      );
    }
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('"Associations" holds what associations publish or republish, one row per post, at the latest repost the reader sees', async () => {
    expect(await feed(inAssociationsFeedSql('$1'), republishedFeedAtSql('$1'), ['reader'])).toEqual(
      [
        { name: 'member-twice', at: '2026-10-06T09:00:00.000Z' }, // the BDE's, not the BDS's day 2
        { name: 'bds-reposted', at: '2026-10-05T12:00:00.000Z' }, // one row, not a second at day 1
        { name: 'member-reposted', at: '2026-10-04T12:00:00.000Z' },
        { name: 'bde-own', at: '2026-10-02T12:00:00.000Z' },
        // HIDDEN's republication did not move it to day 8: the reader cannot see HIDDEN.
        { name: 'bde-hidden-repost', at: '2026-10-01T11:00:00.000Z' },
        // member-alone (nobody) and member-hidden-repost (HIDDEN only) are out.
      ]
    );
  });

  it('"Suivis" counts only the republications of a followed association', async () => {
    // The reader follows the BDS alone: the BDE's republications neither admit nor place.
    const where = republishedForViewerSql('$1', '$2');
    const at = republishedFeedAtSql('$1', '$2');
    expect(await feed(where, at, ['reader', [BDS]])).toEqual([
      { name: 'member-twice', at: '2026-10-02T09:00:00.000Z' },
    ]);
  });
});
