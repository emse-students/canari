/**
 * THE CANAREELS VIEWER'S LIST IS EXACTLY THE REELS THE READER MAY SEE (owner's defect, 2026-11-03),
 * against a REAL PostgreSQL - migrations 071, 072, 073, 078, 121 and 123 applied.
 *
 * The viewer read `feed=all`, the "Mon espace" arm, which is filtered by SPACES (decision 5 of the
 * follow requests): a reel the reader may see only as an ACCEPTED FOLLOWER of its author, or through
 * a MEMBER REPOST, never reached it. `feed=reels` is the viewer's own list, asked with the whole
 * visibility predicate (`list-feed.ts`). What this proves, on the REAL `listPostRows` of
 * `PostsService` (the arms' one query each, not a copy of them):
 *
 *   viewer list = Associations U Suivis U Mon espace, each restricted to reels,
 *
 * for every reader of the cast - and, so the equality is not vacuous, the exact set each reader
 * gets, the reels the follower path must NEVER carry (anonymous, a pending follow, a block), and an
 * order that is total (ties broken by id) so pages neither repeat nor skip.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every integration spec here: skipped without a database.
 * CI's `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- reels-list.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
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
import { resolveListFeed, type ListPostsFeed, type ListPostsParams } from './list-feed';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (file: string) => readFileSync(join(__dirname, '..', 'migrations', file), 'utf8');

/** The cast. Readable ids: a failure names a person. */
const USERS: Record<string, { campus: string | null; formation: string | null }> = {
  au: { campus: 'saint-etienne', formation: 'ICM' }, // the AUTHOR of the personal reels
  rp: { campus: 'saint-etienne', formation: 'ICM' }, // a member who REPOSTS
  gx: { campus: 'gardanne', formation: 'ISMIN' }, // a Gardanne author
  sc: { campus: 'saint-etienne', formation: 'ICM' }, // same campus, follows nobody
  of: { campus: 'gardanne', formation: 'ISMIN' }, // other campus, ACCEPTED follower of au
  pf: { campus: 'gardanne', formation: 'ISMIN' }, // other campus, PENDING follower of au
  bl: { campus: 'saint-etienne', formation: 'ICM' }, // same campus, BLOCKED au
  rr: { campus: 'gardanne', formation: 'ISMIN' }, // other campus, follows rp (reaches by REPOST)
};
const READERS = ['sc', 'of', 'pf', 'bl', 'rr'] as const;

const A1 = '00000000-0000-4000-8000-0000000c0001'; // reaches Saint-Etienne (071's rule)
const A5 = '00000000-0000-4000-8000-0000000c0005'; // reaches ISMIN Gardanne, REPUBLISHES R11

const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const R = {
  personal: P(1), // au's reel
  anonymous: P(2), // au's ANONYMOUS reel
  association: P(3), // A1's reel, reposted by rp
  reposted: P(5), // au's reel, reposted by rp
  notReel: P(6), // au's ordinary post: never in the viewer
  hidden: P(7), // au's reel, hidden by moderation
  expired: P(8), // au's reel past its month
  scheduled: P(9), // au's reel, scheduled tomorrow
  gardanne: P(10), // gx's reel
  republished: P(11), // au's reel, republished by A5
  photo: P(12), // au's one-photo post: in the viewer (singlePhotos), like on Instagram
  tieA: P(13), // two reels by au published at the SAME instant: the id breaks the tie
  tieB: P(14),
};
const NAME = Object.fromEntries(Object.entries(R).map(([k, v]) => [v, k]));
const names = (ids: string[]) => ids.map((id) => NAME[id] ?? id);

/** What each reader's viewer must hold, by name - the equality below is not vacuous. */
const EXPECTED: Record<(typeof READERS)[number], string[]> = {
  // Shares au's and A1's space: every live, published, visible reel of Saint-Etienne.
  sc: ['association', 'anonymous', 'personal', 'photo', 'republished', 'reposted', 'tieA', 'tieB'],
  // Gardanne, au's ACCEPTED follower: au's non-anonymous reels (the defect), A5's republication,
  // gx's. Never the anonymous one; never A1's (not reached, and of follows no reposter).
  of: ['gardanne', 'personal', 'photo', 'republished', 'reposted', 'tieA', 'tieB'],
  // Gardanne, PENDING follower: what Gardanne sees, nothing of au's beyond A5's republication.
  pf: ['gardanne', 'republished'],
  // Saint-Etienne, blocked au: no personal reel of au's, republished or not; the association's
  // and the anonymous one stay (a block is no de-anonymisation oracle, `blockedAuthorSql`).
  bl: ['anonymous', 'association'],
  // Gardanne, follows rp: what rp reposted reaches them (WP-F6), with Gardanne's own.
  rr: ['association', 'gardanne', 'republished', 'reposted'],
};

maybe('the CanaReels viewer list against PostgreSQL (feed=reels)', () => {
  const schema = `reels_list_it_${Math.random().toString(36).slice(2, 10)}`;
  let ds: DataSource;
  let service: PostsService;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** The REAL arm query of `PostsService` (private: the decoration around it reads other tables). */
  async function rows(
    feed: ListPostsFeed,
    viewerUserId: string,
    page: { limit: number; offset: number } = { limit: 100, offset: 0 }
  ): Promise<string[]> {
    const params: ListPostsParams = {
      ...page,
      feed,
      viewerUserId,
      kind: 'reel',
      singlePhotos: true,
    };
    const got: { id: string }[] = await (
      service as unknown as { listPostRows(p: ListPostsParams): Promise<{ id: string }[]> }
    ).listPostRows(params);
    return got.map((r) => r.id);
  }

  const sorted = (ids: Iterable<string>) => [...ids].sort();

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
        "associationId" uuid, anonymous boolean NOT NULL DEFAULT false,
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
    await q(`INSERT INTO associations (id, name, slug) VALUES ($1, 'A5', 'a5')`, [A5]);
    await q(
      `INSERT INTO association_audiences ("associationId", formation, campus)
         VALUES ($1, 'ISMIN', 'gardanne')`,
      [A5]
    );
    for (const [id, u] of Object.entries(USERS)) {
      await q(
        `INSERT INTO users (id, campus, cursus, "firstName", "lastName") VALUES ($1, $2, $3, $1, 'X')`,
        [id, u.campus, JSON.stringify(u.formation ? [{ formation: u.formation, promo: 2024 }] : [])]
      );
    }
    await q(
      `INSERT INTO user_follows ("followerUserId", "followedUserId", status) VALUES
         ('of', 'au', 'accepted'), ('pf', 'au', 'pending'), ('rr', 'rp', 'accepted')`
    );
    await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ('bl', 'au')`);

    const reel = (n: number) => new Date(Date.UTC(2026, 10, 1, 12, n)).toISOString();
    const photo = JSON.stringify([{ type: 'image', mediaId: 'm', mimeType: 'image/jpeg' }]);
    const posts: {
      id: string;
      authorId: string;
      kind?: string;
      associationId?: string;
      anonymous?: boolean;
      hidden?: boolean;
      expired?: boolean;
      scheduled?: boolean;
      images?: string;
      at: string;
    }[] = [
      { id: R.personal, authorId: 'au', kind: 'reel', at: reel(1) },
      { id: R.anonymous, authorId: 'au', kind: 'reel', anonymous: true, at: reel(2) },
      { id: R.association, authorId: 'au', kind: 'reel', associationId: A1, at: reel(3) },
      { id: R.reposted, authorId: 'au', kind: 'reel', at: reel(5) },
      { id: R.notReel, authorId: 'au', at: reel(6) },
      { id: R.hidden, authorId: 'au', kind: 'reel', hidden: true, at: reel(7) },
      { id: R.expired, authorId: 'au', kind: 'reel', expired: true, at: reel(8) },
      { id: R.scheduled, authorId: 'au', kind: 'reel', scheduled: true, at: reel(9) },
      { id: R.gardanne, authorId: 'gx', kind: 'reel', at: reel(10) },
      { id: R.republished, authorId: 'au', kind: 'reel', at: reel(11) },
      { id: R.photo, authorId: 'au', images: photo, at: reel(12) },
      { id: R.tieA, authorId: 'au', kind: 'reel', at: reel(13) },
      { id: R.tieB, authorId: 'au', kind: 'reel', at: reel(13) },
    ];
    for (const p of posts) {
      const isReel = p.kind === 'reel';
      await q(
        `INSERT INTO posts (id, "authorId", "associationId", anonymous, "hiddenByModeration", kind,
                            "expiresAt", "scheduledAt", images, markdown, "publishedAt", "createdAt")
           VALUES ($1, $2, $3, $4, $5, $6,
                   CASE WHEN NOT $7::boolean THEN NULL
                        WHEN $8::boolean THEN now() - interval '1 day'
                        ELSE now() + interval '20 days' END,
                   CASE WHEN $9::boolean THEN now() + interval '1 day' END,
                   $10::jsonb, '', $11::timestamptz, $11::timestamptz)`,
        [
          p.id,
          p.authorId,
          p.associationId ?? null,
          p.anonymous ?? false,
          p.hidden ?? false,
          p.kind ?? 'post',
          isReel,
          p.expired ?? false,
          p.scheduled ?? false,
          p.images ?? (isReel ? JSON.stringify([{ type: 'video', mediaId: 'v' }]) : '[]'),
          p.at,
        ]
      );
    }
    // rp reposts A1's reel and au's second reel (WP-F6); A5 republishes au's (D38b).
    await q(`INSERT INTO member_reposts ("postId", "reposterId") VALUES ($1, 'rp'), ($2, 'rp')`, [
      R.association,
      R.reposted,
    ]);
    await q(
      `INSERT INTO post_republications ("postId", "associationId", "republishedBy")
         VALUES ($1, $2, 'officer')`,
      [R.republished, A5]
    );

    const follows = {
      getFollowedAssociationIdsForUser: () => Promise.resolve([] as string[]),
      getFollowedUserIdsForUser: async (viewer: string) =>
        (
          (await q(
            `SELECT "followedUserId" FROM user_follows WHERE "followerUserId" = $1 AND status = 'accepted'`,
            [viewer]
          )) as { followedUserId: string }[]
        ).map((r) => r.followedUserId),
    } as unknown as FollowsService;
    service = new PostsService(
      { manager: ds.manager } as unknown as Repository<Post>,
      {} as RedisService,
      follows,
      {} as AssociationsService,
      {} as PostNotificationsService,
      {} as PostMediaRetentionService
    );
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds.destroy();
  });

  it.each(READERS)(
    '%s: the viewer is EXACTLY the union of the three tabs, reels only',
    async (who) => {
      const viewer = await rows('reels', who);
      const union = new Set([
        ...(await rows('associations', who)),
        ...(await rows('followed', who)),
        ...(await rows('all', who)),
      ]);
      expect(names(sorted(viewer))).toEqual(names(sorted(union)));
      // Once each: a reel reached through a follow AND a repost is one row.
      expect(new Set(viewer).size).toBe(viewer.length);
      expect(names(viewer).sort()).toEqual([...EXPECTED[who]].sort());
    }
  );

  it('the defect: the accepted follower on another campus missed the reels "Mon espace" leaves to Suivis', async () => {
    const tab = await rows('all', 'of');
    const viewer = await rows('reels', 'of');
    for (const id of [R.personal, R.reposted, R.photo]) {
      expect(tab).not.toContain(id);
      expect(viewer).toContain(id);
    }
  });

  it('never an anonymous reel through the follow path, nor anything a pending follow or a block opens', async () => {
    expect(await rows('reels', 'of')).not.toContain(R.anonymous);
    expect(await rows('reels', 'rr')).not.toContain(R.anonymous);
    const pending = await rows('reels', 'pf');
    for (const id of [R.personal, R.reposted, R.photo, R.tieA, R.anonymous]) {
      expect(pending).not.toContain(id);
    }
    const blocked = await rows('reels', 'bl');
    for (const id of [R.personal, R.reposted, R.republished, R.photo]) {
      expect(blocked).not.toContain(id);
    }
  });

  it('never a hidden, expired, scheduled or non-photo post, for anyone', async () => {
    for (const who of READERS) {
      const viewer = await rows('reels', who);
      for (const id of [R.notReel, R.hidden, R.expired, R.scheduled]) {
        expect(viewer).not.toContain(id);
      }
    }
  });

  it('the order is total - newest first, the id breaking a tie - so pages neither repeat nor skip', async () => {
    const whole = await rows('reels', 'sc');
    expect(names(whole)).toEqual([
      'tieB', // the same instant as tieA, the larger id first
      'tieA',
      'photo',
      'republished',
      'reposted',
      'association',
      'anonymous',
      'personal',
    ]);
    const paged: string[] = [];
    for (let offset = 0; offset < whole.length + 3; offset += 3) {
      paged.push(...(await rows('reels', 'sc', { limit: 3, offset })));
    }
    expect(paged).toEqual(whole);
  });

  it("an installed client's request (kind=reel, no feed) is served the viewer's list", async () => {
    const { feed } = resolveListFeed(undefined, 'reel');
    expect(await rows(feed, 'of')).toEqual(await rows('reels', 'of'));
  });
});
