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
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import type { EntityManager } from 'typeorm';
import { readPostOpenVerdict, type OpenablePost } from './post-openable';
import { PostNotificationsService } from './post-notifications.service';
import { ModerationService } from '../moderation/moderation.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

const ICM_SE = [{ formation: 'ICM', promo: 2024 }];
const ISMIN_GA = [{ formation: 'ISMIN', promo: 2024 }];

/** The cast. Readable ids on purpose: a failure names a role, never a uuid. */
const USERS: Record<string, { campus: string; cursus: unknown[] }> = {
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
        archived boolean NOT NULL DEFAULT false);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "associationId" uuid, anonymous boolean NOT NULL DEFAULT false,
        "hiddenByModeration" boolean NOT NULL DEFAULT false, "scheduledAt" timestamp,
        kind varchar NOT NULL DEFAULT 'post', "expiresAt" timestamp,
        mentions text NOT NULL DEFAULT '', comments jsonb NOT NULL DEFAULT '[]');
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL);
      CREATE TABLE user_follows ("followerUserId" varchar(255), "followedUserId" varchar(255),
        "createdAt" timestamp NOT NULL DEFAULT now(), id uuid NOT NULL DEFAULT gen_random_uuid());
      CREATE TABLE user_blocks ("blockerId" varchar(255), "blockedId" varchar(255));
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
      await client.query(`INSERT INTO users (id, campus, cursus) VALUES ($1, $2, $3)`, [
        userId,
        u.campus,
        JSON.stringify(u.cursus),
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
      ).toEqual(['reader', 'commenter', 'blockedTheCommenter']);
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
        moderation: new ModerationService(reportRepo as never, {} as never),
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
