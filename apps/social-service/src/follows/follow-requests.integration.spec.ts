/**
 * FOLLOW REQUESTS (WP-F2) against a REAL PostgreSQL: ask, the inbox, accept, refuse, withdraw, and
 * the block - migration 114 included.
 *
 * What only the database can prove: that an acceptance is one conditional UPDATE a racing withdraw
 * cannot leave half-done, that a block in either direction stops a request, its listing and its
 * acceptance in the same statement, and that the block severing removes a row WHATEVER its status.
 * The notification service is a recorder: what it is asked to write is the assertion, and its own
 * mapping is `post-notifications.*.spec.ts` and `push-content.spec.ts`.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Locally, against any throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- follow-requests.integration
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { NotFoundException } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { UserFollow } from './entities/user-follow.entity';
import { FollowsService } from './follows.service';
import {
  FOLLOW_ACCEPTED_NOTIFICATION,
  FOLLOW_REQUEST_NOTIFICATION,
  FollowRequestsService,
} from './follow-requests.service';
import { InternalController } from '../internal/internal.controller';
import type { PostNotificationsService } from '../posts/post-notifications.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION_114 = readFileSync(
  join(__dirname, '..', 'migrations', '114_user_follow_status.sql'),
  'utf8'
);

type Told = { recipientId: string; type: string; actorId: string; postId: string };

maybe('follow requests against PostgreSQL (WP-F2)', () => {
  const schema = `follow_req_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let follows: FollowsService;
  let requests: FollowRequestsService;
  const told: Told[] = [];

  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
  const statusOf = async (a: string, b: string): Promise<string | null> => {
    const { rows } = await q(
      `SELECT status FROM user_follows WHERE "followerUserId" = $1 AND "followedUserId" = $2`,
      [a, b]
    );
    return rows[0]?.status ?? null;
  };
  /** Writes the bell row the recorder stands in for, so the drop of it can be observed. */
  const notifications = {
    createNotification: async (d: Told) => {
      told.push({ recipientId: d.recipientId, type: d.type, actorId: d.actorId, postId: d.postId });
      await q(
        `INSERT INTO post_notifications ("recipientId", type, "postId", "actorId") VALUES ($1, $2, $3, $4)`,
        [d.recipientId, d.type, d.postId, d.actorId]
      );
    },
  } as unknown as PostNotificationsService;
  const bellOf = async (recipient: string): Promise<string[]> => {
    const { rows } = await q(
      `SELECT type || ':' || "actorId" AS r FROM post_notifications WHERE "recipientId" = $1 ORDER BY id`,
      [recipient]
    );
    return rows.map((r) => r.r as string);
  };
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
      CREATE TABLE post_notifications (id serial PRIMARY KEY, "recipientId" varchar NOT NULL,
        type varchar NOT NULL, "postId" varchar NOT NULL, "actorId" varchar NOT NULL);
    `);
    await admin.query(MIGRATION_114);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [UserFollow],
      synchronize: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    follows = new FollowsService({} as never, ds.getRepository(UserFollow), {} as never);
    requests = new FollowRequestsService(follows, notifications, ds);
  });

  afterAll(async () => {
    await ds.destroy();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  beforeEach(async () => {
    told.length = 0;
    await q(`DELETE FROM user_follows; DELETE FROM user_blocks; DELETE FROM post_notifications`);
  });

  it('an ask writes ONE pending request and tells the person asked ONCE, however many taps', async () => {
    const answers = await Promise.all(Array.from({ length: 6 }, () => requests.ask('ann', 'bob')));
    expect(answers.every((a) => a.ok && a.status === 'pending')).toBe(true);
    expect(await statusOf('ann', 'bob')).toBe('pending');
    expect(told).toEqual([
      { recipientId: 'bob', type: FOLLOW_REQUEST_NOTIFICATION, actorId: 'ann', postId: 'ann' },
    ]);
  });

  it.each([
    ['the asker blocked the person', 'ann', 'bob'],
    ['the person blocked the asker', 'bob', 'ann'],
  ])(
    'across a block (%s) nothing is written, nobody is told, the answer is a request',
    async (_c, blocker, blocked) => {
      await block(blocker, blocked);
      expect(await requests.ask('ann', 'bob')).toEqual({ ok: true, status: 'pending' });
      expect(await statusOf('ann', 'bob')).toBeNull();
      expect(told).toEqual([]);
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
    told.length = 0;
    expect(await requests.accept('bob', 'ann')).toEqual({ ok: true });
    expect(await statusOf('ann', 'bob')).toBe('accepted');
    expect(await follows.getFollowedUserIdsForUser('ann')).toEqual(['bob']);
    expect(told).toEqual([
      { recipientId: 'ann', type: FOLLOW_ACCEPTED_NOTIFICATION, actorId: 'bob', postId: 'bob' },
    ]);
    await expect(requests.accept('bob', 'ann')).rejects.toBeInstanceOf(NotFoundException);
    await expect(requests.accept('bob', 'zed')).rejects.toBeInstanceOf(NotFoundException);
    // Only the person ASKED answers: the asker cannot accept their own request.
    await requests.ask('cid', 'bob');
    await expect(requests.accept('cid', 'bob')).rejects.toBeInstanceOf(NotFoundException);
    expect(await statusOf('cid', 'bob')).toBe('pending');
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
    told.length = 0;
    expect(await requests.refuse('bob', 'ann')).toEqual({ ok: true });
    expect(await statusOf('ann', 'bob')).toBeNull();
    expect(told).toEqual([]);
    expect(await bellOf('bob')).toEqual([]);
    await expect(requests.refuse('bob', 'ann')).rejects.toBeInstanceOf(NotFoundException);
    await requests.ask('ann', 'bob');
    expect(await statusOf('ann', 'bob')).toBe('pending');
    expect(told).toHaveLength(1);
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

  it('the block severing removes every row between the two, pending or accepted, both directions', async () => {
    const secretBefore = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = 'it-secret';
    const internal = new InternalController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      ds.getRepository(UserFollow),
      {} as never,
      {} as never,
      {} as never
    );
    await requests.ask('ann', 'bob');
    await requests.accept('bob', 'ann');
    await requests.ask('bob', 'ann'); // pending the other way
    await requests.ask('ann', 'cid'); // a third person: untouched
    expect(await internal.severFollowsBetween('ann', 'bob', 'it-secret')).toEqual({
      ok: true,
      removed: 2,
    });
    expect(await statusOf('ann', 'bob')).toBeNull();
    expect(await statusOf('bob', 'ann')).toBeNull();
    expect(await statusOf('ann', 'cid')).toBe('pending');
    if (secretBefore === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = secretBefore;
  });
});
