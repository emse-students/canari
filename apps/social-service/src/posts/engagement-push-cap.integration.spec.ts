/**
 * THE DAILY CAP ON ENGAGEMENT PUSHES (engagement WP-8) against a REAL PostgreSQL: migration 157 as it
 * ships, chat-delivery's `notification_preference` (its migration 028, the same database), the one
 * claim statement, the seam in `fanOutPush`, the GC and the erasure (docs/wiki/engagement.md, "The
 * noise budget - a daily cap from a counter row").
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Locally, against any throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- engagement-push-cap.integration
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { Client, Pool } from 'pg';
import {
  CAMPUS_TREND_NOTIFICATION,
  ENGAGEMENT_DAILY_PUSH_CAP,
  FRIEND_COMMENT_NOTIFICATION,
  FRIEND_REACTION_NOTIFICATION,
  claimEngagementPushes,
  pruneEngagementPushDays,
} from './engagement-push-cap';
import { PostNotificationsService } from './post-notifications.service';
import { ERASURE_STATEMENTS } from '../internal/account-erasure';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (...path: string[]) => readFileSync(join(__dirname, '..', ...path), 'utf8');

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
    await q(migration('migrations', '157_engagement_push_days.sql'));
    await q(
      readFileSync(
        join(
          __dirname,
          '../../../chat-delivery-service/src/migrations/028_notification_preferences.sql'
        ),
        'utf8'
      )
    );
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

  it('the 6th claim of a day is refused, the first five are taken', async () => {
    const answers: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      answers.push((await claimEngagementPushes(manager, ['r'], 'posts')).has('r'));
    }
    expect(answers).toEqual([true, true, true, true, true, false]);
    expect(await counter('r')).toBe(ENGAGEMENT_DAILY_PUSH_CAP);
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
         ('old', (now() AT TIME ZONE 'Europe/Paris')::date - 8, 5),
         ('week', (now() AT TIME ZONE 'Europe/Paris')::date - 7, 5),
         ('today', (now() AT TIME ZONE 'Europe/Paris')::date, 2)`
    );
    expect(await pruneEngagementPushDays(manager)).toBe(1);
    const left = await q(`SELECT "userId" FROM engagement_push_days ORDER BY 1`);
    expect(left.rows.map((r) => r.userId)).toEqual(['today', 'week']);

    const erase = ERASURE_STATEMENTS.find((s) => s.label === 'engagement_push_days')!;
    await q(erase.sql, ['today']);
    expect(await counter('today')).toBeNull();
  });

  describe('the seam in fanOutPush', () => {
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

    const notice = (type: string, recipientIds: string[]) => ({
      recipientIds,
      type,
      actorId: 'actor',
      actorName: 'Actor',
      text: 'hello',
    });

    /** The fan-out is fire-and-forget: let its sends land. */
    const settle = () => new Promise((r) => setTimeout(r, 20));

    beforeEach(() => {
      pushed.length = 0;
    });

    it('the 6th capped push of a day reaches the bell only, not the phone', async () => {
      const svc = service();
      for (let i = 0; i < 6; i++) {
        await svc.pushNotice(notice(CAMPUS_TREND_NOTIFICATION, ['r']));
      }
      await settle();
      expect(pushed).toEqual(['r', 'r', 'r', 'r', 'r']);
      expect(await counter('r')).toBe(5);
    });

    it('an association post, a live, an opening and a mention on the same day are never counted', async () => {
      const svc = service();
      for (let i = 0; i < 5; i++) await svc.pushNotice(notice(CAMPUS_TREND_NOTIFICATION, ['r']));
      for (const type of ['association_post', 'live_started', 'booking_open', 'event_open']) {
        await svc.pushNotice(notice(type, ['r']));
      }
      await svc.pushNotice(notice('mention', ['r']));
      await settle();
      // Five capped pushes, then every uncapped one went out, the cap already spent.
      expect(pushed).toHaveLength(10);
      expect(await counter('r')).toBe(5);
    });

    it('friend activity beyond 5 in a day still pushes, and never spends the budget (amended 2026-11-10)', async () => {
      const svc = service();
      for (let i = 0; i < 4; i++) {
        await svc.pushNotice(notice(FRIEND_REACTION_NOTIFICATION, ['r']));
        await svc.pushNotice(notice(FRIEND_COMMENT_NOTIFICATION, ['r']));
      }
      await settle();
      expect(pushed).toHaveLength(8);
      expect(await counter('r')).toBeNull();
      // The followed account's activity left the whole budget to what the reader does not follow.
      for (let i = 0; i < 6; i++) await svc.pushNotice(notice(CAMPUS_TREND_NOTIFICATION, ['r']));
      await settle();
      expect(pushed).toHaveLength(13);
      expect(await counter('r')).toBe(ENGAGEMENT_DAILY_PUSH_CAP);
    });

    it('an uncapped push never writes a counter row', async () => {
      const svc = service();
      await svc.pushNotice(notice('association_post', ['r', 's']));
      await svc.pushNotice(notice('mention', ['r']));
      await settle();
      expect(pushed.sort()).toEqual(['r', 'r', 's']);
      expect((await q(`SELECT count(*)::int AS n FROM engagement_push_days`)).rows[0].n).toBe(0);
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
