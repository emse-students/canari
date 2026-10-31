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
import { MembersController } from '../controllers/members.controller';
import { InternalController } from '../controllers/internal.controller';
import { CallsService } from './calls.service';
import { externalCommitFrame, memberCommitFrame } from '../testing/mlsFrameFixture';
import { AppController } from '../app.controller';
import { JOIN_ASK_PUBLISH_LUA } from './addressing';
import { finishJoinAskWorkInFlight, joinAskAnnouncementsSettled } from '../utils/join-ask-announce';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const dir = join(__dirname, '..', 'migrations');
const MIGRATION_036 = readFileSync(join(dir, '036_seat_evictions.sql'), 'utf8');
const MIGRATION_038 = readFileSync(join(dir, '038_group_member_awaiting_admission.sql'), 'utf8');
const MIGRATION_039 = readFileSync(join(dir, '039_departure_seat_generation.sql'), 'utf8');

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
    eval: async (..._args: unknown[]) => 1,
    hdel: async () => 0,
    hset: async () => 1,
    hgetall: async () => ({}),
    mget: async (...keys: string[]) => keys.flat().map(() => null),
    // Every member device is online, so a welcome_request is forwarded rather than stored.
    exists: async (_key: string) => 1,
    publish: async (_channel: string, _payload: string) => 1,
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
      // The revoked-device bindings are read by the revoked-leaves question alone, not on this path.
      null as unknown as never,
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
   * The stale-pending purge - THE cron itself, `AppController.cleanupStalePendingInvitations`, not a
   * copy of it: the asks nobody answered expire whole (and are announced), and only the other stale
   * rows lose their device row alone.
   */
  const purgeStalePending = () =>
    (
      new AppController(
        ds.getRepository(QueuedMessage),
        ds.getRepository(KeyPackage),
        ds.getRepository(OneTimeKeyPackage),
        ds.getRepository(Group),
        ds.getRepository(GroupMember),
        ds.getRepository(DeviceGroupMembership),
        ds.getRepository(RevokedDevice),
        ds.getRepository(PushToken),
        ds.getRepository(MlsGroupInfo),
        ds.getRepository(MlsCommitLog),
        redis as unknown as Redis,
        service
      ) as unknown as { cleanupStalePendingInvitations(): Promise<void> }
    ).cleanupStalePendingInvitations();
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
    await q(MIGRATION_039);
    // core-service's table, as its migration shapes it: an awaiting seat a commit admits is asked
    // for a block like any newcomer (`enrolAdmittedPeople`).
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
    // A stored Welcome is what these cases read; its realtime publish is the gateway's.
    jest
      .spyOn(service as unknown as { deliverWelcome: () => Promise<void> }, 'deliverWelcome')
      .mockResolvedValue(undefined);
    await q(`INSERT INTO dm_groups (id, "isGroup", "activeEpoch") VALUES ($1, true, 3)`, [GROUP]);
  });

  beforeEach(async () => {
    // An announcement a previous case started reads rows this one is about to delete.
    await joinAskAnnouncementsSettled();
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
    await joinAskAnnouncementsSettled();
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

  it("a push's Add never answers the ask: refused awaiting_admission under the seat lock, nothing advanced", async () => {
    // The background Welcome a member's shut phone answers (`push/send-welcome-and-commit`) is no
    // member's gesture, whatever the phone's tree says (a removed member's leaf can outlive them).
    await acceptLink();

    await expect(
      service.validateCommit(
        {
          groupId: GROUP,
          deviceId: MEMBER.deviceId,
          baseEpoch: 3,
          proto: memberCommitFrame(GROUP, 3n),
          senderId: MEMBER.userId,
          admits: [JOINER],
        },
        MEMBER.userId,
        { mayAnswerAsk: false }
      )
    ).resolves.toMatchObject({ accepted: false, reason: 'awaiting_admission' });

    expect(await epochOf()).toBe(3);
    expect(await awaiting(JOINER)).toBe(true);
    // And the same Add from a member's own gesture still answers it.
    await expect(memberCommit(3, [JOINER])).resolves.toMatchObject({ accepted: true });
    expect(await awaiting(JOINER)).toBe(false);
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
    // Never in, so no exclusion interval is left behind; the one record is the generation the
    // Decline moved the group to, which an Add built before it is ordered by (review of #2419).
    expect(await rowsOf('dm_group_membership_intervals', JOINER)).toBe(0);
    const [stamp]: { declinedAtSeatGeneration: number | null; owedDeparture: number | null }[] =
      await q(
        `SELECT "declinedAtSeatGeneration", "owedDeparture" FROM dm_seat_evictions
         WHERE "groupId" = $1 AND "userId" = $2`,
        [GROUP, JOINER.userId]
      );
    expect(stamp).toEqual({ declinedAtSeatGeneration: 1, owedDeparture: null });
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

  /**
   * (2) A WELCOME SENT APART ADMITS NOBODY (ADM-3). Only the accepted commit admits a new person, by
   * the `admits` it declares - which every client at the version floor sends - so a commit that
   * declares nobody, followed by a Welcome, leaves the ask standing: the Welcome is refused, nothing
   * is stored, and the joiner can neither report itself active nor commit.
   */
  it('a commit with no admits, then a separate Welcome, does NOT admit the joiner', async () => {
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
      refusalOf(
        service.sendWelcome(MEMBER.userId, {
          groupId: GROUP,
          targetUserId: JOINER.userId,
          targetDeviceId: JOINER.deviceId,
          senderUserId: MEMBER.userId,
          welcomePayload: 'V0VMQ09NRQ==',
        })
      )
    ).resolves.toMatchObject({ status: 403 });

    expect(await awaiting(JOINER)).toBe(true);
    const [queued]: { n: string }[] = await q(
      `SELECT COUNT(*) AS n FROM queued_message WHERE "groupId" = $1 AND "recipientId" = $2`,
      [GROUP, JOINER.userId]
    );
    expect(Number(queued.n)).toBe(0);
    await expect(
      service.activateDeviceMembership(JOINER.userId, JOINER.deviceId, GROUP, {
        authority: 'report',
      })
    ).resolves.toMatchObject({ ok: false, reason: 'awaiting_admission' });
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

  it("a member's pending list never names a key-distribution group's rows", async () => {
    const KEY_GROUP = '00000000-0000-4000-8000-0000000000a9';
    await q(
      `INSERT INTO dm_groups (id, "isGroup", "activeEpoch", "distributionWorkspaceId")
       VALUES ($1, true, 1, '00000000-0000-4000-8000-0000000000aa')`,
      [KEY_GROUP]
    );
    try {
      // The member's device is in the key group, and another device - one with a key package, so
      // nothing but the group's kind can exclude it - holds a pending row there.
      await q(
        `INSERT INTO dm_device_group_memberships ("userId", "deviceId", "groupId", status)
         VALUES ($1, $2, $3, 'active'), ($4, $5, $3, 'pending')`,
        [MEMBER.userId, MEMBER.deviceId, KEY_GROUP, JOINER.userId, JOINER.deviceId]
      );

      const rows = await invitations().getPendingInvitations(
        MEMBER.userId,
        MEMBER.deviceId,
        MEMBER.userId
      );

      expect(rows.filter((r) => r.groupId === KEY_GROUP)).toEqual([]);
    } finally {
      await q(`DELETE FROM dm_device_group_memberships WHERE "groupId" = $1`, [KEY_GROUP]);
      await q(`DELETE FROM dm_groups WHERE id = $1`, [KEY_GROUP]);
    }
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

  /**
   * THE ASK IS PUT TO EVERY ONLINE ADMITTED MEMBER, LIVE (dev, 2026-10-25): the `welcome_request`
   * election reached ONE member, and the others - the owner with the conversation open included -
   * learned of the ask only at their next sweep, minutes later. And the outcome reaches the same
   * screens, so a member whose answer lost the race settles on what the server holds.
   */
  describe('the ask and its outcome reach every online admitted member', () => {
    /** A second device of OTHER, which is offline. */
    const OTHER_OFFLINE = { userId: OTHER.userId, deviceId: 'dev-o-off' };
    /** A third device of OTHER, online on a build that predates the join-ask frames. */
    const OTHER_OLD = { userId: OTHER.userId, deviceId: 'dev-o-old' };
    /** Online with an active device row in the group, and no roster seat: not a member. */
    const STRANGER = { userId: 'stranger', deviceId: 'dev-s' };
    /** A seat that itself awaits a member: it answers nothing, so it is asked nothing. */
    const ASKER_2 = { userId: 'asker-2', deviceId: 'dev-a2' };
    const offline = new Set([`user:online:${OTHER_OFFLINE.userId}:${OTHER_OFFLINE.deviceId}`]);
    /** The online devices whose sessions did NOT declare join-ask (no twin field in the gateway's hash). */
    const withoutJoinAsk = new Set([`user:online:${OTHER_OLD.userId}:${OTHER_OLD.deviceId}`]);
    let frames: Array<{
      to: string;
      type: string;
      requires: unknown;
      data: Record<string, unknown>;
    }>;

    const seat = async (who: { userId: string }, awaitingAdmission: boolean) =>
      q(
        `INSERT INTO dm_group_members ("groupId", "userId", role, "awaitingAdmission")
         VALUES ($1, $2, 'member', $3)`,
        [GROUP, who.userId, awaitingAdmission]
      );
    const activeDevice = async (who: { userId: string; deviceId: string }) =>
      q(
        `INSERT INTO dm_device_group_memberships ("userId", "deviceId", "groupId", status)
         VALUES ($1, $2, $3, 'active')`,
        [who.userId, who.deviceId, GROUP]
      );
    const joinerSeatId = async (): Promise<string> => {
      const [row]: { id: string }[] = await q(
        `SELECT id FROM dm_group_members WHERE "groupId" = $1 AND "userId" = $2`,
        [GROUP, JOINER.userId]
      );
      return row.id;
    };
    /** The control frames of `type` published once every announcement has finished. */
    const framesOf = async (type: string) => {
      await joinAskAnnouncementsSettled();
      return frames
        .filter((f) => f.type === type)
        .map((f) => ({ to: f.to, requires: f.requires, data: f.data }))
        .sort((a, b) => a.to.localeCompare(b.to));
    };
    const toMembers = (data: Record<string, unknown>) =>
      [MEMBER, OTHER].map((who) => ({
        to: `${who.userId}:${who.deviceId}`,
        requires: 'join-ask-1',
        data,
      }));

    beforeEach(async () => {
      frames = [];
      // The join-ask check-and-publish script, as Redis would run it on this device's presence and
      // its sessions' twin fields (the script itself is run against a real Redis in
      // addressing.redis.spec.ts).
      jest
        .spyOn(redis, 'eval')
        .mockImplementation(async (script: unknown, _keys: unknown, ...args: unknown[]) => {
          if (script !== JOIN_ASK_PUBLISH_LUA) return 1;
          const [presenceKey, , , channel, payload, capability] = args as string[];
          if (capability !== 'join-ask-1') return 0;
          if (offline.has(presenceKey) || withoutJoinAsk.has(presenceKey)) return 0;
          if (channel) {
            const env = JSON.parse(payload) as {
              recipientId: string;
              deviceId: string;
              proto: string;
              requiresCapability?: string;
            };
            const frame = JSON.parse(Buffer.from(env.proto, 'base64').toString()) as {
              type: string;
              data: Record<string, unknown>;
            };
            frames.push({
              to: `${env.recipientId}:${env.deviceId}`,
              type: frame.type,
              requires: env.requiresCapability,
              data: frame.data,
            });
          }
          return 1;
        });
      await seat(OTHER, false);
      await activeDevice(OTHER);
      await activeDevice(OTHER_OFFLINE);
      await activeDevice(OTHER_OLD);
      await activeDevice(STRANGER);
      await seat(ASKER_2, true);
      await activeDevice(ASKER_2);
    });

    afterEach(async () => {
      await joinAskAnnouncementsSettled();
      (redis.eval as unknown as jest.SpyInstance).mockRestore();
    });

    it('tells each online device of each admitted member once - never the asker, a stranger, a waiting seat, an offline device or an older build', async () => {
      await acceptLink();

      expect(await framesOf('group.join_ask')).toEqual(
        toMembers({
          groupId: GROUP,
          askId: await joinerSeatId(),
          requesterUserId: JOINER.userId,
          // Every device the link seated (an earlier case registered a second one).
          requesterDeviceIds: expect.arrayContaining([JOINER.deviceId]),
        })
      );
    });

    it('names the ask by its seat on every read a member raises it from', async () => {
      await acceptLink();
      const askId = await joinerSeatId();

      const pending = await invitations().getPendingInvitations(
        MEMBER.userId,
        MEMBER.deviceId,
        MEMBER.userId
      );
      const roster = await members().getGroupUserMembers(GROUP, MEMBER.userId);

      expect(new Set(pending.map((r) => r.askId))).toEqual(new Set([askId]));
      expect(roster.find((r) => r.userId === JOINER.userId)?.askId).toBe(askId);
      expect(roster.find((r) => r.userId === MEMBER.userId)?.askId).toBeNull();
    });

    it("settles a Decline on every other member's screen, once, and a second Decline settles nothing", async () => {
      await acceptLink();
      const askId = await joinerSeatId();

      await expect(decline(MEMBER)).resolves.toEqual({ outcome: 'withdrawn' });
      await expect(decline(OTHER)).resolves.toEqual({ outcome: 'gone' });

      expect(await framesOf('group.join_ask.settled')).toEqual(
        toMembers({ groupId: GROUP, askId, userId: JOINER.userId, outcome: 'declined' })
      );
    });

    it('settles an Add once: a second Add and a late Decline announce nothing more', async () => {
      await acceptLink();
      const askId = await joinerSeatId();

      await expect(memberCommit(3, [JOINER])).resolves.toMatchObject({ accepted: true });
      await expect(memberCommit(4, [JOINER])).resolves.toMatchObject({ accepted: true });
      await expect(decline(OTHER)).resolves.toEqual({ outcome: 'already-admitted' });

      // The joiner is a member now, and still told nothing about their own ask.
      expect(await framesOf('group.join_ask.settled')).toEqual(
        toMembers({ groupId: GROUP, askId, userId: JOINER.userId, outcome: 'admitted' })
      );
    });

    it('a second ask of the same person after a Decline is a NEW identity', async () => {
      await acceptLink();
      const first = await joinerSeatId();
      await decline(MEMBER);
      await acceptLink();
      const second = await joinerSeatId();

      expect(second).not.toBe(first);
      const asks = await framesOf('group.join_ask');
      expect(asks.filter((f) => f.to === `${MEMBER.userId}:${MEMBER.deviceId}`)).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ askId: first }) }),
        expect.objectContaining({ data: expect.objectContaining({ askId: second }) }),
      ]);
    });

    it('settles an ask nobody answered when it expires', async () => {
      await acceptLink();
      const askId = await joinerSeatId();
      await q(
        `UPDATE dm_device_group_memberships SET "pendingSince" = now() - interval '30 days'
         WHERE "userId" = $1`,
        [JOINER.userId]
      );

      await purgeStalePending();

      expect(await framesOf('group.join_ask.settled')).toEqual(
        toMembers({ groupId: GROUP, askId, userId: JOINER.userId, outcome: 'expired' })
      );
    });

    it('settles an ask its own asker withdrew', async () => {
      await acceptLink();
      const askId = await joinerSeatId();

      await members().removeGroupMember(GROUP, JOINER.userId, JOINER.userId);

      expect(await framesOf('group.join_ask.settled')).toEqual(
        toMembers({ groupId: GROUP, askId, userId: JOINER.userId, outcome: 'withdrawn' })
      );
    });

    it("settles a member's removal of somebody else's awaiting seat as declined, never withdrawn", async () => {
      await acceptLink();
      const askId = await joinerSeatId();

      await members().removeGroupMember(GROUP, JOINER.userId, MEMBER.userId);

      expect(await framesOf('group.join_ask.settled')).toEqual(
        toMembers({ groupId: GROUP, askId, userId: JOINER.userId, outcome: 'declined' })
      );
    });

    it('settles nothing through a Welcome sent apart: that door admits nobody (ADM-3)', async () => {
      await acceptLink();
      await expect(memberCommit(3)).resolves.toMatchObject({ accepted: true });

      await service
        .sendWelcome(MEMBER.userId, {
          groupId: GROUP,
          targetUserId: JOINER.userId,
          targetDeviceId: JOINER.deviceId,
          senderUserId: MEMBER.userId,
          welcomePayload: 'V0VMQ09NRQ==',
        })
        .catch(() => undefined);

      expect(await framesOf('group.join_ask.settled')).toEqual([]);
    });

    it('never tells the asker about their own ask, even with an active device once admitted', async () => {
      await acceptLink();
      const askId = await joinerSeatId();
      // A second device of the joiner that holds the group already: once the Add lifts the seat it
      // is an ACTIVE device of an ADMITTED seat, so only the exclusion keeps the asker out.
      await activeDevice({ userId: JOINER.userId, deviceId: 'dev-j-active' });

      await expect(memberCommit(3, [JOINER])).resolves.toMatchObject({ accepted: true });

      expect(await framesOf('group.join_ask.settled')).toEqual(
        toMembers({ groupId: GROUP, askId, userId: JOINER.userId, outcome: 'admitted' })
      );
    });

    /**
     * Review of #2442 (R4): the admitted asks are taken when the commit's TRANSACTION commits, so a
     * step after it that throws - here the parting cleanup - cannot lose the announcement of an
     * admission that is already true on the server.
     */
    it('still settles an admission when a step after the commit throws', async () => {
      await acceptLink();
      const askId = await joinerSeatId();
      const clearParting = jest
        .spyOn(service as unknown as { clearParting: () => Promise<void> }, 'clearParting')
        .mockRejectedValueOnce(new Error('parting cleanup failed'));

      await expect(memberCommit(3, [JOINER])).rejects.toThrow('parting cleanup failed');
      clearParting.mockRestore();

      expect(await awaiting(JOINER)).toBe(false);
      expect(await framesOf('group.join_ask.settled')).toEqual(
        toMembers({ groupId: GROUP, askId, userId: JOINER.userId, outcome: 'admitted' })
      );
    });

    /**
     * The expiry cron runs its expiry and its announcements as ONE tracked unit, so the work a
     * retiring replica waits for (`finishJoinAskWorkInFlight`, the drain's `beforeExit`) holds it
     * from the first database read: a SIGTERM while it runs cannot leave an ask expired unannounced.
     */
    it('lets a drain that starts during the expiry cron wait for its announcements', async () => {
      await acceptLink();
      const askId = await joinerSeatId();
      await q(
        `UPDATE dm_device_group_memberships SET "pendingSince" = now() - interval '30 days'
         WHERE "userId" = $1`,
        [JOINER.userId]
      );

      // The SIGTERM lands as the cron starts: only the drain's own wait stands between this and
      // the frames - the cron itself is not awaited before it.
      const cron = purgeStalePending();
      await finishJoinAskWorkInFlight();

      expect(frames.filter((f) => f.type === 'group.join_ask.settled').map((f) => f.data)).toEqual([
        { groupId: GROUP, askId, userId: JOINER.userId, outcome: 'expired' },
        { groupId: GROUP, askId, userId: JOINER.userId, outcome: 'expired' },
      ]);
      await cron;
    });
  });
});
