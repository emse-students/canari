/**
 * CAMPUS TRENDS (engagement WP-10) against a REAL PostgreSQL: migration 160 as it ships, exactly one
 * stamp at the write that crosses `TREND_THRESHOLD` (none below it, none after 24 hours, none twice,
 * one under concurrent writers), and the space-only audience - never through a follow or a read
 * grant, never the author, never across a block with the author, never a reader already told
 * (docs/wiki/engagement.md, "(c) campus trends").
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Locally, against any throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- campus-trend.integration
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { Client, Pool } from 'pg';
import { TREND_THRESHOLD, announceCampusTrend } from './campus-trend';
import { PostNotificationsService } from './post-notifications.service';
import { createPostNotificationsTable } from './post-notifications.it-schema';
import type { PushContent } from '../push/push-content';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

const SE = 'saint-etienne';
const GA = 'gardanne';
const ICM = JSON.stringify([{ formation: 'ICM', promo: 2025 }]);
const ISMIN = JSON.stringify([{ formation: 'ISMIN', promo: 2025 }]);

/** Gardanne's association: a Saint-Etienne reader sees its posts only through a read grant. */
const EG = '5e000000-0000-4000-8000-0000000000e9';

/** A post id per case, readable in a failure. */
const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** `n` distinct reactors, none of them the author, as `posts.reactions`. */
const reactors = (n: number, from = 0) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`e${from + i}`, 'like']));

maybe('campus trends against PostgreSQL (engagement WP-10)', () => {
  const schema = `trend_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let pool: Pool;
  const pushes: { to: string; content: PushContent }[] = [];

  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
  const manager = { query: async (sql: string, params?: unknown[]) => (await q(sql, params)).rows };
  /** A manager on a pool: concurrent writers on separate connections. */
  const pooled = {
    query: async (sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows,
  };

  const notificationsOn = (m: typeof manager) =>
    new PostNotificationsService(
      {
        manager: m,
        create: (row: Record<string, unknown>) => row,
        save: async (rows: Record<string, unknown>[]) => {
          for (const r of rows) {
            await m.query(
              `INSERT INTO post_notifications ("recipientId", type, "postId", "actorId", "actorName", text)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [r.recipientId, r.type, r.postId, r.actorId, r.actorName, r.text]
            );
          }
          return rows;
        },
      } as never,
      { manager: m } as never,
      {
        notifyContent: (to: string, content: PushContent) => {
          pushes.push({ to, content });
          return Promise.resolve();
        },
      } as never,
      { withheldAmong: () => Promise.resolve(new Set<string>()) } as never
    );
  const notifications = notificationsOn(manager);

  const post = (
    id: string,
    author: string,
    opts: {
      association?: string;
      reactions?: Record<string, string>;
      comments?: unknown[];
      hoursAgo?: number;
      kind?: string;
      hidden?: boolean;
      anonymous?: boolean;
    } = {}
  ) =>
    q(
      `INSERT INTO posts (id, "authorId", "associationId", reactions, comments, kind,
         "hiddenByModeration", markdown, "publishedAt", anonymous)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Soirée jeux', now() - make_interval(hours => $8), $9)`,
      [
        id,
        author,
        opts.association ?? null,
        JSON.stringify(opts.reactions ?? {}),
        JSON.stringify(opts.comments ?? []),
        opts.kind ?? 'post',
        opts.hidden ?? false,
        opts.hoursAgo ?? 1,
        opts.anonymous ?? false,
      ]
    );
  const react = (id: string, who: string) =>
    q(
      `UPDATE posts SET reactions = reactions || jsonb_build_object($2::text, 'like') WHERE id = $1`,
      [id, who]
    );
  const stampOf = async (id: string) =>
    (await q(`SELECT "trendAnnouncedAt" FROM posts WHERE id = $1`, [id])).rows[0].trendAnnouncedAt;
  const told = async (postId: string): Promise<string[]> =>
    (
      await q(
        `SELECT "recipientId" FROM post_engagement_notices WHERE "postId" = $1 AND reason = 'trend' ORDER BY 1`,
        [postId]
      )
    ).rows.map((r) => r.recipientId);
  const user = (id: string, campus = SE, cursus = ICM) =>
    q(`INSERT INTO users (id, campus, cursus) VALUES ($1, $2, $3)`, [id, campus, cursus]);

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}, public`);
    await q(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]', "displayName" varchar,
        "firstName" varchar, "lastName" varchar);
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL, slug varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', archived boolean NOT NULL DEFAULT false,
        "isBDE" boolean NOT NULL DEFAULT false);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "associationId" uuid, "studentsOnly" boolean NOT NULL DEFAULT false,
        anonymous boolean NOT NULL DEFAULT false, "hiddenByModeration" boolean NOT NULL DEFAULT false,
        "scheduledAt" timestamptz, kind varchar NOT NULL DEFAULT 'post', markdown text,
        reactions jsonb NOT NULL DEFAULT '{}', comments jsonb NOT NULL DEFAULT '[]',
        "publishedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions int NOT NULL DEFAULT 0);
      CREATE TABLE user_blocks ("blockerId" varchar(255) NOT NULL, "blockedId" varchar(255) NOT NULL);
      CREATE TABLE user_follows (id uuid PRIMARY KEY, "followerUserId" varchar(255) NOT NULL,
        "followedUserId" varchar(255) NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now());
      CREATE TABLE user_moderation ("userId" varchar(255) PRIMARY KEY,
        "isMuted" boolean NOT NULL DEFAULT false);
    `);
    await q(migration('114_user_follow_status.sql'));
    await createPostNotificationsTable((sql) => q(sql));
    await q(migration('071_spaces.sql'));
    await q(migration('072_drop_is_bde.sql'));
    await q(migration('073_republications.sql'));
    await q(migration('078_read_grants.sql'));
    await q(migration('132_read_grant_readers.sql'));
    await q(migration('121_member_reposts.sql'));
    await q(migration('157_engagement_push_days.sql'));
    await q(migration('159_friend_activity.sql'));
    await q(migration('160_post_trend_announced_at.sql'));
    // A replay is a no-op (the deploy ledger may run it twice).
    await q(migration('160_post_trend_announced_at.sql'));
    await q(
      readFileSync(
        join(
          __dirname,
          '../../../chat-delivery-service/src/migrations/028_notification_preferences.sql'
        ),
        'utf8'
      )
    );
    await q(`INSERT INTO associations (id, name, slug) VALUES ($1, 'EG', 'eg')`, [EG]);
    await q(
      `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, NULL, $2)`,
      [EG, GA]
    );
    // a writes; s1, s2, blk, seen, grant share a's space; g is in Gardanne and follows a.
    for (const id of ['a', 's1', 's2', 'blk', 'seen', 'grant']) await user(id);
    await user('g', GA, ISMIN);
    await q(
      `INSERT INTO user_follows (id, "followerUserId", "followedUserId", status, "acceptedAt")
       VALUES (gen_random_uuid(), 'g', 'a', 'accepted', now())`
    );
    await q(`INSERT INTO user_blocks VALUES ('a', 'blk')`);
    await q(
      `INSERT INTO read_grants (user_id, campus, formation, granted_by) VALUES ('grant', $1, NULL, 'admin')`,
      [GA]
    );
    pool = new Pool({ connectionString: URL, max: 6, options: `-c search_path=${schema},public` });
  });

  afterAll(async () => {
    await pool?.end();
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(() => {
    pushes.length = 0;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('stamps exactly once, at the write that reaches the threshold, and tells its space', async () => {
    expect(TREND_THRESHOLD).toBe(4);
    await post(P(1), 'a', { reactions: { ...reactors(3), a: 'like' } });
    await q(
      `INSERT INTO post_notifications ("recipientId", type, "postId", "actorId", text)
       VALUES ('seen', 'followed_post', $1, 'a', 'x')`,
      [P(1)]
    );
    // Three others and the author's own reaction: below the threshold.
    expect(await announceCampusTrend({ manager, notifications }, P(1))).toBe(0);
    expect(await stampOf(P(1))).toBeNull();

    await react(P(1), 'e3');
    // s1, s2, grant: they share a's space. Not a (the author), not blk (a block with the author),
    // not seen (a row for the post already), not g (a follower outside the space).
    expect(await announceCampusTrend({ manager, notifications }, P(1))).toBe(3);
    const stamp = await stampOf(P(1));
    expect(stamp).not.toBeNull();
    expect(await told(P(1))).toEqual(['grant', 's1', 's2']);

    await react(P(1), 'e4');
    expect(await announceCampusTrend({ manager, notifications }, P(1))).toBe(0);
    expect(await stampOf(P(1))).toEqual(stamp);

    const rows = await q(
      `SELECT "recipientId", type, "actorId", text FROM post_notifications
        WHERE "postId" = $1 AND type = 'campus_trend' ORDER BY 1`,
      [P(1)]
    );
    expect(rows.rows).toEqual(
      ['grant', 's1', 's2'].map((r) => ({
        recipientId: r,
        type: 'campus_trend',
        actorId: 'system',
        text: 'Soirée jeux',
      }))
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(pushes.map((p) => p.to).sort()).toEqual(['grant', 's1', 's2']);
    expect(pushes[0].content.key).toBe('social_campus_trend');
    expect(pushes[0].content.actorName).toBe('');
  });

  it('a comment writer counts once, a reactor who also comments once', async () => {
    await post(P(2), 'a', {
      reactions: reactors(2),
      comments: [{ userId: 'e0' }, { userId: 'c1' }, { userId: 'a' }],
    });
    // e0, e1 and c1: three.
    expect(await announceCampusTrend({ manager, notifications }, P(2))).toBe(0);
    await q(`UPDATE posts SET comments = comments || '[{"userId": "c2"}]'::jsonb WHERE id = $1`, [
      P(2),
    ]);
    expect(await announceCampusTrend({ manager, notifications }, P(2))).toBeGreaterThan(0);
  });

  it('none after 24 hours, none for a hidden post or a reel', async () => {
    await post(P(3), 'a', { reactions: reactors(6), hoursAgo: 25 });
    await post(P(4), 'a', { reactions: reactors(6), hidden: true });
    await post(P(5), 'a', { reactions: reactors(6), kind: 'reel' });
    for (const id of [P(3), P(4), P(5)]) {
      expect(await announceCampusTrend({ manager, notifications }, id)).toBe(0);
      expect(await stampOf(id)).toBeNull();
    }
  });

  it("an association's post: its space is told, a reader through a read grant is not", async () => {
    await post(P(6), 'a', { association: EG, reactions: reactors(4) });
    expect(await announceCampusTrend({ manager, notifications }, P(6))).toBe(1);
    expect(await told(P(6))).toEqual(['g']);
  });

  it('a reader already told by friends activity is not told again', async () => {
    await post(P(7), 'a', { reactions: reactors(4) });
    await q(
      `INSERT INTO post_engagement_notices ("postId", "recipientId", reason) VALUES ($1, 's1', 'friend')`,
      [P(7)]
    );
    expect(await announceCampusTrend({ manager, notifications }, P(7))).toBe(3);
    expect(await told(P(7))).toEqual(['grant', 's2', 'seen']);
  });

  it('an anonymous post: a block with its hidden writer withholds nothing (no oracle)', async () => {
    // The feed shows blk this post whatever the block (`blockedAuthorSql`); a trend withheld from
    // blk on that block would tell blk who wrote it.
    await post(P(9), 'a', { reactions: reactors(4), anonymous: true });
    expect(await announceCampusTrend({ manager, notifications }, P(9))).toBe(5);
    expect(await told(P(9))).toEqual(['blk', 'grant', 's1', 's2', 'seen']);
  });

  it('a ledger that cannot be written leaves the post unstamped - one statement, both or neither', async () => {
    await post(P(10), 'a', { reactions: reactors(4) });
    await q(
      `ALTER TABLE post_engagement_notices ADD CONSTRAINT it_refuse_p10 CHECK ("postId" <> '${P(10)}')`
    );
    try {
      await expect(announceCampusTrend({ manager, notifications }, P(10))).rejects.toThrow(
        /it_refuse_p10/
      );
      expect(await stampOf(P(10))).toBeNull();
    } finally {
      await q(`ALTER TABLE post_engagement_notices DROP CONSTRAINT it_refuse_p10`);
    }
    // The next write that finds the post over the threshold tells its space.
    expect(await announceCampusTrend({ manager, notifications }, P(10))).toBe(4);
    expect(await stampOf(P(10))).not.toBeNull();
  });

  it('concurrent writers over the crossing stamp once and tell each reader once', async () => {
    await post(P(8), 'a', { reactions: reactors(5) });
    const pooledNotifications = notificationsOn(pooled);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        announceCampusTrend({ manager: pooled, notifications: pooledNotifications }, P(8))
      )
    );
    expect(results.filter((n) => n > 0)).toEqual([4]);
    expect(await told(P(8))).toEqual(['grant', 's1', 's2', 'seen']);
  });
});
