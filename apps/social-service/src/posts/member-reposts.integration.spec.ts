/**
 * MEMBER REPOSTS WITH THE AUTHOR'S CONSENT (WP-F6), against a REAL PostgreSQL - migrations 071,
 * 072, 073, 078 and 121 applied.
 *
 * Drives `MemberRepostsService` through a real TypeORM connection, so the reader predicate
 * (`memberRepostReachesUserSql`), the newly-reached rule, the consent lock and the cascades are
 * PostgreSQL's. Notifications are recorded; Redis is a stub.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- member-reposts.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { HttpException } from '@nestjs/common';
import type { RedisService } from '../common/redis/redis.service';
import { postVisibleToViewerSql } from '../spaces/reader-spaces';
import { MemberRepost } from './entities/member-repost.entity';
import { memberRepostContext } from './member-repost-card';
import {
  MEMBER_REPOST_CODES,
  MEMBER_REPOST_NOTIFICATION,
  MemberRepostsService,
  severMemberRepostsBetween,
} from './member-reposts.service';
import type { PostNotificationsService } from './post-notifications.service';
import { dropRepublicationsOf } from './republication-sql';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (file: string) => readFileSync(join(__dirname, '..', 'migrations', file), 'utf8');

/** The cast. Readable ids: a failure names a person. */
const USERS: Record<string, { campus: string; formation: string }> = {
  // The AUTHOR of the personal posts (ICM Saint-Etienne).
  au: { campus: 'saint-etienne', formation: 'ICM' },
  // The REPOSTER: shares au's space, so sees au's posts and A1's.
  rp: { campus: 'saint-etienne', formation: 'ICM' },
  // Gardanne readers who share no space with au, rp or A1:
  fo: { campus: 'gardanne', formation: 'ISMIN' }, // follows rp (accepted)
  fp: { campus: 'gardanne', formation: 'ISMIN' }, // only ASKED to follow rp (pending)
  fa: { campus: 'gardanne', formation: 'ISMIN' }, // follows rp AND au (accepted)
  sb: { campus: 'gardanne', formation: 'ISMIN' }, // follows rp, blocked au
  sr: { campus: 'gardanne', formation: 'ISMIN' }, // follows rp, rp blocked them (row left behind)
  out: { campus: 'gardanne', formation: 'ISMIN' }, // follows nobody
  // An ICM author the reposter blocked, and one who blocked the reposter.
  b1: { campus: 'saint-etienne', formation: 'ICM' },
  b2: { campus: 'saint-etienne', formation: 'ICM' },
  // An author who withdraws consent account-wide.
  nc: { campus: 'saint-etienne', formation: 'ICM' },
  // A Gardanne author rp cannot see.
  gx: { campus: 'gardanne', formation: 'ISMIN' },
};

const A1 = '00000000-0000-4000-8000-0000000c0001'; // association, reaches ICM Saint-Etienne (071)

const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const POSTS: {
  id: string;
  authorId: string;
  associationId?: string;
  anonymous?: boolean;
  hidden?: boolean;
  announced?: boolean;
  allowReposts?: boolean;
}[] = [
  { id: P(1), authorId: 'au', announced: true }, // the main repost, then hidden
  { id: P(2), authorId: 'au', anonymous: true, announced: true },
  { id: P(3), authorId: 'au', hidden: true, announced: true },
  { id: P(4), authorId: 'gx', announced: true }, // unseen by rp
  { id: P(5), authorId: 'rp', announced: true }, // rp's own
  { id: P(6), authorId: 'b1', announced: true }, // rp blocked b1
  { id: P(7), authorId: 'b2', announced: true }, // b2 blocked rp
  { id: P(8), authorId: 'au', announced: true, allowReposts: false }, // override off
  { id: P(9), authorId: 'nc', announced: true }, // the account setting turns off
  { id: P(10), authorId: 'nc', announced: true, allowReposts: true }, // ...override on
  { id: P(11), authorId: 'au', associationId: A1, announced: true }, // entity, announced
  { id: P(12), authorId: 'au', associationId: A1, announced: false }, // entity, not announced
  { id: P(13), authorId: 'au', announced: false }, // personal, not announced
  { id: P(14), authorId: 'au', announced: true }, // the block severing
  { id: P(15), authorId: 'au', announced: true }, // per-post override, both ways
];

function codeOf(err: unknown): string | undefined {
  if (!(err instanceof HttpException)) return undefined;
  const body = err.getResponse();
  return typeof body === 'object' && body !== null ? (body as { code?: string }).code : undefined;
}

async function refusedWith(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HttpException) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

maybe('member reposts against PostgreSQL (migration 121)', () => {
  const schema = `member_repost_it_${Math.random().toString(36).slice(2, 10)}`;
  let ds: DataSource;
  let reposts: MemberRepostsService;
  const told: { type: string; postId: string; actorId: string; recipientIds: string[] }[] = [];

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  async function sees(postId: string, userId: string, followers = true): Promise<boolean> {
    const rows: { visible: boolean }[] = await q(
      `SELECT ${postVisibleToViewerSql('posts', '$2', { followers })} AS visible FROM posts WHERE posts.id = $1`,
      [postId, userId]
    );
    return rows[0]?.visible === true;
  }

  async function repostRows(postId: string): Promise<string[]> {
    const rows: { reposterId: string }[] = await q(
      `SELECT "reposterId" FROM member_reposts WHERE "postId" = $1 ORDER BY "reposterId"`,
      [postId]
    );
    return rows.map((r) => r.reposterId);
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [MemberRepost],
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]', "displayName" varchar,
        "firstName" varchar, "lastName" varchar);
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL, slug varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', archived boolean NOT NULL DEFAULT false,
        "logoUrl" varchar, "logoMediaId" varchar, "isBDE" boolean NOT NULL DEFAULT false,
        "createdBy" varchar(255));
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "associationId" uuid, anonymous boolean NOT NULL DEFAULT false,
        "hiddenByModeration" boolean NOT NULL DEFAULT false, "scheduledAt" timestamptz,
        kind varchar NOT NULL DEFAULT 'post', "expiresAt" timestamptz, markdown text,
        "feedNotifiedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now(),
        "publishedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions int NOT NULL DEFAULT 0);
      CREATE TABLE user_blocks ("blockerId" varchar(255) NOT NULL, "blockedId" varchar(255) NOT NULL);
      CREATE TABLE user_follows ("followerUserId" varchar(255) NOT NULL,
        "followedUserId" varchar(255) NOT NULL, status varchar(16) NOT NULL);
    `);
    await q(`INSERT INTO associations (id, name, slug) VALUES ($1, 'A1', 'a1')`, [A1]);
    await q(migration('071_spaces.sql'));
    await q(migration('072_drop_is_bde.sql'));
    await q(migration('073_republications.sql'));
    await q(migration('078_read_grants.sql'));
    await q(migration('121_member_reposts.sql'));
    // A replay is a no-op (the deploy ledger may run it twice).
    await q(migration('121_member_reposts.sql'));
    for (const [id, u] of Object.entries(USERS)) {
      await q(
        `INSERT INTO users (id, campus, cursus, "firstName", "lastName") VALUES ($1, $2, $3, $1, 'X')`,
        [id, u.campus, JSON.stringify([{ formation: u.formation, promo: 2024 }])]
      );
    }
    await q(
      `INSERT INTO user_follows ("followerUserId", "followedUserId", status) VALUES
         ('fo', 'rp', 'accepted'), ('fp', 'rp', 'pending'), ('fa', 'rp', 'accepted'),
         ('fa', 'au', 'accepted'), ('sb', 'rp', 'accepted'), ('sr', 'rp', 'accepted')`
    );
    await q(
      `INSERT INTO user_blocks ("blockerId", "blockedId") VALUES
         ('sb', 'au'), ('rp', 'sr'), ('rp', 'b1'), ('b2', 'rp')`
    );
    for (const p of POSTS) {
      await q(
        `INSERT INTO posts (id, "authorId", "associationId", anonymous, "hiddenByModeration", markdown,
                            "feedNotifiedAt", "allowReposts")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          p.id,
          p.authorId,
          p.associationId ?? null,
          p.anonymous ?? false,
          p.hidden ?? false,
          `post ${p.id.slice(-2)}`,
          p.announced ? new Date() : null,
          p.allowReposts ?? null,
        ]
      );
    }
    const notifications = {
      createNotifications: (data: (typeof told)[number]) => {
        const recipientIds = [...new Set(data.recipientIds)].filter((id) => id !== data.actorId);
        told.push({ ...data, recipientIds: recipientIds.sort() });
        return Promise.resolve(recipientIds.length);
      },
    } as unknown as PostNotificationsService;
    const redis = { deleteByPattern: () => Promise.resolve(0) } as unknown as RedisService;
    reposts = new MemberRepostsService(ds.getRepository(MemberRepost), notifications, redis);
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds.destroy();
  });

  beforeEach(() => {
    told.length = 0;
  });

  describe('the refusals, D38b re-run for a member reposter', () => {
    it('a hidden post is a 404', async () => {
      const err = await refusedWith(reposts.repost(P(3), 'rp'));
      expect(err.getStatus()).toBe(404);
    });

    it('a post the reposter cannot see is a 404, confirming nothing', async () => {
      const err = await refusedWith(reposts.repost(P(4), 'rp'));
      expect(err.getStatus()).toBe(404);
      expect(codeOf(err)).toBeUndefined();
    });

    it('an ANONYMOUS post is refused (400), and nothing is written', async () => {
      const err = await refusedWith(reposts.repost(P(2), 'rp'));
      expect(err.getStatus()).toBe(400);
      expect(codeOf(err)).toBe(MEMBER_REPOST_CODES.anonymous);
      expect(await repostRows(P(2))).toEqual([]);
    });

    it("the reposter's own post is refused (400)", async () => {
      const err = await refusedWith(reposts.repost(P(5), 'rp'));
      expect(codeOf(err)).toBe(MEMBER_REPOST_CODES.ownPost);
    });

    it('a block works BOTH WAYS: the reposter blocked the author, or the author the reposter', async () => {
      for (const id of [P(6), P(7)]) {
        const err = await refusedWith(reposts.repost(id, 'rp'));
        expect(err.getStatus()).toBe(403);
        expect(codeOf(err)).toBe(MEMBER_REPOST_CODES.blocked);
      }
    });

    it("a post whose override says no is refused (403), and the author's other posts are not", async () => {
      const err = await refusedWith(reposts.repost(P(8), 'rp'));
      expect(codeOf(err)).toBe(MEMBER_REPOST_CODES.notAllowed);
    });
  });

  describe('a repost of a personal post', () => {
    it('reaches the ACCEPTED followers of the reposter only, minus every block', async () => {
      for (const u of ['fo', 'fp', 'fa', 'sb', 'sr', 'out']) {
        expect(await sees(P(1), u)).toBe(u === 'fa'); // fa follows the author already
      }
      const result = await reposts.repost(P(1), 'rp');
      expect(await sees(P(1), 'fo')).toBe(true);
      expect(await sees(P(1), 'fp')).toBe(false); // a request is not a follow
      expect(await sees(P(1), 'sb')).toBe(false); // sb blocked the author
      expect(await sees(P(1), 'sr')).toBe(false); // the reposter blocked sr; the row was left
      expect(await sees(P(1), 'out')).toBe(false);
      // "Tout" stays a feed of spaces (decision 5): the repost does not open it there.
      expect(await sees(P(1), 'fo', false)).toBe(false);
      // ONLY THE NEWLY REACHED ARE TOLD (D38): not fa, who already saw it as au's follower.
      expect(result.newlyReached).toBe(1);
      expect(told).toEqual([
        expect.objectContaining({
          type: MEMBER_REPOST_NOTIFICATION,
          postId: P(1),
          actorId: 'rp',
          recipientIds: ['fo'],
        }),
      ]);
    });

    it('a second repost of the same post is a 409, telling nobody', async () => {
      const err = await refusedWith(reposts.repost(P(1), 'rp'));
      expect(err.getStatus()).toBe(409);
      expect(codeOf(err)).toBe(MEMBER_REPOST_CODES.already);
      expect(told).toEqual([]);
    });

    it('the card offers what the write accepts, and names the reposter to a follower only', async () => {
      const ids = POSTS.map((p) => p.id);
      const forRp = await memberRepostContext(ds.manager, ids, 'rp');
      expect([...forRp.mine]).toEqual([P(1)]);
      expect([...forRp.repostable].sort()).toEqual([
        P(9),
        P(10),
        P(11),
        P(12),
        P(13),
        P(14),
        P(15),
      ]);
      const forFo = await memberRepostContext(ds.manager, [P(1)], 'fo');
      expect(forFo.reposters.get(P(1))).toEqual([{ id: 'rp', name: 'rp X' }]);
      const forOut = await memberRepostContext(ds.manager, [P(1)], 'out');
      expect(forOut.reposters.get(P(1))).toBeUndefined();
      const forAu = await memberRepostContext(ds.manager, [P(1), P(8)], 'au');
      expect(forAu.consent.get(P(1))).toEqual({ override: null, effective: true });
      expect(forAu.consent.get(P(8))).toEqual({ override: false, effective: false });
    });

    it('HIDING THE ORIGINAL REMOVES EVERY REPOST, and the followers lose it', async () => {
      await q(`INSERT INTO member_reposts ("postId", "reposterId") VALUES ($1, 'fa')`, [P(1)]);
      await q(`UPDATE posts SET "hiddenByModeration" = true WHERE id = $1`, [P(1)]);
      const dropped = await dropRepublicationsOf(ds.manager, P(1));
      expect(dropped.memberReposts).toBe(2);
      expect(await repostRows(P(1))).toEqual([]);
      expect(await sees(P(1), 'fo')).toBe(false);
    });

    it('before its first announce, the newly reached are told at the repost (the sweep tells followers only)', async () => {
      const result = await reposts.repost(P(13), 'rp');
      expect(result.newlyReached).toBe(1);
      expect(told[0]?.recipientIds).toEqual(['fo']);
    });
  });

  describe("a repost of an ENTITY post (Q2): no consent, the reposter's accepted followers only", () => {
    it('announced: widens to the accepted followers, tells the newly reached', async () => {
      expect(await sees(P(11), 'fo')).toBe(false);
      const result = await reposts.repost(P(11), 'rp');
      expect(await sees(P(11), 'fo')).toBe(true);
      expect(await sees(P(11), 'fp')).toBe(false);
      // An entity post's author is no block's subject: sb blocked au, the officer, and still sees it.
      expect(await sees(P(11), 'sb')).toBe(true);
      expect(result.newlyReached).toBe(3); // fo, fa, sb
    });

    it('not yet announced: tells nobody now - the sweep will tell everyone who sees it', async () => {
      const result = await reposts.repost(P(12), 'rp');
      expect(result.newlyReached).toBe(0);
      expect(told).toEqual([]);
      expect(await sees(P(12), 'fo')).toBe(true);
    });

    it('its consent cannot be set: not the author is a 404, the author a 400', async () => {
      expect((await refusedWith(reposts.setPostConsent(P(11), 'rp', false))).getStatus()).toBe(404);
      const err = await refusedWith(reposts.setPostConsent(P(11), 'au', false));
      expect(codeOf(err)).toBe(MEMBER_REPOST_CODES.notAuthor);
    });
  });

  describe('consent', () => {
    it('the account setting is ON with no row; OFF refuses, and removes what it no longer covers', async () => {
      expect(await reposts.accountConsent('nc')).toEqual({ allowReposts: true });
      await reposts.repost(P(9), 'rp');
      await reposts.repost(P(10), 'rp');
      const off = await reposts.setAccountConsent('nc', false);
      expect(off).toEqual({ allowReposts: false, removed: 1 });
      expect(await repostRows(P(9))).toEqual([]);
      expect(await repostRows(P(10))).toEqual(['rp']); // its override says yes
      expect(await sees(P(9), 'fo')).toBe(false);
      const err = await refusedWith(reposts.repost(P(9), 'rp'));
      expect(codeOf(err)).toBe(MEMBER_REPOST_CODES.notAllowed);
      expect(await reposts.accountConsent('nc')).toEqual({ allowReposts: false });
    });

    it('the per-post override works both ways', async () => {
      // OFF on a post the account allows: refused, and its reposts go.
      await reposts.repost(P(15), 'rp');
      const off = await reposts.setPostConsent(P(15), 'au', false);
      expect(off).toEqual({ override: false, effective: false, removed: 1 });
      expect(codeOf(await refusedWith(reposts.repost(P(15), 'rp')))).toBe(
        MEMBER_REPOST_CODES.notAllowed
      );
      // ON on a post of an account that said no: accepted.
      await reposts.setPostConsent(P(15), 'au', null);
      expect(await reposts.repost(P(15), 'rp')).toEqual(expect.objectContaining({ postId: P(15) }));
      expect(await repostRows(P(10))).toEqual(['rp']); // nc's override ON, account OFF
      // Back to following the account setting, which is OFF for nc: the repost goes.
      const back = await reposts.setPostConsent(P(10), 'nc', null);
      expect(back).toEqual({ override: null, effective: false, removed: 1 });
    });

    it('only the author sets a post override (404 for anyone else)', async () => {
      expect((await refusedWith(reposts.setPostConsent(P(15), 'rp', true))).getStatus()).toBe(404);
    });
  });

  describe('the block and the erasure', () => {
    it('a block between reposter and author removes the reposts either made of the other', async () => {
      await reposts.repost(P(14), 'rp');
      expect(await severMemberRepostsBetween(ds.manager, 'au', 'rp')).toBeGreaterThanOrEqual(1);
      expect(await repostRows(P(14))).toEqual([]);
      // The entity post au wrote as A1 keeps rp's repost: blocking its officer tells nothing.
      expect(await repostRows(P(11))).toEqual(['rp']);
    });

    it('a block left behind by a failed severing opens nothing', async () => {
      await q(`INSERT INTO member_reposts ("postId", "reposterId") VALUES ($1, 'rp')`, [P(14)]);
      await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ('au', 'rp')`);
      expect(await sees(P(14), 'fo')).toBe(false);
      await q(`DELETE FROM user_blocks WHERE "blockerId" = 'au' AND "blockedId" = 'rp'`);
      await q(`DELETE FROM member_reposts WHERE "postId" = $1`, [P(14)]);
    });

    it("unrepost takes the caller's own repost back, and 404s on none", async () => {
      await reposts.repost(P(14), 'rp');
      expect(await reposts.unrepost(P(14), 'rp')).toEqual({ ok: true });
      expect((await refusedWith(reposts.unrepost(P(14), 'rp'))).getStatus()).toBe(404);
    });

    it('deleting the original removes every repost (the foreign key)', async () => {
      await reposts.repost(P(14), 'rp');
      await q(`DELETE FROM posts WHERE id = $1`, [P(14)]);
      expect(await repostRows(P(14))).toEqual([]);
    });
  });
});
