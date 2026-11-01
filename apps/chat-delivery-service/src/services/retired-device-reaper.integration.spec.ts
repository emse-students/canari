/// <reference types="jest" />

/**
 * THE RETIRED-DEVICE PREDICATE AGAINST A REAL POSTGRESQL - one fixture per clause, so each clause is
 * shown to be load-bearing: a device that fails exactly ONE of them is kept, and only the device that
 * passes all of them is named. Then the cap, a dry run that writes nothing, and an `on` run whose
 * idempotence comes from the ban row it wrote (the purge is stubbed, so the device's queue is STILL
 * there on the second run - and it is still not selected).
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads:
 * skipped without it, and run by the `test-chat-delivery-integration` job in `ci.yml`, which refuses
 * a skip. It builds the seven tables the predicate reads, in their production column types, in a
 * throwaway schema.
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/db bun run test -- retired-device-reaper.integration
 */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { runRetiredDeviceReaper, selectRetiredDevices } from './retired-device-reaper';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const NOW = Date.parse('2026-11-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW - days * DAY);

/** The seven tables, as an estate holds the columns the predicate reads. */
const TABLES = `
  CREATE TABLE auth_sessions (
    id uuid PRIMARY KEY, "userId" varchar(255) NOT NULL, "deviceId" varchar(128),
    "expiresAt" timestamptz NOT NULL);
  CREATE TABLE push_token (
    id uuid PRIMARY KEY, "userId" varchar(255) NOT NULL, "deviceId" varchar NOT NULL,
    token varchar NOT NULL);
  CREATE TABLE revoked_device (
    id varchar(36) PRIMARY KEY, "userId" varchar(255) NOT NULL, "deviceId" varchar NOT NULL,
    "revokedAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, reason varchar(16),
    CONSTRAINT "UQ_revoked_device_user_device" UNIQUE ("userId", "deviceId"));
  CREATE TABLE queued_message (
    id uuid PRIMARY KEY, "recipientId" varchar(255) NOT NULL, "deviceId" varchar NOT NULL,
    "senderDeviceId" varchar, "createdAt" timestamp NOT NULL);
  CREATE TABLE mls_commit_log (
    id uuid PRIMARY KEY, "groupId" uuid NOT NULL, "senderDeviceId" varchar(255),
    "createdAt" timestamp NOT NULL);
  CREATE TABLE key_package (
    id uuid PRIMARY KEY, "userId" varchar(255) NOT NULL, "deviceId" varchar NOT NULL,
    "createdAt" timestamp NOT NULL, UNIQUE ("userId", "deviceId"));
  CREATE TABLE one_time_key_package (
    id uuid PRIMARY KEY, "userId" varchar(255) NOT NULL, "deviceId" varchar NOT NULL,
    "createdAt" timestamp NOT NULL);`;

maybe('retired-device reaper against PostgreSQL', () => {
  const schema = `retired_reaper_it_${Date.now()}`;
  let ds: DataSource;

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const session = (userId: string, deviceId: string, expiresAt = new Date(NOW + 10 * DAY)) =>
    q(`INSERT INTO auth_sessions VALUES ($1, $2, $3, $4)`, [
      randomUUID(),
      userId,
      deviceId,
      expiresAt,
    ]);
  const keyPackage = (userId: string, deviceId: string, createdAt: Date) =>
    q(`INSERT INTO key_package VALUES ($1, $2, $3, $4)`, [
      randomUUID(),
      userId,
      deviceId,
      createdAt,
    ]);
  const queued = (userId: string, deviceId: string, createdAt: Date, senderDeviceId?: string) =>
    q(`INSERT INTO queued_message VALUES ($1, $2, $3, $4, $5)`, [
      randomUUID(),
      userId,
      deviceId,
      senderDeviceId ?? null,
      createdAt,
    ]);

  /**
   * A REPLACED device of `userId`: a queue whose oldest row is 30 days old, an old key package, and
   * a newer device of the same platform with a live session and a key package from 10 days ago.
   * Every clause holds for it - each fixture below then breaks exactly one.
   */
  const replaced = async (userId: string, deviceId: string, newDeviceId = `web-${userId}-new`) => {
    await keyPackage(userId, deviceId, ago(40));
    await queued(userId, deviceId, ago(30));
    await queued(userId, deviceId, ago(1));
    await keyPackage(userId, newDeviceId, ago(10));
    await session(userId, newDeviceId);
  };

  beforeAll(async () => {
    const admin = new DataSource({ type: 'postgres', url: URL });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.destroy();
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      synchronize: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    await q(TABLES);

    // THE ONE THAT QUALIFIES.
    await replaced('u-reap', 'web-u-reap-old');

    // 1. it has a session row - EXPIRED, even: a row still present keeps it.
    await replaced('u-c1', 'web-u-c1-old');
    await session('u-c1', 'web-u-c1-old', ago(2));
    // 2. it has a push token.
    await replaced('u-c2', 'web-u-c2-old');
    await q(`INSERT INTO push_token VALUES ($1, 'u-c2', 'web-u-c2-old', 'tok')`, [randomUUID()]);
    // 3. it is already revoked.
    await replaced('u-c3', 'web-u-c3-old');
    await q(`INSERT INTO revoked_device VALUES ($1, 'u-c3', 'web-u-c3-old', $2, 'retired')`, [
      randomUUID(),
      ago(5),
    ]);
    // 4a. life: it sent a frame that is still queued, 3 days ago.
    await replaced('u-c4a', 'web-u-c4a-old');
    await queued('u-other', 'web-u-other', ago(3), 'web-u-c4a-old');
    // 4b. life: it sent a commit 3 days ago.
    await replaced('u-c4b', 'web-u-c4b-old');
    await q(`INSERT INTO mls_commit_log VALUES ($1, $2, 'web-u-c4b-old', $3)`, [
      randomUUID(),
      randomUUID(),
      ago(3),
    ]);
    // 4c. life: it republished its key package 3 days ago.
    await replaced('u-c4c', 'web-u-c4c-old');
    await q(`UPDATE key_package SET "createdAt" = $1 WHERE "deviceId" = 'web-u-c4c-old'`, [ago(3)]);
    // 4d. life: it published a one-time key package 3 days ago.
    await replaced('u-c4d', 'web-u-c4d-old');
    await q(`INSERT INTO one_time_key_package VALUES ($1, 'u-c4d', 'web-u-c4d-old', $2)`, [
      randomUUID(),
      ago(3),
    ]);
    // 5a. its owner has NO other device.
    await keyPackage('u-c5a', 'web-u-c5a-only', ago(40));
    await queued('u-c5a', 'web-u-c5a-only', ago(30));
    // 5b. the owner's other device is of ANOTHER platform.
    await replaced('u-c5b', 'web-u-c5b-old', 'tauri-u-c5b-phone');
    // 5c. the owner's other device holds only an EXPIRED session.
    await keyPackage('u-c5c', 'web-u-c5c-old', ago(40));
    await queued('u-c5c', 'web-u-c5c-old', ago(30));
    await keyPackage('u-c5c', 'web-u-c5c-new', ago(10));
    await session('u-c5c', 'web-u-c5c-new', ago(1));
    // 5d. the owner's other device's key package is OLDER than this device's oldest queued row.
    await keyPackage('u-c5d', 'web-u-c5d-old', ago(40));
    await queued('u-c5d', 'web-u-c5d-old', ago(30));
    await keyPackage('u-c5d', 'web-u-c5d-new', ago(35));
    await session('u-c5d', 'web-u-c5d-new');
    // 5e. the "other" live device belongs to ANOTHER user.
    await keyPackage('u-c5e', 'web-u-c5e-old', ago(40));
    await queued('u-c5e', 'web-u-c5e-old', ago(30));
    await keyPackage('u-stranger', 'web-u-stranger', ago(10));
    await session('u-stranger', 'web-u-stranger');
  });

  afterAll(async () => {
    if (!ds) return;
    await ds.query(`DROP SCHEMA ${schema} CASCADE`);
    await ds.destroy();
  });

  it('names exactly the replaced device: every clause, failed alone, keeps a device', async () => {
    const selection = await selectRetiredDevices(ds, { now: NOW, cap: 100 });
    expect(selection.candidates.map((c) => c.deviceId)).toEqual(['web-u-reap-old']);
    expect(selection.matched).toBe(1);
    expect(selection.candidates[0]).toMatchObject({ userId: 'u-reap', queuedRows: 2 });
  });

  it('the re-check names the one device asked about, and nothing for a kept one', async () => {
    const yes = await selectRetiredDevices(ds, {
      now: NOW,
      cap: 1,
      only: { userId: 'u-reap', deviceId: 'web-u-reap-old' },
    });
    const no = await selectRetiredDevices(ds, {
      now: NOW,
      cap: 1,
      only: { userId: 'u-c5a', deviceId: 'web-u-c5a-only' },
    });
    expect(yes.candidates.map((c) => c.deviceId)).toEqual(['web-u-reap-old']);
    expect(no.candidates).toEqual([]);
  });

  describe('with three qualifying devices', () => {
    beforeAll(async () => {
      await replaced('u-reap2', 'web-u-reap2-old');
      await replaced('u-reap3', 'web-u-reap3-old');
      // The oldest queue of the three, so a capped run takes it first.
      await queued('u-reap3', 'web-u-reap3-old', ago(60));
    });

    it('the cap bounds the selection, oldest queue first, and `matched` counts past it', async () => {
      const selection = await selectRetiredDevices(ds, { now: NOW, cap: 2 });
      expect(selection.matched).toBe(3);
      expect(selection.candidates.map((c) => c.deviceId)).toEqual([
        'web-u-reap3-old',
        'web-u-reap-old',
      ]);
    });

    it('a dry run writes nothing', async () => {
      const before = await q(`SELECT
        (SELECT count(*) FROM revoked_device)::int AS bans,
        (SELECT count(*) FROM queued_message)::int AS rows,
        (SELECT count(*) FROM key_package)::int AS kps`);
      const messaging = { purgeDeviceFootprint: jest.fn(), notifyDeviceRevoked: jest.fn() };
      const run = await runRetiredDeviceReaper({
        mode: 'dry-run',
        db: ds,
        messaging,
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        now: () => NOW,
      });
      const after = await q(`SELECT
        (SELECT count(*) FROM revoked_device)::int AS bans,
        (SELECT count(*) FROM queued_message)::int AS rows,
        (SELECT count(*) FROM key_package)::int AS kps`);
      expect(run).toMatchObject({ matched: 3, revoked: 0 });
      expect(after).toEqual(before);
      expect(messaging.purgeDeviceFootprint).not.toHaveBeenCalled();
    });

    it('ON bans each as `retired` within the cap, and the ban alone keeps the next run from them', async () => {
      // The purge is stubbed: the queues STAY, so only the ban row can stop a second selection.
      const messaging = {
        purgeDeviceFootprint: jest.fn().mockResolvedValue({
          groupsCleaned: 0,
          keyPackagesDeleted: 0,
          oneTimeKeyPackagesDeleted: 0,
          queuedMessagesDeleted: 0,
          keyGroupsRecorded: 0,
        }),
        notifyDeviceRevoked: jest.fn().mockResolvedValue(false),
      };
      const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const first = await runRetiredDeviceReaper({
        mode: 'on',
        db: ds,
        messaging,
        logger,
        now: () => NOW,
        cap: 2,
      });
      expect(first).toMatchObject({ matched: 3, revoked: 2, failed: 0 });
      const bans = await q(
        `SELECT "deviceId", reason FROM revoked_device WHERE "deviceId" LIKE '%reap%' ORDER BY 1`
      );
      expect(bans).toEqual([
        { deviceId: 'web-u-reap-old', reason: 'retired' },
        { deviceId: 'web-u-reap3-old', reason: 'retired' },
      ]);

      const second = await runRetiredDeviceReaper({
        mode: 'on',
        db: ds,
        messaging,
        logger,
        now: () => NOW,
        cap: 2,
      });
      expect(second).toMatchObject({ matched: 1, revoked: 1 });
      expect(messaging.purgeDeviceFootprint).toHaveBeenLastCalledWith(
        'u-reap2',
        'web-u-reap2-old',
        expect.anything()
      );

      const third = await runRetiredDeviceReaper({
        mode: 'on',
        db: ds,
        messaging,
        logger,
        now: () => NOW,
        cap: 2,
      });
      expect(third).toMatchObject({ matched: 0, revoked: 0 });
      expect(messaging.purgeDeviceFootprint).toHaveBeenCalledTimes(3);
    });
  });
});
