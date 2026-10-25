/**
 * THE PERSON A MEMBER'S ADD ADMITS IS ENROLLED BY THE ACCEPTED COMMIT ITSELF, AGAINST A REAL
 * POSTGRESQL.
 *
 * The roster row (`dm_group_members`) used to be written by the committer's `registerMember`, a
 * separate call made after it READ the gate's accept. An Add whose answer was lost - settled later by
 * a resubmission the gate answered `duplicate`, or held offline and sent from the outbox on return -
 * merged and sent its Welcome without that call: the invitee held a leaf and no seat, every Welcome
 * was refused `welcome_target_not_member`, and the stray sweep took the leaf back out (the DUP and
 * OFF rows of the 1.4.1 campaign, 2026-10-25). These cases fail on that state: the enrolment must be
 * there after the advance with no client call at all, and a duplicate must find exactly the state the
 * first accept left (docs/wiki/protocols/mls-protocol.md, "An Add enrols its people with the
 * accepted commit").
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
import { memberCommitFrame } from '../testing/mlsFrameFixture';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const dir = join(__dirname, '..', 'migrations');
const MIGRATION_036 = readFileSync(join(dir, '036_seat_evictions.sql'), 'utf8');
const MIGRATION_038 = readFileSync(join(dir, '038_group_member_awaiting_admission.sql'), 'utf8');

const GROUP = '00000000-0000-4000-8000-0000000000b1';
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

  /** Only what the commit gate and a Welcome store use. */
  const redis = {
    smembers: async () => [],
    sadd: async () => 0,
    srem: async () => 0,
    smismember: async (_key: string, ...members: string[]) => members.map(() => 0),
    set: async () => 'OK',
    eval: async () => 1,
    hdel: async () => 0,
    hgetall: async () => ({}),
    mget: async (...keys: string[]) => keys.flat().map(() => null),
    exists: async () => 0,
    publish: async () => 1,
  };

  /** The Add of `INVITEE`'s device, staged on `epoch` - the same bytes on every submission. */
  const addCommit = (epoch: number) =>
    service.validateCommit(
      {
        groupId: GROUP,
        deviceId: INVITER.deviceId,
        baseEpoch: epoch,
        proto: memberCommitFrame(GROUP, BigInt(epoch)),
        senderId: INVITER.userId,
        excludeDeviceIds: [`${INVITEE.userId}:${INVITEE.deviceId}`],
        admits: [INVITEE],
      },
      INVITER.userId
    );
  /** The Welcome of that Add, as `mergeSettled` sends it after a settlement. */
  const welcome = () =>
    service.sendWelcome(INVITER.userId, {
      groupId: GROUP,
      targetUserId: INVITEE.userId,
      targetDeviceId: INVITEE.deviceId,
      senderUserId: INVITER.userId,
      welcomePayload: 'd2VsY29tZQ==',
    });
  /** What the roster holds for the invitee: its seats and its open membership intervals. */
  const enrolment = async () => {
    const [seats]: { n: string }[] = await q(
      `SELECT COUNT(*) AS n FROM dm_group_members WHERE "groupId" = $1 AND "userId" = $2`,
      [GROUP, INVITEE.userId]
    );
    const [open]: { n: string }[] = await q(
      `SELECT COUNT(*) AS n FROM dm_group_membership_intervals
       WHERE "groupId" = $1 AND "userId" = $2 AND "leftAt" IS NULL`,
      [GROUP, INVITEE.userId]
    );
    return { seats: Number(seats.n), openIntervals: Number(open.n) };
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
  });

  beforeEach(async () => {
    await q(`UPDATE dm_groups SET "activeEpoch" = 1 WHERE id = $1`, [GROUP]);
    await q(`DELETE FROM mls_commit_log`);
    await q(`DELETE FROM dm_device_group_memberships`);
    await q(`DELETE FROM dm_group_members`);
    await q(`DELETE FROM dm_group_membership_intervals`);
    await q(`DELETE FROM queued_message`);
    await q(`DELETE FROM user_blocks`);
    await q(`INSERT INTO dm_group_members ("groupId", "userId", role) VALUES ($1, $2, 'member')`, [
      GROUP,
      INVITER.userId,
    ]);
    await q(
      `INSERT INTO dm_device_group_memberships ("userId", "deviceId", "groupId", status)
       VALUES ($1, $2, $3, 'active')`,
      [INVITER.userId, INVITER.deviceId, GROUP]
    );
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
    expect(await enrolment()).toEqual({ seats: 1, openIntervals: 1 });
    await expect(refusalOf(welcome())).resolves.toBeNull();
  });

  it('an Add whose answer was lost, settled by a resubmission answered duplicate, leaves the same state as a direct accept', async () => {
    // The first request lands and its answer is lost: the client never sees this accept.
    await addCommit(1);
    const afterAccept = await enrolment();

    // The settlement resubmits the same bytes; the gate answers them as the commit it already took.
    await expect(addCommit(1)).resolves.toEqual({ accepted: true, newEpoch: 2, duplicate: true });

    expect(await enrolment()).toEqual(afterAccept);
    expect(afterAccept).toEqual({ seats: 1, openIntervals: 1 });
    // ...so the Welcome `mergeSettled` then sends is accepted, never `welcome_target_not_member`.
    await expect(refusalOf(welcome())).resolves.toBeNull();
  });

  it('a block between the inviter and the invitee enrols nobody, and the Welcome is refused by its code', async () => {
    await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [
      INVITEE.userId,
      INVITER.userId,
    ]);

    // The commit still lands - the route's refusal never undid one either - but no seat is written.
    await expect(addCommit(1)).resolves.toMatchObject({ accepted: true });

    expect(await enrolment()).toEqual({ seats: 0, openIntervals: 0 });
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
    expect(await enrolment()).toEqual({ seats: 1, openIntervals: 0 });
  });
});
