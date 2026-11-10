/**
 * THE DAILY CAP ON ENGAGEMENT PUSHES (engagement WP-8) against a REAL PostgreSQL: migration 157 as it
 * ships, chat-delivery's `notification_preference` (its migration 028, the same database), the one
 * claim statement, its seams (`withinPushBudget`, asked by the fan-out, the singular notice and the
 * interactions' own pushes), the GC and the erasure (docs/wiki/engagement.md, "The
 * noise budget - a daily cap from a counter row").
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Locally, against any throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- engagement-push-cap.integration
 */
import { Logger } from '@nestjs/common';
import { Client, Pool } from 'pg';
import {
  CAMPUS_TREND_NOTIFICATION,
  ENGAGEMENT_DAILY_PUSH_CAP,
  claimEngagementPushes,
  pruneEngagementPushDays,
} from './engagement-push-cap';
import { PostNotificationsService } from './post-notifications.service';
import { createEngagementPushCapTables, givePushDevices } from './post-notifications.it-schema';
import { ERASURE_STATEMENTS } from '../internal/account-erasure';
import type { NotificationType, PushOnlyNotificationType } from '../push/notification-client-floor';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

maybe('the daily engagement push cap against PostgreSQL (engagement WP-8)', () => {
  const schema = `cap_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let pool: Pool;
  /** What the service and the claim are handed: rows, as TypeORM's `manager.query` answers. */
  const manager = {
    query: (sql: string, params?: unknown[]) => pool.query(sql, params).then((r) => r.rows),
  };
  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
  const counter = async (userId: string): Promise<number | null> =>
    (await q(`SELECT pushed FROM engagement_push_days WHERE "userId" = $1`, [userId])).rows[0]
      ?.pushed ?? null;

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}, public`);
    await createEngagementPushCapTables((sql) => q(sql));
    // Every reader the cases name has a device of unknown build, which every floor keeps.
    await givePushDevices(q, ['r', 's', 'a', 'b', 'c', 'd', 'off', 'other', 'full', 'fresh']);
    pool = new Pool({ connectionString: URL, max: 8, options: `-c search_path=${schema},public` });
  });

  afterAll(async () => {
    await pool?.end();
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await q(`TRUNCATE engagement_push_days, notification_preference`);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  /** `n` times `x`. */
  const times = <T>(n: number, x: T): T[] => Array.from({ length: n }, () => x);

  it('the claim past the cap is refused, the ones before it are taken', async () => {
    const answers: boolean[] = [];
    for (let i = 0; i <= ENGAGEMENT_DAILY_PUSH_CAP; i++) {
      answers.push((await claimEngagementPushes(manager, ['r'], 'posts')).has('r'));
    }
    expect(answers).toEqual([...times(ENGAGEMENT_DAILY_PUSH_CAP, true), false]);
    expect(await counter('r')).toBe(ENGAGEMENT_DAILY_PUSH_CAP);
  });

  it("a type's floor is asked before a unit is spent: a reader whose every device is too old spends none", async () => {
    // campus_trend's floor is 1.6.10: `old` runs 1.6.9 only, `mixed` has a 1.6.9 and a 1.6.10-alpha.1,
    // `unknown` never reported its build (kept, as chat-delivery keeps it), `none` has no device.
    await givePushDevices(q, ['old'], '1.6.9');
    await givePushDevices(q, ['mixed'], '1.6.9');
    await q(`INSERT INTO push_token ("userId", "deviceId") VALUES ('mixed', 'd2')`);
    await q(
      `INSERT INTO key_package ("userId", "deviceId", "deviceAppVersion") VALUES ('mixed', 'd2', '1.6.10-alpha.1')`
    );
    await givePushDevices(q, ['unknown'], 'garbage');
    const allowed = await claimEngagementPushes(
      manager,
      ['old', 'mixed', 'unknown', 'none'],
      'suggestions',
      '1.6.10'
    );
    expect([...allowed].sort()).toEqual(['mixed', 'unknown']);
    expect(await counter('old')).toBeNull();
    expect(await counter('none')).toBeNull();
    // With no floor, every device counts - and so does a reader with none, as before.
    expect([...(await claimEngagementPushes(manager, ['old'], 'reactions'))]).toEqual(['old']);
  });

  it('two dozen concurrent fan-outs over the same readers never exceed the cap', async () => {
    const readers = ['a', 'b', 'c', 'd'];
    // Each fan-out names the readers in its own order, one of them twice: one lock order, DISTINCT.
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        claimEngagementPushes(
          manager,
          i % 2 ? [...readers].reverse().concat('a') : readers,
          'posts'
        )
      )
    );
    for (const r of readers) {
      expect(results.filter((s) => s.has(r))).toHaveLength(ENGAGEMENT_DAILY_PUSH_CAP);
      expect(await counter(r)).toBe(ENGAGEMENT_DAILY_PUSH_CAP);
    }
  });

  it('a reader who switched the category off is never counted', async () => {
    await q(
      `INSERT INTO notification_preference ("userId", "disabledCategories")
       VALUES ('off', '["posts"]'), ('other', '["comments"]')`
    );
    const allowed = await claimEngagementPushes(manager, ['off', 'other'], 'posts');
    expect([...allowed]).toEqual(['other']);
    expect(await counter('off')).toBeNull();
  });

  it('the GC deletes the rows older than a week and keeps the rest; the erasure takes a reader', async () => {
    await q(
      `INSERT INTO engagement_push_days ("userId", day, pushed) VALUES
         ('old', (now() AT TIME ZONE 'Europe/Paris')::date - 8, 3),
         ('week', (now() AT TIME ZONE 'Europe/Paris')::date - 7, 3),
         ('today', (now() AT TIME ZONE 'Europe/Paris')::date, 2)`
    );
    expect(await pruneEngagementPushDays(manager)).toBe(1);
    const left = await q(`SELECT "userId" FROM engagement_push_days ORDER BY 1`);
    expect(left.rows.map((r) => r.userId)).toEqual(['today', 'week']);

    const erase = ERASURE_STATEMENTS.find((s) => s.label === 'engagement_push_days')!;
    await q(erase.sql, ['today']);
    expect(await counter('today')).toBeNull();
  });

  describe('the seams: the fan-out, the singular notice, and the interactions', () => {
    const pushed: string[] = [];

    function service(): PostNotificationsService {
      const notifRepo = {
        manager,
        create: (row: unknown) => row,
        save: (row: unknown) => Promise.resolve(row),
      };
      const postRepo = { manager };
      const push = {
        notifyContent: (userId: string) => {
          pushed.push(userId);
          return Promise.resolve();
        },
      };
      return new PostNotificationsService(
        notifRepo as never,
        postRepo as never,
        push as never,
        { withheldAmong: () => Promise.resolve(new Set<string>()) } as never
      );
    }

    const notice = (type: NotificationType | PushOnlyNotificationType, recipientIds: string[]) => ({
      recipientIds,
      type,
      actorId: 'actor',
      actorName: 'Actor',
      text: 'hello',
    });
    /** The singular path (`createNotification`): a reaction, a comment, an opening. */
    const single = (svc: PostNotificationsService, type: NotificationType) =>
      svc.createNotification({
        recipientId: 'r',
        type,
        postId: 'p',
        actorId: 'actor',
        actorName: 'Actor',
        text: type === 'reaction' ? 'Rire' : 'hello',
      });

    /** The fan-out is fire-and-forget: let its sends land. */
    const settle = () => new Promise((r) => setTimeout(r, 20));

    beforeEach(() => {
      pushed.length = 0;
    });

    it('the counted push past the cap reaches the bell only, not the phone', async () => {
      const svc = service();
      for (let i = 0; i <= ENGAGEMENT_DAILY_PUSH_CAP; i++) {
        await svc.pushNotice(notice(CAMPUS_TREND_NOTIFICATION, ['r']));
      }
      await settle();
      expect(pushed).toEqual(times(ENGAGEMENT_DAILY_PUSH_CAP, 'r'));
      expect(await counter('r')).toBe(ENGAGEMENT_DAILY_PUSH_CAP);
    });

    it('ONE budget across every counted kind: a trend, a reaction and a comment spend it, an opening finds it gone', async () => {
      const svc = service();
      await svc.pushNotice(notice(CAMPUS_TREND_NOTIFICATION, ['r']));
      await single(svc, 'reaction');
      await single(svc, 'comment');
      await single(svc, 'booking_open');
      await single(svc, 'event_open');
      await svc.pushNotice(notice('followed_post', ['r']));
      await svc.pushNotice(notice('member_repost', ['r']));
      await settle();
      expect(pushed).toEqual(times(ENGAGEMENT_DAILY_PUSH_CAP, 'r'));
      expect(await counter('r')).toBe(ENGAGEMENT_DAILY_PUSH_CAP);
    });

    it('a birthday and an association post beyond the cap still push, and so does every uncounted kind', async () => {
      const svc = service();
      for (let i = 0; i < ENGAGEMENT_DAILY_PUSH_CAP; i++) await single(svc, 'reaction');
      await settle();
      expect(pushed).toHaveLength(ENGAGEMENT_DAILY_PUSH_CAP);
      const uncounted = [
        'birthday',
        'birthday',
        'association_post',
        'association_post',
        'association_repost',
        'live_started',
        'mention',
        'live_mention',
        'follow_request',
        'booking_reminder',
      ] as const;
      for (const type of uncounted) await svc.pushNotice(notice(type, ['r']));
      for (const type of ['reply', 'mention', 'follow_accepted', 'booking_changed'] as const) {
        await single(svc, type);
      }
      await settle();
      // Every uncounted push went out, the cap already spent, and none of them touched the counter.
      expect(pushed).toHaveLength(ENGAGEMENT_DAILY_PUSH_CAP + uncounted.length + 4);
      expect(await counter('r')).toBe(ENGAGEMENT_DAILY_PUSH_CAP);
    });

    it('an uncounted push never writes a counter row', async () => {
      const svc = service();
      await svc.pushNotice(notice('association_post', ['r', 's']));
      await svc.pushNotice(notice('birthday', ['r']));
      await single(svc, 'mention');
      await settle();
      expect(pushed.sort()).toEqual(['r', 'r', 'r', 's']);
      expect((await q(`SELECT count(*)::int AS n FROM engagement_push_days`)).rows[0].n).toBe(0);
    });

    it('withinPushBudget answers the readers left, in ONE line per call', async () => {
      const svc = service();
      const log = jest.spyOn(Logger.prototype, 'log');
      log.mockClear();
      await q(
        `INSERT INTO engagement_push_days ("userId", day, pushed)
         VALUES ('full', (now() AT TIME ZONE 'Europe/Paris')::date, $1)`,
        [ENGAGEMENT_DAILY_PUSH_CAP]
      );
      expect(await svc.withinPushBudget('reaction', ['full', 'fresh', 'r'])).toEqual([
        'fresh',
        'r',
      ]);
      expect(log.mock.calls.map(([m]) => String(m))).toEqual([
        expect.stringContaining('type=reaction withheld 1 of 3'),
      ]);
      // An uncounted type is answered untouched, with no statement and no line.
      expect(await svc.withinPushBudget('birthday', ['full'])).toEqual(['full']);
      expect(log).toHaveBeenCalledTimes(1);
    });

    it('a failed claim pushes nobody and reaches the caller', async () => {
      const svc = service();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const broken = { query: () => Promise.reject(new Error('db down')) };
      (svc as unknown as { notifRepo: { manager: unknown } }).notifRepo.manager = broken;
      await expect(svc.pushNotice(notice(CAMPUS_TREND_NOTIFICATION, ['r']))).rejects.toThrow(
        'db down'
      );
      await settle();
      expect(pushed).toEqual([]);
    });
  });
});
