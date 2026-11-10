/**
 * POUR TOI AGAINST A REAL PostgreSQL (owner, 2026-11-10; `for-you-feed.ts`): the ranked window is
 * ordered by `forYouScoreSql` - checked against an order computed BY HAND below - the suggested posts
 * merged into it by the same score with no quota, the followed posts older than the window after it,
 * newest first; what PEOPLE the reader follows write or repost (a followed association's post is
 * in Associations, unless a followed person reposted it); the pages of one ranking neither repeat
 * nor skip, whatever happens between them (a post gaining engagement, a new post, a post hidden, a
 * block, a tail row withdrawn, a repost written or withdrawn); a ranking that is gone is a 410, a
 * Redis that does not answer a 503, a page that mixes shapes a 400. The CanaReels viewer asked
 * `ranked` is ordered by the same score. The installed clients' `followed`, `all` and `reels` are
 * unchanged: chronological, and no suggestion in any.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every integration spec here: skipped without a database.
 * CI's `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- for-you-feed.integration
 */
// FIRST: the review cohort the import-time fragments of reader-spaces are built with.
import '../spaces/review-cohort.it-fixture';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource, type Repository } from 'typeorm';
import { PostsService } from './posts.service';
import type { Post } from './entities/post.entity';
import type { RedisService } from '../common/redis/redis.service';
import type { FollowsService } from '../follows/follows.service';
import type { AssociationsService } from '../associations/associations.service';
import type { PostNotificationsService } from './post-notifications.service';
import type { PostMediaRetentionService } from './post-media-retention.service';
import type { ListPostsFeed, ListPostsParams } from './list-feed';
import {
  FOR_YOU_AS_OF_PATTERN,
  FOR_YOU_CURSOR_PATTERN,
  RANKING_GONE,
  RANKING_PAGE_INVALID,
  RANKING_UNAVAILABLE,
  forYouSnapshotOf,
  writeRankedSnapshot,
} from './for-you-feed';
import { fakeRankedRedis } from './ranked-snapshots.it-fixture';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (file: string) => readFileSync(join(__dirname, '..', 'migrations', file), 'utf8');

const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** An association of Saint-Etienne the viewer follows. */
const A1 = '00000000-0000-4000-8000-0000000c0001';

/**
 * The cast: `f` (followed by the viewer `v`) publishes F*, `s` (same space, not followed) publishes
 * S1, a popular post - a suggestion. Ages in hours before the ranking, engagement in distinct
 * accounts. The score is (1 + engaged) / (age + 2) ^ 1.5:
 */
const POSTS = {
  S1: { n: 1, author: 's', hours: 5, engaged: 5 }, //   6 / 7^1.5   = 0.324
  F1: { n: 2, author: 'f', hours: 1, engaged: 0 }, //   1 / 3^1.5   = 0.192
  F3: { n: 3, author: 'f', hours: 3, engaged: 1 }, //   2 / 5^1.5   = 0.179
  F2: { n: 4, author: 'f', hours: 24, engaged: 10 }, // 11 / 26^1.5  = 0.083
  F4: { n: 5, author: 'f', hours: 72, engaged: 20 }, // 21 / 74^1.5  = 0.033
  Ta: { n: 6, author: 'f', hours: 48, engaged: 0 }, //  1 / 50^1.5  = 0.0028, tied with Tb:
  Tb: { n: 7, author: 'f', hours: 48, engaged: 0 }, //  the same instant, the larger id first
  F6: { n: 8, author: 'f', hours: 20 * 24, engaged: 30 }, // older than 14 days: the tail
  F5: { n: 9, author: 'f', hours: 30 * 24, engaged: 0 }, //  older still
  Fnew: { n: 10, author: 'f', hours: 0, engaged: 0 }, //    published AFTER the first page
} as const;
/** Not in Pour toi: A1's post (an entity's, however engaged), and s's two reels (s is not followed). */
const OTHERS = {
  AP: { n: 20, hours: 2, engaged: 50 },
  R1: { n: 21, hours: 10, engaged: 40 }, // 41 / 12^1.5 = 0.986
  R2: { n: 22, hours: 4, engaged: 0 }, //    1 / 6^1.5  = 0.068
} as const;
type Name = keyof typeof POSTS;
const NAME: Record<string, string> = Object.fromEntries(
  [...Object.entries(POSTS), ...Object.entries(OTHERS)].map(([k, v]) => [P(v.n), k])
);
const names = (rows: { id: string }[]) => rows.map((r) => NAME[r.id] ?? r.id);

/**
 * The order computed by hand from the table above, in Pour toi's three bands: the followed posts
 * under 48 h (F1, F3, F2, by score), then the suggestion (S1 - first by score alone, second band by
 * rule), then the other followed posts of the window by score (F4, then Tb and Ta).
 */
const RANKED: Name[] = ['F1', 'F3', 'F2', 'S1', 'F4', 'Tb', 'Ta'];
const TAIL: Name[] = ['F6', 'F5'];

const reactors = (n: number, tag = 'r') =>
  JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [`${tag}${i}`, 'like'])));

maybe('Pour toi against PostgreSQL (feed=foryou)', () => {
  const schema = `for_you_it_${Math.random().toString(36).slice(2, 10)}`;
  let ds: DataSource;
  let service: PostsService;
  const fake = fakeRankedRedis();
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  type Page = { limit: number; offset: number; asOf?: string; cursor?: string };
  async function rows(
    feed: ListPostsFeed,
    page: Page = { limit: 100, offset: 0 },
    ranked = false,
    viewerUserId = 'v'
  ): Promise<any[]> {
    const params: ListPostsParams = {
      ...page,
      feed,
      viewerUserId,
      ...(feed === 'reels' ? { kind: 'reel' as const, ranked } : {}),
    };
    return (
      service as unknown as { listPostRows(p: ListPostsParams): Promise<any[]> }
    ).listPostRows(params);
  }

  /** The page after `prev`, as the client asks it: after the last place, below the last tail row. */
  const after = (prev: any[], limit: number): Page => {
    const last = prev.reduce((a, b) => (b.feedPosition > a.feedPosition ? b : a));
    return {
      limit,
      offset: last.feedPosition + 1,
      asOf: last.feedAsOf,
      ...(last.feedCursor ? { cursor: last.feedCursor } : {}),
    };
  };

  /** Walks a whole ranked list page by page, as the client does. */
  async function walk(limit: number, viewer = 'v'): Promise<any[]> {
    const all: any[] = [];
    let page = await rows('foryou', { limit, offset: 0 }, false, viewer);
    for (let guard = 0; page.length > 0 && guard < 50; guard++) {
      all.push(...page);
      if (page.length < limit) break;
      page = await rows('foryou', after(page, limit), false, viewer);
    }
    return all;
  }

  /** The status and code a ranked page was refused with. */
  async function refusal(p: Promise<unknown>): Promise<[number, string]> {
    try {
      await p;
    } catch (e: any) {
      return [e.getStatus(), e.getResponse().code];
    }
    throw new Error('served, not refused');
  }

  const repost = (post: string, by: string, hoursAgo: number) =>
    q(
      `INSERT INTO member_reposts ("postId", "reposterId", "repostedAt")
         VALUES ($1, $2, now() - $3::float8 * interval '1 hour')`,
      [post, by, hoursAgo]
    );
  const followG = () =>
    q(
      `INSERT INTO user_follows ("followerUserId", "followedUserId", status) VALUES ('v', 'g', 'accepted')`
    );
  const cleanUp = async () => {
    await q(`DELETE FROM member_reposts`);
    await q(`DELETE FROM user_blocks`);
    await q(`DELETE FROM user_follows WHERE "followedUserId" = 'g'`);
    fake.state.failReads = false;
    fake.state.failWrites = false;
    service.rankedWindowMax = 200;
  };

  const insert = (name: Name) => {
    const p = POSTS[name];
    return q(
      `INSERT INTO posts (id, "authorId", markdown, reactions, "publishedAt", "createdAt")
         VALUES ($1, $2, '', $3::jsonb, now() - make_interval(hours => $4), now() - make_interval(hours => $4))`,
      [P(p.n), p.author, reactors(p.engaged), p.hours]
    );
  };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [],
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]', promo int, "displayName" varchar,
        "firstName" varchar, "lastName" varchar);
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL, slug varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', archived boolean NOT NULL DEFAULT false,
        "logoUrl" varchar, "logoMediaId" varchar, "isBDE" boolean NOT NULL DEFAULT false,
        "createdBy" varchar(255));
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "associationId" uuid, "studentsOnly" boolean NOT NULL DEFAULT false, anonymous boolean NOT NULL DEFAULT false,
        "hiddenByModeration" boolean NOT NULL DEFAULT false, "scheduledAt" timestamptz,
        kind varchar NOT NULL DEFAULT 'post', "expiresAt" timestamptz, "durationMs" int,
        markdown text, mentions text, links jsonb, "attachedFormId" uuid,
        "linkedCalendarEventId" uuid, images jsonb NOT NULL DEFAULT '[]',
        polls jsonb NOT NULL DEFAULT '[]', forms jsonb NOT NULL DEFAULT '[]',
        reactions jsonb NOT NULL DEFAULT '{}', comments jsonb NOT NULL DEFAULT '[]',
        "feedNotifiedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "publishedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions int NOT NULL DEFAULT 0);
      CREATE TABLE association_follows (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "followerUserId" varchar(255) NOT NULL, "associationId" uuid NOT NULL);
      CREATE TABLE user_blocks ("blockerId" varchar(255) NOT NULL, "blockedId" varchar(255) NOT NULL);
      CREATE TABLE user_follows ("followerUserId" varchar(255) NOT NULL,
        "followedUserId" varchar(255) NOT NULL, status varchar(16) NOT NULL);
      CREATE TABLE post_notifications (id serial PRIMARY KEY, "recipientId" varchar(255) NOT NULL,
        type varchar NOT NULL, "postId" varchar, "actorId" varchar(255));
      CREATE TABLE IF NOT EXISTS user_moderation ("userId" varchar(255) PRIMARY KEY,
        "isMuted" boolean NOT NULL DEFAULT false);
    `);
    // A1 exists BEFORE 071, which gives it its Saint-Etienne rule.
    await q(`INSERT INTO associations (id, name, slug) VALUES ($1, 'A1', 'a1')`, [A1]);
    await q(migration('071_spaces.sql'));
    await q(migration('072_drop_is_bde.sql'));
    await q(migration('073_republications.sql'));
    await q(migration('078_read_grants.sql'));
    await q(migration('121_member_reposts.sql'));
    await q(migration('123_member_repost_notices.sql'));
    await q(migration('127_post_space_pins.sql'));
    await q(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS "liveId" uuid NULL`);
    for (const id of ['v', 'f', 's', 'g']) {
      await q(
        `INSERT INTO users (id, campus, cursus, "firstName", "lastName") VALUES ($1, 'saint-etienne', $2, $1, 'X')`,
        [id, JSON.stringify([{ formation: 'ICM', promo: 2024 }])]
      );
    }
    await q(
      `INSERT INTO user_follows ("followerUserId", "followedUserId", status) VALUES ('v', 'f', 'accepted')`
    );
    // `n`: no space at all (not a student), follows f - sees f's posts through the follow only.
    await q(`INSERT INTO users (id, cursus, "firstName", "lastName") VALUES ('n', '[]', 'n', 'X')`);
    await q(
      `INSERT INTO user_follows ("followerUserId", "followedUserId", status) VALUES ('n', 'f', 'accepted')`
    );
    for (const name of Object.keys(POSTS) as Name[]) if (name !== 'Fnew') await insert(name);
    await q(
      `INSERT INTO posts (id, "authorId", "associationId", markdown, reactions, "publishedAt")
         VALUES ($1, 'f', $2, '', $3::jsonb, now() - make_interval(hours => $4))`,
      [P(OTHERS.AP.n), A1, reactors(OTHERS.AP.engaged), OTHERS.AP.hours]
    );
    for (const r of [OTHERS.R1, OTHERS.R2]) {
      await q(
        `INSERT INTO posts (id, "authorId", kind, images, markdown, reactions, "publishedAt")
           VALUES ($1, 's', 'reel', $2::jsonb, '', $3::jsonb, now() - make_interval(hours => $4))`,
        [P(r.n), JSON.stringify([{ type: 'video', mediaId: 'v' }]), reactors(r.engaged), r.hours]
      );
    }

    const follows = {
      getFollowedAssociationIdsForUser: () => Promise.resolve([A1]),
      getFollowedUserIdsForUser: async (viewer: string) =>
        (
          (await q(
            `SELECT "followedUserId" FROM user_follows WHERE "followerUserId" = $1 AND status = 'accepted'`,
            [viewer]
          )) as { followedUserId: string }[]
        ).map((r) => r.followedUserId),
    } as unknown as FollowsService;
    const redis: RedisService = fake.redis;
    service = new PostsService(
      { manager: ds.manager } as unknown as Repository<Post>,
      redis,
      follows,
      // What the decoration of a row asks (`viewerContext`): the reader manages and moderates nothing.
      {
        mayActOnAny: () => Promise.resolve(new Set<string>()),
        moderatedPostIds: () => Promise.resolve(new Set<string>()),
      } as unknown as AssociationsService,
      {} as PostNotificationsService,
      {} as PostMediaRetentionService
    );
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds.destroy();
  });

  it('ranks the window in its bands by the score computed by hand, then the tail newest first', async () => {
    const all = await rows('foryou');
    expect(names(all)).toEqual([...RANKED, ...TAIL]);
    expect(all.map((r) => r.feedPosition)).toEqual(all.map((_, i) => i));
    expect(all.filter((r) => r.feedSuggested).map((r) => NAME[r.id])).toEqual(['S1']);
    expect(new Set(all.map((r) => r.feedAsOf)).size).toBe(1);
    expect(all[0].feedAsOf).toMatch(FOR_YOU_AS_OF_PATTERN);
  });

  it('pages of one ranking neither repeat nor skip, whatever changes between them', async () => {
    const first = await rows('foryou', { limit: 3, offset: 0 });
    expect(names(first)).toEqual(['F1', 'F3', 'F2']);
    const asOf: string = first[0].feedAsOf;

    // Between the pages: Ta becomes the most engaged post of its band, a new post appears, Tb is hidden.
    await q(`UPDATE posts SET reactions = $2::jsonb WHERE id = $1`, [
      P(POSTS.Ta.n),
      reactors(80, 'late'),
    ]);
    await insert('Fnew');
    await q(`UPDATE posts SET "hiddenByModeration" = true WHERE id = $1`, [P(POSTS.Tb.n)]);

    const next = (prev: any[]) => Math.max(...prev.map((r) => r.feedPosition)) + 1;
    const second = await rows('foryou', { limit: 3, offset: next(first), asOf });
    // Tb is withdrawn and takes no place; Ta has NOT moved above F4; Fnew is not in this ranking.
    expect(names(second)).toEqual(['S1', 'F4', 'Ta']);
    const third = await rows('foryou', { limit: 3, offset: next(second), asOf });
    expect(names(third)).toEqual(['F6', 'F5']);
    expect(third.every((r) => FOR_YOU_CURSOR_PATTERN.test(r.feedCursor))).toBe(true);
    const fourth = await rows('foryou', after(third, 3));
    expect(fourth).toEqual([]);

    // A new ranking (the reader's refresh) sees everything that happened: Fnew leads its band, Ta
    // (81 / 50^1.5 = 0.229) climbs above F4 (0.033) in the last band, Tb is gone.
    const fresh = await rows('foryou');
    expect(names(fresh)).toEqual(['Fnew', 'F1', 'F3', 'F2', 'S1', 'Ta', 'F4', 'F6', 'F5']);

    await q(`DELETE FROM posts WHERE id = $1`, [P(POSTS.Fnew.n)]);
    await q(`UPDATE posts SET "hiddenByModeration" = false WHERE id = $1`, [P(POSTS.Tb.n)]);
    await q(`UPDATE posts SET reactions = $2::jsonb WHERE id = $1`, [
      P(POSTS.Ta.n),
      reactors(POSTS.Ta.engaged),
    ]);
  });

  it('a ranking that is gone is a 410, never an empty page that reads as the end', async () => {
    expect(
      await refusal(rows('foryou', { limit: 3, offset: 3, asOf: '2026-01-01T00:00:00.000000Z' }))
    ).toEqual([410, RANKING_GONE]);
  });

  it("an entity's post nobody followed reposted is not in Pour toi: the followed association's is in Associations", async () => {
    expect(names(await rows('foryou'))).not.toContain('AP');
    expect(names(await rows('associations'))).toContain('AP');
  });

  it("the installed clients' Suivis and Campus are unchanged: chronological, no suggestion", async () => {
    const followed = await rows('followed');
    expect(names(followed)).toEqual(['F1', 'AP', 'F3', 'F2', 'Tb', 'Ta', 'F4', 'F6', 'F5']);
    expect(followed.some((r) => 'feedAsOf' in r || 'feedSuggested' in r)).toBe(false);
    const campus = await rows('all');
    expect(names(campus)).toEqual([
      'F1',
      'AP',
      'F3',
      'R2',
      'S1',
      'R1',
      'F2',
      'Tb',
      'Ta',
      'F4',
      'F6',
      'F5',
    ]);
    expect(campus.some((r) => 'feedAsOf' in r || 'feedSuggested' in r)).toBe(false);
  });

  it('the CanaReels viewer asked `ranked` is ordered by the same score; unasked, newest first as before', async () => {
    const ranked = await rows('reels', { limit: 100, offset: 0 }, true);
    expect(names(ranked)).toEqual(['R1', 'R2']);
    expect(ranked[0].feedAsOf).toMatch(FOR_YOU_AS_OF_PATTERN);
    const second = await rows('reels', { limit: 1, offset: 1, asOf: ranked[0].feedAsOf }, true);
    expect(names(second)).toEqual(['R2']);
    const installed = await rows('reels');
    expect(names(installed)).toEqual(['R2', 'R1']);
    expect(installed.some((r) => 'feedAsOf' in r)).toBe(false);
  });

  it("a followed person's repost of an association's post is in Pour toi, placed at the repost (decision A)", async () => {
    await followG();
    await repost(P(OTHERS.AP.n), 'g', 0.5);
    const all = await rows('foryou');
    // 0.5 h ago with 50 accounts engaged: first of the first band.
    expect(names(all)[0]).toBe('AP');
    expect(names(all).filter((n) => n === 'AP')).toHaveLength(1);
    await cleanUp();
    expect(names(await rows('foryou'))).not.toContain('AP');
  });

  it('a block between two pages withdraws the blocked author from the rest of the list', async () => {
    const first = await rows('foryou', { limit: 3, offset: 0 });
    expect(names(first)).toEqual(['F1', 'F3', 'F2']);
    await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ('v', 'f')`);
    expect(names(await rows('foryou', after(first, 100)))).toEqual(['S1']);
    await cleanUp();
  });

  it('a students-only post reaches a student follower only, an anonymous one no follower', async () => {
    const SO = P(30);
    const AN = P(31);
    await q(
      `INSERT INTO posts (id, "authorId", markdown, "studentsOnly", anonymous, "publishedAt")
         VALUES ($1, 'f', '', true, false, now() - interval '6 hours'),
                ($2, 'f', '', false, true, now() - interval '6 hours')`,
      [SO, AN]
    );
    const student = (await rows('foryou')).map((r) => r.id);
    expect(student).toContain(SO);
    expect(student).not.toContain(AN);
    // `n` has no space: f's posts reach it through the follow alone, never a students-only one.
    const outsider = (await rows('foryou', { limit: 100, offset: 0 }, false, 'n')).map((r) => r.id);
    expect(outsider).toContain(P(POSTS.F1.n));
    expect(outsider).not.toContain(SO);
    expect(outsider).not.toContain(AN);
    await q(`DELETE FROM posts WHERE id = ANY($1::uuid[])`, [[SO, AN]]);
  });

  it('a full window is cut at its cap, and the tail starts below its oldest row', async () => {
    service.rankedWindowMax = 3;
    const all = await walk(2);
    // The 3 most recent followed posts are ranked (with the suggestion); Tb, Ta and F4, inside the
    // 14 days but below the cut, open the tail, newest first.
    expect(names(all)).toEqual(['F1', 'F3', 'F2', 'S1', 'Tb', 'Ta', 'F4', 'F6', 'F5']);
    expect(all.map((r) => r.feedPosition)).toEqual(all.map((_, i) => i));
    await cleanUp();
  });

  it('the tail is a keyset: a served tail row withdrawn and a repost written between pages skip nothing', async () => {
    service.rankedWindowMax = 3;
    const first = await rows('foryou', { limit: 5, offset: 0 });
    expect(names(first)).toEqual(['F1', 'F3', 'F2', 'S1', 'Tb']);
    // Between the pages: the tail row just served is hidden, and a followed person reposts F5 (in
    // the tail, not yet served) - after the ranking's instant, so it does not move it.
    await q(`UPDATE posts SET "hiddenByModeration" = true WHERE id = $1`, [P(POSTS.Tb.n)]);
    await followG();
    await repost(P(POSTS.F5.n), 'g', 0);
    const second = await rows('foryou', after(first, 2));
    expect(names(second)).toEqual(['Ta', 'F4']);
    expect(names(await rows('foryou', after(second, 5)))).toEqual(['F6', 'F5']);
    await q(`UPDATE posts SET "hiddenByModeration" = false WHERE id = $1`, [P(POSTS.Tb.n)]);
    await cleanUp();
  });

  it('a post ranked through a repost withdrawn before the tail is served once (scenario a)', async () => {
    await followG();
    // F6 is 20 days old: in the window only through g's repost an hour ago.
    await repost(P(POSTS.F6.n), 'g', 1);
    const first = await rows('foryou', { limit: 2, offset: 0 });
    expect(names(first)).toEqual(['F6', 'F1']);
    await q(`DELETE FROM member_reposts`);
    const rest = await rows('foryou', after(first, 100));
    // Without the repost F6 is placed below the window again; the tail never serves a ranked post.
    expect(names(rest)).toEqual(['F3', 'F2', 'S1', 'F4', 'Tb', 'Ta', 'F5']);
    await cleanUp();
  });

  it('a post both reposted by a followed person and suggested is one row, the followed one', async () => {
    await followG();
    await repost(P(POSTS.S1.n), 'g', 2);
    const all = await walk(3);
    expect(all.filter((r) => r.id === P(POSTS.S1.n))).toHaveLength(1);
    expect(all.find((r) => r.id === P(POSTS.S1.n)).feedSuggested).toBeUndefined();
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    await cleanUp();
  });

  it('a Redis that does not answer is a 503, on the first page and on a later one', async () => {
    fake.state.failWrites = true;
    expect(await refusal(rows('foryou', { limit: 3, offset: 0 }))).toEqual([
      503,
      RANKING_UNAVAILABLE,
    ]);
    fake.state.failWrites = false;
    const first = await rows('foryou', { limit: 3, offset: 0 });
    fake.state.failReads = true;
    expect(await refusal(rows('foryou', after(first, 3)))).toEqual([503, RANKING_UNAVAILABLE]);
    await cleanUp();
  });

  it('a page that mixes two shapes of the list is a 400', async () => {
    // A later page without its ranking (a first page served in the older shape, then this one).
    expect(await refusal(rows('foryou', { limit: 3, offset: 3 }))).toEqual([
      400,
      RANKING_PAGE_INVALID,
    ]);
    const first = await rows('foryou', { limit: 3, offset: 0 });
    const asOf = first[0].feedAsOf;
    // A tail cursor inside the window, and an offset past it without a cursor.
    expect(
      await refusal(
        rows('foryou', { limit: 3, offset: 3, asOf, cursor: `${asOf}_${P(POSTS.F6.n)}` })
      )
    ).toEqual([400, RANKING_PAGE_INVALID]);
    expect(await refusal(rows('foryou', { limit: 3, offset: 50, asOf }))).toEqual([
      400,
      RANKING_PAGE_INVALID,
    ]);
  });

  it('two readers with the same asOf each page their own ranking', async () => {
    const first = await rows('foryou', { limit: 2, offset: 0 });
    const asOf: string = first[0].feedAsOf;
    const prefix = 'posts:ranked:v2:';
    const vKey = [...fake.hashes.keys()].find(
      (k) => k.startsWith(`${prefix}foryou:`) && k.endsWith(':v')
    )!;
    const list = vKey.slice(prefix.length, -':v'.length);
    // n's ranking at the very same instant, holding only F4.
    await writeRankedSnapshot(
      fake.redis,
      list,
      'n',
      forYouSnapshotOf(asOf, asOf, [{ id: P(POSTS.F4.n), at: asOf, suggested: false }])
    );
    expect(names(await rows('foryou', after(first, 100)))).toEqual([...RANKED.slice(2), ...TAIL]);
    const theirs = await rows('foryou', { limit: 1, offset: 0, asOf }, false, 'n');
    expect(names(theirs)).toEqual(['F4']);
  });

  it('through listPosts: the feed cache and the decorated rows keep the ranking facts', async () => {
    const ask = (page: Page) =>
      service.listPosts({ feed: 'foryou', viewerUserId: 'v', ...page } as ListPostsParams);
    const listed: any[] = await ask({ limit: 3, offset: 0 });
    expect(names(listed)).toEqual(['F1', 'F3', 'F2']);
    expect(listed.every((r) => FOR_YOU_AS_OF_PATTERN.test(r.feedAsOf))).toBe(true);
    expect(listed.map((r) => r.feedPosition)).toEqual([0, 1, 2]);
    // The same request is the cached page: the same ranking, not a new one.
    expect(await ask({ limit: 3, offset: 0 })).toEqual(listed);
    const next: any[] = await ask(after(listed, 3));
    expect(names(next)).toEqual(['S1', 'F4', 'Tb']);
    expect(next[0].feedSuggested).toBe(true);
    expect(next.every((r) => r.feedAsOf === listed[0].feedAsOf)).toBe(true);
  });
});
