/// <reference types="jest" />

/**
 * THE RETIRED-DEVICE PREDICATE AGAINST A REAL POSTGRESQL - one fixture per clause, so each clause is
 * shown to be load-bearing: a device that fails exactly ONE of them is kept, and only the device that
 * passes all of them is named. Among the kept: a desktop app closed for 8 days, an owner's other
 * device enrolled BEFORE this one but connected yesterday, and a tauri desktop beside a tauri phone -
 * the three cases a review of #2880 showed the first predicate revoking. Then the DAILY budget, read
 * from the ban rows so a second run the same day spends nothing more; a dry run that writes nothing;
 * and idempotence from the ban row (the purge is stubbed, so the queue is STILL there afterwards).
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads:
 * skipped without it, and run by the `test-chat-delivery-integration` job in `ci.yml`, which refuses
 * a skip. It builds the eight tables the predicate reads, in their production column types, in a
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

/** The eight tables, as an estate holds the columns the predicate reads. */
const TABLES = `
  CREATE TABLE auth_sessions (
    id uuid PRIMARY KEY, "userId" varchar(255) NOT NULL, "deviceId" varchar(128),
    "createdAt" timestamptz NOT NULL DEFAULT now(), "expiresAt" timestamptz NOT NULL);
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
    "deviceName" varchar(80), "deviceOs" varchar(32),
    "createdAt" timestamp NOT NULL, UNIQUE ("userId", "deviceId"));
  CREATE TABLE one_time_key_package (
    id uuid PRIMARY KEY, "userId" varchar(255) NOT NULL, "deviceId" varchar NOT NULL,
    "createdAt" timestamp NOT NULL);
  CREATE TABLE device_signature_key (
    id uuid PRIMARY KEY, "userId" varchar(255) NOT NULL, "deviceId" varchar(255) NOT NULL,
    "signatureKey" varchar(44) NOT NULL, "firstSeenAt" timestamp NOT NULL DEFAULT now());`;

/** What one device is, for the fixtures: its key package's metadata, its last connection, its enrolment. */
interface DeviceShape {
  os?: string | null;
  name?: string | null;
  connected?: Date;
  enrolled?: Date | null;
}

maybe('retired-device reaper against PostgreSQL', () => {
  const schema = `retired_reaper_it_${Date.now()}`;
  let ds: DataSource;

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const session = (userId: string, deviceId: string | null, expiresAt = new Date(NOW + 5 * DAY)) =>
    q(`INSERT INTO auth_sessions (id, "userId", "deviceId", "expiresAt") VALUES ($1, $2, $3, $4)`, [
      randomUUID(),
      userId,
      deviceId,
      expiresAt,
    ]);
  const device = async (userId: string, deviceId: string, shape: DeviceShape = {}) => {
    await q(`INSERT INTO key_package VALUES ($1, $2, $3, $4, $5, $6)`, [
      randomUUID(),
      userId,
      deviceId,
      shape.name === undefined ? 'Laptop' : shape.name,
      shape.os === undefined ? 'windows' : shape.os,
      shape.connected ?? ago(120),
    ]);
    if (shape.enrolled !== null) {
      await q(`INSERT INTO device_signature_key VALUES ($1, $2, $3, $4, $5)`, [
        randomUUID(),
        userId,
        deviceId,
        randomUUID().slice(0, 44),
        shape.enrolled ?? ago(150),
      ]);
    }
  };
  const queued = (userId: string, deviceId: string, createdAt: Date, senderDeviceId?: string) =>
    q(`INSERT INTO queued_message VALUES ($1, $2, $3, $4, $5)`, [
      randomUUID(),
      userId,
      deviceId,
      senderDeviceId ?? null,
      createdAt,
    ]);

  /**
   * A REPLACED device: enrolled 150 days ago, last connected 120 days ago, rows queued since 100
   * days ago; and beside it a NEWER device of the same owner, prefix, OS and name, enrolled 95 days
   * ago, connected yesterday, signed in now. Every clause holds - each fixture below breaks one.
   */
  const replaced = async (
    userId: string,
    old: string,
    opts: { old?: DeviceShape; newer?: DeviceShape; newId?: string; oldestQueued?: Date } = {}
  ) => {
    await device(userId, old, opts.old);
    await queued(userId, old, opts.oldestQueued ?? ago(100));
    await queued(userId, old, ago(1));
    const newId = opts.newId ?? `${old.split('-')[0]}-${userId}-new`;
    await device(userId, newId, { connected: ago(1), enrolled: ago(95), ...opts.newer });
    await session(userId, newId);
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
    // 4a. life inside 90 days: it sent a frame that is still queued, 30 days ago.
    await replaced('u-c4a', 'web-u-c4a-old');
    await queued('u-other', 'web-u-other', ago(30), 'web-u-c4a-old');
    // 4b. it sent a commit 30 days ago.
    await replaced('u-c4b', 'web-u-c4b-old');
    await q(`INSERT INTO mls_commit_log VALUES ($1, $2, 'web-u-c4b-old', $3)`, [
      randomUUID(),
      randomUUID(),
      ago(30),
    ]);
    // 4c. THE HOLIDAY: a desktop app left closed for 8 days - no session (7-day idle expiry), no
    //     push token (a desktop never has one), its owner busy on another laptop of the same kind.
    await replaced('u-c4c', 'tauri-u-c4c-desk', {
      old: { connected: ago(8) },
      oldestQueued: ago(8),
      newer: { enrolled: ago(5) },
    });
    // 4d. it published a one-time key package 30 days ago.
    await replaced('u-c4d', 'web-u-c4d-old');
    await q(`INSERT INTO one_time_key_package VALUES ($1, 'u-c4d', 'web-u-c4d-old', $2)`, [
      randomUUID(),
      ago(30),
    ]);
    // 5a. its owner has NO other device.
    await device('u-c5a', 'web-u-c5a-only');
    await queued('u-c5a', 'web-u-c5a-only', ago(100));
    // 5b. the owner's other device has the other id prefix (tauri beside web), same OS and name.
    await replaced('u-c5b', 'web-u-c5b-old', { newId: 'tauri-u-c5b-app' });
    // 5c. the owner's other device holds only an EXPIRED session.
    await device('u-c5c', 'web-u-c5c-old');
    await queued('u-c5c', 'web-u-c5c-old', ago(100));
    await device('u-c5c', 'web-u-c5c-new', { connected: ago(1), enrolled: ago(95) });
    await session('u-c5c', 'web-u-c5c-new', ago(1));
    // 5d. the owner's other device ENROLLED BEFORE this one, and connected yesterday: its key
    //     package is fresh, but a fresh key package is a connection, not an enrolment.
    await replaced('u-c5d', 'web-u-c5d-old', { newer: { enrolled: ago(200) } });
    // 5e. the "other" live device belongs to ANOTHER user.
    await device('u-c5e', 'web-u-c5e-old');
    await queued('u-c5e', 'web-u-c5e-old', ago(100));
    await device('u-stranger', 'web-u-stranger', { connected: ago(1), enrolled: ago(95) });
    await session('u-stranger', 'web-u-stranger');
    // 5f. a tauri DESKTOP beside a tauri PHONE of the same name: same prefix, different OS.
    await replaced('u-c5f', 'tauri-u-c5f-desk', { newer: { os: 'android' } });
    // 5g. same OS, a different device name.
    await replaced('u-c5g', 'web-u-c5g-old', { newer: { name: 'Work laptop' } });
    // 5h. no name was ever set on either: NULL proves nothing.
    await replaced('u-c5h', 'web-u-c5h-old', { old: { name: null }, newer: { name: null } });
    // 5i. the other device has no signature key at all: no enrolment date, no proof.
    await replaced('u-c5i', 'web-u-c5i-old', { newer: { enrolled: null } });
    // 5j. the other device enrolled after this one's oldest row but BEFORE this one's own first key.
    await replaced('u-c5j', 'web-u-c5j-old', {
      oldestQueued: ago(200),
      old: { enrolled: ago(150) },
      newer: { enrolled: ago(170) },
    });
    // 5k. this device has no signature key of its own, and the other device enrolled BEFORE this
    //     one stopped draining: it was there all along, so it replaced nothing.
    await replaced('u-c5k', 'web-u-c5k-old', {
      old: { enrolled: null },
      newer: { enrolled: ago(105) },
    });
  });

  afterAll(async () => {
    if (!ds) return;
    await ds.query(`DROP SCHEMA ${schema} CASCADE`);
    await ds.destroy();
  });

  it('names exactly the replaced device: every clause, failed alone, keeps a device', async () => {
    const selection = await selectRetiredDevices(ds, { now: NOW, limit: 100 });
    expect(selection.candidates.map((c) => c.deviceId)).toEqual(['web-u-reap-old']);
    expect(selection.matched).toBe(1);
    expect(selection.candidates[0]).toMatchObject({ userId: 'u-reap', queuedRows: 2 });
  });

  it('the re-check names the one device asked about, and nothing for a kept one', async () => {
    const yes = await selectRetiredDevices(ds, {
      now: NOW,
      limit: 1,
      only: { userId: 'u-reap', deviceId: 'web-u-reap-old' },
    });
    const no = await selectRetiredDevices(ds, {
      now: NOW,
      limit: 1,
      only: { userId: 'u-c5d', deviceId: 'web-u-c5d-old' },
    });
    expect(yes.candidates.map((c) => c.deviceId)).toEqual(['web-u-reap-old']);
    expect(no.candidates).toEqual([]);
  });

  describe('with three qualifying devices', () => {
    const quietLogger = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });
    const stubMessaging = () => ({
      // The purge is stubbed: the queues STAY, so only the ban row can stop a second selection.
      purgeDeviceFootprint: jest.fn().mockResolvedValue({
        groupsCleaned: 0,
        keyPackagesDeleted: 0,
        oneTimeKeyPackagesDeleted: 0,
        queuedMessagesDeleted: 0,
        keyGroupsRecorded: 0,
      }),
      notifyDeviceRevoked: jest.fn().mockResolvedValue(false),
    });
    const counts = () =>
      q(`SELECT
        (SELECT count(*) FROM revoked_device)::int AS bans,
        (SELECT count(*) FROM queued_message)::int AS rows,
        (SELECT count(*) FROM key_package)::int AS kps`);

    beforeAll(async () => {
      await replaced('u-reap2', 'web-u-reap2-old');
      // The oldest queue of the three, so a limited selection takes it first.
      await replaced('u-reap3', 'web-u-reap3-old', { oldestQueued: ago(110) });
    });

    it('the limit bounds the selection, oldest queue first, and `matched` counts past it', async () => {
      const selection = await selectRetiredDevices(ds, { now: NOW, limit: 2 });
      expect(selection.matched).toBe(3);
      expect(selection.candidates.map((c) => c.deviceId)).toEqual([
        'web-u-reap3-old',
        'web-u-reap-old',
      ]);
    });

    it('a dry run writes nothing', async () => {
      const before = await counts();
      const messaging = stubMessaging();
      const run = await runRetiredDeviceReaper({
        mode: 'dry-run',
        db: ds,
        messaging,
        logger: quietLogger(),
        now: () => NOW,
      });
      expect(run).toMatchObject({ matched: 3, revoked: 0 });
      expect(await counts()).toEqual(before);
      expect(messaging.purgeDeviceFootprint).not.toHaveBeenCalled();
    });

    it('ON spends a DAILY budget read from the ban rows: a restart the same day revokes nothing more', async () => {
      const messaging = stubMessaging();
      // An install retiring its own id an hour ago spent one unit of today's budget of 3.
      await q(`INSERT INTO revoked_device VALUES ($1, 'u-x', 'web-u-x-abandoned', $2, 'retired')`, [
        randomUUID(),
        new Date(NOW - 60 * 60 * 1000),
      ]);
      const run = (at: number) =>
        runRetiredDeviceReaper({
          mode: 'on',
          db: ds,
          messaging,
          logger: quietLogger(),
          now: () => at,
          budget: 3,
        });

      const first = await run(NOW);
      expect(first).toMatchObject({ matched: 3, budgetLeft: 2, revoked: 2, failed: 0 });
      const bans = await q(
        `SELECT "deviceId", reason FROM revoked_device WHERE "deviceId" LIKE '%reap%' ORDER BY 1`
      );
      expect(bans).toEqual([
        { deviceId: 'web-u-reap-old', reason: 'retired' },
        { deviceId: 'web-u-reap3-old', reason: 'retired' },
      ]);

      // The boot sweep after a deploy, an hour later: the budget is spent, nothing is selected.
      const restart = await run(NOW + 60 * 60 * 1000);
      expect(restart).toMatchObject({ budgetLeft: 0, revoked: 0 });
      expect(messaging.purgeDeviceFootprint).toHaveBeenCalledTimes(2);

      // The next day the budget is free again, and the ban rows alone keep the two from the
      // selection - their queues are still there.
      const nextDay = await run(NOW + 2 * DAY);
      expect(nextDay).toMatchObject({ matched: 1, revoked: 1 });
      expect(messaging.purgeDeviceFootprint).toHaveBeenLastCalledWith(
        'u-reap2',
        'web-u-reap2-old',
        expect.anything()
      );
    });

    it('a session of the owner opened since the selection, and bound to no device, keeps the device', async () => {
      await replaced('u-race', 'web-u-race-old');
      // Signed in "now" - at or after the run's selection instant - and not yet bound.
      await q(
        `INSERT INTO auth_sessions (id, "userId", "deviceId", "createdAt", "expiresAt")
         VALUES ($1, 'u-race', NULL, $2, $3)`,
        [randomUUID(), new Date(NOW + 3 * DAY), new Date(NOW + 10 * DAY)]
      );
      const messaging = stubMessaging();
      const run = await runRetiredDeviceReaper({
        mode: 'on',
        db: ds,
        messaging,
        logger: quietLogger(),
        now: () => NOW + 3 * DAY,
        budget: 10,
      });
      expect(run).toMatchObject({ matched: 1, revoked: 0, skipped: 1 });
      expect(messaging.purgeDeviceFootprint).not.toHaveBeenCalled();
    });
  });
});
