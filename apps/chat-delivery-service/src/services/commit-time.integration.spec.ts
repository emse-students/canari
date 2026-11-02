/**
 * THE ADMISSION FLOOR OF `GET mls/commits/:groupId/accepted-at`, AGAINST A REAL POSTGRESQL.
 *
 * A device is handed the time of the commit that admitted it and of every later one, never of an
 * older one (`commitFloorOf`). The floor is the base epoch the commit gate records on the seat
 * (`admittedByBaseEpoch`, written by the gate's own writer here), no longer a clock comparison - the
 * arrival records it replaced could be written BEFORE the admission (owner, 2026-11-02). These cases
 * hold it against the database, and against the shapes the clock got wrong:
 *
 * - a key-group device admitted in the transaction of its commit: that commit answered, the one
 *   before refused; a publisher's admission never lowers it;
 * - a group admission whose enrolment was written before the Add: the Add answered, the commit
 *   before it refused (the old floor landed on it);
 * - a device kicked (by the real demotion writer, which ends its admission) and re-added, its row
 *   kept: the commits made while it was out refused; a later declaration cannot raise its floor;
 * - a demotion with no kick (the cron) keeps the floor;
 * - a seat found with no admission (an old replica admitted it): floored at the group epoch, once;
 * - the rows from before the column, backfilled by migration 044: refuse rather than leak.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads;
 * CI's `test-chat-delivery-integration` sets it and refuses a skip. Locally:
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- commit-time.integration
 *
 * A throwaway schema, created before the DataSource initializes and dropped at the end. No Redis
 * path is reached.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource, EntityManager } from 'typeorm';
import type Redis from 'ioredis';
import { MessagingService } from './messaging.service';
import { QueuedMessage } from '../entities/queued-message.entity';
import { QueuedPayload } from '../entities/queued-payload.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { GroupInvite } from '../entities/group-invite.entity';
import { GroupMembershipInterval } from '../entities/group-membership-interval.entity';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const dir = join(__dirname, '..', 'migrations');
const MIGRATION_036 = readFileSync(join(dir, '036_seat_evictions.sql'), 'utf8');
const MIGRATION_038 = readFileSync(join(dir, '038_group_member_awaiting_admission.sql'), 'utf8');
const MIGRATION_039 = readFileSync(join(dir, '039_departure_seat_generation.sql'), 'utf8');
const MIGRATION_044 = readFileSync(join(dir, '044_device_admission_base_epoch.sql'), 'utf8');

/** A key-distribution group (a community's), whose seats are per device and keep no stretch. */
const KEY_GROUP = '00000000-0000-4000-8000-0000000000c1';
/** A group conversation, whose members hold membership stretches. */
const GROUP = '00000000-0000-4000-8000-0000000000c2';
const ME = { userId: 'member', deviceId: 'dev-m' };

/** An instant `h` hours into 2026-11-01, UTC. */
const at = (h: number) => new Date(Date.UTC(2026, 10, 1, h));

/** The HTTP status of a rejected call, or `'answered'` with its instant. */
const outcome = (call: Promise<{ acceptedAt: string | null }>) =>
  call.then(
    (r) => r.acceptedAt,
    (e: { getStatus: () => number }) => e.getStatus()
  );

maybe('the accepted-at arrival floor (PostgreSQL)', () => {
  const schema = `commit_time_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: MessagingService;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** Logs the commit built on `base` in `groupId`, accepted at `createdAt`. */
  const commitAt = (groupId: string, base: number, createdAt: Date) =>
    q(
      `INSERT INTO mls_commit_log ("groupId", "baseEpoch", commit, "createdAt") VALUES ($1, $2, 'c', $3)`,
      [groupId, base, createdAt]
    );
  /** A stretch of membership of ME in GROUP. */
  const stretch = (joinedAt: Date, leftAt: Date | null) =>
    q(
      `INSERT INTO dm_group_membership_intervals ("groupId", "userId", "joinedAt", "leftAt") VALUES ($1, $2, $3, $4)`,
      [GROUP, ME.userId, joinedAt, leftAt]
    );
  const ask = (groupId: string, base: number, deviceId: string | null = ME.deviceId) =>
    outcome(service.getCommitAcceptedAt(groupId, base, ME.userId, deviceId ?? undefined));
  /** ME's seat in `groupId`. */
  const seatRow = (groupId: string, status: 'pending' | 'active', m?: EntityManager) =>
    (m ?? ds.manager).query(
      `INSERT INTO dm_device_group_memberships ("groupId", "userId", "deviceId", status) VALUES ($1, $2, $3, $4)`,
      [groupId, ME.userId, ME.deviceId, status]
    );
  /** The commit gate's record of ME's admission by the commit built on `base` - its own writer. */
  const admit = (
    m: EntityManager,
    groupId: string,
    base: number,
    options: { keepRecorded?: boolean; pendingOnly?: boolean } = {}
  ) =>
    (
      service as unknown as {
        recordAdmission: (...a: unknown[]) => Promise<void>;
      }
    ).recordAdmission(m, ME.userId, ME.deviceId, groupId, base, 'IT', options);
  const floorOf = async (groupId: string) =>
    (
      (await q(
        `SELECT "admittedByBaseEpoch" AS floor FROM dm_device_group_memberships WHERE "groupId" = $1 AND "deviceId" = $2`,
        [groupId, ME.deviceId]
      )) as { floor: number | null }[]
    )[0]?.floor;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [
        QueuedMessage,
        QueuedPayload,
        KeyPackage,
        OneTimeKeyPackage,
        GroupMember,
        Group,
        DeviceGroupMembership,
        PushToken,
        RevokedDevice,
        MlsCommitLog,
        MlsGroupInfo,
        GroupInvite,
        GroupMembershipInterval,
      ],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    await ds.synchronize();
    await q(MIGRATION_036);
    await q(MIGRATION_038);
    await q(MIGRATION_039);
    service = new MessagingService(
      ds.getRepository(QueuedMessage),
      ds.getRepository(GroupMember),
      ds.getRepository(Group),
      ds.getRepository(KeyPackage),
      ds.getRepository(OneTimeKeyPackage),
      ds.getRepository(DeviceGroupMembership),
      ds.getRepository(PushToken),
      ds.getRepository(MlsCommitLog),
      ds.getRepository(MlsGroupInfo),
      ds.getRepository(RevokedDevice),
      // The demotion's route removal is the only Redis call reached: answered, nothing behind it.
      { srem: async () => 0 } as unknown as Redis
    );
    await q(
      `INSERT INTO dm_groups (id, "isGroup", "activeEpoch", "distributionChannelId") VALUES ($1, true, 9, gen_random_uuid())`,
      [KEY_GROUP]
    );
    await q(`INSERT INTO dm_groups (id, "isGroup", "activeEpoch") VALUES ($1, true, 9)`, [GROUP]);
  });

  beforeEach(async () => {
    await q(`DELETE FROM mls_commit_log`);
    await q(`DELETE FROM dm_device_group_memberships`);
    await q(`DELETE FROM dm_group_members`);
    await q(`DELETE FROM dm_group_membership_intervals`);
    await q(`DELETE FROM dm_groups WHERE id NOT IN ($1, $2)`, [KEY_GROUP, GROUP]);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('a key-group device is handed the commit that admitted it, and nothing older', async () => {
    await commitAt(KEY_GROUP, 3, at(1));
    // The commit gate's transaction: the admitting commit's log row, the seat it admits, and the
    // admission recorded on it - by the gate's own writer.
    await ds.transaction(async (m) => {
      await m.query(
        `INSERT INTO mls_commit_log ("groupId", "baseEpoch", commit) VALUES ($1, 4, 'c')`,
        [KEY_GROUP]
      );
      await seatRow(KEY_GROUP, 'active', m);
      await admit(m, KEY_GROUP, 4);
    });
    await commitAt(KEY_GROUP, 5, at(23));

    expect(typeof (await ask(KEY_GROUP, 4))).toBe('string');
    expect(await ask(KEY_GROUP, 5)).toBe(at(23).toISOString());
    expect(await ask(KEY_GROUP, 3)).toBe(403);
    // FAILS CLOSED: asked without the device that holds the admission.
    expect(await ask(KEY_GROUP, 5, null)).toBe(400);

    // A publisher's or a creator's admission never LOWERS the one a commit recorded.
    await ds.transaction((m) => admit(m, KEY_GROUP, 0, { keepRecorded: true }));
    expect(await floorOf(KEY_GROUP)).toBe(4);
  });

  it('a group admission answers the Add and refuses the commit before it, though the enrolment was written first', async () => {
    await q(`INSERT INTO dm_group_members ("groupId", "userId", role) VALUES ($1, $2, 'member')`, [
      GROUP,
      ME.userId,
    ]);
    await commitAt(GROUP, 2, at(1));
    // The enrolment writes the stretch and the pending seat BEFORE the Add that admits them - the
    // arrival the old floor read, which then landed on commit 2.
    await stretch(at(2), null);
    await seatRow(GROUP, 'pending');
    await commitAt(GROUP, 3, at(3)); // the Add
    await ds.transaction((m) => admit(m, GROUP, 3));
    await q(`UPDATE dm_device_group_memberships SET status = 'active' WHERE "groupId" = $1`, [
      GROUP,
    ]);
    await commitAt(GROUP, 4, at(5));

    expect(await ask(GROUP, 2)).toBe(403);
    expect(await ask(GROUP, 3)).toBe(at(3).toISOString());
    expect(await ask(GROUP, 4)).toBe(at(5).toISOString());
  });

  it('a device kicked and re-added is refused the commits made while it was out', async () => {
    await seatRow(KEY_GROUP, 'active');
    await commitAt(KEY_GROUP, 2, at(1));
    await ds.transaction((m) => admit(m, KEY_GROUP, 2)); // its first admission
    await commitAt(KEY_GROUP, 3, at(2));
    // The kick: its leaf removed by commit 4, its seat demoted by the ONE writer of `pending` with
    // the kick's instant - the row is KEPT, and its admission ends.
    await commitAt(KEY_GROUP, 4, at(3));
    await service.deactivateDeviceMembership(ME.userId, ME.deviceId, KEY_GROUP, {
      removedFromTreeAt: at(3),
    });
    expect(await floorOf(KEY_GROUP)).toBeNull();
    await commitAt(KEY_GROUP, 5, at(4)); // while it was out
    // Out of the tree, it is answered nothing - and nothing is inferred for a kicked seat.
    expect(await ask(KEY_GROUP, 5)).toBe(403);
    expect(await floorOf(KEY_GROUP)).toBeNull();
    await commitAt(KEY_GROUP, 6, at(5)); // the re-add
    await ds.transaction((m) => admit(m, KEY_GROUP, 6, { pendingOnly: true }));
    await q(
      `UPDATE dm_device_group_memberships SET status = 'active', "kickedAt" = NULL WHERE "groupId" = $1`,
      [KEY_GROUP]
    );
    await commitAt(KEY_GROUP, 7, at(6));

    for (const before of [2, 3, 4, 5]) expect(await ask(KEY_GROUP, before)).toBe(403);
    expect(await ask(KEY_GROUP, 6)).toBe(at(5).toISOString());
    expect(await ask(KEY_GROUP, 7)).toBe(at(6).toISOString());

    // A later commit that merely DECLARES the now-active seat cannot raise its floor.
    await ds.transaction((m) => admit(m, KEY_GROUP, 7, { pendingOnly: true }));
    expect(await floorOf(KEY_GROUP)).toBe(6);
  });

  it('a demotion with no kick (the stale-device cron) keeps the floor', async () => {
    await seatRow(KEY_GROUP, 'active');
    await ds.transaction((m) => admit(m, KEY_GROUP, 2));
    await service.deactivateDeviceMembership(ME.userId, ME.deviceId, KEY_GROUP, {
      removedFromTreeAt: null,
    });
    expect(await floorOf(KEY_GROUP)).toBe(2);
  });

  it('a seat found with no admission is floored at the group epoch, written once', async () => {
    // Admitted by a replica still running the old code: active, with nothing recorded.
    await seatRow(KEY_GROUP, 'active');
    for (const base of [7, 8]) await commitAt(KEY_GROUP, base, at(base));
    await commitAt(KEY_GROUP, 9, at(12));

    expect(await ask(KEY_GROUP, 8)).toBe(403);
    expect(await floorOf(KEY_GROUP)).toBe(9);
    expect(await ask(KEY_GROUP, 9)).toBe(at(12).toISOString());
    const [{ inferred }] = (await q(
      `SELECT "admissionInferred" AS inferred FROM dm_device_group_memberships WHERE "groupId" = $1`,
      [KEY_GROUP]
    )) as { inferred: boolean }[];
    expect(inferred).toBe(true);
  });

  /**
   * ROWS FROM BEFORE THE COLUMN, backfilled by migration 044 - refuse rather than leak. An active
   * seat, and a pending one the cron demoted (never kicked), are floored at their group's epoch; a
   * seat a commit admitted and that has not activated yet at the epoch it holds; a kicked seat is
   * left with no admission.
   */
  it('migration 044 floors every pre-column seat at what it can prove, never lower', async () => {
    const OTHER = '00000000-0000-4000-8000-0000000000c3';
    await q(`INSERT INTO dm_groups (id, "isGroup", "activeEpoch") VALUES ($1, true, 4)`, [OTHER]);
    await q(
      `ALTER TABLE dm_device_group_memberships DROP COLUMN "admittedByBaseEpoch", DROP COLUMN "admissionInferred"`
    );
    const row = (
      groupId: string,
      deviceId: string,
      status: string,
      admittedAtEpoch: number | null,
      kickedAt: Date | null = null
    ) =>
      q(
        `INSERT INTO dm_device_group_memberships ("groupId", "userId", "deviceId", status, "admittedAtEpoch", "kickedAt") VALUES ($1, $2, $3, $4, $5, $6)`,
        [groupId, ME.userId, deviceId, status, admittedAtEpoch, kickedAt]
      );
    await row(KEY_GROUP, ME.deviceId, 'active', null);
    await row(OTHER, ME.deviceId, 'active', null);
    await row(GROUP, ME.deviceId, 'pending', 7); // admitted by the commit on base 6, not activated
    await row(KEY_GROUP, 'dev-kicked', 'pending', null, at(2)); // kicked, not re-added
    await row(OTHER, 'dev-demoted', 'pending', null); // demoted by the cron, its leaf still in

    await q(MIGRATION_044);
    // Idempotent: a second run changes nothing.
    await q(MIGRATION_044);

    const floors = Object.fromEntries(
      (
        (await q(
          `SELECT "groupId", "deviceId", "admittedByBaseEpoch" AS floor, "admissionInferred" AS inferred FROM dm_device_group_memberships`
        )) as { groupId: string; deviceId: string; floor: number | null; inferred: boolean }[]
      ).map((r) => [`${r.groupId.slice(-2)}:${r.deviceId}`, [r.floor, r.inferred]])
    );
    expect(floors).toEqual({
      [`c1:${ME.deviceId}`]: [9, true],
      [`c3:${ME.deviceId}`]: [4, true],
      [`c2:${ME.deviceId}`]: [6, false],
      'c1:dev-kicked': [null, false],
      'c3:dev-demoted': [4, true],
    });

    for (const base of [3, 7, 8]) await commitAt(KEY_GROUP, base, at(base));
    await commitAt(KEY_GROUP, 9, at(12));
    // Every commit accepted before the deploy is refused; the first one after it is answered.
    for (const before of [3, 7, 8]) expect(await ask(KEY_GROUP, before)).toBe(403);
    expect(await ask(KEY_GROUP, 9)).toBe(at(12).toISOString());
    // A kicked seat is answered nothing, and nothing is inferred for it.
    expect(await ask(KEY_GROUP, 9, 'dev-kicked')).toBe(403);
    expect(floors['c1:dev-kicked']).toEqual([null, false]);
  });
});
