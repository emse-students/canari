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
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads;
 * CI's `test-chat-delivery-integration` sets it and refuses a skip. Locally, against a throwaway
 * PostgreSQL:
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- seat-lock.integration
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
import { PinVerifier } from '../entities/pin-verifier.entity';
import { DeviceSignatureKey } from '../entities/device-signature-key.entity';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';
import { RevokedDeviceGroup } from '../entities/revoked-device-group.entity';
import { InvitationsController } from '../controllers/invitations.controller';
import { DevicesController } from '../controllers/devices.controller';
import { InternalController } from '../controllers/internal.controller';
import { claimSeat, seatClaimHolds, withSeatLock, type SeatClaim } from '../utils/seat-eviction';
import { writePendingSeats } from '../utils/group-membership';
import { externalCommitFrame, memberCommitFrame, mlsFrame } from '../testing/mlsFrameFixture';
import { isEntitledToDistributionGroup } from '../internal/distribution-entitlement';
import { globToRegExp } from '../testing/memoryRedis';

// social-service's entitlement answer, held by each case: what an HTTP call does outside the lock.
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

const migration043 = readFileSync(
  join(__dirname, '..', 'migrations', '043_join_ask_pushes.sql'),
  'utf8'
);

const GROUP = '00000000-0000-4000-8000-0000000000e1';
/** What an eviction does to the claims of a group, as the raw holder writes it. */
const BUMP = `UPDATE dm_groups SET "seatGeneration" = "seatGeneration" + 1 WHERE id = $1`;
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
  /** Every routing set by its key; `routes` is GROUP's. */
  const sets = new Map<string, Set<string>>();
  const setOf = (key: string): Set<string> => {
    let set = sets.get(key);
    if (!set) sets.set(key, (set = new Set()));
    return set;
  };
  const routes = setOf(ROUTES);
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const seams = () => service as unknown as Seams;

  /** The gateway's routing sets, in memory - only the commands the seat writers use. */
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
    // An erasure's Redis sweep: one page holding every set its pattern matches; the sets are the
    // only keys held here, so a hash or list pattern matches nothing.
    scan: async (_cursor: string, _match: string, pattern: string) => [
      '0',
      [...sets.keys()].filter((k) => globToRegExp(pattern).test(k)),
    ],
    sscan: async (key: string, _cursor: string, _match: string, pattern: string) => [
      '0',
      [...setOf(key)].filter((m) => globToRegExp(pattern).test(m)),
    ],
    del: async (...keys: string[]) => keys.filter((k) => sets.delete(k)).length,
    // Presence: no device is online, so a transport frame is queued for nobody.
    exists: async () => 0,
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
  const keyPackageFor = async (who: { userId: string; deviceId: string }) =>
    q(
      `INSERT INTO key_package ("userId", "deviceId", "keyPackage") VALUES ($1, $2, 'kp')
       ON CONFLICT DO NOTHING`,
      [who.userId, who.deviceId]
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
        // The rest of what an account erasure deletes, for `deleteUserData` run whole.
        PinVerifier,
        DeviceSignatureKey,
        NotificationPreference,
        UserDismissedGroup,
        // The key groups a revoked device held (migration 041), which an erasure deletes too.
        RevokedDeviceGroup,
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
    // The join-ask push claim (migration 043), as production gets it.
    await q(migration043);
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
    for (const set of sets.values()) set.clear();
    await q(`DELETE FROM dm_device_group_memberships`);
    await q(`DELETE FROM queued_message`);
    await q(`DELETE FROM dm_seat_evictions`);
    await q(`DELETE FROM dm_group_members`);
    await seat(SENDER);
    await seat(PEER);
    // The writers under test read the key package under the lock; an erasure
    // case below deletes PEER's, so it is put back here.
    for (const who of [SENDER, PEER]) await keyPackageFor(who);
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
      await evicting.query(BUMP, [GROUP]);
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
      await evicting.query(BUMP, [GROUP]);
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

  it("a conversation's pending member commits while someone else is removed: refused whole once, then accepted with its seat", async () => {
    // The committer's seat is not yet `active` (`committerNeedsSeat`), so its commit writes it
    // against a claim taken before the lock. Another member's removal moves the group's generation
    // while the commit waits on the lock: the claim is overtaken and the commit refused whole,
    // retryably - the rebuild every client commit path makes - and the retry, on a fresh claim, lands.
    await q(`UPDATE dm_groups SET "activeEpoch" = 3, "deletedAt" = NULL WHERE id = $1`, [GROUP]);
    await q(`DELETE FROM mls_commit_log`);
    await q(
      `UPDATE dm_device_group_memberships SET status = 'pending', "kickedAt" = NULL
        WHERE "groupId" = $1 AND "userId" = $2`,
      [GROUP, SENDER.userId]
    );
    jest
      .spyOn(service, 'sendMessage')
      .mockResolvedValue({ status: 'processed', queued: 0, sent: 0, receivedAt: 0 });
    const commit = () =>
      service.validateCommit(
        {
          groupId: GROUP,
          deviceId: SENDER.deviceId,
          baseEpoch: 3,
          proto: memberCommitFrame(GROUP, 3n),
          senderId: SENDER.userId,
        },
        SENDER.userId
      );
    const statusOfSender = async (): Promise<string> => {
      const [row]: { status: string }[] = await q(
        `SELECT status FROM dm_device_group_memberships
          WHERE "groupId" = $1 AND "userId" = $2 AND "deviceId" = $3`,
        [GROUP, SENDER.userId, SENDER.deviceId]
      );
      return row.status;
    };

    const removing = await holder('exclusive');
    let first: Promise<unknown>;
    try {
      first = commit();
      await parked(1);
      await removing.query(BUMP, [GROUP]);
      await removing.query('COMMIT');
    } finally {
      await release(removing);
    }

    await expect(
      first.then(
        () => null,
        (e: { getStatus: () => number; getResponse: () => { code?: string; seat?: string } }) => ({
          status: e.getStatus(),
          code: e.getResponse().code,
          seat: e.getResponse().seat,
        })
      )
    ).resolves.toEqual({ status: 409, code: 'SEAT_CLAIM_OVERTAKEN', seat: 'committer' });
    expect(await statusOfSender()).toBe('pending');

    await expect(commit()).resolves.toMatchObject({ accepted: true });
    expect(await statusOfSender()).toBe('active');
  });

  it("an account erasure cuts a group's seats and routes under the lock, and a claim taken before it never holds", async () => {
    routes.add(`${PEER.userId}:${PEER.deviceId}`);
    const claim = await claimSeat(ds.manager, GROUP, PEER.userId);

    await expect(service.eraseSeats(GROUP, PEER.userId)).resolves.toMatchObject({
      memberships: 1,
      toRemove: 1,
    });
    expect(await seatsOf(PEER)).toBe(0);
    expect(routes.has(`${PEER.userId}:${PEER.deviceId}`)).toBe(false);
    await expect(withSeatLock(ds.manager, GROUP, (m) => seatClaimHolds(m, claim))).resolves.toBe(
      'evicted_since_claim'
    );
  });

  /**
   * THE WHOLE ERASURE (`InternalController.deleteUserData`), NOT ONE STEP OF IT. The claim is taken
   * before it starts and checked after it ends: nothing about the account may remain to refuse it,
   * so what refuses it must be the group's own generation.
   */
  describe('a claim in flight across a whole account erasure', () => {
    const SECRET = 'seat-lock-it-secret';
    const internal = () => {
      process.env.INTERNAL_SECRET = SECRET;
      return new InternalController(
        ds.getRepository(PushToken),
        ds.getRepository(KeyPackage),
        ds.getRepository(OneTimeKeyPackage),
        ds.getRepository(Group),
        ds.getRepository(GroupMember),
        ds.getRepository(DeviceGroupMembership),
        ds.getRepository(QueuedMessage),
        ds.getRepository(PinVerifier),
        ds.getRepository(RevokedDevice),
        ds.getRepository(GroupInvite),
        ds.getRepository(GroupMembershipInterval),
        redis as unknown as Redis,
        service
      );
    };
    const evictionRowsOf = async (who: { userId: string }): Promise<number> => {
      const [row]: { n: string }[] = await q(
        `SELECT count(*) AS n FROM dm_seat_evictions WHERE "userId" = $1`,
        [who.userId]
      );
      return Number(row.n);
    };
    const holds = (claim: SeatClaim) =>
      withSeatLock(ds.manager, GROUP, (m) => seatClaimHolds(m, claim));

    it('is refused after it, and no eviction row of the account is left', async () => {
      await q(
        `INSERT INTO dm_group_members ("groupId", "userId", role) VALUES ($1, $2, 'member')`,
        [GROUP, PEER.userId]
      );
      // A departure begun and settled earlier: the account HAS an eviction row to lose.
      await service.evictSeats(GROUP, PEER.userId, 'begin');
      await service.evictSeats(GROUP, PEER.userId, { settles: 1 });
      await seat(PEER);
      const claim = await claimSeat(ds.manager, GROUP, PEER.userId);

      await internal().deleteUserData(PEER.userId, SECRET);

      await expect(holds(claim)).resolves.toBe('evicted_since_claim');
      expect(await evictionRowsOf(PEER)).toBe(0);
      expect(await seatsOf(PEER)).toBe(0);
    });

    it('an activation waiting on the seat lock while the account is erased writes no seat after it', async () => {
      // A device with no trace in the group yet: the erasure has no seat of it to cut, so what
      // refuses the activation is its key package, read under the lock and deleted by the erasure.
      const NEW = { userId: 'erased-new', deviceId: 'dev-en' };
      await q(
        `INSERT INTO key_package ("userId", "deviceId", "keyPackage") VALUES ($1, $2, 'kp')
         ON CONFLICT DO NOTHING`,
        [NEW.userId, NEW.deviceId]
      );
      const claim = await claimSeat(ds.manager, GROUP, NEW.userId);
      const held = await holder('exclusive');
      let activating: Promise<unknown>;
      try {
        activating = service.activateDeviceMembership(NEW.userId, NEW.deviceId, GROUP, {
          authority: 'accepted_commit',
          claim,
        });
        await parked(1);
        await internal().deleteUserData(NEW.userId, SECRET);
        await held.query('COMMIT');
      } finally {
        await release(held);
      }

      await expect(activating).resolves.toEqual({ ok: false, reason: 'no_key_package' });
      expect(await seatsOf(NEW)).toBe(0);
    });

    it('an eviction arriving after the erasure writes no row naming the account', async () => {
      await internal().deleteUserData(PEER.userId, SECRET);

      await service.evictSeats(GROUP, PEER.userId, { settles: 1 });

      expect(await evictionRowsOf(PEER)).toBe(0);
    });

    it('a key package republished after the first delete leaves no key package, no seat and no route', async () => {
      // The account reconnects mid-erasure with a token still valid: `register-device` brings its
      // key package back, and a peer's commit then seats it in a group the discovery never saw -
      // with its route. Injected right after the discovered group's cut, the one point between the
      // first delete and the sweep where the test can stand.
      const LATE = '00000000-0000-4000-8000-0000000000e9';
      const lateRoutes = setOf(`group:members:${LATE}`);
      const route = `${PEER.userId}:${PEER.deviceId}`;
      await q(
        `INSERT INTO dm_groups (id, "isGroup", "activeEpoch") VALUES ($1, true, 1)
         ON CONFLICT DO NOTHING`,
        [LATE]
      );
      const cut = service.eraseSeats.bind(service);
      const erase = jest
        .spyOn(service, 'eraseSeats')
        .mockImplementationOnce(async (groupId: string, userId: string) => {
          const done = await cut(groupId, userId);
          await keyPackageFor(PEER);
          const claim = await claimSeat(ds.manager, LATE, PEER.userId);
          await expect(
            service.activateDeviceMembership(PEER.userId, PEER.deviceId, LATE, {
              authority: 'accepted_commit',
              claim,
            })
          ).resolves.toEqual({ ok: true });
          expect(lateRoutes.has(route)).toBe(true);
          return done;
        });
      try {
        await internal().deleteUserData(PEER.userId, SECRET);
      } finally {
        erase.mockRestore();
      }

      const keyPackages: unknown[] = await q(`SELECT 1 FROM key_package WHERE "userId" = $1`, [
        PEER.userId,
      ]);
      expect(keyPackages).toHaveLength(0);
      const rows: unknown[] = await q(
        `SELECT 1 FROM dm_device_group_memberships WHERE "userId" = $1`,
        [PEER.userId]
      );
      expect(rows).toHaveLength(0);
      expect(lateRoutes.has(route)).toBe(false);
      expect(routes.has(route)).toBe(false);
    });

    it("a seat admitted after the sweep's read stays whole, row and route, so a send before the final pass repairs nothing", async () => {
      // The republish and the admit land AFTER the sweep read which groups to cut: no cut of this
      // pass sees the seat. Its route stays beside its row - the route sweep removes only routes no
      // active seat stands behind - and the final pass, run once every token expired, cuts both
      // under the seat lock. A route removed alone would be written back by the next send's
      // reconciliation, which accuses at WARN a writer that did nothing wrong.
      const LATE = '00000000-0000-4000-8000-0000000000ea';
      const lateRoutes = setOf(`group:members:${LATE}`);
      const route = `${PEER.userId}:${PEER.deviceId}`;
      await q(
        `INSERT INTO dm_groups (id, "isGroup", "activeEpoch") VALUES ($1, true, 1)
         ON CONFLICT DO NOTHING`,
        [LATE]
      );
      const seatsRepo = ds.getRepository(DeviceGroupMembership);
      const read = seatsRepo.find.bind(seatsRepo);
      let reads = 0;
      let admitted: unknown;
      const find = jest.spyOn(seatsRepo, 'find').mockImplementation(async (options) => {
        const found = await read(options);
        const isErasureRead =
          (options?.where as { userId?: string } | undefined)?.userId === PEER.userId &&
          (options?.select as { groupId?: boolean } | undefined)?.groupId === true;
        if (isErasureRead && ++reads === 2) {
          await keyPackageFor(PEER);
          const claim = await claimSeat(ds.manager, LATE, PEER.userId);
          admitted = await service.activateDeviceMembership(PEER.userId, PEER.deviceId, LATE, {
            authority: 'accepted_commit',
            claim,
          });
        }
        return found;
      });
      try {
        await internal().deleteUserData(PEER.userId, SECRET);
      } finally {
        find.mockRestore();
      }
      expect(reads).toBe(2);
      expect(admitted).toEqual({ ok: true });

      // The first pass ends with the late seat whole: its row AND its route.
      const standing: unknown[] = await q(
        `SELECT 1 FROM dm_device_group_memberships WHERE "userId" = $1 AND "groupId" = $2`,
        [PEER.userId, LATE]
      );
      expect(standing).toHaveLength(1);
      expect(lateRoutes.has(route)).toBe(true);

      // A member sends between the two passes: the reconciliation finds the routing set complete.
      await q(
        `INSERT INTO dm_device_group_memberships ("userId", "deviceId", "groupId", status)
         VALUES ($1, $2, $3, 'active') ON CONFLICT DO NOTHING`,
        [SENDER.userId, SENDER.deviceId, LATE]
      );
      lateRoutes.add(`${SENDER.userId}:${SENDER.deviceId}`);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      warn.mockClear();
      const sadd = jest.spyOn(redis, 'sadd');
      try {
        await service.sendMessage({
          groupId: LATE,
          senderId: SENDER.userId,
          senderDeviceId: SENDER.deviceId,
          proto: mlsFrame(2, LATE, 1n),
          durable: false,
        });
        expect(sadd.mock.calls.filter(([key]) => key === `group:members:${LATE}`)).toEqual([]);
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('MEMBERS_CACHE_REPAIRED'));
      } finally {
        sadd.mockRestore();
      }

      // The final pass.
      await internal().deleteUserData(PEER.userId, SECRET);

      const keyPackages: unknown[] = await q(`SELECT 1 FROM key_package WHERE "userId" = $1`, [
        PEER.userId,
      ]);
      expect(keyPackages).toHaveLength(0);
      const rows: unknown[] = await q(
        `SELECT 1 FROM dm_device_group_memberships WHERE "userId" = $1`,
        [PEER.userId]
      );
      expect(rows).toHaveLength(0);
      expect(lateRoutes.has(route)).toBe(false);
    });

    it('is refused after it when the account held no seat, only a departure in progress', async () => {
      // Seats cut and roster gone: the eviction row is all that still names the group.
      await service.evictSeats(GROUP, PEER.userId, 'begin');
      const claim = await claimSeat(ds.manager, GROUP, PEER.userId);

      await internal().deleteUserData(PEER.userId, SECRET);

      await expect(holds(claim)).resolves.toBe('evicted_since_claim');
      expect(await evictionRowsOf(PEER)).toBe(0);
    });
  });

  /**
   * THE GROUP'S GENERATION REFUSES A CLAIM ANY EVICTION OVERTOOK, SO A COMMIT THAT WRITES A SEAT
   * MUST BE REFUSED WHOLE. Dropping only the seat would accept a commit whose newcomer is in the tree
   * with no seat and nothing retrying it. social-service's answer is where the eviction lands: the
   * claim was read before the question, and the eviction runs while it is being answered.
   */
  describe('a key-group commit whose seat claim an unrelated eviction overtakes', () => {
    const KEY_GROUP = '00000000-0000-4000-8000-0000000000e2';
    const WORKSPACE = '00000000-0000-4000-8000-0000000000f2';
    const NEWCOMER = { userId: 'kg-newcomer', deviceId: 'dev-kn' };
    const JOINER = { userId: 'kg-joiner', deviceId: 'dev-kj' };
    const epochOf = async (): Promise<number> => {
      const [row]: { activeEpoch: number }[] = await q(
        `SELECT "activeEpoch" FROM dm_groups WHERE id = $1`,
        [KEY_GROUP]
      );
      return Number(row.activeEpoch);
    };
    const statusOf = async (who: { userId: string; deviceId: string }): Promise<string | null> => {
      const rows: { status: string }[] = await q(
        `SELECT status FROM dm_device_group_memberships
          WHERE "groupId" = $1 AND "userId" = $2 AND "deviceId" = $3`,
        [KEY_GROUP, who.userId, who.deviceId]
      );
      return rows[0]?.status ?? null;
    };
    const loggedCommits = async (): Promise<number> => {
      const [row]: { n: string }[] = await q(
        `SELECT count(*) AS n FROM mls_commit_log WHERE "groupId" = $1`,
        [KEY_GROUP]
      );
      return Number(row.n);
    };
    /** social-service answers `true`, after an eviction of PEER - someone else - committed. */
    const answerAfterAnUnrelatedEviction = () =>
      entitled.mockImplementationOnce(async () => {
        await service.evictSeats(KEY_GROUP, PEER.userId, 'begin');
        return true;
      });
    /** The refusal a client reads: its status and its stable code. */
    const refusalOf = (call: Promise<unknown>) =>
      call.then(
        () => null,
        (e: { getStatus: () => number; getResponse: () => { code?: string } }) => ({
          status: e.getStatus(),
          code: e.getResponse().code,
        })
      );

    beforeAll(async () => {
      await q(
        `INSERT INTO dm_groups (id, "isGroup", "activeEpoch", "distributionWorkspaceId")
         VALUES ($1, true, 3, $2)`,
        [KEY_GROUP, WORKSPACE]
      );
    });

    beforeEach(async () => {
      entitled.mockReset();
      jest
        .spyOn(service, 'sendMessage')
        .mockResolvedValue({ status: 'processed', queued: 0, sent: 0, receivedAt: 0 });
      await q(`UPDATE dm_groups SET "activeEpoch" = 3 WHERE id = $1`, [KEY_GROUP]);
      await q(`DELETE FROM mls_commit_log WHERE "groupId" = $1`, [KEY_GROUP]);
      for (const who of [SENDER, PEER]) {
        await q(
          `INSERT INTO dm_device_group_memberships ("userId", "deviceId", "groupId", status)
           VALUES ($1, $2, $3, 'active')`,
          [who.userId, who.deviceId, KEY_GROUP]
        );
      }
      for (const who of [SENDER, NEWCOMER, JOINER]) {
        await q(
          `INSERT INTO key_package ("userId", "deviceId", "keyPackage") VALUES ($1, $2, 'kp')
           ON CONFLICT DO NOTHING`,
          [who.userId, who.deviceId]
        );
      }
    });

    it("refuses a commit admitting a newcomer whole and retryably, and accepts the retry with the newcomer's seat", async () => {
      const commit = () =>
        service.validateCommit(
          {
            groupId: KEY_GROUP,
            deviceId: SENDER.deviceId,
            baseEpoch: 3,
            proto: memberCommitFrame(KEY_GROUP, 3n),
            senderId: SENDER.userId,
            admits: [NEWCOMER],
          },
          SENDER.userId
        );
      answerAfterAnUnrelatedEviction();

      await expect(refusalOf(commit())).resolves.toEqual({
        status: 409,
        code: 'SEAT_CLAIM_OVERTAKEN',
      });
      expect(await epochOf()).toBe(3);
      expect(await loggedCommits()).toBe(0);
      expect(await statusOf(NEWCOMER)).toBeNull();

      entitled.mockResolvedValueOnce(true);
      await expect(commit()).resolves.toMatchObject({ accepted: true });
      expect(await epochOf()).toBe(4);
      expect(await statusOf(NEWCOMER)).toBe('pending');
    });

    it("refuses an external join the same way, and accepts the retry with the joiner's seat", async () => {
      const join = () =>
        service.validateCommit(
          {
            groupId: KEY_GROUP,
            deviceId: JOINER.deviceId,
            baseEpoch: 3,
            proto: externalCommitFrame(KEY_GROUP, 3n, `${JOINER.userId}:${JOINER.deviceId}`),
            senderId: JOINER.userId,
          },
          JOINER.userId
        );
      answerAfterAnUnrelatedEviction();

      await expect(refusalOf(join())).resolves.toEqual({
        status: 409,
        code: 'SEAT_CLAIM_OVERTAKEN',
      });
      expect(await epochOf()).toBe(3);
      expect(await statusOf(JOINER)).toBeNull();

      entitled.mockResolvedValueOnce(true);
      await expect(join()).resolves.toMatchObject({ accepted: true });
      expect(await epochOf()).toBe(4);
      expect(await statusOf(JOINER)).toBe('active');
    });
  });

  it('an eviction of SOMEONE ELSE refuses a claim taken before it once, and the retried claim holds', async () => {
    const claim = await claimSeat(ds.manager, GROUP, SENDER.userId);
    await service.evictSeats(GROUP, PEER.userId, 'begin');

    await expect(withSeatLock(ds.manager, GROUP, (m) => seatClaimHolds(m, claim))).resolves.toBe(
      'evicted_since_claim'
    );
    const retried = await claimSeat(ds.manager, GROUP, SENDER.userId);
    await expect(withSeatLock(ds.manager, GROUP, (m) => seatClaimHolds(m, retried))).resolves.toBe(
      null
    );
  });

  it('a settlement naming no departure in progress says it settled nothing', async () => {
    await expect(service.evictSeats(GROUP, PEER.userId, { settles: 7 })).resolves.toMatchObject({
      settled: false,
    });
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

  /**
   * EVERY WRITER THAT ADMITS A DEVICE READS ITS KEY PACKAGE UNDER THE LOCK, with one known
   * exception - the demotion, which inserts nothing, see `heldKeyPackages`. An account
   * erasure deletes the key packages first, on their own, and again before its sweep. Each case is a
   * device whose key package is already gone.
   */
  describe('no device row is inserted without its key package', () => {
    const GONE = { userId: 'erased-gone', deviceId: 'dev-eg' };

    beforeEach(async () => {
      await q(`DELETE FROM key_package WHERE "userId" = $1`, [GONE.userId]);
      await q(`UPDATE dm_groups SET "deletedAt" = NULL, "activeEpoch" = 3 WHERE id = $1`, [GROUP]);
      await q(`DELETE FROM mls_commit_log`);
    });

    it("a commit whose admit is erased while it waits on the seat lock is accepted without that admit's row", async () => {
      // The admit's key package is there when the commit reads its admits, before the lock.
      await keyPackageFor(GONE);
      jest
        .spyOn(service, 'sendMessage')
        .mockResolvedValue({ status: 'processed', queued: 0, sent: 0, receivedAt: 0 });
      const held = await holder('exclusive');
      let committing: Promise<unknown>;
      try {
        committing = service.validateCommit(
          {
            groupId: GROUP,
            deviceId: SENDER.deviceId,
            baseEpoch: 3,
            proto: memberCommitFrame(GROUP, 3n),
            senderId: SENDER.userId,
            admits: [GONE],
          },
          SENDER.userId
        );
        await parked(1);
        await q(`DELETE FROM key_package WHERE "userId" = $1`, [GONE.userId]);
        await held.query('COMMIT');
      } finally {
        await release(held);
      }

      await expect(committing).resolves.toMatchObject({ accepted: true });
      expect(await seatsOf(GONE)).toBe(0);
    });

    it('a Welcome to it is refused and stores nothing', async () => {
      const claim = await claimSeat(ds.manager, GROUP, GONE.userId);

      await expect(storeWelcome(GONE, claim)).rejects.toMatchObject({
        response: { error: 'welcome_target_not_member' },
      });
      expect(await queuedFor(GONE)).toBe(0);
      expect(await seatsOf(GONE)).toBe(0);
    });

    it('a pending seat is not written for it, while its owner is still enrolled', async () => {
      await expect(
        writePendingSeats(ds.manager, GROUP, GONE.userId, [GONE.deviceId], 'awaiting_admission')
      ).resolves.toBe('written');

      expect(await seatsOf(GONE)).toBe(0);
      const roster: unknown[] = await q(
        `SELECT 1 FROM dm_group_members WHERE "groupId" = $1 AND "userId" = $2`,
        [GROUP, GONE.userId]
      );
      expect(roster).toHaveLength(1);
    });

    it("a group's creator enrolling itself gets its roster row, admitted, and no device row", async () => {
      // The creator the creation route recorded (`Group.createdBy`): nobody else may enrol so.
      await q(`UPDATE dm_groups SET "createdBy" = $2 WHERE id = $1`, [GROUP, GONE.userId]);
      await expect(
        writePendingSeats(ds.manager, GROUP, GONE.userId, [GONE.deviceId], 'creator')
      ).resolves.toBe('written');

      expect(await seatsOf(GONE)).toBe(0);
      const roster: { awaitingAdmission: boolean }[] = await q(
        `SELECT "awaitingAdmission" FROM dm_group_members WHERE "groupId" = $1 AND "userId" = $2`,
        [GROUP, GONE.userId]
      );
      expect(roster).toEqual([{ awaitingAdmission: false }]);
    });

    it("a group's creator erased while its seat waits on the lock gets no seat", async () => {
      // Addressable when the creation's gate asks, before the lock; gone by the time it writes.
      await keyPackageFor(GONE);
      const held = await holder('exclusive');
      let creating: Promise<unknown>;
      try {
        creating = service.activateDeviceMembership(GONE.userId, GONE.deviceId, GROUP, {
          authority: 'group_creator',
        });
        await parked(1);
        await q(`DELETE FROM key_package WHERE "userId" = $1`, [GONE.userId]);
        await held.query('COMMIT');
      } finally {
        await release(held);
      }

      await expect(creating).resolves.toEqual({ ok: false, reason: 'no_key_package' });
      expect(await seatsOf(GONE)).toBe(0);
      expect(routes.has(`${GONE.userId}:${GONE.deviceId}`)).toBe(false);
    });
  });

  describe("a member ends another user's device row only while it is not active", () => {
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
        {} as unknown as MessagingService
      );
    const statusOf = async (who: { userId: string; deviceId: string }) => {
      const rows: Array<{ status: string }> = await q(
        `SELECT status FROM dm_device_group_memberships
          WHERE "groupId" = $1 AND "userId" = $2 AND "deviceId" = $3`,
        [GROUP, who.userId, who.deviceId]
      );
      return rows[0]?.status ?? null;
    };

    beforeEach(async () => {
      await q(`UPDATE dm_groups SET "deletedAt" = NULL WHERE id = $1`, [GROUP]);
      // SENDER is an admitted member on the roster; PEER's device rows are the targets.
      await ds.getRepository(GroupMember).save({ groupId: GROUP, userId: SENDER.userId });
    });

    it("refuses ending another member's ACTIVE row and leaves it in place", async () => {
      const refusal = await controller()
        .deleteDeviceMembership(PEER.userId, PEER.deviceId, GROUP, SENDER.userId)
        .catch((e: unknown) => e);

      expect((refusal as { getResponse(): unknown }).getResponse()).toMatchObject({
        code: 'MEMBERSHIP_NOT_ALLOWED',
      });
      expect(await statusOf(PEER)).toBe('active');
    });

    it("ends another user's PENDING row", async () => {
      await q(
        `UPDATE dm_device_group_memberships SET status = 'pending'
          WHERE "groupId" = $1 AND "userId" = $2`,
        [GROUP, PEER.userId]
      );

      await expect(
        controller().deleteDeviceMembership(PEER.userId, PEER.deviceId, GROUP, SENDER.userId)
      ).resolves.toMatchObject({ status: 'deleted', affected: 1 });
      expect(await statusOf(PEER)).toBeNull();
    });

    it("ends the caller's own ACTIVE row", async () => {
      await expect(
        controller().deleteDeviceMembership(PEER.userId, PEER.deviceId, GROUP, PEER.userId)
      ).resolves.toMatchObject({ status: 'deleted', affected: 1 });
      expect(await statusOf(PEER)).toBeNull();
    });

    it('answers NOT_A_MEMBER for a tombstoned group that still holds the seat', async () => {
      await q(`UPDATE dm_groups SET "deletedAt" = now() WHERE id = $1`, [GROUP]);

      const refusal = await controller()
        .deleteDeviceMembership(PEER.userId, PEER.deviceId, GROUP, SENDER.userId)
        .catch((e: unknown) => e);

      expect((refusal as { getResponse(): unknown }).getResponse()).toMatchObject({
        code: 'NOT_A_MEMBER',
      });
      expect(await statusOf(PEER)).toBe('active');
    });
  });
});
