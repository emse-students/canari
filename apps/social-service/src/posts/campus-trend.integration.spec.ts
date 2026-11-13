/**
 * CAMPUS TRENDS (engagement WP-10) against a REAL PostgreSQL: migrations 160 and 161 as they ship,
 * exactly one stamp at the write that crosses `TREND_THRESHOLD` (none below it, none after 24 hours,
 * none twice, one under concurrent writers, NONE for a post already past it when first evaluated -
 * the deploy of 2026-11-10), the space-only audience - never through a follow or a read grant, never
 * the author, never across a block with the author, never a reader already told - ONE trend per
 * reader per day and TWO per Paris week, and the followed account each reader is told liked it
 * (docs/wiki/engagement.md, "WP-10 - campus trends").
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
import { TREND_THRESHOLD, announceCampusTrend, groupByLikedBy, trendMediaOf } from './campus-trend';
import { PostNotificationsService } from './post-notifications.service';
import {
  createEngagementPushCapTables,
  createPostNotificationsTable,
  givePushDevices,
  turnSuggestionPushOn,
  turnSuggestionsOffInApp,
} from './post-notifications.it-schema';
import { ERASURE_STATEMENTS } from '../internal/account-erasure';
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

/** `n` distinct accounts that LIKED it ("J'aime"), none of them the author, as `posts.reactions`. */
const likers = (n: number, from = 100) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`l${from + i}`, "J'aime"]));

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
  /** A reader - "Suggestions dans l'app" on (the default) and its opt-in PUSH turned on, unless `suggestions` is false: then switched off in the app, which silences both. */
  const user = async (id: string, campus = SE, cursus = ICM, suggestions = true) => {
    await q(`INSERT INTO users (id, campus, cursus) VALUES ($1, $2, $3)`, [id, campus, cursus]);
    if (suggestions) await turnSuggestionPushOn(q, [id]);
    else await turnSuggestionsOffInApp(q, [id]);
  };

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
        "associationId" uuid, "studentsOnly" boolean NOT NULL DEFAULT false, "reachPublic" varchar(16), "reachSpaces" jsonb,
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
    await createEngagementPushCapTables((sql) => q(sql));
    await q(migration('159_friend_activity.sql'));
    await q(migration('160_post_trend_announced_at.sql'));
    // A replay is a no-op (the deploy ledger may run it twice).
    await q(migration('160_post_trend_announced_at.sql'));
    await q(migration('161_campus_trend_calm.sql'));
    await q(migration('161_campus_trend_calm.sql'));
    await q(`INSERT INTO associations (id, name, slug) VALUES ($1, 'EG', 'eg')`, [EG]);
    await q(
      `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, NULL, $2)`,
      [EG, GA]
    );
    // a writes; s1, s2, blk, seen, grant share a's space; g is in Gardanne and follows a.
    for (const id of ['a', 's1', 's2', 'blk', 'seen', 'grant']) await user(id);
    await user('g', GA, ISMIN);
    // nos shares a's space and switched Suggestions off in the app: told of no trend, ever.
    await user('nos', SE, ICM, false);
    await givePushDevices(q, ['nos']);
    // Every reader has a device of unknown build: the push cap's floor keeps it (a trend has one).
    await givePushDevices(q, ['a', 's1', 's2', 'blk', 'seen', 'grant', 'g']);
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
    await q(`DELETE FROM campus_trend_weeks`);
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
    // not seen (a row for the post already), not g (a follower outside the space), not nos (in the
    // space, but switched Suggestions off in the app - on by default).
    expect(await announceCampusTrend({ manager, notifications }, P(1))).toBe(3);
    const stamp = await stampOf(P(1));
    expect(stamp).not.toBeNull();
    expect(await told(P(1))).toEqual(['grant', 's1', 's2']);
    // nos spent no slot of the day or the week either.
    expect((await q(`SELECT 1 FROM campus_trend_weeks WHERE "userId" = 'nos'`)).rows).toEqual([]);

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

  it("a reader already told of the post (a friends' activity row of before 2026-11-10) is not told again", async () => {
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
    await q(`UPDATE campus_trend_weeks SET "lastDay" = "lastDay" - 1`);
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

  describe('the followed account a trend names (owner, 2026-11-10; review of #3316)', () => {
    const follow = (follower: string, followed: string, status = 'accepted') =>
      q(
        `INSERT INTO user_follows (id, "followerUserId", "followedUserId", status, "acceptedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [follower, followed, status]
      );
    /** The rows of a post, as the bell reads them: `meta` resolved at the read. */
    const served = async (postId: string) => {
      const rows: {
        id: string;
        recipientId: string;
        type: string;
        meta: Record<string, unknown> | null;
      }[] = (
        await q(
          `SELECT id, "recipientId", type, meta FROM post_notifications WHERE "postId" = $1 ORDER BY 2`,
          [postId]
        )
      ).rows;
      await (
        notifications as unknown as { resolveTrendLikedBy(r: typeof rows): Promise<void> }
      ).resolveTrendLikedBy(rows);
      return Object.fromEntries(rows.map((r) => [r.recipientId, r.meta]));
    };

    beforeAll(async () => {
      // Named accounts live in Gardanne, outside the audience, so the told set is unchanged.
      for (const [id, first, last] of [
        ['e0', 'Léa', 'Martin'],
        ['e1', 'Hugo', 'Petit'],
        ['e2', 'Inès', 'Roux'],
        ['e3', 'Noé', 'Blanc'],
      ]) {
        await user(id, GA, ISMIN);
        await q(`UPDATE users SET "firstName" = $2, "lastName" = $3 WHERE id = $1`, [
          id,
          first,
          last,
        ]);
      }
    });

    /** "Partager mon activité" is OFF until turned on (owner, 2026-11-10): each named account turns it on. */
    const shareActivity = (id: string, on: boolean) =>
      q(
        `INSERT INTO user_activity_settings ("userId", "shareActivity") VALUES ($1, $2)
         ON CONFLICT ("userId") DO UPDATE SET "shareActivity" = EXCLUDED."shareActivity"`,
        [id, on]
      );

    beforeEach(async () => {
      for (const id of ['e0', 'e1', 'e2', 'e3']) await shareActivity(id, true);
    });

    afterEach(async () => {
      await q(`DELETE FROM user_follows WHERE "followerUserId" <> 'g'`);
      await q(`DELETE FROM user_activity_settings`);
      await q(`DELETE FROM user_blocks WHERE NOT ("blockerId" = 'a' AND "blockedId" = 'blk')`);
    });

    it('names nobody who never turned "Partager mon activité" on - no row is off', async () => {
      await q(`DELETE FROM user_activity_settings`);
      await follow('s1', 'e0');
      await post(P(29), 'a', { reactions: { ...likers(T), e0: "J'aime" } });
      expect(await announceCampusTrend({ manager, notifications }, P(29))).toBe(4);
      const rows = await q(
        `SELECT meta FROM post_notifications WHERE "postId" = $1 AND "recipientId" = 's1'`,
        [P(29)]
      );
      expect(rows.rows).toEqual([{ meta: null }]);
    });

    it('names, per reader, ONE followed account that LIKED it - its id on the row, its name in the push', async () => {
      // s1 follows e1 and e0: the smallest id, e0, is named.
      await follow('s1', 'e1');
      await follow('s1', 'e0');
      // s2 follows e1, who does not share their activity, and e3, who only laughed: nobody.
      await follow('s2', 'e1');
      await follow('s2', 'e3');
      await shareActivity('e1', false);
      // grant follows e2, and a block stands between them: nobody.
      await follow('grant', 'e2');
      await q(`INSERT INTO user_blocks VALUES ('e2', 'grant')`);
      // seen asked to follow e0, never accepted: nobody.
      await follow('seen', 'e0', 'pending');

      // Likes: T - 3 strangers, e0, e1, e2 and s1 (the reader) - and the author's own, never counted.
      await post(P(30), 'a', {
        reactions: {
          ...likers(T - 3),
          e0: "J'aime",
          e1: "J'adore",
          e2: "J'aime",
          e3: 'Rire',
          s1: "J'aime",
          a: "J'aime",
        },
      });
      expect(await announceCampusTrend({ manager, notifications }, P(30))).toBe(4);
      const rows = await q(
        `SELECT "recipientId", meta FROM post_notifications WHERE "postId" = $1 ORDER BY 1`,
        [P(30)]
      );
      // "et N autres" counts likes only, never the author, the named account or the reader: the
      // T - 3 strangers, e1 and e2.
      expect(rows.rows).toEqual([
        { recipientId: 'grant', meta: null },
        { recipientId: 's1', meta: { likedBy: { userId: 'e0', others: T - 1 } } },
        { recipientId: 's2', meta: null },
        { recipientId: 'seen', meta: null },
      ]);
      await new Promise((r) => setTimeout(r, 20));
      const byReader = new Map(pushes.map((p) => [p.to, p.content]));
      expect(byReader.get('s1')).toEqual(
        expect.objectContaining({
          key: 'social_campus_trend',
          actorName: 'Léa Martin',
          count: T - 1,
          legacyBody: `Aimée par Léa Martin et ${T - 1} autres`,
        })
      );
      expect(byReader.get('s2')).toEqual(
        expect.objectContaining({
          actorName: '',
          legacyBody: 'Une publication qui fait réagir votre espace',
        })
      );
      expect(byReader.get('s2')?.count).toBeUndefined();
    });

    it('the bell serves the name only while the naming holds: the like, a block, the share switch, an unfollow, the cohort, an erasure', async () => {
      await follow('s1', 'e0');
      await post(P(40), 'a', { reactions: { ...likers(T), e0: "J'aime" } });
      expect(await announceCampusTrend({ manager, notifications }, P(40))).toBe(4);
      const named = { likedBy: { name: 'Léa Martin', others: T } };
      expect((await served(P(40))).s1).toEqual(named);
      // The like taken back, or turned into a reaction that is not a like.
      await q(`UPDATE posts SET reactions = reactions - 'e0' WHERE id = $1`, [P(40)]);
      expect((await served(P(40))).s1).toEqual({});
      await q(`UPDATE posts SET reactions = reactions || '{"e0": "Rire"}' WHERE id = $1`, [P(40)]);
      expect((await served(P(40))).s1).toEqual({});
      await q(`UPDATE posts SET reactions = reactions || '{"e0": "J''adore"}' WHERE id = $1`, [
        P(40),
      ]);
      expect((await served(P(40))).s1).toEqual(named);
      // The named account now on the other side of the review cohort.
      const saved = process.env.SERVICE_ACCOUNT_USER_ID;
      process.env.SERVICE_ACCOUNT_USER_ID = 'e0';
      try {
        expect((await served(P(40))).s1).toEqual({});
      } finally {
        if (saved === undefined) delete process.env.SERVICE_ACCOUNT_USER_ID;
        else process.env.SERVICE_ACCOUNT_USER_ID = saved;
      }
      expect((await served(P(40))).s1).toEqual(named);
      // A block either way.
      await q(`INSERT INTO user_blocks VALUES ('s1', 'e0')`);
      expect((await served(P(40))).s1).toEqual({});
      await q(`DELETE FROM user_blocks WHERE "blockerId" = 's1'`);
      expect((await served(P(40))).s1).toEqual(named);
      // The share switch turned off - and its row gone, which is off too since 2026-11-10.
      await shareActivity('e0', false);
      expect((await served(P(40))).s1).toEqual({});
      await q(`DELETE FROM user_activity_settings`);
      expect((await served(P(40))).s1).toEqual({});
      await shareActivity('e0', true);
      // The follow gone.
      await q(`DELETE FROM user_follows WHERE "followerUserId" = 's1'`);
      expect((await served(P(40))).s1).toEqual({});
      await follow('s1', 'e0');
      expect((await served(P(40))).s1).toEqual(named);
      // The account erased: its key leaves the stored row, which stays and names nobody.
      const erase = ERASURE_STATEMENTS.find((x) => x.label === 'post_notifications_liked_by')!;
      await q(erase.sql, ['e0']);
      const stored = await q(
        `SELECT meta FROM post_notifications WHERE "postId" = $1 AND "recipientId" = 's1'`,
        [P(40)]
      );
      expect(stored.rows).toEqual([{ meta: {} }]);
      expect((await served(P(40))).s1).toEqual({});
    });

    it("the bell drops the name once the post's reactors are withheld from the reader (grant only)", async () => {
      // g (Gardanne) is told of EG's post, liked by e0 whom g follows; Gardanne's e0, e1 and e2
      // are told too.
      await follow('g', 'e0');
      try {
        await post(P(47), 'e3', { association: EG, reactions: { ...likers(T), e0: "J'aime" } });
        expect(await announceCampusTrend({ manager, notifications }, P(47))).toBe(4);
        expect(await told(P(47))).toEqual(['e0', 'e1', 'e2', 'g']);
        const named = { likedBy: { name: 'Léa Martin', others: T } };
        expect((await served(P(47))).g).toEqual(named);
        // g moves to Saint-Etienne and reaches Gardanne through a read grant only, with "voit les
        // commentaires" off: the post's people are withheld from g, so is the name.
        await q(`UPDATE users SET campus = $1 WHERE id = 'g'`, [SE]);
        await q(
          `INSERT INTO read_grants (user_id, campus, formation, granted_by) VALUES ('g', $1, NULL, 'admin')`,
          [GA]
        );
        expect((await served(P(47))).g).toEqual({});
      } finally {
        await q(`DELETE FROM read_grants WHERE user_id = 'g'`);
        await q(`UPDATE users SET campus = $1 WHERE id = 'g'`, [GA]);
        await q(
          `DELETE FROM user_follows WHERE "followerUserId" = 'g' AND "followedUserId" = 'e0'`
        );
      }
    });

    it('never names the author, an anonymous one included', async () => {
      // s1 follows a, who wrote the post anonymously and liked it: naming a would unmask them.
      await follow('s1', 'a');
      await post(P(41), 'a', { reactions: { ...likers(T), a: "J'aime" }, anonymous: true });
      expect(await announceCampusTrend({ manager, notifications }, P(41))).toBe(5);
      const rows = await q(`SELECT DISTINCT meta FROM post_notifications WHERE "postId" = $1`, [
        P(41),
      ]);
      expect(rows.rows).toEqual([{ meta: null }]);
    });

    it('never names an account across the review cohort', async () => {
      const saved = process.env.SERVICE_ACCOUNT_USER_ID;
      process.env.SERVICE_ACCOUNT_USER_ID = 'e0';
      try {
        await follow('s1', 'e0');
        await post(P(42), 'a', { reactions: { ...likers(T), e0: "J'aime" } });
        expect(await announceCampusTrend({ manager, notifications }, P(42))).toBe(4);
        const rows = await q(`SELECT DISTINCT meta FROM post_notifications WHERE "postId" = $1`, [
          P(42),
        ]);
        expect(rows.rows).toEqual([{ meta: null }]);
      } finally {
        if (saved === undefined) delete process.env.SERVICE_ACCOUNT_USER_ID;
        else process.env.SERVICE_ACCOUNT_USER_ID = saved;
      }
    });

    it('writes every bell row even when a push fails, and says so per group', async () => {
      await follow('s1', 'e0');
      await post(P(43), 'a', { reactions: { ...likers(T), e0: "J'aime" } });
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const failing = notificationsOn(manager);
      jest.spyOn(failing, 'pushNotice').mockRejectedValue(new Error('push down'));
      expect(await announceCampusTrend({ manager, notifications: failing }, P(43))).toBe(4);
      expect(await told(P(43))).toEqual(['grant', 's1', 's2', 'seen']);
      const rows = await q(
        `SELECT count(*)::int AS n FROM post_notifications WHERE "postId" = $1`,
        [P(43)]
      );
      expect(rows.rows[0].n).toBe(4);
      // Two groups (s1 named; the others not), each failing on its own.
      expect(warn.mock.calls.filter(([m]) => String(m).includes('push down'))).toHaveLength(2);
    });
  });

  describe('TWO trends per reader per Paris week (owner, 2026-11-10)', () => {
    /**
     * THE DATABASE'S CLOCK, PINNED: a schema of its own holds a `now()` that reads a setting, and a
     * connection whose search path names it BEFORE `pg_catalog` resolves every unqualified `now()`
     * there - the statements under test unchanged. No wall clock is asserted: the week is chosen.
     */
    const clock = `clock_${Math.random().toString(36).slice(2, 10)}`;
    let pinned: Client;
    const at = (paris: string) =>
      pinned.query(`SELECT set_config('it.now', $1, false)`, [`${paris} Europe/Paris`]);
    const onClock = {
      query: async (sql: string, params?: unknown[]) => (await pinned.query(sql, params)).rows,
    };
    const clocked = () => notificationsOn(onClock);
    /** A post published an hour before the pinned instant, past the threshold. */
    const crossingAt = async (id: string) => {
      await post(id, 'a', { reactions: reactors(T) });
      await pinned.query(
        `UPDATE posts SET "publishedAt" = now() - interval '1 hour' WHERE id = $1`,
        [id]
      );
      return announceCampusTrend({ manager: onClock, notifications: clocked() }, id);
    };

    beforeAll(async () => {
      await q(`CREATE SCHEMA ${clock}`);
      await q(
        `CREATE FUNCTION ${clock}.now() RETURNS timestamptz LANGUAGE sql STABLE
           AS $$ SELECT current_setting('it.now')::timestamptz $$`
      );
      pinned = new Client({
        connectionString: URL,
        options: `-c search_path=${clock},${schema},pg_catalog,public`,
      });
      await pinned.connect();
    });

    afterAll(async () => {
      await pinned?.end();
      await q(`DROP SCHEMA IF EXISTS ${clock} CASCADE`);
    });

    it('the pinned clock is the one the statements read', async () => {
      await at('2026-11-11 12:00');
      const day = await pinned.query(`SELECT (now() AT TIME ZONE 'Europe/Paris')::date::text AS d`);
      expect(day.rows[0].d).toBe('2026-11-11');
    });

    it('Monday and Tuesday told, Wednesday and Sunday not; the next Monday told again', async () => {
      await at('2026-11-09 12:00'); // a Monday
      expect(await crossingAt(P(31))).toBe(4);
      await at('2026-11-10 12:00');
      expect(await crossingAt(P(32))).toBe(4);
      await at('2026-11-11 12:00');
      expect(await crossingAt(P(33))).toBe(0);
      // Took off all the same: stamped, so never announced later in a quieter week.
      expect(await stampOf(P(33))).not.toBeNull();
      await at('2026-11-15 23:30'); // Sunday evening, Paris: still the same week
      expect(await crossingAt(P(34))).toBe(0);
      await at('2026-11-16 00:30'); // Monday, half past midnight Paris (still Sunday in UTC)
      expect(await crossingAt(P(35))).toBe(4);
      expect(await told(P(35))).toEqual(['grant', 's1', 's2', 'seen']);
    });

    it('a deleted post frees no slot: the week is counted on its own row, not from the ledger', async () => {
      await at('2026-11-09 12:00');
      expect(await crossingAt(P(44))).toBe(4);
      await at('2026-11-10 12:00');
      expect(await crossingAt(P(45))).toBe(4);
      // Both posts deleted: their ledger rows go with them (ON DELETE CASCADE), the count does not.
      await q(`DELETE FROM posts WHERE id IN ($1, $2)`, [P(44), P(45)]);
      await at('2026-11-11 12:00');
      expect(await crossingAt(P(46))).toBe(0);
      const week = await q(`SELECT DISTINCT told, "lastDay"::text AS d FROM campus_trend_weeks`);
      expect(week.rows).toEqual([{ told: 2, d: '2026-11-10' }]);
    });

    it('a reader with one trend this week may still have a second - the cap is per reader', async () => {
      await at('2026-11-09 12:00');
      expect(await crossingAt(P(36))).toBe(4);
      // An anonymous post reaches blk too (no oracle); blk has had no trend this week.
      await at('2026-11-10 12:00');
      await post(P(37), 'a', { reactions: reactors(T), anonymous: true });
      await pinned.query(
        `UPDATE posts SET "publishedAt" = now() - interval '1 hour' WHERE id = $1`,
        [P(37)]
      );
      expect(await announceCampusTrend({ manager: onClock, notifications: clocked() }, P(37))).toBe(
        5
      );
      await at('2026-11-12 12:00');
      await post(P(38), 'a', { reactions: reactors(T), anonymous: true });
      await pinned.query(
        `UPDATE posts SET "publishedAt" = now() - interval '1 hour' WHERE id = $1`,
        [P(38)]
      );
      expect(await announceCampusTrend({ manager: onClock, notifications: clocked() }, P(38))).toBe(
        1
      );
      expect(await told(P(38))).toEqual(['blk']);
    });
  });
});

describe('groupByLikedBy', () => {
  const row = (
    recipientId: string,
    friendId: string | null,
    others: number,
    firstName: string | null = null
  ) => ({ recipientId, friendId, others, displayName: null, firstName, lastName: null });

  it('groups by what the push says - the account and the count; an account with no name names nobody', () => {
    const groups = groupByLikedBy([
      row('r1', 'f1', 9, 'Léa'),
      row('r2', null, 0),
      row('r3', 'f1', 9, 'Léa'),
      // r5 liked it too, so its "others" leaves itself out: another sentence, another group.
      row('r5', 'f1', 8, 'Léa'),
      row('r4', 'f2', 3),
    ]);
    expect([...groups.values()]).toEqual([
      { friendId: 'f1', likedBy: { name: 'Léa', others: 9 }, recipients: ['r1', 'r3'] },
      { friendId: null, likedBy: null, recipients: ['r2', 'r4'] },
      { friendId: 'f1', likedBy: { name: 'Léa', others: 8 }, recipients: ['r5'] },
    ]);
  });

  it('never counts fewer than zero others', () => {
    const [group] = groupByLikedBy([row('r1', 'f1', -1, 'Léa')]).values();
    expect(group.likedBy).toEqual({ name: 'Léa', others: 0 });
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
