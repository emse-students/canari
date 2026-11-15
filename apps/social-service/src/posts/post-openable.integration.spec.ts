/**
 * A WRITE OR A NOTIFICATION ON A POST FOLLOWS THE READ'S PREDICATE - against a REAL PostgreSQL,
 * migrations 071 to 078, 114 and 121 included.
 *
 * `readPostOpenVerdict` is the one gate `getById`, a vote, a reaction, a comment, a comment like,
 * a mention and a report on a post or a comment go through. The unit specs pin the wiring with the
 * audience term as a switch; this file runs the gate, the mention filter
 * (`PostNotificationsService.mentionRecipientsOf`) and the report refusal
 * (`ModerationService.createReport`) on real rows, for the four readers that matter: one who may
 * open the post, one outside its audience, one a block separates from its author (both ways), and
 * any reader of a post hidden by moderation - plus a post scheduled later and an anonymous one.
 *
 * The other readers the audience admits - an accepted follower, a member reached through a member
 * repost, a read grant - are NOT re-run here: the gate's audience term IS
 * `postVisibleToViewerSql`, the shared audience code, and each of those readers is proven on it in
 * its own integration spec (`spaces/follower-visibility`, `posts/member-reposts`,
 * `spaces/read-grants`). A write gated here admits exactly the readers that code admits.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Locally, against any throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- post-openable
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import type { EntityManager } from 'typeorm';
import { readPostOpenVerdict, type OpenablePost } from './post-openable';
import { PostNotificationsService } from './post-notifications.service';
import { PostsService } from './posts.service';
import { ModerationService } from '../moderation/moderation.service';
import { AssociationsService } from '../associations/associations.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

const ICM_SE = [{ formation: 'ICM', promo: 2024 }];
const ISMIN_GA = [{ formation: 'ISMIN', promo: 2024 }];

/** The cast. Readable ids on purpose: a failure names a role, never a uuid. */
const USERS: Record<string, { campus: string; cursus: unknown[]; admin?: boolean }> = {
  author: { campus: 'saint-etienne', cursus: ICM_SE },
  // Shares the author's space, no block: the positive case.
  reader: { campus: 'saint-etienne', cursus: ICM_SE },
  // Gardanne: shares no space with the author, follows nobody - outside every post's audience.
  outsider: { campus: 'gardanne', cursus: ISMIN_GA },
  // Same space, and the AUTHOR blocked them.
  blockedByAuthor: { campus: 'saint-etienne', cursus: ICM_SE },
  // Same space, and THEY blocked the author.
  blockedTheAuthor: { campus: 'saint-etienne', cursus: ICM_SE },
  // Same space; writes a comment on the personal post.
  commenter: { campus: 'saint-etienne', cursus: ICM_SE },
  // Same space, and blocked the commenter (not the author).
  blockedTheCommenter: { campus: 'saint-etienne', cursus: ICM_SE },
  // A platform admin in Gardanne: outside every post's audience as a reader - by id, moderation only.
  adminOutside: { campus: 'gardanne', cursus: ISMIN_GA, admin: true },
  // A platform admin who shares the author's space: an ordinary reader there.
  adminInside: { campus: 'saint-etienne', cursus: ICM_SE, admin: true },
};

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P_PERSONAL = id(601);
const P_HIDDEN = id(602);
const P_SCHEDULED = id(603);
const P_ANONYMOUS = id(604);

maybe("writes and notifications on a post follow the read's gate, against PostgreSQL", () => {
  const schema = `post_open_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;
  let manager: EntityManager;

  /** The stored row, as the services read it. */
  const row = async (postId: string): Promise<OpenablePost> =>
    (
      await client.query(
        `SELECT id, "authorId", "associationId", anonymous, "hiddenByModeration", "scheduledAt",
                kind, "expiresAt", mentions FROM posts WHERE id = $1`,
        [postId]
      )
    ).rows[0];

  const opens = async (postId: string, viewerId: string) =>
    (await readPostOpenVerdict(manager, await row(postId), { viewerId }, 'READ_OR_REACT')).refusal;

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]', promo int, formation varchar,
        "displayName" varchar, "firstName" varchar, "lastName" varchar);
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', "isBDE" boolean NOT NULL DEFAULT false,
        archived boolean NOT NULL DEFAULT false, "parentAssociationId" uuid);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "associationId" uuid, "studentsOnly" boolean NOT NULL DEFAULT false, "reachPublic" varchar(16), "reachSpaces" jsonb, anonymous boolean NOT NULL DEFAULT false,
        "hiddenByModeration" boolean NOT NULL DEFAULT false, "scheduledAt" timestamp,
        kind varchar NOT NULL DEFAULT 'post', "expiresAt" timestamp,
        mentions text NOT NULL DEFAULT '', comments jsonb NOT NULL DEFAULT '[]');
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions int NOT NULL DEFAULT 0);
      CREATE TABLE user_follows ("followerUserId" varchar(255), "followedUserId" varchar(255),
        "createdAt" timestamp NOT NULL DEFAULT now(), id uuid NOT NULL DEFAULT gen_random_uuid());
      CREATE TABLE user_blocks ("blockerId" varchar(255), "blockedId" varchar(255));
      CREATE TABLE post_notifications (id serial PRIMARY KEY); -- migration 132 adds a column to it
      CREATE TABLE association_calendar_events (id uuid PRIMARY KEY, "associationId" uuid,
        "createdBy" varchar(255) NOT NULL DEFAULT 'it', "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE association_calendar_event_co_owners (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL, association_id uuid NOT NULL);
    `);
    for (const name of [
      '071_spaces.sql',
      '072_drop_is_bde.sql',
      '073_republications.sql',
      '074_coorganise.sql',
      '078_read_grants.sql',
      '114_user_follow_status.sql',
      '121_member_reposts.sql',
      '132_read_grant_readers.sql',
    ]) {
      await client.query(migration(name));
    }
    // A member repost reaches nobody from a muted reposter (WP-F6): the predicate reads this table.
    await client.query(
      `CREATE TABLE IF NOT EXISTS user_moderation ("userId" varchar(255) PRIMARY KEY, "isMuted" boolean NOT NULL DEFAULT false)`
    );
    for (const [userId, u] of Object.entries(USERS)) {
      await client.query(`INSERT INTO users (id, campus, cursus, admin) VALUES ($1, $2, $3, $4)`, [
        userId,
        u.campus,
        JSON.stringify(u.cursus),
        u.admin === true,
      ]);
    }
    await client.query(
      `INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ('author', 'blockedByAuthor'),
         ('blockedTheAuthor', 'author'), ('blockedTheCommenter', 'commenter')`
    );
    const comments = JSON.stringify([
      { id: 'c-plain', userId: 'commenter', text: 'plain' },
      { id: 'c-anon', userId: 'commenter', anonymous: true, text: 'masked' },
    ]);
    await client.query(
      `INSERT INTO posts (id, "authorId", anonymous, "hiddenByModeration", "scheduledAt", comments)
         VALUES ($1, 'author', false, false, NULL, $5),
                ($2, 'author', false, true, NULL, '[]'),
                ($3, 'author', false, false, now() + interval '1 day', '[]'),
                ($4, 'author', true, false, NULL, '[]')`,
      [P_PERSONAL, P_HIDDEN, P_SCHEDULED, P_ANONYMOUS, comments]
    );
    manager = {
      query: (sql: string, params?: unknown[]) =>
        client.query(sql, params as unknown[]).then((r) => r.rows),
    } as unknown as EntityManager;
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  describe('the gate (`readPostOpenVerdict`)', () => {
    it('opens a post to a reader who shares its space, and to its author', async () => {
      expect(await opens(P_PERSONAL, 'reader')).toBeNull();
      expect(await opens(P_PERSONAL, 'author')).toBeNull();
    });

    it('refuses a reader outside its audience, and a block either way, as not found', async () => {
      expect(await opens(P_PERSONAL, 'outsider')).toBe('not-found');
      expect(await opens(P_PERSONAL, 'blockedByAuthor')).toBe('not-found');
      expect(await opens(P_PERSONAL, 'blockedTheAuthor')).toBe('not-found');
    });

    it('refuses a hidden post as hidden to its audience, and as not found to an outsider', async () => {
      expect(await opens(P_HIDDEN, 'reader')).toBe('hidden');
      expect(await opens(P_HIDDEN, 'outsider')).toBe('not-found');
    });

    it('refuses a post scheduled later to all but its author', async () => {
      expect(await opens(P_SCHEDULED, 'reader')).toBe('not-found');
      expect(await opens(P_SCHEDULED, 'author')).toBeNull();
    });

    it('keeps the block exemption of an anonymous post (no oracle on its author)', async () => {
      expect(await opens(P_ANONYMOUS, 'blockedByAuthor')).toBeNull();
      expect(await opens(P_ANONYMOUS, 'outsider')).toBe('not-found');
    });
  });

  describe('a platform admin by id: moderates, never participates (2026-11-14)', () => {
    const INTENTS = ['READ_OR_REACT', 'COMMENT', 'VOTE'] as const;
    const verdict = async (
      postId: string,
      viewerId: string,
      intent: (typeof INTENTS)[number],
      allowHidden?: boolean
    ) =>
      (await readPostOpenVerdict(manager, await row(postId), { viewerId, allowHidden }, intent))
        .refusal;

    it.each(['READ_OR_REACT', 'COMMENT'] as const)(
      'the moderation read (`allowHidden`, intent %s) opens any post: outside the audience, hidden, scheduled',
      async (intent) => {
        for (const postId of [P_PERSONAL, P_HIDDEN, P_SCHEDULED]) {
          expect(await verdict(postId, 'adminOutside', intent, true)).toBeNull();
        }
      }
    );

    it.each(INTENTS)(
      'a reaction, a comment, a vote (intent %s) outside the audience: the 404 an ordinary reader gets',
      async (intent) => {
        expect(await verdict(P_PERSONAL, 'adminOutside', intent)).toBe('not-found');
        expect(await verdict(P_PERSONAL, 'outsider', intent)).toBe('not-found');
      }
    );

    it.each(INTENTS)(
      'inside their own audience (intent %s) an admin acts as the ordinary reader they are',
      async (intent) => {
        expect(await verdict(P_PERSONAL, 'adminInside', intent)).toBeNull();
        expect(await verdict(P_HIDDEN, 'adminInside', intent)).toBe('hidden');
      }
    );

    it('an admin whose only door is a named grant with the comments off: no comment through it, the moderation read still reads them', async () => {
      const asso = id(701);
      const post = id(702);
      await client.query(
        `INSERT INTO users (id, campus, cursus, admin) VALUES ('grantAdmin', 'gardanne', $1, true)`,
        [JSON.stringify(ISMIN_GA)]
      );
      await client.query(`INSERT INTO associations (id, name) VALUES ($1, 'it')`, [asso]);
      await client.query(
        `INSERT INTO association_audiences ("associationId", formation, campus)
           VALUES ($1, 'ICM', 'saint-etienne')`,
        [asso]
      );
      await client.query(
        `INSERT INTO posts (id, "authorId", "associationId") VALUES ($1, 'author', $2)`,
        [post, asso]
      );
      // A grant on ICM x saint-etienne, and no `read_grant_readers` row: "voit les commentaires" off.
      await client.query(
        `INSERT INTO read_grants (user_id, campus, formation, granted_by)
           VALUES ('grantAdmin', 'saint-etienne', 'ICM', 'it')`
      );
      expect(await verdict(post, 'grantAdmin', 'READ_OR_REACT')).toBeNull();
      expect(await verdict(post, 'grantAdmin', 'COMMENT')).toBe('not-found');
      expect(await verdict(post, 'grantAdmin', 'COMMENT', true)).toBeNull();
    });

    it('a mention never reaches an admin outside the audience, nor a report from one files', async () => {
      expect(
        await new PostNotificationsService(
          {} as never,
          { manager } as never,
          {} as never,
          {} as never
        ).mentionRecipientsOf(
          await row(P_PERSONAL),
          'author',
          ['adminOutside', 'adminInside'],
          'READ_OR_REACT'
        )
      ).toEqual(['adminInside']);
      const save = jest.fn();
      const moderation = new ModerationService(
        { manager, findOne: jest.fn(() => Promise.resolve(null)), save } as never,
        {} as never,
        {} as never
      );
      await expect(
        moderation.createReport({
          reporterId: 'adminOutside',
          contentType: 'post',
          contentId: P_PERSONAL,
          reason: 'spam',
        })
      ).rejects.toMatchObject({ status: 404 });
      expect(save).not.toHaveBeenCalled();
    });
  });

  describe('a BDE moderator by id: moderates within its spaces, never participates (owner, 2026-11-15)', () => {
    // "Oui, dans ses espaces": the moderation read follows `mayModeratePost` - here the REAL one, the
    // statement `AssociationsService.moderatedPostIds` runs, on this schema.
    const BDE_SE = id(801);
    const BDE_GA = id(802);
    const MODERATE = AssociationPermissionFlag.MODERATE;
    // All three live in Gardanne: outside every post's audience as readers.
    const CAST = {
      // MODERATE in the BDE governing the author's space (ICM x Saint-Etienne): in scope.
      modInScope: BDE_SE,
      // MODERATE in the BDE governing Gardanne ISMIN: out of scope for the author's posts.
      modOutOfScope: BDE_GA,
      // A member of the author's BDE with no MODERATE right.
      plainMember: BDE_SE,
    } as const;
    let service: PostsService;

    beforeAll(async () => {
      // An OPEN report is what lets a BDE moderator read a post scheduled later (owner, 2026-11-15).
      await client.query(
        `CREATE TABLE content_reports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           "contentType" varchar(30) NOT NULL, "contentId" varchar NOT NULL,
           status varchar(20) NOT NULL DEFAULT 'pending');
         -- The tables the queue's scope (reportInBdeScopeSql) names beside posts.
         CREATE TABLE IF NOT EXISTS lives (id uuid PRIMARY KEY, "broadcasterId" varchar(255) NOT NULL,
           "associationId" uuid);
         CREATE TABLE IF NOT EXISTS live_cuts ("liveId" uuid PRIMARY KEY,
           "broadcasterId" varchar(255) NOT NULL, "associationId" uuid);
         CREATE TABLE IF NOT EXISTS live_chat_reported_lines ("reportId" uuid PRIMARY KEY,
           "liveId" uuid NOT NULL)`
      );
      await client.query(
        `INSERT INTO associations (id, name) VALUES ($1, 'BDE SE'), ($2, 'BDE GA')`,
        [BDE_SE, BDE_GA]
      );
      await client.query(
        `UPDATE spaces SET "bdeAssociationId" = $1 WHERE formation = 'ICM' AND campus = 'saint-etienne'`,
        [BDE_SE]
      );
      await client.query(
        `UPDATE spaces SET "bdeAssociationId" = $1 WHERE formation = 'ISMIN' AND campus = 'gardanne'`,
        [BDE_GA]
      );
      for (const [userId, bde] of Object.entries(CAST)) {
        await client.query(`INSERT INTO users (id, campus, cursus) VALUES ($1, 'gardanne', $2)`, [
          userId,
          JSON.stringify(ISMIN_GA),
        ]);
        await client.query(
          `INSERT INTO association_members ("associationId", "userId", permissions) VALUES ($1, $2, $3)`,
          [bde, userId, userId === 'plainMember' ? 0 : MODERATE]
        );
      }
      const scope = Object.assign(Object.create(AssociationsService.prototype), {
        memberRepo: { query: (sql: string, params?: unknown[]) => manager.query(sql, params) },
        logger: new Logger('post-openable-it-moderation-scope'),
      }) as AssociationsService;
      service = new PostsService(
        {
          manager,
          findOne: async ({ where }: { where: { id: string } }) =>
            (await client.query(`SELECT * FROM posts WHERE id = $1`, [where.id])).rows[0] ?? null,
        } as never,
        {} as never,
        {} as never,
        scope,
        {} as never,
        {} as never
      );
      // What is served is not this spec's question: whether the read opens is.
      jest
        .spyOn(service, 'serveToReader')
        .mockImplementation(async (post) => ({ id: post.id }) as never);
      Object.assign(service, { commentIdentityService: { serve: async (c: unknown[]) => c } });
    });

    afterAll(async () => {
      await client.query(`UPDATE spaces SET "bdeAssociationId" = NULL`);
    });

    /** The HTTP answer of a call; anything that is not one (a SQL error) fails the test as itself. */
    const status = (p: Promise<unknown>) =>
      p.then(
        () => 'open',
        (e: { status?: number }) => {
          if (typeof e.status !== 'number') throw e;
          return e.status;
        }
      );

    it('in scope, it opens by id a hidden post and one outside its audience, and lists their comments', async () => {
      for (const postId of [P_PERSONAL, P_HIDDEN]) {
        expect(await service.getById(postId, { viewerId: 'modInScope' })).toEqual({ id: postId });
        await expect(service.listComments(postId, 'modInScope', {})).resolves.toMatchObject({
          comments: expect.any(Array),
        });
      }
      expect((await service.listComments(P_PERSONAL, 'modInScope', {})).comments).toHaveLength(2);
    });

    it.each(['modOutOfScope', 'plainMember'])(
      '%s gets the ordinary answer: the 404 of an outsider, by id and on the comments',
      async (who) => {
        for (const postId of [P_PERSONAL, P_HIDDEN]) {
          expect(await status(service.getById(postId, { viewerId: who }))).toBe(404);
          expect(await status(service.listComments(postId, who, {}))).toBe(404);
        }
      }
    );

    it('a post scheduled later: refused to the BDE moderator, opened by an open report on it, and once published (owner, 2026-11-15: "Exclure les posts programmes")', async () => {
      const opens = async () => [
        await status(service.getById(P_SCHEDULED, { viewerId: 'modInScope' })),
        await status(service.listComments(P_SCHEDULED, 'modInScope', {})),
      ];
      expect(await opens()).toEqual([404, 404]);
      // A report already dealt with opens nothing; an open one does.
      await client.query(
        `INSERT INTO content_reports ("contentType", "contentId", status) VALUES ('post', $1, 'reviewed')`,
        [P_SCHEDULED]
      );
      expect(await opens()).toEqual([404, 404]);
      await client.query(
        `INSERT INTO content_reports ("contentType", "contentId", status) VALUES ('post', $1, 'pending')`,
        [P_SCHEDULED]
      );
      expect(await opens()).toEqual(['open', 'open']);
      await client.query(`DELETE FROM content_reports`);
      expect(await opens()).toEqual([404, 404]);
      // Published: an ordinary post in its scope again.
      await client.query(
        `UPDATE posts SET "scheduledAt" = now() - interval '1 minute' WHERE id = $1`,
        [P_SCHEDULED]
      );
      try {
        expect(await opens()).toEqual(['open', 'open']);
      } finally {
        await client.query(
          `UPDATE posts SET "scheduledAt" = now() + interval '1 day' WHERE id = $1`,
          [P_SCHEDULED]
        );
      }
    });

    it('the hidden-posts list asks the same read: a hidden post scheduled later is listed to the BDE moderator only while an open report targets it, or once published; always to a platform admin', async () => {
      const post = id(803);
      await client.query(
        `ALTER TABLE posts ADD COLUMN IF NOT EXISTS markdown text,
           ADD COLUMN IF NOT EXISTS "createdAt" timestamp NOT NULL DEFAULT now()`
      );
      await client.query(
        `INSERT INTO posts (id, "authorId", "hiddenByModeration", "scheduledAt", markdown)
           VALUES ($1, 'author', true, now() + interval '1 day', 'held')`,
        [post]
      );
      const listed = async (userId: string, isGlobalAdmin = false) =>
        (await service.getHiddenPosts({ userId, isGlobalAdmin })).some(
          (r: { id: string }) => r.id === post
        );
      try {
        expect(await listed('modInScope')).toBe(false);
        expect(await listed('adminOutside', true)).toBe(true);
        await client.query(
          `INSERT INTO content_reports ("contentType", "contentId", status) VALUES ('post', $1, 'pending')`,
          [post]
        );
        expect(await listed('modInScope')).toBe(true);
        // Dealt with, the report opens nothing any more: the row stays, its status changed.
        await client.query(`UPDATE content_reports SET status = 'dismissed'`);
        expect(await listed('modInScope')).toBe(false);
        await client.query(
          `UPDATE posts SET "scheduledAt" = now() - interval '1 minute' WHERE id = $1`,
          [post]
        );
        expect(await listed('modInScope')).toBe(true);
        // Out of scope, it is never listed.
        expect(await listed('modOutOfScope')).toBe(false);
      } finally {
        await client.query(`DELETE FROM content_reports`);
        await client.query(`DELETE FROM posts WHERE id = $1`, [post]);
      }
    });

    it("the queue's previews ask the same read: the text of a post scheduled later, and of a comment under it, is shown to the BDE moderator only while the post's report is open, or once published; always to a platform admin; and the read of something unpublished is logged", async () => {
      await client.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS markdown text`);
      const before = (await client.query(`SELECT comments FROM posts WHERE id = $1`, [P_SCHEDULED]))
        .rows[0].comments as unknown;
      await client.query(`UPDATE posts SET markdown = 'not out yet', comments = $2 WHERE id = $1`, [
        P_SCHEDULED,
        JSON.stringify([{ id: 'c-under-scheduled', userId: 'author', text: 'a word under it' }]),
      ]);
      await client.query(
        `INSERT INTO content_reports ("contentType", "contentId", status)
           VALUES ('post', $1, 'pending'), ('comment', 'c-under-scheduled', 'pending')`,
        [P_SCHEDULED]
      );
      // The queue's own listing: every status is listed, and the page is narrowed by the scope
      // fragment the service hands its query builder (`reportInBdeScopeSql`), run for real here -
      // `bde-moderation.integration.spec.ts` covers its passage through TypeORM.
      const queueOf = () => {
        let scope: { sql: string; moderator: string } | null = null;
        const page = {
          orderBy: () => page,
          take: () => page,
          skip: () => page,
          where: (sql: string, params: { scopeModerator: string }) => {
            scope = {
              sql: sql.replaceAll(':scopeModerator', '$1'),
              moderator: params.scopeModerator,
            };
            return page;
          },
          getMany: async () => {
            const narrowed = scope as { sql: string; moderator: string } | null;
            const { rows } = narrowed
              ? await client.query(
                  `SELECT r.* FROM content_reports r WHERE ${narrowed.sql} ORDER BY r."contentType" DESC`,
                  [narrowed.moderator]
                )
              : await client.query(
                  `SELECT r.* FROM content_reports r ORDER BY r."contentType" DESC`
                );
            return rows;
          },
        };
        return page;
      };
      const moderation = new ModerationService(
        { manager, createQueryBuilder: queueOf } as never,
        {} as never,
        {} as never
      );
      const logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const reads = () =>
        logged.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[MODERATION_READ]'));
      /** The page as `[the post's preview, the comment's preview]`, the post's report first. */
      const preview = async (userId: string, isGlobalAdmin = false) =>
        (await moderation.listAllReports({ userId, isGlobalAdmin })).map((r) => r.contentPreview);
      try {
        expect(await preview('modInScope')).toEqual(['not out yet', 'a word under it']);
        // Served of a post still scheduled later: a moderation read, logged with the post's id only.
        expect(reads()).toHaveLength(1);
        expect(reads()[0]).toContain(P_SCHEDULED.slice(0, 8));
        expect(reads()[0]).not.toContain('not out yet');
        // Out of scope, the queue lists neither report: nothing to preview.
        expect(await preview('modOutOfScope')).toEqual([]);
        logged.mockClear();
        await client.query(
          `UPDATE content_reports SET status = 'dismissed' WHERE "contentType" = 'post'`
        );
        // Both reports are still listed; the text they are about is no longer the moderator's to
        // read - the comment's own open report does not open the post it sits under.
        expect(await preview('modInScope')).toEqual([null, null]);
        expect(reads()).toEqual([]);
        expect(await preview('adminOutside', true)).toEqual(['not out yet', 'a word under it']);
        await client.query(
          `UPDATE posts SET "scheduledAt" = now() - interval '1 minute' WHERE id = $1`,
          [P_SCHEDULED]
        );
        logged.mockClear();
        expect(await preview('modInScope')).toEqual(['not out yet', 'a word under it']);
        // Published: an ordinary read of the queue, nothing unpublished was served.
        expect(reads()).toEqual([]);
      } finally {
        logged.mockRestore();
        await client.query(`DELETE FROM content_reports`);
        await client.query(
          `UPDATE posts SET "scheduledAt" = now() + interval '1 day', comments = $2 WHERE id = $1`,
          [P_SCHEDULED, JSON.stringify(before)]
        );
      }
    });

    it("the exclusion names the BDE moderator: a platform admin's read of a post scheduled later is unchanged", async () => {
      expect(
        await status(
          service.getById(P_SCHEDULED, { viewerId: 'adminOutside', isGlobalAdmin: true })
        )
      ).toBe('open');
    });

    it('a hidden post in its audience answers a reader who does not moderate it the 403 of a hidden post', async () => {
      expect(await status(service.getById(P_HIDDEN, { viewerId: 'reader' }))).toBe(403);
      expect(await status(service.listComments(P_HIDDEN, 'reader', {}))).toBe(403);
    });

    it.each(['READ_OR_REACT', 'COMMENT', 'VOTE'] as const)(
      'outside its audience, the moderator is refused a write of intent %s (no write asks the moderation read)',
      async (intent) => {
        expect(await status(service.assertVisible(P_PERSONAL, 'modInScope', intent))).toBe(404);
      }
    );
  });

  describe('a mention (`mentionRecipientsOf`)', () => {
    const notifications = () =>
      new PostNotificationsService({} as never, { manager } as never, {} as never, {} as never);
    const everyoneButTheAuthor = Object.keys(USERS).filter((u) => u !== 'author');

    it('reaches only who may open the post: not an outsider, not a block either way', async () => {
      expect(
        await notifications().mentionRecipientsOf(
          await row(P_PERSONAL),
          'author',
          everyoneButTheAuthor,
          'READ_OR_REACT'
        )
      ).toEqual(['reader', 'commenter', 'blockedTheCommenter', 'adminInside']);
    });

    it('reaches nobody on a hidden post, nor on one scheduled later', async () => {
      for (const postId of [P_HIDDEN, P_SCHEDULED]) {
        expect(
          await notifications().mentionRecipientsOf(
            await row(postId),
            'author',
            ['reader'],
            'READ_OR_REACT'
          )
        ).toEqual([]);
      }
    });

    it("drops a block with the WRITER of a comment's mention, whoever wrote the post", async () => {
      expect(
        await notifications().mentionRecipientsOf(
          await row(P_PERSONAL),
          'commenter',
          ['reader', 'blockedTheCommenter'],
          'COMMENT'
        )
      ).toEqual(['reader']);
    });
  });

  describe('a report (`ModerationService.createReport`)', () => {
    const service = () => {
      const reportRepo = {
        manager,
        findOne: jest.fn(() => Promise.resolve(null)),
        create: jest.fn((r: unknown) => r),
        save: jest.fn((r: object) => Promise.resolve({ id: 'r1', ...r })),
        count: jest.fn(() => Promise.resolve(1)),
      };
      return {
        reportRepo,
        moderation: new ModerationService(reportRepo as never, {} as never, {} as never),
      };
    };
    const report = (reporterId: string, contentType: 'post' | 'comment', contentId: string) => {
      const s = service();
      return {
        s,
        done: s.moderation.createReport({ reporterId, contentType, contentId, reason: 'spam' }),
      };
    };

    it('files a report on a post the reporter may open', async () => {
      const { s, done } = report('reader', 'post', P_PERSONAL);
      await done;
      expect(s.reportRepo.save).toHaveBeenCalled();
    });

    it.each([
      ['outsider', P_PERSONAL],
      ['blockedByAuthor', P_PERSONAL],
      ['blockedTheAuthor', P_PERSONAL],
      ['reader', P_HIDDEN],
      ['reader', P_SCHEDULED],
    ])('refuses %s on post %s: 404 CONTENT_NOT_FOUND, nothing filed', async (who, postId) => {
      const { s, done } = report(who, 'post', postId);
      await expect(done).rejects.toMatchObject({
        status: 404,
        response: { code: 'CONTENT_NOT_FOUND' },
      });
      expect(s.reportRepo.save).not.toHaveBeenCalled();
    });

    it('files a report on a comment the reporter is shown', async () => {
      const { s, done } = report('reader', 'comment', 'c-plain');
      await done;
      expect(s.reportRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ contentId: 'c-plain', reportedUserId: 'commenter' })
      );
    });

    it('refuses a comment under a post the reporter may not open, or by a writer a block hides', async () => {
      for (const who of ['outsider', 'blockedByAuthor', 'blockedTheCommenter']) {
        const { s, done } = report(who, 'comment', 'c-plain');
        await expect(done).rejects.toMatchObject({ status: 404 });
        expect(s.reportRepo.save).not.toHaveBeenCalled();
      }
    });

    it('files a report on an anonymous comment across a block with its writer: the read shows it', async () => {
      const { s, done } = report('blockedTheCommenter', 'comment', 'c-anon');
      await done;
      expect(s.reportRepo.save).toHaveBeenCalled();
    });
  });
});
