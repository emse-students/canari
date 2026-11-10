/**
 * THE BELL (engagement WP-3) against a REAL PostgreSQL: migrations 142 and 143 as they ship, the
 * level table of docs/wiki/engagement.md ("The bell - data model"), the reset that rides on a follow
 * coming into being (L3), the old mute routes writing the new store (L8), the erasure statement.
 *
 * What only the database can prove: that the copy keeps a newer bell, that the mirror trigger turns
 * an old image's mute write into a bell write (insert, upsert and delete), that a retried or
 * concurrent follow resets nothing it did not create, that a person's bell is written only while
 * the caller follows them (one statement), and that `fanOutPush` asks the bell of the right account
 * - the notification service is the REAL one; only the push transport is a recorder.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Locally, against any throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- account-bells.integration
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { NotFoundException } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { AccountBell } from './entities/account-bell.entity';
import { AssociationFollow } from './entities/association-follow.entity';
import { UserFollow } from './entities/user-follow.entity';
import { AccountBellsService, BELL_CODES, type BellLevel } from './account-bells.service';
import { FollowsService } from './follows.service';
import { FollowRequestsService } from './follow-requests.service';
import { PostNotification } from '../posts/entities/post-notification.entity';
import { PostNotificationsService } from '../posts/post-notifications.service';
import {
  createEngagementPushCapTables,
  createPostNotificationsTable,
} from '../posts/post-notifications.it-schema';
import { ERASURE_STATEMENTS } from '../internal/account-erasure';
import type { PushContent } from '../push/push-content';
import type { NotificationType } from '../push/notification-client-floor';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

const BDE = '7a1c2d9e-0000-4000-8000-000000000001';
const CLUB = '7a1c2d9e-0000-4000-8000-000000000002';
const PEOPLE = ['ann', 'bob', 'cid', 'dan'];

/** What a refusal carries: the typed code, read from the exception, never its message. */
const codeOf = (e: unknown): unknown =>
  (e as { getResponse?: () => { code?: string } }).getResponse?.().code;

maybe('the bell against PostgreSQL (engagement WP-3)', () => {
  const schema = `bells_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let bells: AccountBellsService;
  let follows: FollowsService;
  let requests: FollowRequestsService;
  let notifications: PostNotificationsService;
  const pushed: string[] = [];

  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
  /**
   * The associations table through SQL: the bell and the follow ask only these things of it. Through
   * the pool (`ds`), not the admin client, which a burst of concurrent follows would share.
   */
  const assoRows = (sql: string, params: unknown[]): Promise<Record<string, unknown>[]> =>
    ds.query(sql, params);
  const assoRepo = {
    exists: async ({ where }: { where: { id: string } }) =>
      (await assoRows(`SELECT 1 FROM associations WHERE id = $1`, [where.id])).length > 0,
    findOne: async ({ where }: { where: { id: string } }) =>
      (await assoRows(`SELECT id, name FROM associations WHERE id = $1`, [where.id]))[0] ?? null,
    findBy: ({ id }: { id: { _value: string[] } }) =>
      assoRows(`SELECT id, name, slug, NULL AS "logoUrl" FROM associations WHERE id = ANY($1)`, [
        id._value,
      ]),
  };
  const push = {
    notifyContent: (to: string, content: PushContent) => {
      pushed.push(`${to}:${content.key}`);
      return Promise.resolve();
    },
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const bellRows = async (): Promise<string[]> =>
    (
      await q(
        `SELECT "userId" || '>' || "targetKind" || ':' || "targetId" || '=' || level AS r
           FROM account_bells ORDER BY 1`
      )
    ).rows.map((r) => r.r as string);
  const accepted = (a: string, b: string) =>
    q(
      `INSERT INTO user_follows (id, "followerUserId", "followedUserId", status, "acceptedAt")
       VALUES (gen_random_uuid(), $1, $2, 'accepted', now())`,
      [a, b]
    );
  const pending = (a: string, b: string) =>
    q(
      `INSERT INTO user_follows (id, "followerUserId", "followedUserId", status)
       VALUES (gen_random_uuid(), $1, $2, 'pending')`,
      [a, b]
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}, public`);
    // The tables as production has them, from before migrations existed (TypeORM built them).
    await q(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, "displayName" varchar, "firstName" varchar,
        "lastName" varchar);
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL, slug varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', archived boolean NOT NULL DEFAULT false,
        "isBDE" boolean NOT NULL DEFAULT false, "createdBy" varchar(255));
      -- What migrations 071-132 below build on: the bell entity's "commentId" comes from 132.
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL, "associationId" uuid,
        anonymous boolean NOT NULL DEFAULT false, "hiddenByModeration" boolean NOT NULL DEFAULT false,
        "publishedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions int NOT NULL DEFAULT 0);
      CREATE TABLE association_follows (id uuid PRIMARY KEY, "followerUserId" varchar(255) NOT NULL,
        "associationId" uuid NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_association_follows" UNIQUE ("followerUserId", "associationId"));
      CREATE TABLE user_follows (id uuid PRIMARY KEY, "followerUserId" varchar(255) NOT NULL,
        "followedUserId" varchar(255) NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_user_follows_pair" UNIQUE ("followerUserId", "followedUserId"));
      CREATE TABLE user_blocks ("blockerId" varchar(255) NOT NULL, "blockedId" varchar(255) NOT NULL);
    `);
    await createPostNotificationsTable(q);
    for (const name of [
      '071_spaces.sql',
      '072_drop_is_bde.sql',
      '073_republications.sql',
      '078_read_grants.sql',
      '132_read_grant_readers.sql',
    ]) {
      await q(migration(name));
    }
    await q(migration('114_user_follow_status.sql'));
    await q(migration('080_association_push_mutes.sql'));
    for (const id of PEOPLE) {
      await q(`INSERT INTO users (id, "displayName") VALUES ($1, $2)`, [id, id.toUpperCase()]);
    }
    await q(
      `INSERT INTO associations (id, name, slug) VALUES ($1, 'BDE', 'bde'), ($2, 'Club', 'club')`,
      [BDE, CLUB]
    );
    await q(migration('142_account_bells.sql'));
    // THE STATE MIGRATION 143 MEETS: two mutes set before it, and one bell a reader already chose
    // through the new code (lives on the CLUB) for an association they had also muted.
    await q(
      `INSERT INTO association_push_mutes ("userId", "associationId") VALUES
               ('ann', $1), ('bob', $1), ('cid', $2)`,
      [BDE, CLUB]
    );
    await q(
      `INSERT INTO account_bells ("userId", "targetKind", "targetId", level)
             VALUES ('cid', 'association', $1, 'lives')`,
      [CLUB]
    );
    await q(migration('143_account_bells_copy_push_mutes.sql'));
    // A followed person's post is counted by the daily push cap (owner, 2026-11-10).
    await createEngagementPushCapTables((sql) => q(sql));
    // Applied twice, as a re-run of a deploy would: nothing changes.
    await q(migration('142_account_bells.sql'));
    await q(migration('143_account_bells_copy_push_mutes.sql'));

    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [AccountBell, AssociationFollow, UserFollow, PostNotification],
      synchronize: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    bells = new AccountBellsService(ds.getRepository(AccountBell), assoRepo as never);
    follows = new FollowsService(
      ds.getRepository(AssociationFollow),
      ds.getRepository(UserFollow),
      assoRepo as never
    );
    notifications = new PostNotificationsService(
      ds.getRepository(PostNotification),
      { manager: ds.manager } as never,
      push as never,
      bells
    );
    const redis = { incr: () => Promise.resolve(1), deleteByPattern: () => Promise.resolve(1) };
    requests = new FollowRequestsService(follows, notifications, ds, redis as never);
  });

  afterAll(async () => {
    await ds?.destroy();
    await q(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it('migration 143 copies every mute as none, and keeps a bell the reader chose since', async () => {
    expect(await bellRows()).toEqual([
      `ann>association:${BDE}=none`,
      `bob>association:${BDE}=none`,
      `cid>association:${CLUB}=lives`,
    ]);
  });

  describe('after the copy', () => {
    beforeEach(async () => {
      pushed.length = 0;
      await q(`DELETE FROM engagement_push_days`);
      await q(`DELETE FROM account_bells; DELETE FROM association_push_mutes;
               DELETE FROM association_follows; DELETE FROM user_follows; DELETE FROM user_blocks;
               DELETE FROM post_notifications; DELETE FROM user_follow_notices`);
    });

    it("mirrors an OLD image's mute writes - insert, upsert and delete - into the bell", async () => {
      await q(`INSERT INTO association_push_mutes ("userId", "associationId") VALUES ('ann', $1)`, [
        BDE,
      ]);
      expect(await bellRows()).toEqual([`ann>association:${BDE}=none`]);
      // The reader then chose lives through the new code; an old build mutes again (TypeORM's upsert).
      await bells.setLevel('ann', 'association', BDE, 'lives');
      await q(
        `INSERT INTO association_push_mutes ("userId", "associationId") VALUES ('ann', $1)
         ON CONFLICT ("userId", "associationId") DO UPDATE SET "userId" = EXCLUDED."userId"`,
        [BDE]
      );
      expect(await bellRows()).toEqual([`ann>association:${BDE}=none`]);
      await q(`DELETE FROM association_push_mutes WHERE "userId" = 'ann'`);
      expect(await bellRows()).toEqual([]);
    });

    it('sets, reads and clears a level idempotently; all is no row', async () => {
      expect(await bells.levelOf('ann', 'association', BDE)).toBe('all');
      for (const level of ['lives', 'lives', 'none', 'none'] as BellLevel[]) {
        expect(await bells.setLevel('ann', 'association', BDE, level)).toEqual({ level });
      }
      expect(await bells.levelOf('ann', 'association', BDE)).toBe('none');
      await bells.setLevel('ann', 'association', BDE, 'all');
      await bells.setLevel('ann', 'association', BDE, 'all');
      expect(await bellRows()).toEqual([]);
    });

    it('refuses a bell on a person the caller does not follow, a pending request, or across a block', async () => {
      const refusal = (target: string) =>
        bells.setLevel('ann', 'user', target, 'none').then(
          () => 'written',
          (e: unknown) => codeOf(e)
        );
      expect(await refusal('bob')).toBe(BELL_CODES.targetNotFound);
      await pending('ann', 'bob');
      expect(await refusal('bob')).toBe(BELL_CODES.targetNotFound);
      await accepted('ann', 'cid');
      expect(await refusal('cid')).toBe('written');
      // A block severs the follow (the internal route deletes the row); the bell is then refused.
      await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ('dan', 'ann')`);
      await q(`DELETE FROM user_follows WHERE "followedUserId" = 'dan'`);
      expect(await refusal('dan')).toBe(BELL_CODES.targetNotFound);
      expect(await bellRows()).toEqual(['ann>user:cid=none']);
    });

    it('a NEW association follow resets the bell; a retried one does not', async () => {
      await bells.setLevel('ann', 'association', BDE, 'none');
      // Following a muted association unmutes it (L3).
      await follows.followAssociation('ann', BDE);
      expect(await bellRows()).toEqual([]);
      // The reader reduces it again; a retried follow, or five at once, creates nothing and resets nothing.
      await bells.setLevel('ann', 'association', BDE, 'lives');
      await Promise.all(Array.from({ length: 5 }, () => follows.followAssociation('ann', BDE)));
      expect(await bellRows()).toEqual([`ann>association:${BDE}=lives`]);
      expect((await q(`SELECT 1 FROM association_follows`)).rowCount).toBe(1);
      // Unfollow then follow is a new follow.
      await follows.unfollowAssociation('ann', BDE);
      await follows.followAssociation('ann', BDE);
      expect(await bellRows()).toEqual([]);
    });

    it('five concurrent new follows of a muted association create one follow and reset once', async () => {
      await bells.setLevel('bob', 'association', CLUB, 'none');
      await Promise.all(Array.from({ length: 5 }, () => follows.followAssociation('bob', CLUB)));
      expect((await q(`SELECT 1 FROM association_follows`)).rowCount).toBe(1);
      expect(await bellRows()).toEqual([]);
    });

    it("a person's ACCEPTANCE resets the new follower's bell; a re-sent one does not", async () => {
      // A stale bell from an earlier follow of bob, then a new request bob accepts.
      await q(`INSERT INTO account_bells ("userId", "targetKind", "targetId", level)
               VALUES ('ann', 'user', 'bob', 'none'), ('cid', 'user', 'bob', 'none')`);
      await pending('ann', 'bob');
      await requests.accept('bob', 'ann');
      expect(await bellRows()).toEqual(['cid>user:bob=none']);
      await bells.setLevel('ann', 'user', 'bob', 'lives');
      await expect(requests.accept('bob', 'ann')).rejects.toBeInstanceOf(NotFoundException);
      expect(await bellRows()).toEqual(['ann>user:bob=lives', 'cid>user:bob=none']);
    });

    it('an acceptance refused across a block resets nothing', async () => {
      await q(`INSERT INTO account_bells ("userId", "targetKind", "targetId", level)
               VALUES ('ann', 'user', 'bob', 'none')`);
      await pending('ann', 'bob');
      await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ('bob', 'ann')`);
      await expect(requests.accept('bob', 'ann')).rejects.toBeInstanceOf(NotFoundException);
      expect(await bellRows()).toEqual(['ann>user:bob=none']);
    });

    describe('the level table, through the real notification service', () => {
      const asso = (type: NotificationType) =>
        notifications.createNotifications({
          recipientIds: ['ann', 'bob', 'cid'],
          type,
          postId: '11111111-1111-4111-8111-111111111111',
          actorId: 'dan',
          actorName: 'BDE',
          text: 'Soiree',
          associationId: BDE,
          associationLogoMediaId: 'logo1',
        });

      beforeEach(async () => {
        await bells.setLevel('bob', 'association', BDE, 'lives');
        await bells.setLevel('cid', 'association', BDE, 'none');
      });

      it('an association post: pushed at all, a bell row only at lives and none', async () => {
        await asso('association_post');
        await flush();
        expect(pushed).toEqual(['ann:social_association_post']);
        const rows = await q(`SELECT "recipientId" FROM post_notifications ORDER BY 1`);
        expect(rows.rows.map((r) => r.recipientId)).toEqual(['ann', 'bob', 'cid']);
      });

      it('an association live: pushed at all and lives, not at none', async () => {
        await notifications.pushNotice({
          recipientIds: ['ann', 'bob', 'cid'],
          type: 'live_started',
          actorId: 'dan',
          actorName: 'BDE',
          text: '',
          associationId: BDE,
          associationLogoMediaId: 'logo1',
        });
        await flush();
        expect(pushed.sort()).toEqual(['ann:social_live_started', 'bob:social_live_started']);
      });

      it("a person's post and live answer to THAT person's bell, not to an association's", async () => {
        await accepted('bob', 'dan');
        await accepted('cid', 'dan');
        await bells.setLevel('bob', 'user', 'dan', 'lives');
        await bells.setLevel('cid', 'user', 'dan', 'none');
        await notifications.createNotifications({
          recipientIds: ['ann', 'bob', 'cid'],
          type: 'followed_post',
          postId: '11111111-1111-4111-8111-111111111112',
          actorId: 'dan',
          actorName: 'DAN',
          text: 'Hello',
        });
        await notifications.pushNotice({
          recipientIds: ['ann', 'bob', 'cid'],
          type: 'live_started',
          actorId: 'dan',
          actorName: 'DAN',
          text: '',
        });
        await flush();
        expect(pushed.sort()).toEqual([
          'ann:social_followed_post',
          'ann:social_live_started',
          'bob:social_live_started',
        ]);
      });

      it('a mention is never withheld by a bell', async () => {
        await bells.setLevel('cid', 'association', BDE, 'none');
        await notifications.createNotifications({
          recipientIds: ['cid'],
          type: 'mention',
          postId: '11111111-1111-4111-8111-111111111113',
          actorId: 'dan',
          actorName: 'DAN',
          text: 'Hey',
          associationId: BDE,
          associationLogoMediaId: 'logo1',
        });
        await flush();
        expect(pushed).toEqual(['cid:social_mention']);
      });
    });

    it('the legacy mute routes read and write the bell, and a mute they set is honoured', async () => {
      await bells.mute('ann', BDE);
      expect(await bells.isMuted('ann', BDE)).toBe(true);
      expect((await bells.listMuted('ann')).map((a) => a.name)).toEqual(['BDE']);
      expect(await q(`SELECT 1 FROM association_push_mutes`).then((r) => r.rowCount)).toBe(0);
      await bells.setLevel('ann', 'association', BDE, 'lives');
      // `lives` is not a mute to an old build: it shows the association unmuted.
      expect(await bells.isMuted('ann', BDE)).toBe(false);
      await bells.unmute('ann', BDE);
      await bells.unmute('ann', BDE);
      expect(await bellRows()).toEqual([]);
    });

    it('an UPPER-CASE association id is the same bell: it withholds, lists and resets on follow', async () => {
      const upper = BDE.toUpperCase();
      await bells.setLevel('ann', 'association', upper, 'none');
      expect(await bellRows()).toEqual([`ann>association:${BDE}=none`]);
      expect((await bells.listReduced('ann')).map((b) => b.targetId)).toEqual([BDE]);
      const target = { kind: 'association', id: BDE, push: 'post' } as const;
      expect([...(await bells.withheldAmong(target, ['ann']))]).toEqual(['ann']);
      await follows.followAssociation('ann', upper);
      expect(await bellRows()).toEqual([]);
    });

    it('moving a bell off none, by any route, leaves no legacy mute row behind', async () => {
      const legacyRows = () => q(`SELECT 1 FROM association_push_mutes`).then((r) => r.rowCount);
      const oldImageMute = () =>
        q(`INSERT INTO association_push_mutes ("userId", "associationId") VALUES ('ann', $1)`, [
          BDE,
        ]);
      await oldImageMute();
      await bells.setLevel('ann', 'association', BDE, 'lives');
      expect(await legacyRows()).toBe(0);
      expect(await bellRows()).toEqual([`ann>association:${BDE}=lives`]);
      await oldImageMute();
      await bells.unmute('ann', BDE);
      expect(await legacyRows()).toBe(0);
      expect(await bellRows()).toEqual([]);
      await oldImageMute();
      await follows.followAssociation('ann', BDE);
      expect(await legacyRows()).toBe(0);
      expect(await bellRows()).toEqual([]);
    });

    it('lists every reduction for the settings, an association by name, a person by id', async () => {
      await accepted('ann', 'bob');
      await bells.setLevel('ann', 'user', 'bob', 'lives');
      await bells.setLevel('ann', 'association', CLUB, 'none');
      await bells.setLevel('ann', 'association', BDE, 'lives');
      await bells.setLevel('cid', 'association', BDE, 'none');
      expect(await bells.listReduced('ann')).toEqual([
        { kind: 'association', targetId: BDE, level: 'lives', name: 'BDE' },
        { kind: 'association', targetId: CLUB, level: 'none', name: 'Club' },
        { kind: 'user', targetId: 'bob', level: 'lives', name: null },
      ]);
    });

    it('refuses an association id that is no uuid as not found, never a database error', async () => {
      const e = await bells.setLevel('ann', 'association', 'bde', 'none').catch((x: unknown) => x);
      expect(codeOf(e)).toBe(BELL_CODES.targetNotFound);
    });

    it("the erasure deletes the account's bells and every bell on it", async () => {
      await accepted('ann', 'bob');
      await accepted('cid', 'ann');
      await bells.setLevel('ann', 'user', 'bob', 'none');
      await bells.setLevel('ann', 'association', BDE, 'none');
      await bells.setLevel('cid', 'user', 'ann', 'lives');
      await bells.setLevel('cid', 'association', BDE, 'none');
      const erasure = ERASURE_STATEMENTS.find((s) => s.label === 'account_bells')!;
      await q(erasure.sql, ['ann']);
      expect(await bellRows()).toEqual([`cid>association:${BDE}=none`]);
    });
  });
});
