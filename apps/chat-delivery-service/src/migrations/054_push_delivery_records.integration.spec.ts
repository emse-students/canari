/// <reference types="jest" />

/**
 * MIGRATION 054 AND THE PUSH DELIVERY RECORD, AGAINST A REAL POSTGRESQL (owner, 2026-11-21: "totals +
 * last delivery"; docs/wiki/services/chat-delivery.md, "Push delivery records"): the table and the two
 * columns land and replay as a no-op; a batch's counts ADD to the day's rows, a failure under its own
 * code; concurrent flushes of overlapping rows all land, none lost to a deadlock; `lastPushSentAt`
 * is stamped on the accepted registrations only and never goes back; `lastPushFetchedAt` on the one
 * that fetched; and an account's erasure takes both dates with the registration.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads:
 * skipped without it, and run by the `test-chat-delivery-integration` job in `ci.yml`, which refuses
 * a skip. The schema before 054 is `push_token` as its entity makes it, minus the two new columns, in
 * a throwaway schema.
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/db bun run test -- 054_push_delivery
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { PushToken } from '../entities/push-token.entity';
import {
  PushDeliveryTally,
  recordPushDeliveries,
  PushDeliveryRecorder,
  recordPushFetches,
} from '../utils/push-delivery-records';
import { deleteAccountPushTokens, deleteStalePushTokens } from '../utils/push-envelope';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '054_push_delivery_records.sql'), 'utf8');

maybe('migration 054 (push delivery records) against PostgreSQL', () => {
  jest.setTimeout(60_000);
  const schema = `push_delivery_it_${Date.now()}`;
  const options = { extra: { options: `-c search_path=${schema}` } };
  let admin: Client;
  let ds: DataSource;
  const logger = new Logger('push-delivery-it');
  let warn: jest.SpyInstance;

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const register = async (userId: string, deviceId: string, platform = 'android') =>
    (
      (await q(
        `INSERT INTO push_token ("userId", "deviceId", token, platform, locale)
         VALUES ($1, $2, 'tok', $3, 'fr') RETURNING id`,
        [userId, deviceId, platform]
      )) as Array<{ id: string }>
    )[0].id;
  const today = async () =>
    (
      (await q(
        `SELECT "kind", "platform", "outcome", "code", "count"::int AS n FROM push_delivery_daily
          WHERE "day" = (now() AT TIME ZONE 'UTC')::date ORDER BY 1, 2, 3, 4`
      )) as Array<{ kind: string; platform: string; outcome: string; code: string; n: number }>
    ).map((r) => `${r.kind}/${r.platform}/${r.outcome}${r.code ? `/${r.code}` : ''}=${r.n}`);
  const datesOf = async (id: string) =>
    (
      (await q(
        `SELECT "lastPushSentAt" AS sent, "lastPushFetchedAt" AS fetched FROM push_token WHERE id = $1`,
        [id]
      )) as Array<{ sent: Date | null; fetched: Date | null }>
    )[0];

  beforeAll(async () => {
    for (const level of ['log', 'debug', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const before = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [PushToken],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      ...options,
    });
    await before.initialize();
    await before.synchronize();
    await before.query(
      `ALTER TABLE push_token DROP COLUMN "lastPushSentAt", DROP COLUMN "lastPushFetchedAt"`
    );
    await before.destroy();
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [PushToken],
      synchronize: false,
      installExtensions: false,
      ...options,
    });
    await ds.initialize();
    // Applied TWICE: the deploy ledger replays a file whose successor failed.
    await q(MIGRATION);
    await q(MIGRATION);
  }, 60_000);

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
    jest.restoreAllMocks();
  }, 60_000);

  beforeEach(async () => {
    warn.mockClear();
    await q('DELETE FROM push_delivery_daily');
    await q('DELETE FROM push_token');
  });

  it('adds both dates as null on an existing registration, and the entity reads them', async () => {
    await register('u1', 'pixel');
    const row = await ds.getRepository(PushToken).findOneByOrFail({ userId: 'u1' });
    expect(row.lastPushSentAt).toBeNull();
    expect(row.lastPushFetchedAt).toBeNull();
  });

  it("adds a batch's counts to the day's rows, a failure under its own code", async () => {
    const a = await register('u1', 'pixel');
    const b = await register('u2', 'iphone', 'ios');
    const batch = () => {
      const tally = new PushDeliveryTally('message');
      tally.attempted({ id: a, platform: 'android' });
      tally.accepted({ id: a, platform: 'android' });
      tally.attempted({ id: b, platform: 'ios' });
      tally.failed({ id: b, platform: 'ios' }, 'messaging/registration-token-not-registered');
      tally.pruned({ id: b, platform: 'ios' });
      return tally;
    };
    await recordPushDeliveries(ds.manager, batch(), logger, 'it-1');
    await recordPushDeliveries(ds.manager, batch(), logger, 'it-2');

    expect(await today()).toEqual([
      'message/android/accepted=2',
      'message/android/attempted=2',
      'message/ios/attempted=2',
      'message/ios/failed/messaging/registration-token-not-registered=2',
      'message/ios/pruned=2',
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('loses no count when many batches over the same rows flush at once', async () => {
    const ids = await Promise.all(['a', 'b', 'c'].map((d) => register('u1', d)));
    const flushes = Array.from({ length: 24 }, (_, i) => {
      const tally = new PushDeliveryTally('social');
      // Each batch meets the devices in a different order; the rows still lock in one.
      const order = i % 2 === 0 ? ids : [...ids].reverse();
      for (const id of order) {
        tally.attempted({ id, platform: i % 3 === 0 ? 'ios' : 'android' });
        tally.accepted({ id, platform: i % 3 === 0 ? 'ios' : 'android' });
      }
      return recordPushDeliveries(ds.manager, tally, logger, `it-${i}`);
    });
    await Promise.all(flushes);

    expect(await today()).toEqual([
      'social/android/accepted=48',
      'social/android/attempted=48',
      'social/ios/accepted=24',
      'social/ios/attempted=24',
    ]);
    // A deadlock would have been one batch's WARN.
    expect(warn).not.toHaveBeenCalled();
  });

  it('stamps lastPushSentAt on the accepted registrations only, and never back in time', async () => {
    const sent = await register('u1', 'pixel');
    const failed = await register('u1', 'tablet');
    const tally = new PushDeliveryTally('message');
    tally.attempted({ id: sent, platform: 'android' });
    tally.accepted({ id: sent, platform: 'android' });
    tally.attempted({ id: failed, platform: 'android' });
    tally.failed({ id: failed, platform: 'android' }, 'messaging/internal-error');
    await recordPushDeliveries(ds.manager, tally, logger, 'it');

    const first = (await datesOf(sent)).sent;
    expect(first).toBeInstanceOf(Date);
    expect((await datesOf(failed)).sent).toBeNull();

    // A later date written by another replica is kept against an earlier transaction's now().
    await q(`UPDATE push_token SET "lastPushSentAt" = now() + interval '1 hour' WHERE id = $1`, [
      sent,
    ]);
    const ahead = (await datesOf(sent)).sent as Date;
    await recordPushDeliveries(ds.manager, tally, logger, 'it');
    expect((await datesOf(sent)).sent).toEqual(ahead);
  });

  it('a registration deleted since the send is simply not stamped, and the rest are', async () => {
    const gone = await register('u1', 'pixel');
    const kept = await register('u2', 'pixel');
    const tally = new PushDeliveryTally('ring');
    for (const id of [gone, kept]) {
      tally.attempted({ id, platform: 'android' });
      tally.accepted({ id, platform: 'android' });
    }
    await q(`DELETE FROM push_token WHERE id = $1`, [gone]);
    await recordPushDeliveries(ds.manager, tally, logger, 'it');
    expect((await datesOf(kept)).sent).toBeInstanceOf(Date);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stamps lastPushFetchedAt on the registration that fetched, and nowhere else', async () => {
    const fetched = await register('u1', 'pixel');
    const other = await register('u1', 'tablet');
    await recordPushFetches(ds.manager, [{ userId: 'u1', deviceId: 'pixel' }], logger, 'wake');
    expect((await datesOf(fetched)).fetched).toBeInstanceOf(Date);
    expect((await datesOf(other)).fetched).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('the recorder folds a burst into few writes, and every count lands', async () => {
    const ids = await Promise.all(['a', 'b'].map((d) => register('u1', d)));
    const recorder = new PushDeliveryRecorder();
    for (let i = 0; i < 50; i++) {
      const tally = new PushDeliveryTally('message');
      tally.attempted({ id: ids[i % 2], platform: 'android' });
      tally.accepted({ id: ids[i % 2], platform: 'android' });
      recorder.record(ds.manager, tally, `burst-${i}`);
      recorder.fetched(ds.manager, 'u1', i % 2 === 0 ? 'a' : 'b', 'wake');
    }
    await recorder.settled();

    expect(await today()).toEqual(['message/android/accepted=50', 'message/android/attempted=50']);
    for (const id of ids) {
      const dates = await datesOf(id);
      expect(dates.sent).toBeInstanceOf(Date);
      expect(dates.fetched).toBeInstanceOf(Date);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('the 90-day sweep deletes exactly the registrations not renewed since the cutoff', async () => {
    const old = await register('u1', 'old');
    const fresh = await register('u2', 'fresh');
    await q(`UPDATE push_token SET "updatedAt" = now() - interval '91 days' WHERE id = $1`, [old]);
    const deleted = await deleteStalePushTokens(
      ds.manager,
      new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    );
    expect(deleted).toBe(1);
    expect(await q(`SELECT id FROM push_token ORDER BY id`)).toEqual([{ id: fresh }]);
  });

  it("an account's erasure takes both dates with its registrations, and leaves the totals", async () => {
    const id = await register('u1', 'pixel');
    const tally = new PushDeliveryTally('social');
    tally.attempted({ id, platform: 'android' });
    tally.accepted({ id, platform: 'android' });
    await recordPushDeliveries(ds.manager, tally, logger, 'it');
    await recordPushFetches(ds.manager, [{ userId: 'u1', deviceId: 'pixel' }], logger, 'wake');

    await deleteAccountPushTokens(ds.manager, 'u1');

    expect(await q(`SELECT 1 FROM push_token WHERE "userId" = 'u1'`)).toEqual([]);
    expect(await today()).toEqual(['social/android/accepted=1', 'social/android/attempted=1']);
  });
});
