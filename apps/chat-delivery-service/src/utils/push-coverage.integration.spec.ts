/// <reference types="jest" />

/**
 * THE PUSH-COVERAGE PREDICATE AGAINST A REAL POSTGRESQL. A phone is counted when it RAN inside the
 * day (its key package reset more than the ladder's grace ago), is not banned, holds a live session
 * of ITS OWN account, and has no push row; a phone whose last stated outcome is `no-token` is counted
 * apart. Each kept device below differs from a counted one by exactly one fact.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, like every chat-delivery integration spec: skipped
 * without it, run by `test-chat-delivery-integration` in `ci.yml`, which refuses a skip.
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/db bun run test -- push-coverage.integration
 */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { reportPushCoverage } from './push-coverage';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const NOW = Date.parse('2026-11-15T20:00:00Z');
const MIN = 60 * 1000;
const ago = (minutes: number) => new Date(NOW - minutes * MIN);

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
  CREATE TABLE key_package (
    id uuid PRIMARY KEY, "userId" varchar(255) NOT NULL, "deviceId" varchar NOT NULL,
    "deviceOs" varchar(32), "deviceAppVersion" varchar(32), "pushOutcome" varchar(32),
    "createdAt" timestamp NOT NULL, UNIQUE ("userId", "deviceId"));`;

maybe('push-coverage predicate against PostgreSQL', () => {
  const schema = `push_coverage_it_${Date.now()}`;
  let ds: DataSource;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** A phone that ran `minutesAgo`, with a live session of its own unless told otherwise. */
  const phone = async (
    userId: string,
    deviceId: string,
    opts: {
      os?: string;
      minutesAgo?: number;
      outcome?: string | null;
      session?: 'own' | 'other-account' | 'expired' | 'none';
      row?: boolean;
      banned?: boolean;
    } = {}
  ) => {
    await q(`INSERT INTO key_package VALUES ($1, $2, $3, $4, '1.7.0', $5, $6)`, [
      randomUUID(),
      userId,
      deviceId,
      opts.os ?? 'android',
      opts.outcome ?? null,
      ago(opts.minutesAgo ?? 60),
    ]);
    const session = opts.session ?? 'own';
    if (session !== 'none') {
      await q(`INSERT INTO auth_sessions VALUES ($1, $2, $3, $4)`, [
        randomUUID(),
        session === 'other-account' ? `${userId}-other` : userId,
        deviceId,
        session === 'expired' ? ago(1) : ago(-60 * 24),
      ]);
    }
    if (opts.row) {
      await q(`INSERT INTO push_token VALUES ($1, $2, $3, 'tok')`, [
        randomUUID(),
        userId,
        deviceId,
      ]);
    }
    if (opts.banned) {
      await q(`INSERT INTO revoked_device VALUES ($1, $2, $3, $4, 'owner')`, [
        randomUUID(),
        userId,
        deviceId,
        ago(5),
      ]);
    }
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

    // COUNTED, withoutPush: ran an hour ago, own live session, no row.
    await phone('u1', 'tauri-u1', { outcome: 'unauthorized:session-expired' });
    // COUNTED, withoutPush: an older build stating nothing.
    await phone('u2', 'tauri-u2', { os: 'ios' });
    // COUNTED, noOsToken: the OS gave it no token - known, counted apart.
    await phone('u3', 'tauri-u3', { outcome: 'no-token' });

    // KEPT: holds its row.
    await phone('u4', 'tauri-u4', { row: true });
    // KEPT: inside the ladder's grace (ran 3 minutes ago).
    await phone('u5', 'tauri-u5', { minutesAgo: 3 });
    // KEPT: last ran two days ago.
    await phone('u6', 'tauri-u6', { minutesAgo: 2 * 24 * 60 });
    // KEPT: a browser.
    await phone('u7', 'web-u7', { os: 'web' });
    // KEPT: banned.
    await phone('u8', 'tauri-u8', { banned: true });
    // KEPT: its session is expired.
    await phone('u9', 'tauri-u9', { session: 'expired' });
    // KEPT: the only live session naming its device id belongs to ANOTHER account.
    await phone('u10', 'tauri-u10', { session: 'other-account' });
    // KEPT: a phone BROWSER - the user agent states the phone's OS, the runtime registers no push
    // (production, 2026-11-22: the whole `1.7.2` line was these).
    await phone('u11', 'web-u11', { os: 'android' });
    await phone('u12', 'web-u12', { os: 'ios' });
  });

  afterAll(async () => {
    await ds?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds?.destroy();
  });

  it('counts the phones that ran and hold no row, the OS-tokenless apart, and writes nothing', async () => {
    const logger = { log: jest.fn(), warn: jest.fn() };
    const rows = await reportPushCoverage(ds, logger, NOW);
    expect(rows).toEqual([
      {
        os: 'android',
        build: '1.7.0',
        devices: 3,
        withoutPush: 1,
        noOsToken: 1,
        // The no-token phone and the one holding its row are not in it: only the unregistered.
        outcomes: ['unauthorized:session-expired'],
      },
      {
        os: 'ios',
        build: '1.7.0',
        devices: 1,
        withoutPush: 1,
        noOsToken: 0,
        outcomes: ['unstated'],
      },
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(await q(`SELECT count(*)::int AS n FROM push_token`)).toEqual([{ n: 1 }]);
  });
});
