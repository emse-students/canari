/**
 * THE PERSON A MEMBER'S ADD ADMITS IS ENROLLED BY THE ACCEPTED COMMIT ITSELF, AGAINST A REAL
 * POSTGRESQL - and a departure HOLDS against an Add built before it.
 *
 * The roster row (`dm_group_members`) used to be written by the committer's `registerMember`, a
 * separate call made after it READ the gate's accept. An Add whose answer was lost - settled later by
 * a resubmission the gate answered `duplicate`, or held offline and sent from the outbox on return -
 * merged and sent its Welcome without that call: the invitee held a leaf and no seat, every Welcome
 * was refused `welcome_target_not_member`, and the stray sweep took the leaf back out (the DUP and
 * OFF rows of the 1.4.1 campaign, 2026-10-25). These cases fail on that state: the enrolment must be
 * there after the advance with no client call at all, and a duplicate must find exactly the state the
 * first accept left. The review of #2419 added the other half: an Add built BEFORE a leave or a
 * removal, landing after it at an unchanged epoch, must not undo it (docs/wiki/protocols/
 * mls-protocol.md, "An Add enrols its people with the accepted commit").
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, like every chat-delivery integration spec. Locally:
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- add-enrolment.integration
 *
 * A throwaway schema, created before the DataSource initializes and dropped at the end; Redis is a
 * set in memory. `user_blocks` is core-service's table, created here as its migration shapes it.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
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
import { MembersController } from '../controllers/members.controller';
import { memberCommitFrame } from '../testing/mlsFrameFixture';
import { isEntitledToDistributionGroup } from '../internal/distribution-entitlement';

// social-service's entitlement answer, for the one key-group case.
jest.mock('../internal/distribution-entitlement', () => ({
  ...jest.requireActual('../internal/distribution-entitlement'),
  isEntitledToDistributionGroup: jest.fn(),
}));
const entitled = isEntitledToDistributionGroup as jest.MockedFunction<
  typeof isEntitledToDistributionGroup
>;

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const dir = join(__dirname, '..', 'migrations');
const MIGRATION_036 = readFileSync(join(dir, '036_seat_evictions.sql'), 'utf8');
const MIGRATION_038 = readFileSync(join(dir, '038_group_member_awaiting_admission.sql'), 'utf8');
const MIGRATION_039 = readFileSync(join(dir, '039_departure_seat_generation.sql'), 'utf8');

const GROUP = '00000000-0000-4000-8000-0000000000b1';
const KEY_GROUP = '00000000-0000-4000-8000-0000000000b2';
const WORKSPACE = '00000000-0000-4000-8000-0000000000b3';
const INVITER = { userId: 'inviter', deviceId: 'dev-i' };
const INVITEE = { userId: 'invitee', deviceId: 'dev-n' };

/** The status and refusal name of a rejected call, or `null` when it resolved. */
const refusalOf = (call: Promise<unknown>) =>
  call.then(
    () => null,
    (e: { getStatus: () => number; getResponse: () => { code?: string; error?: string } }) => ({
      status: e.getStatus(),
      name: e.getResponse().code ?? e.getResponse().error,
    })
  );

maybe('an Add enrols its invitee with the accepted commit (PostgreSQL)', () => {
  const schema = `add_enrol_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: MessagingService;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** Only what the commit gate, a Welcome store and a removal use. */
  const redis = {
    smembers: async () => [],
    sadd: async () => 0,
    srem: async () => 0,
    smismember: async (_key: string, ...members: string[]) => members.map(() => 0),
    set: async () => 'OK',
    eval: async () => 1,
    hset: async () => 0,
    hdel: async () => 0,
    hgetall: async () => ({}),
    mget: async (...keys: string[]) => keys.flat().map(() => null),
    exists: async () => 0,
    publish: async () => 1,
  };

  /**
   * A commit of `INVITER`'s at `epoch`, admitting `INVITEE`'s device when `admits` - the same bytes
   * for the same epoch on every submission, which is what the gate's duplicate test compares.
   */
  const commitAt = (epoch: number, admits = true, group = GROUP) =>
    service.validateCommit(
      {
        groupId: group,
        deviceId: INVITER.deviceId,
        baseEpoch: epoch,
        proto: memberCommitFrame(group, BigInt(epoch)),
        senderId: INVITER.userId,
        ...(admits
          ? {
              excludeDeviceIds: [`${INVITEE.userId}:${INVITEE.deviceId}`],
              admits: [INVITEE],
            }
          : {}),
      },
      INVITER.userId
    );
  const addCommit = (epoch: number) => commitAt(epoch, true);
  /** The Welcome of that Add, as `mergeSettled` sends it after a settlement. */
  const welcome = () =>
    service.sendWelcome(INVITER.userId, {
      groupId: GROUP,
      targetUserId: INVITEE.userId,
      targetDeviceId: INVITEE.deviceId,
      senderUserId: INVITER.userId,
      welcomePayload: 'd2VsY29tZQ==',
    });
  const members = () =>
    new MembersController(
      ds.getRepository(GroupMember),
      // The dismissed-groups table is not on this path.
      null as unknown as never,
      ds.getRepository(Group),
      ds.getRepository(KeyPackage),
      ds.getRepository(DeviceGroupMembership),
      ds.getRepository(MlsGroupInfo),
      ds.getRepository(QueuedMessage),
      ds.getRepository(RevokedDevice),
      redis as unknown as Redis,
      ds
    );
  /** The removal of `INVITEE` through its route, by `caller` - the inviter, or the invitee leaving. */
  const remove = (caller: string) =>
    members().removeGroupMember(GROUP, INVITEE.userId, caller, undefined);
  /** What the server holds for the invitee: seats, open intervals and device rows. */
  const enrolment = async (group = GROUP) => {
    const count = async (sql: string) => {
      const [row]: { n: string }[] = await q(sql, [group, INVITEE.userId]);
      return Number(row.n);
    };
    return {
      seats: await count(
        `SELECT COUNT(*) AS n FROM dm_group_members WHERE "groupId" = $1 AND "userId" = $2`
      ),
      openIntervals: await count(
        `SELECT COUNT(*) AS n FROM dm_group_membership_intervals
         WHERE "groupId" = $1 AND "userId" = $2 AND "leftAt" IS NULL`
      ),
      devices: await count(
        `SELECT COUNT(*) AS n FROM dm_device_group_memberships WHERE "groupId" = $1 AND "userId" = $2`
      ),
    };
  };

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
    // The columns as production gets them: the entities already made them, so the migration must
    // replay as a no-op on tables that have them.
    await q(MIGRATION_039);
    await q(
      `CREATE TABLE user_blocks ("blockerId" varchar NOT NULL, "blockedId" varchar NOT NULL)`
    );
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
    jest
      .spyOn(service, 'sendMessage')
      .mockResolvedValue({ status: 'processed', queued: 0, sent: 0, receivedAt: 0 });
    jest
      .spyOn(service as unknown as { deliverWelcome: () => Promise<void> }, 'deliverWelcome')
      .mockResolvedValue(undefined);
    await q(`INSERT INTO dm_groups (id, "isGroup", "activeEpoch") VALUES ($1, true, 1)`, [GROUP]);
    await q(
      `INSERT INTO dm_groups (id, "isGroup", "activeEpoch", "distributionWorkspaceId")
       VALUES ($1, true, 1, $2)`,
      [KEY_GROUP, WORKSPACE]
    );
  });

  beforeEach(async () => {
    entitled.mockReset();
    await q(
      `UPDATE dm_groups SET "activeEpoch" = 1, "seatGeneration" = 0, "epochSeatGeneration" = 0`
    );
    await q(`DELETE FROM mls_commit_log`);
    await q(`DELETE FROM dm_device_group_memberships`);
    await q(`DELETE FROM dm_group_members`);
    await q(`DELETE FROM dm_group_membership_intervals`);
    await q(`DELETE FROM dm_seat_evictions`);
    await q(`DELETE FROM queued_message`);
    await q(`DELETE FROM user_blocks`);
    await q(`INSERT INTO dm_group_members ("groupId", "userId", role) VALUES ($1, $2, 'member')`, [
      GROUP,
      INVITER.userId,
    ]);
    for (const group of [GROUP, KEY_GROUP]) {
      await q(
        `INSERT INTO dm_device_group_memberships ("userId", "deviceId", "groupId", status)
         VALUES ($1, $2, $3, 'active')`,
        [INVITER.userId, INVITER.deviceId, group]
      );
    }
    for (const who of [INVITER, INVITEE]) {
      await q(
        `INSERT INTO key_package ("userId", "deviceId", "keyPackage") VALUES ($1, $2, 'kp')
         ON CONFLICT DO NOTHING`,
        [who.userId, who.deviceId]
      );
    }
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('the accepted Add enrols the invitee with the advance, with no client call, and its Welcome is then stored', async () => {
    await expect(addCommit(1)).resolves.toEqual({ accepted: true, newEpoch: 2 });

    // No `registerMember` was made: the commit alone wrote the seat and opened the interval.
    expect(await enrolment()).toEqual({ seats: 1, openIntervals: 1, devices: 1 });
    await expect(refusalOf(welcome())).resolves.toBeNull();
  });

  it('an Add whose answer was lost, settled by a resubmission answered duplicate, leaves the same state as a direct accept', async () => {
    // The first request lands and its answer is lost: the client never sees this accept.
    await addCommit(1);
    const afterAccept = await enrolment();

    // The settlement resubmits the same bytes; the gate answers them as the commit it already took.
    await expect(addCommit(1)).resolves.toEqual({ accepted: true, newEpoch: 2, duplicate: true });

    expect(await enrolment()).toEqual(afterAccept);
    expect(afterAccept).toEqual({ seats: 1, openIntervals: 1, devices: 1 });
    // ...so the Welcome `mergeSettled` then sends is accepted, never `welcome_target_not_member`.
    await expect(refusalOf(welcome())).resolves.toBeNull();
  });

  it('a block between the inviter and the invitee enrols nobody, writes no device row, and the Welcome is refused by its code', async () => {
    await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [
      INVITEE.userId,
      INVITER.userId,
    ]);

    // The commit still lands - the route's refusal never undid one either - but no seat is written,
    // and no device row that would queue frames for a device whose Welcome is refused.
    await expect(addCommit(1)).resolves.toMatchObject({ accepted: true });

    expect(await enrolment()).toEqual({ seats: 0, openIntervals: 0, devices: 0 });
    await expect(refusalOf(welcome())).resolves.toEqual({
      status: 403,
      name: 'WELCOME_TARGET_NOT_MEMBER',
    });
  });

  it('a person already on the roster keeps the seat and the interval they had', async () => {
    await q(`INSERT INTO dm_group_members ("groupId", "userId", role) VALUES ($1, $2, 'admin')`, [
      GROUP,
      INVITEE.userId,
    ]);

    await expect(addCommit(1)).resolves.toMatchObject({ accepted: true });

    const [seat]: { role: string }[] = await q(
      `SELECT role FROM dm_group_members WHERE "groupId" = $1 AND "userId" = $2`,
      [GROUP, INVITEE.userId]
    );
    expect(seat.role).toBe('admin');
    // Seeded without an interval, and the commit did not open one: an existing seat is not re-enrolled.
    expect(await enrolment()).toEqual({ seats: 1, openIntervals: 0, devices: 1 });
  });

  it("a seat awaiting a member's admission is left as it is, and lifted - never enrolled a second time", async () => {
    await q(
      `INSERT INTO dm_group_members ("groupId", "userId", role, "awaitingAdmission")
       VALUES ($1, $2, 'member', true)`,
      [GROUP, INVITEE.userId]
    );

    await expect(addCommit(1)).resolves.toMatchObject({ accepted: true });

    const [seat]: { awaitingAdmission: boolean }[] = await q(
      `SELECT "awaitingAdmission" FROM dm_group_members WHERE "groupId" = $1 AND "userId" = $2`,
      [GROUP, INVITEE.userId]
    );
    expect(seat.awaitingAdmission).toBe(false);
    expect(await enrolment()).toEqual({ seats: 1, openIntervals: 0, devices: 1 });
  });

  it('a committer that holds no seat itself enrols nobody', async () => {
    await q(`DELETE FROM dm_group_members WHERE "groupId" = $1 AND "userId" = $2`, [
      GROUP,
      INVITER.userId,
    ]);

    await expect(addCommit(1)).resolves.toMatchObject({ accepted: true });

    expect(await enrolment()).toEqual({ seats: 0, openIntervals: 0, devices: 0 });
  });

  describe('a departure holds against an Add built before it', () => {
    /** The invitee, enrolled by a first Add (epoch 1 -> 2), as any member is. */
    const enrolInvitee = async () => {
      await addCommit(1);
      expect(await enrolment()).toEqual({ seats: 1, openIntervals: 1, devices: 1 });
    };

    it('removed, and its Remove commit lost: an Add built on the epoch before lands at it and enrols nobody', async () => {
      await enrolInvitee();
      // The removal is recorded; its Remove commit never lands, so the epoch stays at 2.
      await remove(INVITER.userId);

      // The Add built on epoch 2 before the removal (held in an outbox) arrives now.
      await expect(addCommit(2)).resolves.toMatchObject({ accepted: true, newEpoch: 3 });

      expect(await enrolment()).toEqual({ seats: 0, openIntervals: 0, devices: 0 });
      await expect(refusalOf(welcome())).resolves.toEqual({
        status: 403,
        name: 'WELCOME_TARGET_NOT_MEMBER',
      });
    });

    it('left by themselves (no commit at all): the late Add enrols nobody', async () => {
      await enrolInvitee();
      await remove(INVITEE.userId);

      await expect(addCommit(2)).resolves.toMatchObject({ accepted: true });

      expect(await enrolment()).toEqual({ seats: 0, openIntervals: 0, devices: 0 });
    });

    it('removed, then re-invited by a NEW Add built after the departure: enrolled again', async () => {
      await enrolInvitee();
      await remove(INVITER.userId);
      // The Remove commit lands: a new epoch, begun after the departure.
      await expect(commitAt(2, false)).resolves.toMatchObject({ accepted: true, newEpoch: 3 });

      // The re-invitation is built on that epoch.
      await expect(addCommit(3)).resolves.toMatchObject({ accepted: true, newEpoch: 4 });

      expect(await enrolment()).toEqual({ seats: 1, openIntervals: 1, devices: 1 });
      await expect(refusalOf(welcome())).resolves.toBeNull();
    });
  });

  it("a key group's admits enrol nobody on the conversation roster - its roster is social-service's", async () => {
    entitled.mockResolvedValue(true);

    await expect(commitAt(1, true, KEY_GROUP)).resolves.toMatchObject({ accepted: true });

    const after = await enrolment(KEY_GROUP);
    expect(after.seats).toBe(0);
    expect(after.openIntervals).toBe(0);
    // The admit itself is written, as it always was.
    expect(after.devices).toBe(1);
  });
});
