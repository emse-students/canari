/// <reference types="jest" />

/**
 * TWO REGISTRATIONS OF ONE DEVICE, AT ONCE, AGAINST A REAL POSTGRESQL.
 *
 * Production 2026-11-07 (`1.6.6`): two `register-device` requests for the same user and device
 * started in the same millisecond. The handler read the `key_package` row, found none in both, and
 * inserted twice; the second insert hit `UNIQUE ("userId", "deviceId")` and answered 500. The write
 * is now ONE `INSERT ... ON CONFLICT DO UPDATE` ({@link upsertDeviceKeyPackage}). Here both calls
 * are made to OVERLAP for certain - a second session holds an uncommitted insert of the same pair,
 * and both registrations are proven blocked behind it before it commits - then both must succeed,
 * leave one row, and leave the state a sequential re-registration leaves. The column semantics of
 * a re-registration (what is overwritten, what is kept) are pinned beside it.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads:
 * skipped without it, and run by the `test-chat-delivery-integration` job in `ci.yml`, which refuses
 * a skip. The tables are the entities' own, in a throwaway schema.
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/db bun run test -- device-key-package.integration
 */
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { DevicesController } from '../controllers/devices.controller';
import type { MessagingService } from '../services/messaging.service';
import { upsertDeviceKeyPackage } from './device-key-package';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

type Row = {
  id: string;
  keyPackage: string;
  notAfter: Date | null;
  deviceName: string | null;
  deviceOs: string | null;
  deviceAppVersion: string | null;
  createdAt: Date;
};

maybe('register-device writes its key package row in one statement (PostgreSQL)', () => {
  jest.setTimeout(60_000);
  const schema = `device_key_package_it_${Date.now()}`;
  let admin: Client;
  let ds: DataSource;
  let controller: DevicesController;

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const rowsOf = async (userId: string, deviceId: string): Promise<Row[]> =>
    (await q(
      `SELECT id, "keyPackage", "notAfter", "deviceName", "deviceOs", "deviceAppVersion",
              "createdAt"
         FROM key_package WHERE "userId" = $1 AND "deviceId" = $2`,
      [userId, deviceId]
    )) as Row[];

  /** A second session on the same schema, to hold the unique entry the registrations must wait on. */
  const connect = async () => {
    const client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`SET search_path TO ${schema}`);
    return client;
  };
  /**
   * Resolves once `count` sessions are blocked BEHIND `holder` (transitively): the proof that the
   * operations under test overlap. Polled, never timed - jest's own timeout ends a hang.
   */
  const untilBlockedBy = async (holder: Client, count: number) => {
    const [{ pid }] = (await holder.query(`SELECT pg_backend_pid() AS pid`)).rows as Array<{
      pid: number;
    }>;
    for (;;) {
      const [{ waiting }] = (
        await admin.query(
          `WITH RECURSIVE behind AS (
             SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
             UNION
             SELECT a.pid FROM pg_stat_activity a JOIN behind b ON b.pid = ANY(pg_blocking_pids(a.pid))
           )
           SELECT count(*)::int AS waiting FROM behind`,
          [pid]
        )
      ).rows as Array<{ waiting: number }>;
      if (waiting >= count) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [
        KeyPackage,
        OneTimeKeyPackage,
        GroupMember,
        Group,
        DeviceGroupMembership,
        PushToken,
        RevokedDevice,
      ],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    await ds.synchronize();
    controller = new DevicesController(
      ds.getRepository(KeyPackage),
      ds.getRepository(OneTimeKeyPackage),
      ds.getRepository(GroupMember),
      ds.getRepository(Group),
      ds.getRepository(DeviceGroupMembership),
      ds.getRepository(PushToken),
      ds.getRepository(RevokedDevice),
      {} as unknown as Redis,
      ds,
      {} as unknown as MessagingService,
      { record: async () => undefined } as never
    );
  });

  afterAll(async () => {
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
    await ds?.destroy();
    jest.restoreAllMocks();
  });

  it('two registrations of a NEW device that overlap both succeed and leave one row', async () => {
    const holder = await connect();
    let calls: Array<Promise<unknown>>;
    try {
      await holder.query('BEGIN');
      // An uncommitted insert of the same pair: every write of it now waits on this transaction.
      await holder.query(
        `INSERT INTO key_package (id, "userId", "deviceId", "keyPackage", "createdAt")
         VALUES ($1, 'u1', 'web-u1-new', 'held', now())`,
        [randomUUID()]
      );
      calls = [
        controller.registerDevice(
          { userId: 'u1', deviceId: 'web-u1-new', keyPackage: 'kp-a', deviceOs: 'android' },
          'u1'
        ),
        controller.registerDevice(
          { userId: 'u1', deviceId: 'web-u1-new', keyPackage: 'kp-b', deviceOs: 'android' },
          'u1'
        ),
      ];
      await untilBlockedBy(holder, 2);
      // Rolled back: the two registrations were both waiting on a row that never exists, so both
      // go on to INSERT - the exact shape of production's two "no row yet" reads.
      await holder.query('ROLLBACK');
    } finally {
      await holder.end();
    }

    await expect(Promise.all(calls)).resolves.toEqual([
      { status: 'registered' },
      { status: 'registered' },
    ]);
    const rows = await rowsOf('u1', 'web-u1-new');
    expect(rows).toHaveLength(1);
    // The later of the two is kept, as two sequential calls would leave it.
    expect(['kp-a', 'kp-b']).toContain(rows[0].keyPackage);
    expect(rows[0].deviceOs).toBe('android');
  });

  it('two overlapping RE-registrations both succeed, and exactly one of the upserts created the row', async () => {
    const holder = await connect();
    let writes: Array<Promise<{ inserted: boolean }>>;
    try {
      await holder.query('BEGIN');
      await holder.query(
        `INSERT INTO key_package (id, "userId", "deviceId", "keyPackage", "createdAt")
         VALUES ($1, 'u1', 'web-u1-held', 'first', now())`,
        [randomUUID()]
      );
      const write = (keyPackage: string) =>
        upsertDeviceKeyPackage(
          ds,
          { userId: 'u1', deviceId: 'web-u1-held', keyPackage, notAfter: null },
          randomUUID()
        );
      writes = [write('kp-a'), write('kp-b')];
      await untilBlockedBy(holder, 2);
      // Committed: the row exists, so both waiting writes become updates of it.
      await holder.query('COMMIT');
    } finally {
      await holder.end();
    }

    const outcomes = await Promise.all(writes);
    expect(outcomes).toEqual([{ inserted: false }, { inserted: false }]);
    const rows = await rowsOf('u1', 'web-u1-held');
    expect(rows).toHaveLength(1);
    expect(['kp-a', 'kp-b']).toContain(rows[0].keyPackage);
  });

  it('a re-registration overwrites the package, its date and createdAt, and keeps what it does not carry', async () => {
    const first = await upsertDeviceKeyPackage(
      ds,
      {
        userId: 'u2',
        deviceId: 'd2',
        keyPackage: 'old',
        notAfter: new Date('2027-01-01T00:00:00Z'),
        deviceName: 'Pixel',
        deviceOs: 'android',
        deviceAppVersion: '1.6.5',
      },
      randomUUID(),
      new Date('2026-10-01T00:00:00Z')
    );
    expect(first).toEqual({ inserted: true });
    const [before] = await rowsOf('u2', 'd2');

    const second = await upsertDeviceKeyPackage(
      ds,
      { userId: 'u2', deviceId: 'd2', keyPackage: 'new', notAfter: null },
      randomUUID(),
      new Date('2026-11-07T00:00:00Z')
    );
    expect(second).toEqual({ inserted: false });
    const rows = await rowsOf('u2', 'd2');
    expect(rows).toHaveLength(1);
    const [after] = rows;
    // The row keeps its identity; the new id is only for a created row.
    expect(after.id).toBe(before.id);
    expect(after.keyPackage).toBe('new');
    // The date belongs to the payload: written even when it is null.
    expect(after.notAfter).toBeNull();
    // Absent metadata keeps what the row holds.
    expect(after.deviceName).toBe('Pixel');
    expect(after.deviceOs).toBe('android');
    expect(after.deviceAppVersion).toBe('1.6.5');
    // createdAt is the enrolment's date, reset on every registration.
    expect(after.createdAt.getTime()).toBeGreaterThan(before.createdAt.getTime());

    await upsertDeviceKeyPackage(
      ds,
      {
        userId: 'u2',
        deviceId: 'd2',
        keyPackage: 'newer',
        notAfter: new Date('2027-02-01T00:00:00Z'),
        deviceName: 'Pixel 9',
        deviceAppVersion: '1.6.7',
      },
      randomUUID()
    );
    const [latest] = await rowsOf('u2', 'd2');
    expect(latest.deviceName).toBe('Pixel 9');
    expect(latest.deviceOs).toBe('android');
    expect(latest.deviceAppVersion).toBe('1.6.7');
    expect(latest.notAfter?.toISOString()).toBe('2027-02-01T00:00:00.000Z');
  });
});
