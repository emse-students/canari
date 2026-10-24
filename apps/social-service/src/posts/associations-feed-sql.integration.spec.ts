/**
 * THE "ASSOCIATIONS" FEED'S TWO CLAUSES, against a REAL PostgreSQL (`associations-feed-sql.ts`).
 *
 * The cases are the user's (2026-10-24): a member's post the BDE republished is IN the feed, as ONE
 * row, placed at the republication; a post published by one association and carried by another is
 * one row too, at the later date; a post carried by two associations is still one row, at the latest
 * republication; a member's post nobody carried stays out. `posts.service.associations-feed.spec.ts`
 * proves the arm is built from these clauses.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every integration spec here: skipped without a database,
 * never passing. CI's `test-social-integration` sets it and fails on a skipped test. Everything
 * happens in a throwaway schema, dropped at the end.
 */
import { Client } from 'pg';
import { ASSOCIATIONS_FEED_AT_SQL, IN_ASSOCIATIONS_FEED_SQL } from './associations-feed-sql';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const BDE = '00000000-0000-4000-8000-00000000b0de';
const BDS = '00000000-0000-4000-8000-00000000b0d5';

maybe('the associations feed clauses against PostgreSQL', () => {
  const schema = `assoc_feed_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    // Only the columns the clauses read, with the production types (migration 073 for the second).
    await client.query(`CREATE TABLE posts (
      id text PRIMARY KEY,
      "associationId" uuid NULL,
      "publishedAt" timestamptz NOT NULL
    )`);
    await client.query(`CREATE TABLE post_republications (
      "postId" text NOT NULL,
      "associationId" uuid NOT NULL,
      "republishedAt" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("postId", "associationId")
    )`);
    const posts: Array<[string, string | null, string]> = [
      // Published by the BDE on day 2, carried by nobody.
      ['bde-own', BDE, '2026-10-02T12:00:00Z'],
      // A member's post on day 1, republished by the BDE on day 4.
      ['member-reposted', null, '2026-10-01T12:00:00Z'],
      // A member's post on day 3 nobody carried: not an association's.
      ['member-alone', null, '2026-10-03T12:00:00Z'],
      // The BDS's post on day 1, republished by the BDE on day 5: already in the feed, one row.
      ['bds-reposted', BDS, '2026-10-01T08:00:00Z'],
      // A member's post on day 1, carried by the BDS on day 2 and the BDE on day 6.
      ['member-twice', null, '2026-10-01T09:00:00Z'],
    ];
    for (const [id, associationId, publishedAt] of posts) {
      await client.query(
        `INSERT INTO posts (id, "associationId", "publishedAt") VALUES ($1, $2, $3)`,
        [id, associationId, publishedAt]
      );
    }
    const reposts: Array<[string, string, string]> = [
      ['member-reposted', BDE, '2026-10-04T12:00:00Z'],
      ['bds-reposted', BDE, '2026-10-05T12:00:00Z'],
      ['member-twice', BDS, '2026-10-02T09:00:00Z'],
      ['member-twice', BDE, '2026-10-06T09:00:00Z'],
    ];
    for (const [postId, associationId, republishedAt] of reposts) {
      await client.query(
        `INSERT INTO post_republications ("postId", "associationId", "republishedAt") VALUES ($1, $2, $3)`,
        [postId, associationId, republishedAt]
      );
    }
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('holds what associations publish or republish, one row per post, newest repost first', async () => {
    const res = await client.query<{ id: string; at: Date }>(
      `SELECT posts.id, ${ASSOCIATIONS_FEED_AT_SQL} AS at FROM posts
        WHERE ${IN_ASSOCIATIONS_FEED_SQL}
        ORDER BY ${ASSOCIATIONS_FEED_AT_SQL} DESC, posts.id DESC`
    );
    expect(res.rows.map((r) => r.id)).toEqual([
      'member-twice', // day 6, the BDE's (not the BDS's day 2)
      'bds-reposted', // day 5, the BDE's - not a second card at its day 1
      'member-reposted', // day 4, the BDE's
      'bde-own', // day 2, its own publication
    ]);
    expect(res.rows.find((r) => r.id === 'member-twice')!.at.toISOString()).toBe(
      '2026-10-06T09:00:00.000Z'
    );
  });
});
