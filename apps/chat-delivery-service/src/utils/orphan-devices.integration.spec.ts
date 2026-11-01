/// <reference types="jest" />

/**
 * THE ORPHAN-DEVICE PREDICATE AGAINST A REAL POSTGRESQL: a device is an orphan only when it holds
 * queued rows AND has no session row (of any age), no push token, no active ban and no life in the
 * last 7 days (a key package, a one-time key package, a commit or a frame sent). Each kept device
 * below differs from a counted one by exactly one fact. The count, the hand procedure's allowlist and
 * its per-device re-check are asked the same question, and none of them writes.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads:
 * skipped without it, and run by the `test-chat-delivery-integration` job in `ci.yml`, which refuses
 * a skip. It builds the tables the predicate reads, in their production column types, in a
 * throwaway schema.
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/db bun run test -- orphan-devices.integration
 */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  ORPHAN_DEVICE_LIST_SQL,
  ORPHAN_DEVICE_RECHECK_SQL,
  orphanDeviceParams,
  reportOrphanDevices,
} from './orphan-devices';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const NOW = Date.parse('2026-11-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW - days * DAY);

const TABLES = `
  CREATE TABLE auth_sessions (
    id uuid PRIMARY KEY, "userId" varchar(255) NOT NULL, "deviceId" varchar(128),
    "expiresAt" timestamptz NOT NULL);
  CREATE TABLE push_token (
    id uuid PRIMARY KEY, "userId" varchar(255) NOT NULL, "deviceId" varchar NOT NULL,
    token varchar NOT NULL, UNIQUE ("userId", "deviceId"));
  CREATE TABLE revoked_device (
    id varchar(36) PRIMARY KEY, "userId" varchar(255) NOT NULL, "deviceId" varchar NOT NULL,
    "revokedAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, reason varchar(16),
    CONSTRAINT "UQ_revoked_device_user_device" UNIQUE ("userId", "deviceId"));
  CREATE TABLE queued_message (
    id uuid PRIMARY KEY, "recipientId" varchar(255) NOT NULL, "deviceId" varchar NOT NULL,
    "senderDeviceId" varchar, "createdAt" timestamp NOT NULL);
  CREATE TABLE key_package (
    id uuid PRIMARY KEY, "userId" varchar(255) NOT NULL, "deviceId" varchar NOT NULL,
    "createdAt" timestamp NOT NULL, UNIQUE ("userId", "deviceId"));
  CREATE TABLE one_time_key_package (
    id uuid PRIMARY KEY, "userId" varchar(255) NOT NULL, "deviceId" varchar NOT NULL,
    "createdAt" timestamp NOT NULL);
  CREATE TABLE mls_commit_log (
    id uuid PRIMARY KEY, "groupId" uuid NOT NULL, "senderDeviceId" varchar,
    "createdAt" timestamp NOT NULL);`;

maybe('orphan-device predicate against PostgreSQL', () => {
  const schema = `orphan_devices_it_${Date.now()}`;
  let ds: DataSource;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const queued = async (userId: string, deviceId: string, rows: number) => {
    for (let i = 0; i < rows; i++) {
      await q(`INSERT INTO queued_message VALUES ($1, $2, $3, 'other-device', $4)`, [
        randomUUID(),
        userId,
        deviceId,
        ago(2),
      ]);
    }
  };
  const keyPackage = (userId: string, deviceId: string, createdAt: Date) =>
    q(`INSERT INTO key_package VALUES ($1, $2, $3, $4)`, [
      randomUUID(),
      userId,
      deviceId,
      createdAt,
    ]);
  const counts = () =>
    q(`SELECT
      (SELECT count(*) FROM queued_message)::int AS rows,
      (SELECT count(*) FROM revoked_device)::int AS bans`);

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

    // COUNTED: an orphan that connected 20 days ago - inside the GC's window, nothing else takes it.
    await queued('u1', 'web-u1-a', 3);
    await keyPackage('u1', 'web-u1-a', ago(20));
    // COUNTED: an orphan silent for 120 days - the GC's own, so outside `insideGcWindow`.
    await queued('u2', 'tauri-u2-a', 2);
    await keyPackage('u2', 'tauri-u2-a', ago(120));
    // COUNTED: an orphan with no key package at all, whose last commit is 8 days old.
    await queued('u3', 'web-u3-a', 1);
    await q(`INSERT INTO mls_commit_log VALUES ($1, $2, 'web-u3-a', $3)`, [
      randomUUID(),
      randomUUID(),
      ago(8),
    ]);

    // KEPT: a session row - expired, even: a row still present is not an orphan.
    await queued('u4', 'web-u4-a', 5);
    await q(`INSERT INTO auth_sessions VALUES ($1, 'u4', 'web-u4-a', $2)`, [randomUUID(), ago(1)]);
    // KEPT: a push token.
    await queued('u5', 'tauri-u5-a', 5);
    await q(`INSERT INTO push_token VALUES ($1, 'u5', 'tauri-u5-a', 'tok')`, [randomUUID()]);
    // KEPT: revoked.
    await queued('u6', 'web-u6-a', 5);
    await q(`INSERT INTO revoked_device VALUES ($1, 'u6', 'web-u6-a', $2, 'retired')`, [
      randomUUID(),
      ago(1),
    ]);
    // KEPT: no queued row - nothing to drain.
    await keyPackage('u7', 'web-u7-a', ago(20));
    // KEPT, life: a key package published 3 days ago.
    await queued('u8', 'web-u8-a', 5);
    await keyPackage('u8', 'web-u8-a', ago(3));
    // KEPT, life: a one-time key package published 3 days ago.
    await queued('u9', 'web-u9-a', 5);
    await q(`INSERT INTO one_time_key_package VALUES ($1, 'u9', 'web-u9-a', $2)`, [
      randomUUID(),
      ago(3),
    ]);
    // KEPT, life: a commit 3 days ago.
    await queued('u10', 'web-u10-a', 5);
    await q(`INSERT INTO mls_commit_log VALUES ($1, $2, 'web-u10-a', $3)`, [
      randomUUID(),
      randomUUID(),
      ago(3),
    ]);
    // KEPT, life: a frame it sent 3 days ago, still queued for someone else.
    await queued('u11', 'web-u11-a', 5);
    await q(`INSERT INTO queued_message VALUES ($1, 'u1', 'web-u1-b', 'web-u11-a', $2)`, [
      randomUUID(),
      ago(3),
    ]);
  });

  afterAll(async () => {
    if (!ds) return;
    await ds.query(`DROP SCHEMA ${schema} CASCADE`);
    await ds.destroy();
  });

  it('counts the orphans, sums their rows, and splits off the ones the GC cannot reach', async () => {
    const logger = { log: jest.fn() };
    const before = await counts();
    const count = await reportOrphanDevices(ds, logger, NOW);
    // `web-u1-b` (the frame u11 sent) is an orphan too: one row, no session, no life.
    expect(count).toEqual({ devices: 4, rows: 7, insideGcWindow: 1 });
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[ORPHAN_DEVICES\] devices=4 rows=7 insideGcWindow=1 /)
    );
    expect(await counts()).toEqual(before);
  });

  it('the allowlist names exactly what the count counts', async () => {
    const list = await q(ORPHAN_DEVICE_LIST_SQL, orphanDeviceParams(NOW));
    expect(list.map((r: { deviceId: string }) => r.deviceId)).toEqual([
      'web-u1-a',
      'web-u1-b',
      'tauri-u2-a',
      'web-u3-a',
    ]);
  });

  it('the re-check answers 1 for an orphan and 0 for a device that showed life', async () => {
    const recheck = async (userId: string, deviceId: string) =>
      (await q(ORPHAN_DEVICE_RECHECK_SQL, [...orphanDeviceParams(NOW), userId, deviceId]))[0]
        .orphan as number;
    expect(await recheck('u1', 'web-u1-a')).toBe(1);
    expect(await recheck('u8', 'web-u8-a')).toBe(0);
    expect(await recheck('u4', 'web-u4-a')).toBe(0);
  });
});
