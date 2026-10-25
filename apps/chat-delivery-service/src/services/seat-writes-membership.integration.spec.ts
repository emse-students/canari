/**
 * SEAT WRITES CHECK MEMBERSHIP, AGAINST A REAL POSTGRESQL - migration 036 included.
 *
 * A key-distribution group's seats are created only by writers that ask social-service whether the
 * person is entitled, against a claim re-read under the seat lock (`utils/seat-eviction.ts`). The
 * two transition writers - the demotion (`deactivateDeviceMembership`) and the report of `active`
 * (`promoteReportedSeat`) - create none: these cases drive both through their real doors (the status
 * route, the stale-device and kick demotions) for a device with no seat, and for a member whose seat
 * they legitimately move.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, like every chat-delivery integration spec:
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- seat-writes-membership.integration
 *
 * A throwaway schema, dropped at the end; Redis is a set in memory.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { HttpException, Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
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
import { InvitationsController } from '../controllers/invitations.controller';
import { isEntitledToDistributionGroup } from '../internal/distribution-entitlement';

// social-service's entitlement answer, set by each case.
jest.mock('../internal/distribution-entitlement', () => ({
  ...jest.requireActual('../internal/distribution-entitlement'),
  isEntitledToDistributionGroup: jest.fn(),
}));
const entitled = isEntitledToDistributionGroup as jest.MockedFunction<
  typeof isEntitledToDistributionGroup
>;

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = readFileSync(
  join(__dirname, '..', 'migrations', '036_seat_evictions.sql'),
  'utf8'
);

const KEY_GROUP = '00000000-0000-4000-8000-0000000000f1';
const WORKSPACE = '00000000-0000-4000-8000-0000000000a1';
const ROUTES = `group:members:${KEY_GROUP}`;
/** A member who stays. */
const MEMBER = { userId: 'member', deviceId: 'dev-m' };
/** A person evicted from the key group: no seat, no route. */
const UNSEATED = { userId: 'gone', deviceId: 'dev-g' };

maybe('seat writes check membership in a key-distribution group (PostgreSQL)', () => {
  const schema = `seat_mb_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: MessagingService;
  const sets = new Map<string, Set<string>>();
  const setOf = (key: string): Set<string> => {
    let set = sets.get(key);
    if (!set) sets.set(key, (set = new Set()));
    return set;
  };
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  const redis = {
    smembers: async (key: string) => [...setOf(key)],
    sadd: async (key: string, ...members: string[]) => {
      const set = setOf(key);
      const before = set.size;
      members.forEach((m) => set.add(m));
      return set.size - before;
    },
    srem: async (key: string, ...members: string[]) => {
      const set = setOf(key);
      const before = set.size;
      members.forEach((m) => set.delete(m));
      return before - set.size;
    },
  };

  const controller = () =>
    new InvitationsController(
      ds.getRepository(DeviceGroupMembership),
      ds.getRepository(GroupMember),
      ds.getRepository(Group),
      ds.getRepository(GroupInvite),
      ds.getRepository(KeyPackage),
      ds.getRepository(RevokedDevice),
      ds.getRepository(QueuedMessage),
      redis as unknown as Redis,
      service
    );

  /** The status route as the device itself calls it (`x-user-id` is its own user). */
  const report = (who: { userId: string; deviceId: string }, status: 'pending' | 'active') =>
    controller().updateInvitationStatus(
      { userId: who.userId, deviceId: who.deviceId, groupId: KEY_GROUP, status },
      who.userId
    );
  const refusalOf = (call: Promise<unknown>) =>
    call.then(
      () => null,
      (e: unknown) =>
        e instanceof HttpException
          ? { status: e.getStatus(), body: e.getResponse() as Record<string, unknown> }
          : { status: -1, body: { thrown: String(e) } }
    );

  const seatOf = async (who: { userId: string; deviceId: string }) => {
    const rows: Array<{ status: string; kickedAt: Date | null }> = await q(
      `SELECT status, "kickedAt" FROM dm_device_group_memberships
        WHERE "groupId" = $1 AND "userId" = $2 AND "deviceId" = $3`,
      [KEY_GROUP, who.userId, who.deviceId]
    );
    return rows[0] ?? null;
  };
  const routed = (who: { userId: string; deviceId: string }) =>
    setOf(ROUTES).has(`${who.userId}:${who.deviceId}`);
  const seatActive = async (who: { userId: string; deviceId: string }) => {
    await q(
      `INSERT INTO dm_device_group_memberships ("userId", "deviceId", "groupId", status)
       VALUES ($1, $2, $3, 'active')`,
      [who.userId, who.deviceId, KEY_GROUP]
    );
    setOf(ROUTES).add(`${who.userId}:${who.deviceId}`);
  };
  /** The eviction as social-service runs it: begun, then settled. */
  const evicted = async (who: { userId: string }) => {
    const { generation } = await service.evictSeats(KEY_GROUP, who.userId, 'begin');
    await service.evictSeats(KEY_GROUP, who.userId, { settles: generation });
  };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

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
    await q(migration);
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
      redis as unknown as Redis
    );
    await q(
      `INSERT INTO dm_groups (id, "isGroup", "activeEpoch", "distributionWorkspaceId")
       VALUES ($1, true, 3, $2)`,
      [KEY_GROUP, WORKSPACE]
    );
    // Both devices are addressable: a key package each, nothing revoked.
    for (const who of [MEMBER, UNSEATED]) {
      await q(
        `INSERT INTO key_package ("userId", "deviceId", "keyPackage") VALUES ($1, $2, 'kp')`,
        [who.userId, who.deviceId]
      );
    }
  });

  beforeEach(async () => {
    for (const set of sets.values()) set.clear();
    await q(`DELETE FROM dm_device_group_memberships`);
    await q(`DELETE FROM queued_message`);
    await q(`DELETE FROM dm_seat_evictions`);
    entitled.mockReset();
    entitled.mockImplementation(async (_scope, userId) => userId === MEMBER.userId);
    await seatActive(MEMBER);
    await seatActive(UNSEATED);
    await evicted(UNSEATED);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('the eviction left no seat and no route', async () => {
    expect(await seatOf(UNSEATED)).toBeNull();
    expect(routed(UNSEATED)).toBe(false);
  });

  it("a report of 'pending' with no seat is refused and writes no row", async () => {
    const refusal = await refusalOf(report(UNSEATED, 'pending'));

    expect(refusal).toMatchObject({
      status: 403,
      body: { code: 'NOT_A_MEMBER', reason: 'no_seat' },
    });
    expect(await seatOf(UNSEATED)).toBeNull();
  });

  it('reports in both directions from a device with no seat leave no seat and no route', async () => {
    await refusalOf(report(UNSEATED, 'pending'));
    const refusal = await refusalOf(report(UNSEATED, 'active'));

    expect(routed(UNSEATED)).toBe(false);
    expect(await seatOf(UNSEATED)).toBeNull();
    expect(refusal).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
  });

  it("a device with no seat reporting 'active' is refused (no_seat)", async () => {
    const refusal = await refusalOf(report(UNSEATED, 'active'));

    expect(refusal).toMatchObject({ status: 403, body: { reason: 'no_seat' } });
    expect(routed(UNSEATED)).toBe(false);
  });

  it('a stale-device demotion of a row already deleted writes no row', async () => {
    // What the hourly cron does with a row it read active before an eviction deleted it.
    await expect(
      service.deactivateDeviceMembership(UNSEATED.userId, UNSEATED.deviceId, KEY_GROUP, {
        removedFromTreeAt: null,
        tag: 'CRON_STALE_DEVICE',
      })
    ).resolves.toBe(false);
    expect(await seatOf(UNSEATED)).toBeNull();
  });

  it('a kick of a row already deleted writes no row', async () => {
    await expect(
      service.deactivateDeviceMembership(UNSEATED.userId, UNSEATED.deviceId, KEY_GROUP, {
        removedFromTreeAt: new Date(0),
        tag: 'KICK_DEVICE',
      })
    ).resolves.toBe(false);
    expect(await seatOf(UNSEATED)).toBeNull();
  });

  it('a pending key-group seat whose owner is not entitled is not promoted', async () => {
    await q(
      `INSERT INTO dm_device_group_memberships ("userId", "deviceId", "groupId", status)
       VALUES ($1, $2, $3, 'pending')`,
      [UNSEATED.userId, UNSEATED.deviceId, KEY_GROUP]
    );

    const refusal = await refusalOf(report(UNSEATED, 'active'));

    expect(refusal).toMatchObject({
      status: 403,
      body: { code: 'NOT_A_MEMBER', reason: 'not_entitled' },
    });
    expect((await seatOf(UNSEATED))?.status).toBe('pending');
    expect(routed(UNSEATED)).toBe(false);
  });

  it("an entitled member's pending key-group seat is promoted and routed", async () => {
    await q(
      `UPDATE dm_device_group_memberships SET status = 'pending'
        WHERE "groupId" = $1 AND "userId" = $2`,
      [KEY_GROUP, MEMBER.userId]
    );
    setOf(ROUTES).delete(`${MEMBER.userId}:${MEMBER.deviceId}`);

    await expect(report(MEMBER, 'active')).resolves.toEqual({ status: 'active' });
    expect((await seatOf(MEMBER))?.status).toBe('active');
    expect(routed(MEMBER)).toBe(true);
    expect(entitled).toHaveBeenCalledWith(
      { kind: 'workspace', id: WORKSPACE },
      MEMBER.userId,
      expect.any(String)
    );
  });

  it('an already active seat is reported again without asking anyone', async () => {
    await expect(report(MEMBER, 'active')).resolves.toEqual({ status: 'active' });
    expect(entitled).not.toHaveBeenCalled();
  });

  it('a promotion whose claim an eviction overtook is refused and promotes nothing', async () => {
    await q(
      `UPDATE dm_device_group_memberships SET status = 'pending'
        WHERE "groupId" = $1 AND "userId" = $2`,
      [KEY_GROUP, MEMBER.userId]
    );
    // An eviction begins while the entitlement is being asked: social-service still says yes.
    entitled.mockImplementation(async () => {
      await service.evictSeats(KEY_GROUP, MEMBER.userId, 'begin');
      return true;
    });

    const refusal = await refusalOf(report(MEMBER, 'active'));

    expect(refusal).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    expect(await seatOf(MEMBER)).toBeNull();
    expect(routed(MEMBER)).toBe(false);
  });

  it("a member's own demotion of a seat it holds still works and drops the route", async () => {
    await expect(report(MEMBER, 'pending')).resolves.toEqual({ status: 'pending' });
    expect((await seatOf(MEMBER))?.status).toBe('pending');
    expect(routed(MEMBER)).toBe(false);
  });
});
