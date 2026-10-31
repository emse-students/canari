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
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { UserFollow } from './entities/user-follow.entity';
import {
  FOLLOW_ASKS_PER_DAY,
  FOLLOW_CODES,
  FOLLOW_PENDING_MAX,
  FollowsService,
} from './follows.service';
import {
  FOLLOW_ACCEPTED_NOTIFICATION,
  FOLLOW_REQUEST_NOTIFICATION,
  FollowRequestsService,
} from './follow-requests.service';
import { InternalController } from '../internal/internal.controller';
import { PostNotification } from '../posts/entities/post-notification.entity';
import { POST_LIST_CACHE_PREFIX } from '../posts/post-list-cache';
import { PostNotificationsService } from '../posts/post-notifications.service';
import type { PushContent } from '../push/push-content';
import { FOLLOW_REQUESTS_TARGET, NOTIFICATIONS_TARGET } from '../push/push-target';

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
  /** The feed cache: what was dropped is the assertion. */
  const dropped: string[] = [];
  const redis = {
    deleteByPattern: (match: string) => {
      dropped.push(match);
      return Promise.resolve(1);
    },
  };
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
        "associationLogoUrl" varchar, text varchar NOT NULL, meta jsonb, read boolean NOT NULL DEFAULT false,
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
    requests = new FollowRequestsService(follows, notifications, ds, redis as never);
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
    dropped.length = 0;
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
      { to: 'bob', key: 'social_follow_request', actor: 'ANN', target: FOLLOW_REQUESTS_TARGET },
    ]);
  });

  it('ask -> withdraw -> ask, in a loop, tells the person ONCE: the notice is durable state', async () => {
    for (let i = 0; i < 5; i++) {
      await requests.ask('ann', 'bob');
      await requests.leave('ann', 'bob');
    }
    await requests.ask('ann', 'bob');
    expect(pushed.map((x) => x.key)).toEqual(['social_follow_request']);
    // The request still reaches its person: in the inbox, and as ONE bell row, written again
    // without a push.
    expect((await requests.incoming('bob', 50, 0)).map((r) => r.userId)).toEqual(['ann']);
    expect(await bellOf('bob')).toEqual([`${FOLLOW_REQUEST_NOTIFICATION}:ann`]);
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
    // Asked again: the request stands in the inbox with its bell row, and no second push.
    await requests.ask('ann', 'bob');
    expect(await statusOf('ann', 'bob')).toBe('pending');
    expect(pushed).toEqual([]);
    expect(await bellOf('bob')).toEqual([`${FOLLOW_REQUEST_NOTIFICATION}:ann`]);
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

  describe('the caller own lists (WP-F3)', () => {
    /** `fan` asks `bob` and `bob` accepts: a follower. */
    const followerOf = async (fan: string, whom: string) => {
      await requests.ask(fan, whom);
      await requests.accept(whom, fan);
    };

    it('my followers are the ACCEPTED ones, most recently accepted first, never a pending ask, never across a block', async () => {
      await followerOf('ann', 'bob');
      await q(
        `UPDATE user_follows SET "acceptedAt" = now() - interval '1 hour' WHERE "followerUserId" = 'ann'`
      );
      await followerOf('cid', 'bob');
      await requests.ask('dan', 'bob'); // still a request
      await followerOf('eve', 'bob');
      await block('eve', 'bob'); // the severing never ran: the row stays, never listed
      await followerOf('bob', 'ann'); // whom bob follows is not his followers

      const mine = await requests.followers('bob', 50, 0);
      expect(mine.map((r) => r.userId)).toEqual(['cid', 'ann']);
      expect((await requests.followers('bob', 1, 1)).map((r) => r.userId)).toEqual(['ann']);
    });

    it('a follower is dated by the ACCEPTANCE, not by the ask', async () => {
      // ann asked a day ago and was accepted now; cid asked and was accepted an hour ago.
      await requests.ask('ann', 'bob');
      await q(
        `UPDATE user_follows SET "createdAt" = now() - interval '1 day' WHERE "followerUserId" = 'ann'`
      );
      await followerOf('cid', 'bob');
      await q(
        `UPDATE user_follows SET "acceptedAt" = now() - interval '1 hour' WHERE "followerUserId" = 'cid'`
      );
      await requests.accept('bob', 'ann');
      const mine = await requests.followers('bob', 50, 0);
      expect(mine.map((r) => r.userId)).toEqual(['ann', 'cid']);
      const { rows } = await q(
        `SELECT "acceptedAt" FROM user_follows WHERE "followerUserId" = 'ann' AND "followedUserId" = 'bob'`
      );
      expect(mine[0].createdAt).toEqual(rows[0].acceptedAt);
    });

    it('removing a follower deletes the follow at once, tells nobody, and they may ask again', async () => {
      await followerOf('ann', 'bob');
      expect(await follows.getFollowedUserIdsForUser('ann')).toEqual(['bob']);
      pushed.length = 0;
      expect(await requests.removeFollower('bob', 'ann')).toEqual({ ok: true });
      expect(await statusOf('ann', 'bob')).toBeNull();
      // Every reader of a follow reads this row (WP-F1): with it gone, the Suivis arm stops here,
      // and the announce sweep and the live push are pinned in reader-spaces and lives specs.
      expect(await follows.getFollowedUserIdsForUser('ann')).toEqual([]);
      // ...and ann's cached Suivis page goes too, as on a block.
      expect(dropped).toEqual([`${POST_LIST_CACHE_PREFIX}*`]);
      expect(pushed).toEqual([]);
      await expect(requests.removeFollower('bob', 'ann')).rejects.toBeInstanceOf(NotFoundException);
      expect((await requests.ask('ann', 'bob')).status).toBe('pending');
    });

    it('a pending request is refused, not removed; and nobody removes a follow that is not theirs', async () => {
      await requests.ask('ann', 'bob');
      await expect(requests.removeFollower('bob', 'ann')).rejects.toBeInstanceOf(NotFoundException);
      expect(await statusOf('ann', 'bob')).toBe('pending');
      await requests.accept('bob', 'ann');
      // ann is bob's follower, not the other way round: ann cannot "remove" bob.
      await expect(requests.removeFollower('ann', 'bob')).rejects.toBeInstanceOf(NotFoundException);
      expect(await statusOf('ann', 'bob')).toBe('accepted');
    });

    it('my sent requests are the unanswered ones I asked, and a withdraw takes one off the list', async () => {
      await requests.ask('ann', 'bob');
      await q(
        `UPDATE user_follows SET "createdAt" = now() - interval '1 hour' WHERE "followedUserId" = 'bob'`
      );
      await requests.ask('ann', 'cid');
      await followerOf('ann', 'dan'); // answered: not a request any more
      await requests.ask('eve', 'ann'); // asked OF ann: her inbox, not her sent list

      expect((await requests.outgoing('ann', 50, 0)).map((r) => r.userId)).toEqual(['cid', 'bob']);
      await requests.leave('ann', 'cid');
      expect((await requests.outgoing('ann', 50, 0)).map((r) => r.userId)).toEqual(['bob']);
    });
  });

  it(`an asker with ${FOLLOW_PENDING_MAX} unanswered requests is refused 409 FOLLOW_PENDING_LIMIT; an existing request still answers`, async () => {
    await q(
      `INSERT INTO user_follows (id, "followerUserId", "followedUserId", status)
       SELECT gen_random_uuid(), 'ann', 'p' || i, 'pending' FROM generate_series(1, $1) i`,
      [FOLLOW_PENDING_MAX]
    );
    const refusal = await refusalOf(requests.ask('ann', 'bob'));
    expect(refusal).toBeInstanceOf(ConflictException);
    expect(codeOf(refusal)).toBe(FOLLOW_CODES.pendingLimit);
    expect(await statusOf('ann', 'bob')).toBeNull();
    expect(pushed).toEqual([]);
    expect(await requests.ask('ann', 'p1')).toEqual({ ok: true, status: 'pending' });
    // One answered or withdrawn, and the asker may ask again.
    await requests.leave('ann', 'p1');
    expect(await requests.ask('ann', 'bob')).toEqual({ ok: true, status: 'pending' });
  });

  it(`an asker who told ${FOLLOW_ASKS_PER_DAY} new people today is refused 429 FOLLOW_DAILY_LIMIT, but may re-ask someone already told`, async () => {
    const tellMany = (age: string) =>
      q(
        `INSERT INTO user_follow_notices ("followerUserId", "followedUserId", kind, "createdAt")
         SELECT 'ann', 'n' || i, 'request', now() - $2::interval FROM generate_series(1, $1) i`,
        [FOLLOW_ASKS_PER_DAY, age]
      );
    await tellMany('1 hour');
    const refusal = await refusalOf(requests.ask('ann', 'bob'));
    expect(refusal).toBeInstanceOf(HttpException);
    expect((refusal as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(codeOf(refusal)).toBe(FOLLOW_CODES.dailyLimit);
    expect(await statusOf('ann', 'bob')).toBeNull();
    // Somebody already told costs no push, so the cap does not apply to them.
    await q(
      `INSERT INTO user_follow_notices ("followerUserId", "followedUserId", kind) VALUES ('ann', 'cid', 'request')`
    );
    expect(await requests.ask('ann', 'cid')).toEqual({ ok: true, status: 'pending' });
    expect(pushed).toEqual([]);
    // A day later the window has moved on.
    await q(`DELETE FROM user_follow_notices WHERE "followedUserId" LIKE 'n%'`);
    await tellMany('25 hours');
    expect(await requests.ask('ann', 'bob')).toEqual({ ok: true, status: 'pending' });
    expect(pushed.map((x) => x.to)).toEqual(['bob']);
  });

  describe('the caps hold under concurrency: one asker, many parallel asks to distinct people', () => {
    /** How many asks run at once - more than the pool's connections, so some wait for one. */
    const PARALLEL = 24;
    const strangers = Array.from({ length: PARALLEL }, (_, i) => `par${i}`);

    beforeAll(async () => {
      for (const id of strangers) {
        await q(`INSERT INTO users (id, "displayName") VALUES ($1, $1) ON CONFLICT DO NOTHING`, [
          id,
        ]);
      }
      // Each written request holds its transaction open a moment after its counts were taken, so
      // asks that are not serialised overlap every time instead of only when the scheduler says so.
      await q(`
        CREATE FUNCTION slow_ask() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(0.05); RETURN NEW; END $$;
        CREATE TRIGGER slow_ask AFTER INSERT ON user_follows
          FOR EACH ROW WHEN (NEW."followedUserId" LIKE 'par%') EXECUTE FUNCTION slow_ask();`);
    });

    afterAll(async () => {
      await q(`DROP TRIGGER slow_ask ON user_follows; DROP FUNCTION slow_ask()`);
    });

    /** Runs every ask at once and sorts the outcomes: written, or the refusal's code. */
    const askAll = async () => {
      const outcomes = await Promise.all(strangers.map((id) => refusalOf(requests.ask('ann', id))));
      return {
        written: outcomes.filter((o) => o === 'written').length,
        codes: [...new Set(outcomes.filter((o) => o !== 'written').map(codeOf))],
      };
    };

    it(`${FOLLOW_PENDING_MAX - 1} unanswered requests and ${PARALLEL} asks at once: exactly one is written`, async () => {
      await q(
        `INSERT INTO user_follows (id, "followerUserId", "followedUserId", status)
         SELECT gen_random_uuid(), 'ann', 'p' || i, 'pending' FROM generate_series(1, $1) i`,
        [FOLLOW_PENDING_MAX - 1]
      );
      const { written, codes } = await askAll();
      expect(written).toBe(1);
      expect(codes).toEqual([FOLLOW_CODES.pendingLimit]);
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM user_follows WHERE "followerUserId" = 'ann' AND status = 'pending'`
      );
      expect(rows[0].n).toBe(FOLLOW_PENDING_MAX);
      expect(pushed).toHaveLength(1);
    });

    it(`${FOLLOW_ASKS_PER_DAY - 1} people told today and ${PARALLEL} asks at once: exactly one more is told`, async () => {
      await q(
        `INSERT INTO user_follow_notices ("followerUserId", "followedUserId", kind, "createdAt")
         SELECT 'ann', 'n' || i, 'request', now() - interval '1 hour' FROM generate_series(1, $1) i`,
        [FOLLOW_ASKS_PER_DAY - 1]
      );
      const { written, codes } = await askAll();
      expect(written).toBe(1);
      expect(codes).toEqual([FOLLOW_CODES.dailyLimit]);
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM user_follow_notices
          WHERE "followerUserId" = 'ann' AND kind = 'request' AND "createdAt" > now() - interval '1 day'`
      );
      expect(rows[0].n).toBe(FOLLOW_ASKS_PER_DAY);
      expect(pushed).toHaveLength(1);
    });
  });

  it('a request hidden by a block does not count against the pending cap', async () => {
    await q(
      `INSERT INTO user_follows (id, "followerUserId", "followedUserId", status)
       SELECT gen_random_uuid(), 'ann', 'p' || i, 'pending' FROM generate_series(1, $1) i`,
      [FOLLOW_PENDING_MAX - 1]
    );
    await requests.ask('ann', 'cid');
    // The severing never ran: the row stays, but the asker no longer sees it, nor can withdraw it.
    await block('cid', 'ann');
    expect(await requests.ask('ann', 'bob')).toEqual({ ok: true, status: 'pending' });
  });

  it('a block that commits DURING the ask retracts the request it wrote, and nobody is told', async () => {
    // The block lands between the insert's check and its commit: a trigger writes it in the
    // insert's own transaction, which is the interleaving a concurrent block can produce.
    await q(`
      CREATE FUNCTION block_during_ask() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO user_blocks ("blockerId", "blockedId") VALUES (NEW."followedUserId", NEW."followerUserId");
        RETURN NEW;
      END $$;
      CREATE TRIGGER block_during_ask AFTER INSERT ON user_follows
        FOR EACH ROW WHEN (NEW."followerUserId" = 'eve') EXECUTE FUNCTION block_during_ask();`);
    try {
      const refusal = await refusalOf(requests.ask('eve', 'bob'));
      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect(codeOf(refusal)).toBe(FOLLOW_CODES.blocked);
      expect(await statusOf('eve', 'bob')).toBeNull();
      expect(pushed).toEqual([]);
      expect(await bellOf('bob')).toEqual([]);
      // Nobody was told, so the notice it claimed goes too: no daily cap charged, no push lost.
      const { rows } = await q(`SELECT 1 FROM user_follow_notices WHERE "followerUserId" = 'eve'`);
      expect(rows).toEqual([]);
    } finally {
      await q(`DROP TRIGGER block_during_ask ON user_follows; DROP FUNCTION block_during_ask()`);
    }
  });

  describe('a claim stands only for a notice sent', () => {
    const noticesOf = async (asker: string) =>
      (
        await q(
          `SELECT "followedUserId" AS p FROM user_follow_notices WHERE "followerUserId" = $1`,
          [asker]
        )
      ).rows.map((r) => r.p as string);

    afterEach(() => jest.restoreAllMocks());

    it('a block landing just before the push releases the claim, and a later ask pushes', async () => {
      // The block commits after the ask's own re-read, before the notification's: the window
      // between them, forced by blocking as the notification's re-read starts.
      const query = ds.query.bind(ds);
      jest
        .spyOn(ds, 'query')
        .mockImplementation(async (sql: string, params?: Parameters<DataSource['query']>[1]) => {
          if (/^\s*SELECT NOT NOT EXISTS/.test(sql)) await block('bob', 'ann');
          return query(sql, params);
        });
      expect(await requests.ask('ann', 'bob')).toEqual({ ok: true, status: 'pending' });
      jest.restoreAllMocks();
      expect(pushed).toEqual([]);
      expect(await noticesOf('ann')).toEqual([]);
      // Lifted, withdrawn and asked again: bob is told, since he never was.
      await q(`DELETE FROM user_blocks`);
      await requests.leave('ann', 'bob');
      await requests.ask('ann', 'bob');
      expect(pushed.map((x) => x.to)).toEqual(['bob']);
      expect(await noticesOf('ann')).toEqual(['bob']);
    });

    it('a notification that throws releases the claim, and a later ask pushes', async () => {
      jest
        .spyOn(PostNotificationsService.prototype, 'createNotification')
        .mockRejectedValueOnce(new Error('notification store down'));
      expect(await requests.ask('ann', 'bob')).toEqual({ ok: true, status: 'pending' });
      expect(pushed).toEqual([]);
      expect(await noticesOf('ann')).toEqual([]);
      await requests.leave('ann', 'bob');
      await requests.ask('ann', 'bob');
      expect(pushed.map((x) => x.to)).toEqual(['bob']);
    });
  });

  it('an acceptance whose block landed after it is written tells nobody', async () => {
    await requests.ask('ann', 'bob');
    pushed.length = 0;
    // The acceptance's UPDATE ran before the block; the push path re-reads it before sending.
    await q(`
      CREATE FUNCTION block_after_accept() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO user_blocks ("blockerId", "blockedId") VALUES (NEW."followerUserId", NEW."followedUserId");
        RETURN NEW;
      END $$;
      CREATE TRIGGER block_after_accept AFTER UPDATE ON user_follows
        FOR EACH ROW EXECUTE FUNCTION block_after_accept();`);
    try {
      expect(await requests.accept('bob', 'ann')).toEqual({ ok: true });
      expect(pushed).toEqual([]);
      expect(await bellOf('ann')).toEqual([]);
    } finally {
      await q(
        `DROP TRIGGER block_after_accept ON user_follows; DROP FUNCTION block_after_accept()`
      );
    }
  });
});
