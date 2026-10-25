/// <reference types="jest" />

jest.mock('../internal/device-sessions', () => {
  const actual = jest.requireActual('../internal/device-sessions');
  return { ...actual, endDeviceSessions: jest.fn().mockResolvedValue(0) };
});

/**
 * MIGRATION 040 AND THE CAUSE OF A BAN AGAINST A REAL POSTGRESQL: the column lands on an empty and on
 * a populated `revoked_device`, replays as a no-op, leaves an older row NULL (read as the owner's),
 * and the real delete and registration routes write and read the cause through TypeORM - the owner's
 * revocation refused as `DEVICE_REVOKED_BY_OWNER`, an install's retired id as `DEVICE_REVOKED` +
 * `reason: 'retired'`, and an owner's ban never downgraded by a later "retired" delete - including
 * by one RACING it, since the merge is the one `INSERT ... ON CONFLICT` statement (`upsertRevocation`).
 * Ending the device's sessions is core-service's, and is mocked here.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads:
 * skipped without it, and run by the `test-chat-delivery-integration` job in `ci.yml`, which refuses
 * a skip. It builds `revoked_device` in the shape it had before 040, in a throwaway schema.
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/db bun run test -- 040_revoked_device_reason
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { DevicesController } from '../controllers/devices.controller';
import { upsertRevocation } from '../utils/revocation';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '040_revoked_device_reason.sql'), 'utf8');

/** `revoked_device` as an estate holds it before 040. */
const REVOKED_DEVICE_BEFORE_040 = `
  CREATE TABLE revoked_device (
    id varchar(36) PRIMARY KEY,
    "userId" varchar(255) NOT NULL,
    "deviceId" varchar NOT NULL,
    "revokedAt" timestamp NOT NULL DEFAULT now(),
    CONSTRAINT "UQ_revoked_device_user_device" UNIQUE ("userId", "deviceId")
  );`;

maybe('migration 040 (revoked_device.reason) against PostgreSQL', () => {
  const schema = `revoked_reason_it_${Date.now()}`;
  let ds: DataSource;
  let controller: DevicesController;
  const purge = jest.fn().mockResolvedValue({
    groupsCleaned: 0,
    keyPackagesDeleted: 0,
    oneTimeKeyPackagesDeleted: 0,
    queuedMessagesDeleted: 0,
  });

  beforeAll(async () => {
    const admin = new DataSource({ type: 'postgres', url: URL });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.destroy();
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [RevokedDevice],
      synchronize: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    for (const level of ['log', 'warn', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    await ds.query(REVOKED_DEVICE_BEFORE_040);
    // A row written before the column - the estate's existing bans.
    await ds.query(
      `INSERT INTO revoked_device (id, "userId", "deviceId") VALUES ('legacy-1', 'u1', 'd-legacy')`
    );
    // Applied TWICE: the deploy ledger replays a file whose successor failed.
    await ds.query(MIGRATION);
    await ds.query(MIGRATION);

    controller = Object.create(DevicesController.prototype) as DevicesController;
    Object.assign(controller, {
      revokedDeviceRepo: ds.getRepository(RevokedDevice),
      dataSource: ds,
      messagingService: {
        purgeDeviceFootprint: purge,
        notifyDeviceRevoked: jest.fn().mockResolvedValue(false),
      },
      deviceSignatureKeys: { record: jest.fn() },
      logger: new Logger('it'),
    });
  }, 60_000);

  afterAll(async () => {
    await ds?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds?.destroy();
    jest.restoreAllMocks();
  }, 60_000);

  const register = (deviceId: string) =>
    controller
      .registerDevice({ userId: 'u1', deviceId, keyPackage: 'a2V5' }, 'u1', undefined)
      .catch((e: unknown) => e);

  const reasonOf = async (deviceId: string): Promise<unknown> =>
    (
      (await ds.query(`SELECT reason FROM revoked_device WHERE "deviceId" = $1`, [deviceId])) as {
        reason: unknown;
      }[]
    )[0]?.reason;

  it('adds a nullable column and leaves the older rows NULL - no backfill', async () => {
    expect(await reasonOf('d-legacy')).toBeNull();
  });

  it('refuses an older ban as the owner, whose cause nothing recorded', async () => {
    expect(await register('d-legacy')).toMatchObject({
      status: 403,
      response: { code: 'DEVICE_REVOKED_BY_OWNER' },
    });
  });

  it('records the owner for a plain delete, and refuses the id as revoked by its owner', async () => {
    await controller.deleteDevice('u1', 'd-owner', undefined, 'u1', undefined);
    expect(await reasonOf('d-owner')).toBe('owner');
    expect(await register('d-owner')).toMatchObject({
      status: 403,
      response: { code: 'DEVICE_REVOKED_BY_OWNER', reason: 'owner' },
    });
  });

  it('records retired for an install retiring its id, and refuses it as DEVICE_REVOKED', async () => {
    await controller.deleteDevice('u1', 'd-retired', 'retired', 'u1', undefined);
    expect(await reasonOf('d-retired')).toBe('retired');
    expect(await register('d-retired')).toMatchObject({
      status: 403,
      response: { code: 'DEVICE_REVOKED', reason: 'retired' },
    });
  });

  it("never downgrades an owner's ban, and upgrades a retired one to the owner's", async () => {
    await controller.deleteDevice('u1', 'd-owner', 'retired', 'u1', undefined);
    expect(await reasonOf('d-owner')).toBe('owner');

    await controller.deleteDevice('u1', 'd-retired', undefined, 'u1', undefined);
    expect(await reasonOf('d-retired')).toBe('owner');
    // One row per pair, still: the re-revocation reused it.
    const rows = (await ds.query(
      `SELECT count(*)::int AS n FROM revoked_device WHERE "deviceId" IN ('d-owner', 'd-retired')`
    )) as { n: number }[];
    expect(rows[0].n).toBe(2);
  });

  it("keeps the owner's cause when an owner's delete and a retirement race on one id", async () => {
    // Each round starts with no row, so both statements may take the INSERT arm or meet the
    // other's row: whichever order PostgreSQL serialises them in, the owner's cause is the one left.
    for (let round = 0; round < 20; round++) {
      const deviceId = `d-race-${round}`;
      const [first, second] = round % 2 === 0 ? ['owner', 'retired'] : ['retired', 'owner'];
      await Promise.all([
        upsertRevocation(ds, 'u1', deviceId, first as 'owner' | 'retired', `race-${round}-a`),
        upsertRevocation(ds, 'u1', deviceId, second as 'owner' | 'retired', `race-${round}-b`),
      ]);
      expect(await reasonOf(deviceId)).toBe('owner');
    }
  });

  it('lets a lapsed ban start over with the new cause, like its date does', async () => {
    await ds.query(
      `INSERT INTO revoked_device (id, "userId", "deviceId", "revokedAt", reason)
       VALUES ('lapsed-1', 'u1', 'd-lapsed', now() - interval '11 years', 'owner')`
    );
    expect(await upsertRevocation(ds, 'u1', 'd-lapsed', 'retired', 'unused')).toBe('retired');
    expect(await reasonOf('d-lapsed')).toBe('retired');
  });

  it('refuses the prekey upload of a banned id the same way', async () => {
    const failure = await controller
      .registerDevicePrekeys(
        {
          userId: 'u1',
          deviceId: 'd-owner',
          keyPackages: [{ keyPackage: 'a2V5', notAfter: null }],
        },
        'u1',
        undefined
      )
      .catch((e: unknown) => e);
    expect(failure).toMatchObject({ status: 403, response: { code: 'DEVICE_REVOKED_BY_OWNER' } });
  });
});
