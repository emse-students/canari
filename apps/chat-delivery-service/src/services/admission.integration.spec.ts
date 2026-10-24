/**
 * A LINK JOIN IS AN ASK UNTIL A MEMBER'S ADD ANSWERS IT, AGAINST A REAL POSTGRESQL - migration 038
 * included.
 *
 * The invitation link writes the person on the roster with `pending` seats, and members no longer
 * Add a person who holds no leaf on a server row's word: a member is asked (Add / Decline). The seat
 * was also the whole of what let its owner read the external-join base and have an external commit
 * accepted, so the joiner admitted itself around the member. `dm_group_members.awaitingAdmission`
 * carries the one fact that tells the two apart - the seat came from a link - to where it is decided:
 * the base and the commit gate refuse it, the joiner's own membership read says to wait, and the
 * first member commit that admits one of the person's devices lifts it (docs/wiki/protocols/
 * mls-protocol.md, "Who admits a new person").
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads;
 * CI's `test-chat-delivery-integration` sets it and refuses a skip. Locally:
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- admission.integration
 *
 * A throwaway schema, created before the DataSource initializes and dropped at the end; Redis is a
 * set in memory.
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
import { InvitationsController } from '../controllers/invitations.controller';
import { externalCommitFrame, memberCommitFrame } from '../testing/mlsFrameFixture';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const dir = join(__dirname, '..', 'migrations');
const MIGRATION_036 = readFileSync(join(dir, '036_seat_evictions.sql'), 'utf8');
const MIGRATION_038 = readFileSync(join(dir, '038_group_member_awaiting_admission.sql'), 'utf8');

const GROUP = '00000000-0000-4000-8000-0000000000a8';
const MEMBER = { userId: 'member', deviceId: 'dev-m' };
const JOINER = { userId: 'joiner', deviceId: 'dev-j' };

/** The status and refusal name of a rejected call, or `null` when it resolved. */
const refusalOf = (call: Promise<unknown>) =>
  call.then(
    () => null,
    (e: { getStatus: () => number; getResponse: () => { code?: string; error?: string } }) => ({
      status: e.getStatus(),
      name: e.getResponse().code ?? e.getResponse().error,
    })
  );

maybe('a link join waits for a member admission (PostgreSQL)', () => {
  const schema = `admission_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: MessagingService;
  const routes = new Map<string, Set<string>>();
  const setOf = (key: string) => {
    let set = routes.get(key);
    if (!set) routes.set(key, (set = new Set()));
    return set;
  };
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** The gateway's routing sets and the commit lock, in memory - only what these paths use. */
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
    smismember: async (key: string, ...members: string[]) =>
      members.map((m) => (setOf(key).has(m) ? 1 : 0)),
    set: async () => 'OK',
    eval: async () => 1,
    hdel: async () => 0,
    hgetall: async () => ({}),
    mget: async (...keys: string[]) => keys.flat().map(() => null),
  };

  const invitations = () =>
    new InvitationsController(
      ds.getRepository(DeviceGroupMembership),
      ds.getRepository(GroupMember),
      ds.getRepository(Group),
      ds.getRepository(GroupInvite),
      ds.getRepository(KeyPackage),
      ds.getRepository(RevokedDevice),
      ds.getRepository(QueuedMessage),
      redis as unknown as Redis,
      { notifyWelcomeRequest: async () => undefined } as unknown as MessagingService
    );
  const awaiting = async (who: { userId: string }): Promise<boolean | null> => {
    const rows: { awaitingAdmission: boolean }[] = await q(
      `SELECT "awaitingAdmission" FROM dm_group_members WHERE "groupId" = $1 AND "userId" = $2`,
      [GROUP, who.userId]
    );
    return rows[0]?.awaitingAdmission ?? null;
  };
  const epochOf = async (): Promise<number> => {
    const [row]: { activeEpoch: number }[] = await q(
      `SELECT "activeEpoch" FROM dm_groups WHERE id = $1`,
      [GROUP]
    );
    return Number(row.activeEpoch);
  };
  const memberCommit = (epoch: number, admits?: { userId: string; deviceId: string }[]) =>
    service.validateCommit(
      {
        groupId: GROUP,
        deviceId: MEMBER.deviceId,
        baseEpoch: epoch,
        proto: memberCommitFrame(GROUP, BigInt(epoch)),
        senderId: MEMBER.userId,
        ...(admits ? { admits } : {}),
      },
      MEMBER.userId
    );
  const joinerExternalCommit = (epoch: number) =>
    service.validateCommit(
      {
        groupId: GROUP,
        deviceId: JOINER.deviceId,
        baseEpoch: epoch,
        proto: externalCommitFrame(GROUP, BigInt(epoch), `${JOINER.userId}:${JOINER.deviceId}`),
        senderId: JOINER.userId,
      },
      JOINER.userId
    );
  const acceptLink = async () => {
    const invite = await ds
      .getRepository(GroupInvite)
      .save(
        ds
          .getRepository(GroupInvite)
          .create({ groupId: GROUP, token: `it-${Math.random()}`, createdBy: MEMBER.userId })
      );
    return invitations().acceptGroupInvite(invite.token, JOINER.userId);
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
    // The column as production gets it: the entity already made it, so the migration must replay
    // as a no-op on a table that has it.
    await q(MIGRATION_038);
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
    await q(`INSERT INTO dm_groups (id, "isGroup", "activeEpoch") VALUES ($1, true, 3)`, [GROUP]);
  });

  beforeEach(async () => {
    for (const set of routes.values()) set.clear();
    await q(`UPDATE dm_groups SET "activeEpoch" = 3 WHERE id = $1`, [GROUP]);
    await q(`DELETE FROM mls_commit_log`);
    await q(`DELETE FROM dm_device_group_memberships`);
    await q(`DELETE FROM dm_group_members`);
    await q(`DELETE FROM dm_group_membership_intervals`);
    await q(`DELETE FROM queued_message`);
    await q(`INSERT INTO dm_group_members ("groupId", "userId", role) VALUES ($1, $2, 'member')`, [
      GROUP,
      MEMBER.userId,
    ]);
    await q(
      `INSERT INTO dm_device_group_memberships ("userId", "deviceId", "groupId", status)
       VALUES ($1, $2, $3, 'active')`,
      [MEMBER.userId, MEMBER.deviceId, GROUP]
    );
    for (const who of [MEMBER, JOINER]) {
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

  it('writes the link seat as awaiting a member, and tells the joiner device so', async () => {
    await expect(acceptLink()).resolves.toEqual({ groupId: GROUP, alreadyMember: false });

    expect(await awaiting(JOINER)).toBe(true);
    // The member's seat, written by nobody's link, never awaits.
    expect(await awaiting(MEMBER)).toBe(false);
    const rows = await invitations().getDeviceMemberships(
      JOINER.userId,
      JOINER.deviceId,
      JOINER.userId
    );
    expect(rows).toEqual([
      expect.objectContaining({
        groupId: GROUP,
        status: 'pending',
        welcomeQueued: false,
        addInFlight: false,
        awaitingAdmission: true,
      }),
    ]);
  });

  it('withholds the external-join base and refuses the joiner every commit until a member admits them', async () => {
    await acceptLink();

    // 409, never the 403 of no seat: a client reads a 403 there as "not a member" and retires.
    await expect(refusalOf(service.getGroupInfo(GROUP, JOINER.userId))).resolves.toEqual({
      status: 409,
      name: 'awaiting_admission',
    });
    await expect(refusalOf(joinerExternalCommit(3))).resolves.toEqual({
      status: 403,
      name: 'NOT_A_MEMBER',
    });
    expect(await epochOf()).toBe(3);
    // A member commit from the joiner's pending device is refused the same way.
    await expect(
      refusalOf(
        service.validateCommit(
          {
            groupId: GROUP,
            deviceId: JOINER.deviceId,
            baseEpoch: 3,
            proto: memberCommitFrame(GROUP, 3n),
            senderId: JOINER.userId,
          },
          JOINER.userId
        )
      )
    ).resolves.toEqual({ status: 403, name: 'NOT_A_MEMBER' });
    expect(await epochOf()).toBe(3);
  });

  it("a member's commit that admits none of the joiner's devices leaves the ask standing", async () => {
    await acceptLink();

    await expect(memberCommit(3)).resolves.toMatchObject({ accepted: true });

    expect(await awaiting(JOINER)).toBe(true);
  });

  it("a member's Add admits the joiner: the ask is lifted with the advance, and the joiner may rejoin by themselves", async () => {
    await acceptLink();

    await expect(memberCommit(3, [JOINER])).resolves.toMatchObject({ accepted: true });

    expect(await epochOf()).toBe(4);
    expect(await awaiting(JOINER)).toBe(false);
    // From here the person is a member like any other: a later lost state is healed by their own
    // external commit, which is what the seat was always for.
    await expect(refusalOf(service.getGroupInfo(GROUP, JOINER.userId))).resolves.toBeNull();
    await expect(joinerExternalCommit(4)).resolves.toMatchObject({ accepted: true });
    expect(await epochOf()).toBe(5);
  });

  it('a declined joiner holds no seat at all, and the base answers the 403 of a non-member', async () => {
    await acceptLink();
    // A member's Decline is `removeMemberFromServer`: the roster row and the device seats go.
    await q(`DELETE FROM dm_device_group_memberships WHERE "userId" = $1`, [JOINER.userId]);
    await q(`DELETE FROM dm_group_members WHERE "userId" = $1`, [JOINER.userId]);

    await expect(refusalOf(service.getGroupInfo(GROUP, JOINER.userId))).resolves.toMatchObject({
      status: 403,
    });
    await expect(refusalOf(joinerExternalCommit(3))).resolves.toEqual({
      status: 403,
      name: 'NOT_A_MEMBER',
    });
  });
});
