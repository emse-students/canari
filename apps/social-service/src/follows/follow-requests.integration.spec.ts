/**
 * FOLLOW REQUESTS (WP-F2) against a REAL PostgreSQL: ask, the inbox, accept, refuse, withdraw, and
 * the block - migration 114 included.
 *
 * What only the database can prove: that an acceptance is one conditional UPDATE a racing withdraw
 * cannot leave half-done, that a block in either direction stops a request, its listing and its
 * acceptance in the same statement, that a person is told ONCE per pair from the
 * `user_follow_notices` row however the asker loops, and that the block severing removes a row
 * WHATEVER its status. The notification service is the REAL `PostNotificationsService` over a
 * real `post_notifications` table, so the bell row AND the push content key it maps are asserted -
 * only the push transport is a recorder.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Locally, against any throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- follow-requests.integration
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { UserFollow } from './entities/user-follow.entity';
import { FOLLOW_CODES, FollowsService } from './follows.service';
import {
  FOLLOW_ACCEPTED_NOTIFICATION,
  FOLLOW_REQUEST_NOTIFICATION,
  FollowRequestsService,
} from './follow-requests.service';
import { InternalController } from '../internal/internal.controller';
import { PostNotification } from '../posts/entities/post-notification.entity';
import { PostNotificationsService } from '../posts/post-notifications.service';
import type { PushContent } from '../push/push-content';
import { NOTIFICATIONS_TARGET } from '../push/push-target';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION_114 = readFileSync(
  join(__dirname, '..', 'migrations', '114_user_follow_status.sql'),
  'utf8'
);

/** One push the real notification service handed to the transport. */
type Pushed = { to: string; key: string; actor: string; target: string | undefined };

/** The people of this file; anyone else - `zed`, an association's id - is nobody to follow. */
const PEOPLE = ['ann', 'bob', 'cid', 'dan', 'eve'];

/** What a refused ask must carry: the typed code, read from the exception, never its message. */
const codeOf = (e: unknown): unknown =>
  (e as { getResponse?: () => { code?: string } }).getResponse?.().code;

maybe('follow requests against PostgreSQL (WP-F2)', () => {
  const schema = `follow_req_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let follows: FollowsService;
  let requests: FollowRequestsService;
  const pushed: Pushed[] = [];
  /** The internal routes' secret for this file, set for its duration and restored after. */
  const IT_SECRET = 'follow-req-it-secret';
  let secretBefore: string | undefined;
  /** The internal controller, with only the repository its severing route reads. */
  const severing = () =>
    new InternalController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      ds.getRepository(UserFollow),
      {} as never,
      {} as never,
      {} as never
    );

  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
  const statusOf = async (a: string, b: string): Promise<string | null> => {
    const { rows } = await q(
      `SELECT status FROM user_follows WHERE "followerUserId" = $1 AND "followedUserId" = $2`,
      [a, b]
    );
    return rows[0]?.status ?? null;
  };
  /** The push transport, the one thing not real: what the mapping produced is the assertion. */
  const push = {
    notifyContent: (to: string, content: PushContent, data: Record<string, string>) => {
      pushed.push({ to, key: content.key, actor: content.actorName, target: data.target });
      return Promise.resolve();
    },
  };
  const bellOf = async (recipient: string): Promise<string[]> => {
    const { rows } = await q(
      `SELECT type || ':' || "actorId" AS r FROM post_notifications WHERE "recipientId" = $1
        ORDER BY "createdAt", type`,
      [recipient]
    );
    return rows.map((r) => r.r as string);
  };
  const refusalOf = (asking: Promise<unknown>): Promise<unknown> =>
    asking.then(
      () => 'written',
      (e: unknown) => e
    );
  const block = (blocker: string, blocked: string) =>
    q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [blocker, blocked]);

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}, public`);
    // The table as production has it before 114, then 114 as it ships.
    await admin.query(`
      CREATE TABLE user_follows (
        id uuid PRIMARY KEY,
        "followerUserId" varchar(255) NOT NULL,
        "followedUserId" varchar(255) NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_user_follows_pair" UNIQUE ("followerUserId", "followedUserId"));
      CREATE TABLE user_blocks ("blockerId" varchar(255) NOT NULL, "blockedId" varchar(255) NOT NULL);
      CREATE TABLE users (id varchar(255) PRIMARY KEY, "displayName" varchar, "firstName" varchar,
        "lastName" varchar);
      CREATE TABLE post_notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "recipientId" varchar NOT NULL, type varchar NOT NULL, "postId" varchar NOT NULL,
        "actorId" varchar NOT NULL, "actorName" varchar, "associationId" varchar,
        "associationLogoUrl" varchar, text varchar NOT NULL, read boolean NOT NULL DEFAULT false,
        "createdAt" timestamp NOT NULL DEFAULT clock_timestamp());
    `);
    for (const id of PEOPLE) {
      await admin.query(`INSERT INTO users (id, "displayName") VALUES ($1, $2)`, [
        id,
        id.toUpperCase(),
      ]);
    }
    await admin.query(MIGRATION_114);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [UserFollow, PostNotification],
      synchronize: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    follows = new FollowsService({} as never, ds.getRepository(UserFollow), {} as never);
    const notifications = new PostNotificationsService(
      ds.getRepository(PostNotification),
      { manager: ds.manager } as never,
      push as never,
      {} as never
    );
    requests = new FollowRequestsService(follows, notifications, ds);
    secretBefore = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = IT_SECRET;
  });

  afterAll(async () => {
    if (secretBefore === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = secretBefore;
    await ds.destroy();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  beforeEach(async () => {
    pushed.length = 0;
    await q(`DELETE FROM user_follows; DELETE FROM user_blocks; DELETE FROM post_notifications;
             DELETE FROM user_follow_notices`);
  });

  it('an ask writes ONE pending request and tells the person asked ONCE, however many taps', async () => {
    const answers = await Promise.all(Array.from({ length: 6 }, () => requests.ask('ann', 'bob')));
    expect(answers.every((a) => a.ok && a.status === 'pending')).toBe(true);
    expect(await statusOf('ann', 'bob')).toBe('pending');
    expect(await bellOf('bob')).toEqual([`${FOLLOW_REQUEST_NOTIFICATION}:ann`]);
    // Through the REAL mapping: a push with its content key, the asker's name and the typed target.
    expect(pushed).toEqual([
      { to: 'bob', key: 'social_follow_request', actor: 'ANN', target: NOTIFICATIONS_TARGET },
    ]);
  });

  it('ask -> withdraw -> ask, in a loop, tells the person ONCE: the notice is durable state', async () => {
    for (let i = 0; i < 5; i++) {
      await requests.ask('ann', 'bob');
      await requests.leave('ann', 'bob');
    }
    await requests.ask('ann', 'bob');
    expect(pushed.map((x) => x.key)).toEqual(['social_follow_request']);
    // The request still reaches its person: the inbox reads `user_follows`, not the bell.
    expect((await requests.incoming('bob', 50, 0)).map((r) => r.userId)).toEqual(['ann']);
  });

  it.each([
    ['an unknown id', 'zed'],
    ['an association id', '7a1c2d9e-0000-4000-8000-000000000001'],
  ])('an ask of %s is refused 404 FOLLOW_TARGET_NOT_FOUND and writes nothing', async (_c, id) => {
    const refusal = await refusalOf(requests.ask('ann', id));
    expect(refusal).toBeInstanceOf(NotFoundException);
    expect(codeOf(refusal)).toBe(FOLLOW_CODES.targetNotFound);
    expect(await statusOf('ann', id)).toBeNull();
    expect(pushed).toEqual([]);
  });

  it.each([
    ['the asker blocked the person', 'ann', 'bob'],
    ['the person blocked the asker', 'bob', 'ann'],
  ])(
    'across a block (%s) the ask is refused 403 FOLLOW_BLOCKED: no row, nobody told',
    async (_c, blocker, blocked) => {
      await block(blocker, blocked);
      const refusal = await refusalOf(requests.ask('ann', 'bob'));
      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect(codeOf(refusal)).toBe(FOLLOW_CODES.blocked);
      expect(await statusOf('ann', 'bob')).toBeNull();
      expect(pushed).toEqual([]);
      expect(await bellOf('bob')).toEqual([]);
    }
  );

  it('the inbox is the pending requests FOR the caller, newest first, minus a block, and counts the same', async () => {
    await requests.ask('ann', 'bob');
    await q(
      `UPDATE user_follows SET "createdAt" = now() - interval '1 hour' WHERE "followerUserId" = 'ann'`
    );
    await requests.ask('cid', 'bob');
    await requests.ask('dan', 'bob');
    await requests.accept('bob', 'dan');
    await requests.ask('eve', 'bob');
    await block('bob', 'eve'); // the severing call failed: the row is still there, never shown
    await requests.ask('bob', 'ann'); // bob's own outgoing ask is not in his inbox

    const inbox = await requests.incoming('bob', 50, 0);
    expect(inbox.map((r) => r.userId)).toEqual(['cid', 'ann']);
    expect(await requests.incomingCount('bob')).toEqual({ pending: 2 });
    expect((await requests.incoming('bob', 1, 0)).map((r) => r.userId)).toEqual(['cid']);
    expect((await requests.incoming('bob', 1, 1)).map((r) => r.userId)).toEqual(['ann']);
    expect(await requests.incoming('ann', 50, 0)).toEqual([
      { userId: 'bob', createdAt: expect.any(Date) },
    ]);
  });

  it('an acceptance makes the follow and tells the asker; a second one, or one never asked, is a 404', async () => {
    await requests.ask('ann', 'bob');
    pushed.length = 0;
    expect(await requests.accept('bob', 'ann')).toEqual({ ok: true });
    expect(await statusOf('ann', 'bob')).toBe('accepted');
    const { rows } = await q(
      `SELECT "acceptedAt" FROM user_follows WHERE "followerUserId" = 'ann' AND "followedUserId" = 'bob'`
    );
    expect(rows[0].acceptedAt).toBeInstanceOf(Date);
    expect(await follows.getFollowedUserIdsForUser('ann')).toEqual(['bob']);
    expect(await bellOf('ann')).toEqual([`${FOLLOW_ACCEPTED_NOTIFICATION}:bob`]);
    expect(pushed).toEqual([
      { to: 'ann', key: 'social_follow_accepted', actor: 'BOB', target: NOTIFICATIONS_TARGET },
    ]);
    await expect(requests.accept('bob', 'ann')).rejects.toBeInstanceOf(NotFoundException);
    await expect(requests.accept('bob', 'zed')).rejects.toBeInstanceOf(NotFoundException);
    // Only the person ASKED answers: the asker cannot accept their own request.
    await requests.ask('cid', 'bob');
    await expect(requests.accept('cid', 'bob')).rejects.toBeInstanceOf(NotFoundException);
    expect(await statusOf('cid', 'bob')).toBe('pending');
  });

  it('unfollow -> ask -> accept again tells neither side a second time', async () => {
    await requests.ask('ann', 'bob');
    await requests.accept('bob', 'ann');
    await requests.leave('ann', 'bob');
    await requests.ask('ann', 'bob');
    await requests.accept('bob', 'ann');
    expect(pushed.map((x) => x.key)).toEqual(['social_follow_request', 'social_follow_accepted']);
    expect(await statusOf('ann', 'bob')).toBe('accepted');
  });

  it('no acceptance across a block, even when the severing never ran', async () => {
    await requests.ask('ann', 'bob');
    await block('ann', 'bob');
    await expect(requests.accept('bob', 'ann')).rejects.toBeInstanceOf(NotFoundException);
    expect(await statusOf('ann', 'bob')).toBe('pending');
  });

  it('an acceptance racing a withdraw never leaves a follow behind the withdraw', async () => {
    for (let i = 0; i < 20; i++) {
      await requests.ask('ann', 'bob');
      const [accepted, withdrawn] = await Promise.allSettled([
        requests.accept('bob', 'ann'),
        requests.leave('ann', 'bob'),
      ]);
      expect(withdrawn.status).toBe('fulfilled');
      // Either outcome is right; the only error an acceptance may meet is "no pending request".
      const acceptError = accepted.status === 'rejected' ? accepted.reason : null;
      expect(acceptError === null || acceptError instanceof NotFoundException).toBe(true);
      expect(await statusOf('ann', 'bob')).toBeNull();
    }
  });

  it('a refusal deletes the request, tells nobody and removes its bell row; the asker may ask again', async () => {
    await requests.ask('ann', 'bob');
    expect(await bellOf('bob')).toEqual([`${FOLLOW_REQUEST_NOTIFICATION}:ann`]);
    pushed.length = 0;
    expect(await requests.refuse('bob', 'ann')).toEqual({ ok: true });
    expect(await statusOf('ann', 'bob')).toBeNull();
    expect(pushed).toEqual([]);
    expect(await bellOf('bob')).toEqual([]);
    expect(await bellOf('ann')).toEqual([]);
    await expect(requests.refuse('bob', 'ann')).rejects.toBeInstanceOf(NotFoundException);
    // Asked again: the request stands in the inbox, and the person is not pushed a second time.
    await requests.ask('ann', 'bob');
    expect(await statusOf('ann', 'bob')).toBe('pending');
    expect(pushed).toEqual([]);
  });

  it('a refusal never touches an accepted follow', async () => {
    await requests.ask('ann', 'bob');
    await requests.accept('bob', 'ann');
    await expect(requests.refuse('bob', 'ann')).rejects.toBeInstanceOf(NotFoundException);
    expect(await statusOf('ann', 'bob')).toBe('accepted');
  });

  it('a withdrawn request takes its bell row along; an unfollow keeps the history', async () => {
    await requests.ask('ann', 'bob');
    await requests.leave('ann', 'bob');
    expect(await bellOf('bob')).toEqual([]);
    await requests.ask('ann', 'bob');
    await requests.accept('bob', 'ann');
    await requests.leave('ann', 'bob');
    expect(await statusOf('ann', 'bob')).toBeNull();
    expect(await bellOf('ann')).toEqual([`${FOLLOW_ACCEPTED_NOTIFICATION}:bob`]);
  });

  it('the block severing removes every row between the two, pending or accepted, both directions, and their request bell rows', async () => {
    const internal = severing();
    await requests.ask('ann', 'bob');
    await requests.accept('bob', 'ann');
    await requests.ask('bob', 'ann'); // pending the other way
    await requests.ask('ann', 'cid'); // a third person: untouched
    await requests.ask('dan', 'bob'); // a third person's request to one of them: untouched
    expect(await internal.severFollowsBetween('ann', 'bob', IT_SECRET)).toEqual({
      ok: true,
      removed: 2,
    });
    expect(await statusOf('ann', 'bob')).toBeNull();
    expect(await statusOf('bob', 'ann')).toBeNull();
    expect(await statusOf('ann', 'cid')).toBe('pending');
    // Both requests' bell rows go; the acceptance is history, and dan's request is not theirs.
    expect(await bellOf('bob')).toEqual([`${FOLLOW_REQUEST_NOTIFICATION}:dan`]);
    expect(await bellOf('ann')).toEqual([`${FOLLOW_ACCEPTED_NOTIFICATION}:bob`]);
    expect(await bellOf('cid')).toEqual([`${FOLLOW_REQUEST_NOTIFICATION}:ann`]);
  });
});
