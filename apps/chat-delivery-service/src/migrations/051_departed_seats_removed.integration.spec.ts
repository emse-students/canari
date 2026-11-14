/// <reference types="jest" />

/**
 * MIGRATION 051 AGAINST A REAL POSTGRESQL: the departed-seat ALLOWLIST removes exactly the seat of a
 * person who holds no device anywhere, and keeps every seat that differs from it by ONE fact - a live
 * member, a pending join, a person with a device row in another group, a person who enrolled a device
 * again (a key package, no row yet), an open ask. A removal is a removal: the group's seat generation
 * moves, the open interval closes at it, and the copy holds the row whole. The rollback written in
 * the file's header restores the seat and reopens the interval. A second run is a no-op.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads:
 * skipped without it, and run by the `test-chat-delivery-integration` job in `ci.yml`, which refuses
 * a skip. It builds the tables the migration reads, in their production column types, in a
 * throwaway schema.
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/db bun run test -- 051_departed_seats_removed
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '051_departed_seats_removed.sql'), 'utf8');

/** The rollback statements of the header, between its two markers, comment prefix stripped. */
function rollbackSql(): string {
  const body = MIGRATION.split('-- ROLLBACK BEGIN')[1]?.split('-- ROLLBACK END')[0];
  if (!body) throw new Error('051 carries no ROLLBACK BEGIN/END block');
  return body
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^--\s*/, ''))
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

const TABLES = `
  CREATE TABLE dm_groups (id uuid PRIMARY KEY, "seatGeneration" integer NOT NULL DEFAULT 0);
  CREATE TYPE dm_group_members_role_enum AS ENUM ('admin', 'member');
  CREATE TABLE dm_group_members (
    id uuid PRIMARY KEY, "groupId" uuid NOT NULL, "userId" varchar(255) NOT NULL,
    role dm_group_members_role_enum NOT NULL DEFAULT 'member',
    "notifLevel" varchar(16) NOT NULL DEFAULT 'all', "callsAllowed" boolean,
    "awaitingAdmission" boolean NOT NULL DEFAULT false,
    "joinedAt" timestamp NOT NULL DEFAULT now(), UNIQUE ("groupId", "userId"));
  CREATE TABLE dm_device_group_memberships (
    id uuid PRIMARY KEY, "groupId" uuid NOT NULL, "userId" varchar(255) NOT NULL,
    "deviceId" varchar NOT NULL, status varchar NOT NULL);
  CREATE TABLE key_package (
    id uuid PRIMARY KEY, "userId" varchar(255) NOT NULL, "deviceId" varchar NOT NULL,
    UNIQUE ("userId", "deviceId"));
  CREATE TABLE dm_group_membership_intervals (
    id uuid PRIMARY KEY, "groupId" uuid NOT NULL, "userId" varchar(255) NOT NULL,
    "joinedAt" timestamp NOT NULL, "leftAt" timestamp, "leftAtSeatGeneration" integer);
  CREATE UNIQUE INDEX "UQ_open_interval" ON dm_group_membership_intervals ("groupId", "userId")
    WHERE "leftAt" IS NULL;`;

maybe('migration 051 (departed seats) against PostgreSQL', () => {
  jest.setTimeout(60_000);
  const schema = `departed_seats_it_${Date.now()}`;
  let ds: DataSource;
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    ds.query(sql, params) as Promise<T[]>;

  const G1 = randomUUID();
  const G2 = randomUUID();
  const G3 = randomUUID();

  const seat = (groupId: string, userId: string, awaitingAdmission = false) =>
    q(
      `INSERT INTO dm_group_members (id, "groupId", "userId", role, "awaitingAdmission", "joinedAt")
       VALUES ($1, $2, $3, 'member', $4, '2026-10-01T10:00:00')`,
      [randomUUID(), groupId, userId, awaitingAdmission]
    ).then(() =>
      q(
        `INSERT INTO dm_group_membership_intervals (id, "groupId", "userId", "joinedAt")
         VALUES ($1, $2, $3, '2026-10-01T10:00:00')`,
        [randomUUID(), groupId, userId]
      )
    );
  const device = (groupId: string, userId: string, deviceId: string, status: string) =>
    q(
      `INSERT INTO dm_device_group_memberships (id, "groupId", "userId", "deviceId", status)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), groupId, userId, deviceId, status]
    );
  const keyPackage = (userId: string, deviceId: string) =>
    q(`INSERT INTO key_package (id, "userId", "deviceId") VALUES ($1, $2, $3)`, [
      randomUUID(),
      userId,
      deviceId,
    ]);
  const roster = async () =>
    (
      await q<{ g: string; u: string }>(
        `SELECT "groupId" AS g, "userId" AS u FROM dm_group_members`
      )
    )
      .map((r) => `${r.g === G1 ? 'G1' : r.g === G2 ? 'G2' : 'G3'}:${r.u}`)
      .sort();
  const generation = async (groupId: string) =>
    Number(
      (
        await q<{ s: number }>(`SELECT "seatGeneration" AS s FROM dm_groups WHERE id = $1`, [
          groupId,
        ])
      )[0].s
    );
  const interval = async (groupId: string, userId: string) =>
    (
      await q<{ leftAt: Date | null; leftAtSeatGeneration: number | null }>(
        `SELECT "leftAt", "leftAtSeatGeneration" FROM dm_group_membership_intervals
          WHERE "groupId" = $1 AND "userId" = $2`,
        [groupId, userId]
      )
    )[0];

  const BEFORE = [
    'G1:u-departed',
    'G1:u-live',
    'G2:u-awaiting',
    'G2:u-departed',
    'G2:u-device-elsewhere',
    'G2:u-pending',
    'G3:u-device-elsewhere',
    'G3:u-reenrolled',
  ];

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
    for (const g of [G1, G2, G3]) await q(`INSERT INTO dm_groups (id) VALUES ($1)`, [g]);

    // REMOVED: a departed person - two seats, no device row anywhere, no key package.
    await seat(G1, 'u-departed');
    await seat(G2, 'u-departed');
    // KEPT: a live member - an active device in the group and its key package.
    await seat(G1, 'u-live');
    await device(G1, 'u-live', 'd-live', 'active');
    await keyPackage('u-live', 'd-live');
    // KEPT: a pending join - only a `pending` row in the group, and its key package.
    await seat(G2, 'u-pending');
    await device(G2, 'u-pending', 'd-pending', 'pending');
    await keyPackage('u-pending', 'd-pending');
    // KEPT: no row in G2, but a device row in G3 - and no key package (the narrower allowlist).
    await seat(G2, 'u-device-elsewhere');
    await seat(G3, 'u-device-elsewhere');
    await device(G3, 'u-device-elsewhere', 'd-else', 'active');
    // KEPT: no device row anywhere, but a key package - a person who came back on a new device.
    await seat(G3, 'u-reenrolled');
    await keyPackage('u-reenrolled', 'd-new');
    // KEPT: an open ask with no device - a Decline's, not this file's.
    await seat(G2, 'u-awaiting', true);

    const seeded = await roster();
    if (seeded.join() !== BEFORE.join()) throw new Error(`fixture seeded ${seeded.join()}`);
    await ds.query(MIGRATION);
  });

  afterAll(async () => {
    await ds?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds?.destroy();
  });

  it("removes the departed person's seats, and only them", async () => {
    expect(await roster()).toEqual(BEFORE.filter((s) => !s.endsWith(':u-departed')));
  });

  it('moves the seat generation of each group it removed from, and of no other', async () => {
    expect(await generation(G1)).toBe(1);
    expect(await generation(G2)).toBe(1);
    expect(await generation(G3)).toBe(0);
  });

  it("closes the departed person's open interval at the moved generation, and no other", async () => {
    const g1 = await interval(G1, 'u-departed');
    expect(g1.leftAt).not.toBeNull();
    expect(g1.leftAtSeatGeneration).toBe(1);
    expect((await interval(G1, 'u-live')).leftAt).toBeNull();
    expect((await interval(G2, 'u-pending')).leftAt).toBeNull();
  });

  it('keeps a whole copy of each removed row, with the interval it closed', async () => {
    const rows = await q<{ seat: { groupId: string; userId: string }; n: number }>(
      `SELECT seat, cardinality("closedIntervalIds") AS n FROM dm_group_members_removed_051`
    );
    expect(
      rows.map((r) => `${r.seat.groupId === G1 ? 'G1' : 'G2'}:${r.seat.userId}`).sort()
    ).toEqual(['G1:u-departed', 'G2:u-departed']);
    expect(rows.every((r) => Number(r.n) === 1)).toBe(true);
  });

  it('is a no-op the second time', async () => {
    await ds.query(MIGRATION);

    expect(await roster()).toEqual(BEFORE.filter((s) => !s.endsWith(':u-departed')));
    expect(await generation(G1)).toBe(1);
    const [{ n }] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM dm_group_members_removed_051`
    );
    expect(n).toBe(2);
  });

  it('is undone by the rollback its header carries', async () => {
    await ds.query(rollbackSql());

    expect(await roster()).toEqual(BEFORE);
    expect(await interval(G1, 'u-departed')).toEqual({ leftAt: null, leftAtSeatGeneration: null });
  });
});
