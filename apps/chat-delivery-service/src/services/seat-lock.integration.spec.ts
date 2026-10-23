/**
 * THE SEAT LOCK'S ORDERINGS, AGAINST A REAL POSTGRESQL - migration 036 included.
 *
 * A seat's claim, its eviction, its route and a send's queued rows are ordered by one per-group
 * advisory lock (`utils/seat-eviction.ts`): the writers that create or delete a seat take it
 * exclusive, a send's queue write takes it shared. Which side waits for which is the whole
 * mechanism, and no fake can judge an advisory lock - so each ordering is run here deterministically:
 * a raw client holds the lock in an open transaction, the test reads `pg_blocking_pids` until the
 * service's own transaction is parked on it, then commits. No sleep anywhere. The same harness
 * holds two commits at one base, a Welcome store, an erasure and the two `pending` seat writers.
 *
 * GATED ON `DELIVERY_IT_DATABASE_URL`; CI's `test-delivery-integration` sets it. Locally, against a
 * throwaway PostgreSQL:
 *
 *   DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- seat-lock.integration
 *
 * Everything happens in a throwaway schema, created before the DataSource initializes and dropped at
 * the end. Redis is a set in memory: the routes it holds are ordered by the PostgreSQL lock, which is
 * what is under test.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { MessagingService } from './messaging.service';
import { QueuedMessage } from '../entities/queued-message.entity';
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
import { DevicesController } from '../controllers/devices.controller';
import { claimSeat, seatClaimHolds, withSeatLock, type SeatClaim } from '../utils/seat-eviction';
import { memberCommitFrame } from '../testing/mlsFrameFixture';

const URL = process.env.DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = readFileSync(
  join(__dirname, '..', 'migrations', '036_seat_evictions.sql'),
  'utf8'
);

const GROUP = '00000000-0000-4000-8000-0000000000e1';
const SENDER = { userId: 'sender', deviceId: 'dev-s' };
const PEER = { userId: 'peer', deviceId: 'dev-p' };
const ROUTES = `group:members:${GROUP}`;

/** The private seams under test, reached by name. */
interface Seams {
  enqueueForLiveGroup(
    rows: QueuedMessage[],
    groupId: string,
    tag: string,
    traceId: string,
    sealed: undefined,
    opts: {
      seats?: { exempt: ReadonlySet<string> };
      welcome?: { userId: string; deviceId: string; keyGroup: boolean; claim: SeatClaim | null };
    }
  ): Promise<QueuedMessage[]>;
  restoreRoutes(
    groupId: string,
    candidates: Array<{ userId: string; deviceId: string }>
  ): Promise<{ restored: string[]; gone: string[] }>;
}

maybe('the seat lock orders claims, evictions, routes and queued rows (PostgreSQL)', () => {
  const schema = `seat_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: MessagingService;
  const routes = new Set<string>();
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const seams = () => service as unknown as Seams;

  /** The gateway's routing sets, in memory - only the commands the seat writers use. */
  const redis = {
    smembers: async (key: string) => (key === ROUTES ? [...routes] : []),
    sadd: async (_key: string, ...members: string[]) => {
      const before = routes.size;
      members.forEach((m) => routes.add(m));
      return routes.size - before;
    },
    srem: async (_key: string, ...members: string[]) => {
      const before = routes.size;
      members.forEach((m) => routes.delete(m));
      return before - routes.size;
    },
    smismember: async (_key: string, ...members: string[]) =>
      members.map((m) => (routes.has(m) ? 1 : 0)),
    // The commit gate's Redis lock, as it stands once its 5 s have run out: never held. What
    // serialises two commits at one base must then be the database alone.
    set: async () => 'OK',
    eval: async () => 1,
    hdel: async () => 0,
    hgetall: async () => ({}),
  };

  /**
   * Resolves once at least `count` backends are WAITING on a lock - read from the server's own lock
   * table, so the test knows the other side is parked rather than hoping a pause was long enough.
   * Each round is a real query, never a sleep; jest's timeout bounds it.
   */
  const parked = async (count: number) => {
    for (;;) {
      const [row]: { n: string }[] = await q(
        `SELECT count(*) AS n FROM pg_stat_activity
         WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`
      );
      if (Number(row.n) >= count) return;
    }
  };

  /** A raw client in the test schema holding the group's seat lock in an open transaction. */
  const holder = async (mode: 'exclusive' | 'shared'): Promise<Client> => {
    const client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`SET search_path TO ${schema}`);
    await client.query('BEGIN');
    const fn = mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
    await client.query(`SELECT ${fn}(hashtextextended($1, 0))`, [`seat:${GROUP}`]);
    return client;
  };
  const release = async (client: Client) => {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  };

  const seat = async (who: { userId: string; deviceId: string }) =>
    q(
      `INSERT INTO dm_device_group_memberships ("userId", "deviceId", "groupId", status)
       VALUES ($1, $2, $3, 'active')`,
      [who.userId, who.deviceId, GROUP]
    );
  const queuedFor = async (who: { userId: string }): Promise<number> => {
    const [row]: { n: string }[] = await q(
      `SELECT count(*) AS n FROM queued_message WHERE "groupId" = $1 AND "recipientId" = $2`,
      [GROUP, who.userId]
    );
    return Number(row.n);
  };
  const seatsOf = async (who: { userId: string }): Promise<number> => {
    const [row]: { n: string }[] = await q(
      `SELECT count(*) AS n FROM dm_device_group_memberships WHERE "groupId" = $1 AND "userId" = $2`,
      [GROUP, who.userId]
    );
    return Number(row.n);
  };
  /** A key-group Welcome to `who`, stored against `claim` as `sendWelcome` stores one. */
  const storeWelcome = (who: { userId: string; deviceId: string }, claim: SeatClaim) =>
    seams().enqueueForLiveGroup(
      [
        ds.getRepository(QueuedMessage).create({
          recipientId: who.userId,
          deviceId: who.deviceId,
          senderId: SENDER.userId,
          groupId: GROUP,
          proto: 'd2VsY29tZQ==',
          isWelcome: true,
        }),
      ],
      GROUP,
      'WELCOME',
      'it',
      undefined,
      { welcome: { userId: who.userId, deviceId: who.deviceId, keyGroup: true, claim } }
    );
  const frameFor = (who: { userId: string; deviceId: string }) =>
    ds.getRepository(QueuedMessage).create({
      recipientId: who.userId,
      deviceId: who.deviceId,
      senderId: SENDER.userId,
      senderDeviceId: SENDER.deviceId,
      groupId: GROUP,
      proto: 'cGF5bG9hZA==',
    });

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
    // The eviction record as production gets it: the migration, not an entity.
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
    await q(`INSERT INTO dm_groups (id, "isGroup", "activeEpoch") VALUES ($1, true, 3)`, [GROUP]);
  });

  beforeEach(async () => {
    routes.clear();
    await q(`DELETE FROM dm_device_group_memberships`);
    await q(`DELETE FROM queued_message`);
    await q(`DELETE FROM dm_seat_evictions`);
    await seat(SENDER);
    await seat(PEER);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('a claim an eviction overtakes while the claimant waits on the lock does not stand', async () => {
    const claim = await claimSeat(ds.manager, GROUP, PEER.userId);
    const evicting = await holder('exclusive');
    try {
      await evicting.query(
        `INSERT INTO dm_seat_evictions ("groupId", "userId", "generation") VALUES ($1, $2, 1)`,
        [GROUP, PEER.userId]
      );
      const checked = withSeatLock(ds.manager, GROUP, (m) => seatClaimHolds(m, claim));
      await parked(1);
      await evicting.query('COMMIT');

      await expect(checked).resolves.toBe('evicted_since_claim');
    } finally {
      await release(evicting);
    }
  });

  it("an eviction's departure, once begun, refuses every claim until it is settled", async () => {
    await service.evictSeats(GROUP, PEER.userId, 'begin');
    const claim = await claimSeat(ds.manager, GROUP, PEER.userId);

    await expect(withSeatLock(ds.manager, GROUP, (m) => seatClaimHolds(m, claim))).resolves.toBe(
      'departure_in_progress'
    );
    await service.evictSeats(GROUP, PEER.userId, { settles: 1 });
    const fresh = await claimSeat(ds.manager, GROUP, PEER.userId);
    await expect(withSeatLock(ds.manager, GROUP, (m) => seatClaimHolds(m, fresh))).resolves.toBe(
      null
    );
  });

  it('a send whose recipients were read before an eviction waits for it, then queues nothing for that seat', async () => {
    const evicting = await holder('exclusive');
    try {
      await evicting.query(
        `DELETE FROM dm_device_group_memberships WHERE "groupId" = $1 AND "userId" = $2`,
        [GROUP, PEER.userId]
      );
      const sending = seams().enqueueForLiveGroup(
        [frameFor(PEER)],
        GROUP,
        'SEND',
        'it',
        undefined,
        { seats: { exempt: new Set() } }
      );
      await parked(1);
      await evicting.query('COMMIT');

      await expect(sending).resolves.toEqual([]);
      expect(await queuedFor(PEER)).toBe(0);
    } finally {
      await release(evicting);
    }
  });

  it('an eviction waits for a send holding the lock shared, then deletes what it queued', async () => {
    const sending = await holder('shared');
    try {
      const evicted = service.evictSeats(GROUP, PEER.userId, 'begin');
      await parked(1);
      await sending.query(
        `INSERT INTO queued_message ("recipientId", "deviceId", "groupId", proto) VALUES ($1, $2, $3, 'x')`,
        [PEER.userId, PEER.deviceId, GROUP]
      );
      await sending.query('COMMIT');

      await expect(evicted).resolves.toMatchObject({ memberships: 1, queued: 1 });
      expect(await queuedFor(PEER)).toBe(0);
    } finally {
      await release(sending);
    }
  });

  it('two sends into one group never wait for each other', async () => {
    const other = await holder('shared');
    try {
      // Resolves while the other send still holds the lock shared: a wait would time this test out.
      await expect(
        seams().enqueueForLiveGroup([frameFor(PEER)], GROUP, 'SEND', 'it', undefined, {
          seats: { exempt: new Set() },
        })
      ).resolves.toHaveLength(1);
      expect(await queuedFor(PEER)).toBe(1);
    } finally {
      await release(other);
    }
  });

  it("a commit's removed device is queued without a seat, the one exemption", async () => {
    await q(`DELETE FROM dm_device_group_memberships WHERE "userId" = $1`, [PEER.userId]);

    await expect(
      seams().enqueueForLiveGroup([frameFor(PEER)], GROUP, 'SEND', 'it', undefined, {
        seats: { exempt: new Set([`${PEER.userId}:${PEER.deviceId}`]) },
      })
    ).resolves.toHaveLength(1);
  });

  it('a route restored from a read taken before an eviction waits for it, and writes nothing', async () => {
    const evicting = await holder('exclusive');
    try {
      await evicting.query(
        `DELETE FROM dm_device_group_memberships WHERE "groupId" = $1 AND "userId" = $2`,
        [GROUP, PEER.userId]
      );
      const restoring = seams().restoreRoutes(GROUP, [SENDER, PEER]);
      await parked(1);
      await evicting.query('COMMIT');

      await expect(restoring).resolves.toEqual({
        restored: [`${SENDER.userId}:${SENDER.deviceId}`],
        gone: [`${PEER.userId}:${PEER.deviceId}`],
      });
      expect([...routes]).toEqual([`${SENDER.userId}:${SENDER.deviceId}`]);
    } finally {
      await release(evicting);
    }
  });

  it('a key-group Welcome stored against a claim an eviction overtakes waits for it, and stores nothing', async () => {
    // The claim is read, social-service answers, and an eviction commits before the store.
    await q(`DELETE FROM dm_device_group_memberships WHERE "userId" = $1`, [PEER.userId]);
    const claim = await claimSeat(ds.manager, GROUP, PEER.userId);
    const evicting = await holder('exclusive');
    try {
      await evicting.query(
        `INSERT INTO dm_seat_evictions ("groupId", "userId", "generation") VALUES ($1, $2, 1)`,
        [GROUP, PEER.userId]
      );
      const storing = storeWelcome(PEER, claim);
      await parked(1);
      await evicting.query('COMMIT');

      await expect(storing).rejects.toMatchObject({
        response: { error: 'welcome_target_not_member' },
      });
      expect(await queuedFor(PEER)).toBe(0);
      expect(await seatsOf(PEER)).toBe(0);
    } finally {
      await release(evicting);
    }
  });

  it('a key-group Welcome whose claim still holds is stored with its pending row', async () => {
    await q(`DELETE FROM dm_device_group_memberships WHERE "userId" = $1`, [PEER.userId]);
    const claim = await claimSeat(ds.manager, GROUP, PEER.userId);

    await expect(storeWelcome(PEER, claim)).resolves.toHaveLength(1);
    expect(await queuedFor(PEER)).toBe(1);
    expect(await seatsOf(PEER)).toBe(1);
  });

  it('two commits at one base, the first parked on the seat lock: exactly one is accepted', async () => {
    // Both pass the epoch read before either advances; a timer-held lock that expired orders
    // nothing, so the advance itself must.
    await q(`UPDATE dm_groups SET "activeEpoch" = 3 WHERE id = $1`, [GROUP]);
    await q(`DELETE FROM mls_commit_log`);
    for (const who of [SENDER, PEER]) {
      await q(
        `INSERT INTO key_package ("userId", "deviceId", "keyPackage") VALUES ($1, $2, 'kp')
         ON CONFLICT DO NOTHING`,
        [who.userId, who.deviceId]
      );
    }
    jest.spyOn(service, 'sendMessage').mockResolvedValue({
      status: 'processed',
      queued: 0,
      sent: 0,
      receivedAt: 0,
    });
    const commitAs = (who: { userId: string; deviceId: string }) =>
      service.validateCommit(
        {
          groupId: GROUP,
          deviceId: who.deviceId,
          baseEpoch: 3,
          proto: memberCommitFrame(GROUP, 3n),
          senderId: who.userId,
        },
        who.userId
      );

    const evicting = await holder('exclusive');
    let results: Awaited<ReturnType<typeof commitAs>>[];
    try {
      const first = commitAs(SENDER);
      await parked(1);
      const second = commitAs(PEER);
      await parked(2);
      await evicting.query('COMMIT');
      results = await Promise.all([first, second]);
    } finally {
      await release(evicting);
    }

    expect(results.filter((r) => r.accepted)).toHaveLength(1);
    expect(results.filter((r) => !r.accepted)).toEqual([
      { accepted: false, currentEpoch: 4, reason: 'epoch_mismatch' },
    ]);
    const [group]: { activeEpoch: number }[] = await q(
      `SELECT "activeEpoch" FROM dm_groups WHERE id = $1`,
      [GROUP]
    );
    expect(group.activeEpoch).toBe(4);
    const logged: unknown[] = await q(`SELECT 1 FROM mls_commit_log WHERE "groupId" = $1`, [GROUP]);
    expect(logged).toHaveLength(1);
  });

  it("an account erasure cuts a group's seats and routes under the lock, and a claim taken before it never holds", async () => {
    routes.add(`${PEER.userId}:${PEER.deviceId}`);
    const claim = await claimSeat(ds.manager, GROUP, PEER.userId);

    await expect(service.eraseSeats(GROUP, PEER.userId)).resolves.toMatchObject({
      memberships: 1,
      toRemove: 1,
      generation: 1,
    });
    expect(await seatsOf(PEER)).toBe(0);
    expect(routes.has(`${PEER.userId}:${PEER.deviceId}`)).toBe(false);
    await expect(withSeatLock(ds.manager, GROUP, (m) => seatClaimHolds(m, claim))).resolves.toBe(
      'evicted_since_claim'
    );
  });

  describe('a pending seat is written under the seat lock, never after an eviction', () => {
    const NEWCOMER = { userId: 'newcomer', deviceId: 'dev-n' };
    /** Resolves `'parked'` once the call waits on a lock, `'finished'` if it never had to. */
    const waitsOrFinishes = (call: Promise<unknown>) =>
      Promise.race([parked(1).then(() => 'parked' as const), call.then(() => 'finished' as const)]);
    const seatsOfGroup = async (who: { userId: string }): Promise<number> => seatsOf(who);

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
    const devices = () =>
      new DevicesController(
        ds.getRepository(KeyPackage),
        ds.getRepository(OneTimeKeyPackage),
        ds.getRepository(GroupMember),
        ds.getRepository(Group),
        ds.getRepository(DeviceGroupMembership),
        ds.getRepository(PushToken),
        ds.getRepository(RevokedDevice),
        redis as unknown as Redis,
        ds,
        {} as unknown as MessagingService,
        { record: async () => undefined } as never
      );

    beforeEach(async () => {
      await q(`UPDATE dm_groups SET "deletedAt" = NULL WHERE id = $1`, [GROUP]);
      await q(`DELETE FROM dm_group_members`);
      await q(`DELETE FROM dm_group_membership_intervals`);
      await q(`DELETE FROM key_package WHERE "userId" = $1`, [NEWCOMER.userId]);
    });

    it('an invite accepted while the group ends waits for it, and writes no roster row and no seat', async () => {
      await q(
        `INSERT INTO key_package ("userId", "deviceId", "keyPackage") VALUES ($1, $2, 'kp')`,
        [NEWCOMER.userId, NEWCOMER.deviceId]
      );
      const invite = await ds
        .getRepository(GroupInvite)
        .save(
          ds
            .getRepository(GroupInvite)
            .create({ groupId: GROUP, token: `it-${schema}`, createdBy: SENDER.userId })
        );
      const ending = await holder('exclusive');
      let outcome: 'parked' | 'finished';
      let accepting: Promise<unknown>;
      try {
        await ending.query(`UPDATE dm_groups SET "deletedAt" = now() WHERE id = $1`, [GROUP]);
        accepting = invitations()
          .acceptGroupInvite(invite.token, NEWCOMER.userId)
          .catch((e: unknown) => e);
        outcome = await waitsOrFinishes(accepting);
        await ending.query('COMMIT');
      } finally {
        await release(ending);
      }
      await accepting;

      expect(outcome).toBe('parked');
      expect(await seatsOfGroup(NEWCOMER)).toBe(0);
      const roster: unknown[] = await q(
        `SELECT 1 FROM dm_group_members WHERE "groupId" = $1 AND "userId" = $2`,
        [GROUP, NEWCOMER.userId]
      );
      expect(roster).toHaveLength(0);
    });

    it('a device registered while its owner is removed waits for the removal, and writes no seat', async () => {
      await q(
        `INSERT INTO dm_group_members ("groupId", "userId", role) VALUES ($1, $2, 'member')`,
        [GROUP, NEWCOMER.userId]
      );
      const removing = await holder('exclusive');
      let outcome: 'parked' | 'finished';
      let registering: Promise<unknown>;
      try {
        await removing.query(
          `DELETE FROM dm_group_members WHERE "groupId" = $1 AND "userId" = $2`,
          [GROUP, NEWCOMER.userId]
        );
        registering = devices()
          .registerDevice(
            { userId: NEWCOMER.userId, deviceId: NEWCOMER.deviceId, keyPackage: 'a2V5' },
            NEWCOMER.userId,
            undefined
          )
          .catch((e: unknown) => e);
        outcome = await waitsOrFinishes(registering);
        await removing.query('COMMIT');
      } finally {
        await release(removing);
      }
      await registering;

      expect(outcome).toBe('parked');
      expect(await seatsOfGroup(NEWCOMER)).toBe(0);
    });

    it('a device registered by a member still gets its pending seat', async () => {
      await q(
        `INSERT INTO dm_group_members ("groupId", "userId", role) VALUES ($1, $2, 'member')`,
        [GROUP, NEWCOMER.userId]
      );

      await devices().registerDevice(
        { userId: NEWCOMER.userId, deviceId: NEWCOMER.deviceId, keyPackage: 'a2V5' },
        NEWCOMER.userId,
        undefined
      );

      expect(await seatsOfGroup(NEWCOMER)).toBe(1);
    });
  });
});
