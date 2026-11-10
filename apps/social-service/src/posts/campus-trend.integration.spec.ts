/**
 * CAMPUS TRENDS (engagement WP-10) against a REAL PostgreSQL: migrations 160 and 161 as they ship,
 * exactly one stamp at the write that crosses `TREND_THRESHOLD` (none below it, none after 24 hours,
 * none twice, one under concurrent writers, NONE for a post already past it when first evaluated -
 * the deploy of 2026-11-10), the space-only audience - never through a follow or a read grant, never
 * the author, never across a block with the author, never a reader already told - and ONE trend per
 * reader per day (docs/wiki/engagement.md, "WP-10 - campus trends").
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
import { TREND_THRESHOLD, announceCampusTrend, trendMediaOf } from './campus-trend';
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

/** The threshold every case is written against. */
const T = TREND_THRESHOLD;

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
              `INSERT INTO post_notifications ("recipientId", type, "postId", "actorId", "actorName", text, meta)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [r.recipientId, r.type, r.postId, r.actorId, r.actorName, r.text, r.meta ?? null]
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
      markdown?: string;
      images?: unknown[];
    } = {}
  ) =>
    q(
      `INSERT INTO posts (id, "authorId", "associationId", reactions, comments, kind,
         "hiddenByModeration", markdown, "publishedAt", anonymous, images)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $10, now() - make_interval(hours => $8), $9, $11)`,
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
        opts.markdown ?? 'Soirée jeux',
        JSON.stringify(opts.images ?? []),
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
        images jsonb NOT NULL DEFAULT '[]',
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
    await q(migration('161_campus_trend_calm.sql'));
    await q(migration('161_campus_trend_calm.sql'));
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

  beforeEach(async () => {
    pushes.length = 0;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    // Each case starts on a day nobody was told of a trend (the rule's own cases set it themselves).
    await q(`DELETE FROM post_engagement_notices WHERE reason = 'trend'`);
    // ... and with the whole daily push budget (WP-8), which every case here would otherwise share.
    await q(`DELETE FROM engagement_push_days`);
  });

  afterEach(() => jest.restoreAllMocks());

  it('stamps exactly once, at the write that reaches the threshold, and tells its space', async () => {
    // Every case is written in T: the threshold is a measurement and moves with R1.
    expect(T).toBeGreaterThan(2);
    await post(P(1), 'a', { reactions: { ...reactors(T - 1), a: 'like' } });
    await q(
      `INSERT INTO post_notifications ("recipientId", type, "postId", "actorId", text)
       VALUES ('seen', 'followed_post', $1, 'a', 'x')`,
      [P(1)]
    );
    // T - 1 others and the author's own reaction: below the threshold.
    expect(await announceCampusTrend({ manager, notifications }, P(1))).toBe(0);
    expect(await stampOf(P(1))).toBeNull();

    await react(P(1), `e${T - 1}`);
    // s1, s2, grant: they share a's space. Not a (the author), not blk (a block with the author),
    // not seen (a row for the post already), not g (a follower outside the space).
    expect(await announceCampusTrend({ manager, notifications }, P(1))).toBe(3);
    const stamp = await stampOf(P(1));
    expect(stamp).not.toBeNull();
    expect(await told(P(1))).toEqual(['grant', 's1', 's2']);

    await react(P(1), `e${T}`);
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
      reactions: reactors(T - 2),
      comments: [{ userId: 'e0' }, { userId: 'c1' }, { userId: 'a' }],
    });
    // e0 .. e(T-3) and c1 - e0 commenting counts once, the author not at all: T - 1.
    expect(await announceCampusTrend({ manager, notifications }, P(2))).toBe(0);
    await q(`UPDATE posts SET comments = comments || '[{"userId": "c2"}]'::jsonb WHERE id = $1`, [
      P(2),
    ]);
    expect(await announceCampusTrend({ manager, notifications }, P(2))).toBeGreaterThan(0);
  });

  it('none after 24 hours, none for a reel; a hidden post past it is stamped and told to nobody', async () => {
    await post(P(3), 'a', { reactions: reactors(T + 2), hoursAgo: 25 });
    await post(P(4), 'a', { reactions: reactors(T + 2), hidden: true });
    await post(P(5), 'a', { reactions: reactors(T + 2), kind: 'reel' });
    for (const id of [P(3), P(4), P(5)]) {
      expect(await announceCampusTrend({ manager, notifications }, id)).toBe(0);
      expect(await told(id)).toEqual([]);
    }
    expect(await stampOf(P(3))).toBeNull();
    expect(await stampOf(P(5))).toBeNull();
    // Stamped: a restore can never announce it on a level read (review of #3312, H1).
    expect(await stampOf(P(4))).not.toBeNull();
  });

  it('a post that took off while hidden is never announced once restored (H1)', async () => {
    await post(P(22), 'a', { reactions: reactors(T - 1), hidden: true });
    expect(await announceCampusTrend({ manager, notifications }, P(22))).toBe(0);
    await react(P(22), `e${T - 1}`);
    expect(await announceCampusTrend({ manager, notifications }, P(22))).toBe(0);
    expect(await stampOf(P(22))).not.toBeNull();
    await q(`UPDATE posts SET "hiddenByModeration" = false WHERE id = $1`, [P(22)]);
    await react(P(22), `e${T}`);
    expect(await announceCampusTrend({ manager, notifications }, P(22))).toBe(0);
    expect(await told(P(22))).toEqual([]);
  });

  it('a post restored BELOW the threshold is announced at its real crossing after it', async () => {
    await post(P(23), 'a', { reactions: reactors(T - 2), hidden: true });
    expect(await announceCampusTrend({ manager, notifications }, P(23))).toBe(0);
    await q(`UPDATE posts SET "hiddenByModeration" = false WHERE id = $1`, [P(23)]);
    await react(P(23), `e${T - 2}`);
    await react(P(23), `e${T - 1}`);
    expect(await announceCampusTrend({ manager, notifications }, P(23))).toBe(4);
  });

  it("an association's post: its space is told, a reader through a read grant is not", async () => {
    await post(P(6), 'a', { association: EG, reactions: reactors(T) });
    expect(await announceCampusTrend({ manager, notifications }, P(6))).toBe(1);
    expect(await told(P(6))).toEqual(['g']);
  });

  it('a reader already told by friends activity is not told again', async () => {
    await post(P(7), 'a', { reactions: reactors(T) });
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
    await post(P(9), 'a', { reactions: reactors(T), anonymous: true });
    expect(await announceCampusTrend({ manager, notifications }, P(9))).toBe(5);
    expect(await told(P(9))).toEqual(['blk', 'grant', 's1', 's2', 'seen']);
  });

  it('a ledger that cannot be written leaves the post unstamped - one statement, both or neither', async () => {
    await post(P(10), 'a', { reactions: reactors(T) });
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
    await post(P(8), 'a', { reactions: reactors(T + 1) });
    const pooledNotifications = notificationsOn(pooled);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        announceCampusTrend({ manager: pooled, notifications: pooledNotifications }, P(8))
      )
    );
    expect(results.filter((n) => n > 0)).toEqual([4]);
    expect(await told(P(8))).toEqual(['grant', 's1', 's2', 'seen']);
  });

  /** A post as the estates hold one written before migration 161: no recorded count. */
  const unrecorded = (id: string) =>
    q(`UPDATE posts SET "trendEngagedSeen" = NULL WHERE id = $1`, [id]);

  it('a post already past the threshold when first evaluated is never announced (the deploy of 2026-11-10)', async () => {
    // Published before the rule, already past it: its next reactions record a count, stamp nothing.
    await post(P(11), 'a', { reactions: reactors(T + 2) });
    await unrecorded(P(11));
    expect(await announceCampusTrend({ manager, notifications }, P(11))).toBe(0);
    // Stamped at that first evaluation, told to nobody: a rollback to 1.6.9 finds it stamped (H2).
    const stamp = await stampOf(P(11));
    expect(stamp).not.toBeNull();
    await react(P(11), `e${T + 2}`);
    expect(await announceCampusTrend({ manager, notifications }, P(11))).toBe(0);
    expect(await stampOf(P(11))).toEqual(stamp);
    expect(await told(P(11))).toEqual([]);
    // Published before the rule BELOW the threshold: recorded at its first evaluation, then a real
    // crossing is announced.
    await post(P(12), 'a', { reactions: reactors(T - 2) });
    await unrecorded(P(12));
    expect(await announceCampusTrend({ manager, notifications }, P(12))).toBe(0);
    await react(P(12), `e${T - 2}`);
    await react(P(12), `e${T - 1}`);
    expect(await announceCampusTrend({ manager, notifications }, P(12))).toBe(4);
  });

  it('a count recorded at or past the threshold (a threshold lowered since) announces nothing', async () => {
    await post(P(13), 'a', { reactions: reactors(T) });
    await q(`UPDATE posts SET "trendEngagedSeen" = $2 WHERE id = $1`, [P(13), T]);
    await react(P(13), `e${T}`);
    expect(await announceCampusTrend({ manager, notifications }, P(13))).toBe(0);
    // Stamped silently: past the threshold, and never announced later.
    expect(await stampOf(P(13))).not.toBeNull();
    expect(await told(P(13))).toEqual([]);
  });

  it('records the count it read at every evaluation, and writes nothing when it did not change', async () => {
    await post(P(14), 'a', { reactions: reactors(1) });
    expect(await announceCampusTrend({ manager, notifications }, P(14))).toBe(0);
    const seen = async () =>
      (await q(`SELECT "trendEngagedSeen" AS n FROM posts WHERE id = $1`, [P(14)])).rows[0].n;
    expect(await seen()).toBe(1);
    const xmin = async () =>
      (await q(`SELECT xmin::text AS x FROM posts WHERE id = $1`, [P(14)])).rows[0].x;
    const before = await xmin();
    expect(await announceCampusTrend({ manager, notifications }, P(14))).toBe(0);
    expect(await xmin()).toBe(before);
  });

  it('ONE trend per reader per day: a second post the same day tells only who was not told yet', async () => {
    await post(P(15), 'a', { reactions: reactors(T) });
    expect(await announceCampusTrend({ manager, notifications }, P(15))).toBe(4);
    // grant, s1, s2 and seen were told today; blk - left out of a's named post by the block, but
    // in the audience of an anonymous one - has had no trend today, so it alone is told.
    await post(P(16), 'a', { reactions: reactors(T), anonymous: true });
    await new Promise((r) => setTimeout(r, 20));
    pushes.length = 0;
    expect(await announceCampusTrend({ manager, notifications }, P(16))).toBe(1);
    expect(await told(P(16))).toEqual(['blk']);
    // The post took off all the same: stamped, so never announced again.
    expect(await stampOf(P(16))).not.toBeNull();
    const rows = await q(
      `SELECT "recipientId" FROM post_notifications WHERE "postId" = $1 ORDER BY 1`,
      [P(16)]
    );
    expect(rows.rows.map((r) => r.recipientId)).toEqual(['blk']);
    await new Promise((r) => setTimeout(r, 20));
    expect(pushes.map((p) => p.to)).toEqual(['blk']);
  });

  it('the next Paris day, a reader may be told of a trend again', async () => {
    await post(P(17), 'a', { reactions: reactors(T) });
    expect(await announceCampusTrend({ manager, notifications }, P(17))).toBe(4);
    // Move yesterday's rows to yesterday by the database's own clock - no wall clock asserted.
    await q(`UPDATE post_engagement_notices SET "trendDay" = "trendDay" - 1 WHERE "postId" = $1`, [
      P(17),
    ]);
    await post(P(18), 'a', { reactions: reactors(T) });
    expect(await announceCampusTrend({ manager, notifications }, P(18))).toBe(4);
    expect(await told(P(18))).toEqual(['grant', 's1', 's2', 'seen']);
  });

  it('two posts crossing at once: each reader is told of exactly one', async () => {
    await post(P(19), 'a', { reactions: reactors(T) });
    await post(P(20), 'a', { reactions: reactors(T) });
    const pooledNotifications = notificationsOn(pooled);
    const counts = await Promise.all(
      [P(19), P(20)].map((id) =>
        announceCampusTrend({ manager: pooled, notifications: pooledNotifications }, id)
      )
    );
    expect(counts.reduce((a, b) => a + b, 0)).toBe(4);
    const perReader = await q(
      `SELECT "recipientId", count(*)::int AS n FROM post_engagement_notices
        WHERE reason = 'trend' GROUP BY 1 ORDER BY 1`
    );
    expect(perReader.rows).toEqual(
      ['grant', 's1', 's2', 'seen'].map((recipientId) => ({ recipientId, n: 1 }))
    );
  });

  it('a post with no text is told by what it shows: its photo, on the row and in the push', async () => {
    await post(P(21), 'a', {
      reactions: reactors(T),
      markdown: '',
      images: [{ type: 'image', mediaId: 'm1' }],
    });
    expect(await announceCampusTrend({ manager, notifications }, P(21))).toBe(4);
    const rows = await q(`SELECT DISTINCT text, meta FROM post_notifications WHERE "postId" = $1`, [
      P(21),
    ]);
    expect(rows.rows).toEqual([{ text: '', meta: { media: 'photo' } }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(new Set(pushes.map((p) => p.content.key))).toEqual(
      new Set(['social_campus_trend_photo'])
    );
  });
});

describe('trendMediaOf', () => {
  it('names the first picture or video, in their order, and nothing else', () => {
    expect(trendMediaOf([{ type: 'image' }, { type: 'video' }])).toBe('photo');
    expect(trendMediaOf([{ type: 'file' }, { type: 'video' }])).toBe('video');
    expect(trendMediaOf([{ type: 'audio' }])).toBeNull();
    expect(trendMediaOf([])).toBeNull();
    expect(trendMediaOf(null)).toBeNull();
  });
});
