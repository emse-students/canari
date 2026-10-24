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
import { DataSource, LessThan } from 'typeorm';
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
import { MembersController } from '../controllers/members.controller';
import { InternalController } from '../controllers/internal.controller';
import { CallsService } from './calls.service';
import { externalCommitFrame, memberCommitFrame } from '../testing/mlsFrameFixture';
import { expireUnansweredAsks, seatKey } from '../utils/group-membership';
import { STALE_PENDING_INVITATION_MS } from '../retention.constants';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const dir = join(__dirname, '..', 'migrations');
const MIGRATION_036 = readFileSync(join(dir, '036_seat_evictions.sql'), 'utf8');
const MIGRATION_038 = readFileSync(join(dir, '038_group_member_awaiting_admission.sql'), 'utf8');

const GROUP = '00000000-0000-4000-8000-0000000000a8';
const MEMBER = { userId: 'member', deviceId: 'dev-m' };
const JOINER = { userId: 'joiner', deviceId: 'dev-j' };
/** A second member, whose device has not processed the first member's Add. */
const OTHER = { userId: 'other', deviceId: 'dev-o' };

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
    // Every member device is online, so a welcome_request is forwarded rather than stored.
    exists: async () => 1,
    publish: async () => 1,
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
  /** A member's Decline of `target`'s ask through its route, as the member `who`. */
  const decline = (who: { userId: string }, target: { userId: string } = JOINER) =>
    members().declineJoinRequest(GROUP, target.userId, who.userId);
  /** How many rows `table` holds for `who` in the group. */
  const rowsOf = async (table: string, who: { userId: string }): Promise<number> => {
    const [row]: { n: string }[] = await q(
      `SELECT COUNT(*) AS n FROM ${table} WHERE "groupId" = $1 AND "userId" = $2`,
      [GROUP, who.userId]
    );
    return Number(row.n);
  };
  /**
   * The stale-pending purge as `AppController.cleanupStalePendingInvitations` runs it: the asks
   * nobody answered expire whole, and only the other stale rows lose their device row alone.
   */
  const purgeStalePending = async () => {
    const expiry = new Date(Date.now() - STALE_PENDING_INVITATION_MS);
    const stale = await ds.getRepository(DeviceGroupMembership).find({
      where: { status: 'pending', pendingSince: LessThan(expiry) },
    });
    const { awaiting: asks } = await expireUnansweredAsks(ds.manager, stale, expiry);
    for (const row of stale) {
      if (asks.has(seatKey(row.groupId, row.userId))) continue;
      await ds.getRepository(DeviceGroupMembership).delete({
        userId: row.userId,
        deviceId: row.deviceId,
        groupId: row.groupId,
      });
    }
  };
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
    // A stored Welcome is what these cases read; its realtime publish is the gateway's.
    jest
      .spyOn(service as unknown as { deliverWelcome: () => Promise<void> }, 'deliverWelcome')
      .mockResolvedValue(undefined);
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
    await q(`DELETE FROM dm_seat_evictions`);
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

    await expect(decline(MEMBER)).resolves.toEqual({ outcome: 'withdrawn' });

    expect(await rowsOf('dm_group_members', JOINER)).toBe(0);
    expect(await rowsOf('dm_device_group_memberships', JOINER)).toBe(0);
    // Never in, so nothing of a removal is recorded: no eviction, no exclusion interval left behind.
    expect(await rowsOf('dm_group_membership_intervals', JOINER)).toBe(0);
    expect(await rowsOf('dm_seat_evictions', JOINER)).toBe(0);
    await expect(refusalOf(service.getGroupInfo(GROUP, JOINER.userId))).resolves.toMatchObject({
      status: 403,
    });
    await expect(refusalOf(joinerExternalCommit(3))).resolves.toEqual({
      status: 403,
      name: 'NOT_A_MEMBER',
    });
  });

  /**
   * (1) A DECLINE NEVER STRIPS AN ADMITTED PERSON. Member A's Add lifts the ask; member B, whose
   * device has not processed that epoch, still sees the ask and declines. The generic removal deleted
   * the admitted person's seat and devices and recorded an eviction - a leaf with no seat. The
   * guarded withdrawal answers `already-admitted` and touches nothing.
   */
  it("a Decline after another member's Add answers already-admitted and leaves the person whole", async () => {
    await acceptLink();
    await q(`INSERT INTO dm_group_members ("groupId", "userId", role) VALUES ($1, $2, 'member')`, [
      GROUP,
      OTHER.userId,
    ]);
    await expect(memberCommit(3, [JOINER])).resolves.toMatchObject({ accepted: true });

    await expect(decline(OTHER)).resolves.toEqual({ outcome: 'already-admitted' });

    expect(await awaiting(JOINER)).toBe(false);
    expect(await rowsOf('dm_device_group_memberships', JOINER)).toBe(1);
    expect(await rowsOf('dm_seat_evictions', JOINER)).toBe(0);
    const [interval]: { leftAt: Date | null }[] = await q(
      `SELECT "leftAt" FROM dm_group_membership_intervals WHERE "groupId" = $1 AND "userId" = $2`,
      [GROUP, JOINER.userId]
    );
    expect(interval.leftAt).toBeNull();
  });

  it('an Add and a Decline racing each other leave one consistent answer, never a leaf with no seat', async () => {
    for (let round = 0; round < 5; round++) {
      await q(`UPDATE dm_groups SET "activeEpoch" = 3 WHERE id = $1`, [GROUP]);
      await q(`DELETE FROM mls_commit_log`);
      await q(`DELETE FROM dm_device_group_memberships WHERE "userId" = $1`, [JOINER.userId]);
      await q(`DELETE FROM dm_group_members WHERE "userId" = $1`, [JOINER.userId]);
      await acceptLink();

      const [added, declined] = await Promise.allSettled([
        memberCommit(3, [JOINER]),
        decline(MEMBER),
      ]);

      const admittedRows: { admittedAtEpoch: number | null }[] = await q(
        `SELECT "admittedAtEpoch" FROM dm_device_group_memberships
         WHERE "groupId" = $1 AND "userId" = $2`,
        [GROUP, JOINER.userId]
      );
      const observed = {
        declined: declined.status === 'fulfilled' ? declined.value.outcome : 'rejected',
        added: added.status,
        seat: await awaiting(JOINER),
        devices: await rowsOf('dm_device_group_memberships', JOINER),
        admittedRows,
      };
      // Two orders, each with ONE consistent end state - chosen by what the Decline answered, and
      // asserted whole, so no expectation is skipped on either side.
      // - The Decline went first: the ask is gone whole. An Add accepted after it is an ordinary
      //   invitation by that member - its own admitted row, the roster row its client registers
      //   next - never a leftover of the withdrawn ask: a Decline does not undo a later Add.
      // - The Add went first: the Decline answers `already-admitted` and leaves the person whole.
      const declineFirst = {
        declined: 'withdrawn',
        added: added.status,
        seat: null,
        // Not this order's question: the admitted rows below are.
        devices: observed.devices,
        admittedRows: added.status === 'fulfilled' ? [{ admittedAtEpoch: 4 }] : [],
      };
      const addFirst = {
        declined: 'already-admitted',
        added: 'fulfilled',
        seat: false,
        devices: 1,
        // Not this order's question: one device row is.
        admittedRows: observed.admittedRows,
      };
      expect(observed).toEqual(observed.declined === 'withdrawn' ? declineFirst : addFirst);
    }
  });

  /**
   * (2) A MEMBER WHOSE CLIENT PREDATES `admits` STILL ADMITS: it Adds from the `pending` row with a
   * commit that declares nobody, then sends the Welcome apart. The Welcome it stores lifts the ask, so
   * the joiner's device turns active under no flag and commits like any member.
   */
  it("an old client's Add - a commit with no admits, then a separate Welcome - admits the joiner", async () => {
    await acceptLink();
    // Before any Welcome, the joiner may not report itself active: a 409, never a 403.
    await expect(
      service.activateDeviceMembership(JOINER.userId, JOINER.deviceId, GROUP, {
        authority: 'report',
      })
    ).resolves.toMatchObject({ ok: false, reason: 'awaiting_admission' });

    await expect(memberCommit(3)).resolves.toMatchObject({ accepted: true });
    expect(await awaiting(JOINER)).toBe(true);
    await expect(
      service.sendWelcome(MEMBER.userId, {
        groupId: GROUP,
        targetUserId: JOINER.userId,
        targetDeviceId: JOINER.deviceId,
        senderUserId: MEMBER.userId,
        welcomePayload: 'V0VMQ09NRQ==',
      })
    ).resolves.toEqual({ status: 'queued' });

    expect(await awaiting(JOINER)).toBe(false);
    await expect(
      service.activateDeviceMembership(JOINER.userId, JOINER.deviceId, GROUP, {
        authority: 'report',
      })
    ).resolves.toMatchObject({ ok: true });
    // A member now: a commit of theirs is accepted.
    await expect(
      service.validateCommit(
        {
          groupId: GROUP,
          deviceId: JOINER.deviceId,
          baseEpoch: 4,
          proto: memberCommitFrame(GROUP, 4n),
          senderId: JOINER.userId,
        },
        JOINER.userId
      )
    ).resolves.toMatchObject({ accepted: true });
  });

  it('a person still awaiting a member may not Welcome a device of their own to lift their ask', async () => {
    await acceptLink();

    await expect(
      refusalOf(
        service.sendWelcome(JOINER.userId, {
          groupId: GROUP,
          targetUserId: JOINER.userId,
          targetDeviceId: JOINER.deviceId,
          senderUserId: JOINER.userId,
          welcomePayload: 'V0VMQ09NRQ==',
        })
      )
    ).resolves.toMatchObject({ status: 403 });
    expect(await awaiting(JOINER)).toBe(true);
  });

  /**
   * (3) AN ASK NOBODY ANSWERED EXPIRES WHOLE. Purging its device rows alone left the roster flag:
   * the joiner then read no `awaiting-admission`, met a 409 at the base and raised a fresh ask on
   * every cadence. The seat goes as a Decline takes it, and the joiner then meets the 403 of a
   * non-member.
   */
  it('the stale-pending purge withdraws an unanswered ask whole, and keeps one still live', async () => {
    await acceptLink();
    await q(
      `UPDATE dm_device_group_memberships SET "pendingSince" = now() - interval '30 days'
       WHERE "userId" = $1`,
      [JOINER.userId]
    );

    await purgeStalePending();

    expect(await rowsOf('dm_group_members', JOINER)).toBe(0);
    expect(await rowsOf('dm_device_group_memberships', JOINER)).toBe(0);
    expect(await rowsOf('dm_group_membership_intervals', JOINER)).toBe(0);
    await expect(refusalOf(service.getGroupInfo(GROUP, JOINER.userId))).resolves.toMatchObject({
      status: 403,
    });

    // A second device that asked recently keeps the whole ask alive.
    await acceptLink();
    await q(
      `UPDATE dm_device_group_memberships SET "pendingSince" = now() - interval '30 days'
       WHERE "userId" = $1`,
      [JOINER.userId]
    );
    await q(
      `INSERT INTO key_package ("userId", "deviceId", "keyPackage") VALUES ($1, 'dev-j2', 'kp')
       ON CONFLICT DO NOTHING`,
      [JOINER.userId]
    );
    await q(
      `INSERT INTO dm_device_group_memberships ("userId", "deviceId", "groupId", status)
       VALUES ($1, 'dev-j2', $2, 'pending')`,
      [JOINER.userId, GROUP]
    );

    await purgeStalePending();

    expect(await awaiting(JOINER)).toBe(true);
    // ...and its stale device row is not purged alone either, which would strand the joiner.
    expect(await rowsOf('dm_device_group_memberships', JOINER)).toBe(2);
  });

  /**
   * (4) A SEAT STILL AWAITING A MEMBER ANSWERS NOTHING FOR THE GROUP (review of #2358, B1). Counted
   * as a membership by the controllers' caller checks, it enrolled an accomplice whose seat read as
   * not awaiting - who then read the base and entered by external commit with no member's Add. Every
   * such refusal is the 409 `awaiting_admission`, never the 403 a client retires a conversation on;
   * leaving is the one thing it may do.
   */
  describe('a seat awaiting a member is not a membership', () => {
    const ACCOMPLICE = { userId: 'accomplice' };
    const AWAITING = { status: 409, name: 'awaiting_admission' };

    it('cannot enrol another user, who therefore cannot read the base nor join by external commit', async () => {
      await acceptLink();

      await expect(
        refusalOf(members().addGroupMember(GROUP, { userId: ACCOMPLICE.userId }, JOINER.userId))
      ).resolves.toEqual(AWAITING);

      expect(await rowsOf('dm_group_members', ACCOMPLICE)).toBe(0);
      await expect(
        refusalOf(service.getGroupInfo(GROUP, ACCOMPLICE.userId))
      ).resolves.toMatchObject({ status: 403 });
    });

    it('cannot remove a member from the roster, but may withdraw its own seat', async () => {
      await acceptLink();

      await expect(
        refusalOf(members().removeGroupMember(GROUP, MEMBER.userId, JOINER.userId))
      ).resolves.toEqual(AWAITING);
      expect(await rowsOf('dm_group_members', MEMBER)).toBe(1);

      await expect(
        refusalOf(members().removeGroupMember(GROUP, JOINER.userId, JOINER.userId))
      ).resolves.toBeNull();
      expect(await rowsOf('dm_group_members', JOINER)).toBe(0);
    });

    it('cannot mint an invitation link', async () => {
      await acceptLink();

      await expect(
        refusalOf(invitations().createGroupInvite(GROUP, JOINER.userId))
      ).resolves.toEqual(AWAITING);
    });

    it('cannot read the roster, one group or many', async () => {
      await acceptLink();

      await expect(refusalOf(members().getGroupUserMembers(GROUP, JOINER.userId))).resolves.toEqual(
        AWAITING
      );
      await expect(refusalOf(members().getGroupMembers(GROUP, JOINER.userId))).resolves.toEqual(
        AWAITING
      );
      await expect(
        members().getGroupRosters({ groupIds: [GROUP] }, JOINER.userId)
      ).resolves.toMatchObject({ rosters: {}, refused: [GROUP] });
      // An admitted member reads it, the ask named as one.
      await expect(members().getGroupUserMembers(GROUP, MEMBER.userId)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ userId: JOINER.userId, awaitingAdmission: true }),
          expect.objectContaining({ userId: MEMBER.userId, awaitingAdmission: false }),
        ])
      );
    });

    /** The routes that read the flag nowhere before the re-review of #2358 (F1). */
    it('cannot read the history, one group or in a batch', async () => {
      await acceptLink();

      await expect(
        refusalOf(service.getHistory(GROUP, undefined, JOINER.userId, undefined))
      ).resolves.toEqual(AWAITING);
      const authorize = (
        service as unknown as {
          authorizeHistoryGroups: (
            ids: string[],
            user: string,
            admin: undefined,
            reject: boolean
          ) => Promise<Set<string>>;
        }
      ).authorizeHistoryGroups.bind(service);
      await expect(authorize([GROUP], JOINER.userId, undefined, false)).resolves.toEqual(new Set());
      await expect(
        service.getHistoryBatch([{ groupId: GROUP }], JOINER.userId, undefined)
      ).resolves.toMatchObject({ histories: { [GROUP]: [] } });
      // The member it is withheld from the joiner for still reads it.
      await expect(authorize([GROUP], MEMBER.userId, undefined, true)).resolves.toEqual(
        new Set([GROUP])
      );
    });

    it('cannot read the exclusion windows a history answer is filtered on', async () => {
      await acceptLink();

      await expect(refusalOf(members().getGroupExclusions(GROUP, JOINER.userId))).resolves.toEqual(
        AWAITING
      );
      await expect(members().getGroupExclusions(GROUP, MEMBER.userId)).resolves.toMatchObject({
        addressedAnswers: true,
      });
    });

    it('shares no presence with the members, in either direction', async () => {
      await acceptLink();
      await q(
        `INSERT INTO dm_group_members ("groupId", "userId", role) VALUES ($1, $2, 'member')`,
        [GROUP, OTHER.userId]
      );
      const internal = new InternalController(
        null as never,
        null as never,
        null as never,
        ds.getRepository(Group),
        ds.getRepository(GroupMember),
        null as never,
        null as never,
        null as never,
        null as never,
        null as never,
        null as never,
        redis as unknown as Redis,
        null as never
      );
      Object.defineProperty(internal, 'secret', { value: 'it-secret', writable: true });
      const audience = (viewerId: string, userIds: string[]) =>
        internal.presenceSharedConversations('it-secret', { viewerId, userIds });

      await expect(audience(MEMBER.userId, [JOINER.userId, OTHER.userId])).resolves.toEqual({
        userIds: [OTHER.userId],
      });
      await expect(audience(JOINER.userId, [MEMBER.userId, OTHER.userId])).resolves.toEqual({
        userIds: [],
      });
    });

    it('places, joins and rings no call, and no ring reaches it', async () => {
      await acceptLink();
      await q(
        `CREATE TABLE IF NOT EXISTS platform_config (id int PRIMARY KEY, calls_mode text NOT NULL)`
      );
      await q(
        `INSERT INTO platform_config (id, calls_mode) VALUES (1, 'audio_video')
         ON CONFLICT (id) DO UPDATE SET calls_mode = EXCLUDED.calls_mode`
      );
      const calls = new CallsService(
        ds.getRepository(GroupMember),
        ds.getRepository(PushToken),
        redis as unknown as Redis,
        null as never,
        null as never
      );

      await expect(refusalOf(calls.initiateCall(JOINER.userId, GROUP))).resolves.toEqual(AWAITING);
      await expect(
        refusalOf(calls.requestRoomToken(JOINER.userId, GROUP, 'room'))
      ).resolves.toEqual(AWAITING);
      await expect(refusalOf(calls.getIceServers(JOINER.userId, GROUP, 'call'))).resolves.toEqual(
        AWAITING
      );
      await expect(
        refusalOf(calls.ringGroup(JOINER.userId, GROUP, 'call', false))
      ).resolves.toEqual(AWAITING);
      await expect(
        refusalOf(calls.endRing(JOINER.userId, GROUP, 'call', 'cancelled'))
      ).resolves.toEqual(AWAITING);

      // A member's ring: the waiting seat is neither a callee nor ringable.
      const fanOut = calls as unknown as {
        otherMemberIds: (groupId: string, userId: string) => Promise<string[]>;
        membersWhoTakeCalls: (groupId: string, callId: string, ids: string[]) => Promise<string[]>;
      };
      await expect(fanOut.otherMemberIds(GROUP, MEMBER.userId)).resolves.toEqual([]);
      await expect(
        fanOut.membersWhoTakeCalls(GROUP, 'call', [JOINER.userId, MEMBER.userId])
      ).resolves.toEqual([MEMBER.userId]);
    });
  });

  /**
   * (5) A DECLINE TELLS AN ASK FROM A SEAT THAT NEVER WAS ONE (review of #2358, P2-1). A roster user
   * with no leaf and no flag - a seat written before migration 038, a member's invite between its
   * roster write and its Add - was answered `already-admitted`, which nothing on record supported.
   */
  it('a Decline of a seat that never awaited a member, and holds no trace of an Add, answers not-awaiting', async () => {
    await q(`INSERT INTO dm_group_members ("groupId", "userId", role) VALUES ($1, $2, 'member')`, [
      GROUP,
      OTHER.userId,
    ]);
    await q(
      `INSERT INTO dm_device_group_memberships ("userId", "deviceId", "groupId", status)
       VALUES ($1, $2, $3, 'pending')`,
      [OTHER.userId, OTHER.deviceId, GROUP]
    );

    await expect(decline(MEMBER, OTHER)).resolves.toEqual({ outcome: 'not-awaiting' });

    expect(await rowsOf('dm_group_members', OTHER)).toBe(1);
    expect(await rowsOf('dm_device_group_memberships', OTHER)).toBe(1);
  });

  it('a member reads which pending rows are asks', async () => {
    await acceptLink();

    const rows = await invitations().getPendingInvitations(
      MEMBER.userId,
      MEMBER.deviceId,
      MEMBER.userId
    );

    // One row per device of the joiner the link seated (an earlier case registered a second one).
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => [r.userId, r.groupId, r.awaitingAdmission])).toEqual(
      rows.map(() => [JOINER.userId, GROUP, true])
    );
  });

  /**
   * (6) A WAITING DEVICE ASKS ON EVERY RECOVERY CADENCE FOR UP TO 14 DAYS (review of #2358, P2-3):
   * every relay is still made, and its lines are said at the 1st, 10th, 100th... ask of that device.
   */
  it('relays every ask of a waiting device, and says it at its 1st and 10th repeat only', async () => {
    await acceptLink();
    const logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    logged.mockClear();

    const answers: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { status } = await service.notifyWelcomeRequest(JOINER.userId, {
        groupId: GROUP,
        requesterUserId: JOINER.userId,
        requesterDeviceId: JOINER.deviceId,
      });
      answers.push(status);
    }

    expect(answers).toEqual(Array.from({ length: 10 }, () => 'forwarded'));
    const starts = logged.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('[WELCOME_REQ]') && line.includes('START'));
    expect(starts.map((line) => /repeat=(\d+)/.exec(line)?.[1])).toEqual(['1', '10']);
  });
});
