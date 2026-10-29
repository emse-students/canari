/**
 * MIGRATION 114 (WP-F1) against a REAL PostgreSQL: `user_follows.status`.
 *
 * What only the database can prove: every follow present when the migration runs is recorded
 * ACCEPTED (decision 3, existing follows are kept); a row written afterwards without a status is a
 * PENDING request (the default fails closed, which is what the old image writes in the seconds of a
 * deploy); the file is a no-op the second time (the deploy ledger replays a file whose successor
 * failed); and the CHECK refuses any third value.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like `spaces/reader-spaces.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Locally, against any throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- user-follow-status.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { UserFollow } from './entities/user-follow.entity';
import { FollowsService } from './follows.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION_114 = readFileSync(
  join(__dirname, '..', 'migrations', '114_user_follow_status.sql'),
  'utf8'
);

maybe('migration 114: user_follows.status against PostgreSQL', () => {
  const schema = `follow_status_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;

  /** Every row, as `follower->followed:status`, in a stable order. */
  async function rows(): Promise<string[]> {
    const { rows: r } = await client.query(
      `SELECT "followerUserId" AS a, "followedUserId" AS b, status FROM user_follows ORDER BY 1, 2`
    );
    return r.map((x) => `${x.a}->${x.b}:${x.status}`);
  }

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    // The table as production has it before 114 (the shape TypeORM gave it, no status).
    await client.query(`
      CREATE TABLE user_follows (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "followerUserId" varchar(255) NOT NULL,
        "followedUserId" varchar(255) NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_user_follows_pair" UNIQUE ("followerUserId", "followedUserId"));
      INSERT INTO user_follows ("followerUserId", "followedUserId") VALUES ('a', 'b'), ('b', 'a'), ('c', 'a');
    `);
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  });

  it('records every existing follow ACCEPTED, and is a no-op when replayed', async () => {
    await client.query(MIGRATION_114);
    expect(await rows()).toEqual(['a->b:accepted', 'b->a:accepted', 'c->a:accepted']);
    await client.query(MIGRATION_114);
    expect(await rows()).toEqual(['a->b:accepted', 'b->a:accepted', 'c->a:accepted']);
    // Each existing follow is dated: never asked, so accepted when it was made.
    const { rows: dated } = await client.query(
      `SELECT count(*)::int AS n FROM user_follows WHERE "acceptedAt" = "createdAt"`
    );
    expect(dated[0].n).toBe(3);
  });

  it('keeps every accepted follow dated, and a notice recorded once per pair and kind', async () => {
    await expect(
      client.query(
        `INSERT INTO user_follows ("followerUserId", "followedUserId", status) VALUES ('x', 'y', 'accepted')`
      )
    ).rejects.toMatchObject({ code: '23514' });
    await client.query(
      `INSERT INTO user_follow_notices ("followerUserId", "followedUserId", kind) VALUES ('x', 'y', 'request')`
    );
    const again = await client.query(
      `INSERT INTO user_follow_notices ("followerUserId", "followedUserId", kind) VALUES ('x', 'y', 'request')
       ON CONFLICT DO NOTHING RETURNING kind`
    );
    expect(again.rows).toEqual([]);
    await expect(
      client.query(
        `INSERT INTO user_follow_notices ("followerUserId", "followedUserId", kind) VALUES ('x', 'y', 'spam')`
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('writes a row with no status as a PENDING request: the default fails closed', async () => {
    await client.query(
      `INSERT INTO user_follows ("followerUserId", "followedUserId") VALUES ('d', 'a')`
    );
    expect(await rows()).toContain('d->a:pending');
    // A replay after new rows exist still touches none of them.
    await client.query(MIGRATION_114);
    expect(await rows()).toContain('d->a:pending');
  });

  it('refuses any status other than pending and accepted', async () => {
    await expect(
      client.query(
        `INSERT INTO user_follows ("followerUserId", "followedUserId", status) VALUES ('e', 'a', 'refused')`
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it("indexes what is pending FOR a person (the request inbox's read)", async () => {
    const { rows: idx } = await client.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'IDX_user_follows_pending_followed'`,
      [schema]
    );
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toMatch(/WHERE \(\(status\)::text = 'pending'::text\)/);
  });
});

maybe('FollowsService against PostgreSQL: the request is ONE idempotent insert', () => {
  const schema = `follow_service_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let follows: FollowsService;

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}, public`);
    await admin.query(`
      CREATE TABLE user_follows (
        id uuid PRIMARY KEY,
        "followerUserId" varchar(255) NOT NULL,
        "followedUserId" varchar(255) NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_user_follows_pair" UNIQUE ("followerUserId", "followedUserId"));
      CREATE TABLE users (id varchar(255) PRIMARY KEY);
      CREATE TABLE user_blocks ("blockerId" varchar(255) NOT NULL, "blockedId" varchar(255) NOT NULL);
      INSERT INTO users (id) VALUES ('target'), ('star');
    `);
    await admin.query(MIGRATION_114);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [UserFollow],
      synchronize: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    follows = new FollowsService({} as never, ds.getRepository(UserFollow), {} as never);
  });

  afterAll(async () => {
    await ds.destroy();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it('a double tap writes one request and answers both taps, never a 500 on the unique key', async () => {
    const taps = await Promise.all(
      Array.from({ length: 8 }, () => follows.recordFollowRequest('tap', 'target'))
    );
    expect(taps.filter((t) => t.created)).toHaveLength(1);
    expect(taps.every((t) => t.status === 'pending')).toBe(true);
    const { rows } = await admin.query(
      `SELECT status FROM user_follows WHERE "followerUserId" = 'tap'`
    );
    expect(rows).toEqual([{ status: 'pending' }]);
  });

  it('a second ask leaves an ACCEPTED follow accepted, and says so', async () => {
    await follows.followUser('fan', 'star');
    await admin.query(
      `UPDATE user_follows SET status = 'accepted', "acceptedAt" = now() WHERE "followerUserId" = 'fan'`
    );
    expect(await follows.followUser('fan', 'star')).toEqual({ ok: true, status: 'accepted' });
    expect(await follows.getFollowedUserIdsForUser('fan')).toEqual(['star']);
  });
});
