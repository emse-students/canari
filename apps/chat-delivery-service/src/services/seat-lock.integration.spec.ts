/**
 * THE SEAT LOCK'S ORDERINGS, AGAINST A REAL POSTGRESQL - migration 036 included.
 *
 * A seat's claim, its eviction, its route and a send's queued rows are ordered by one per-group
 * advisory lock (`utils/seat-eviction.ts`): the writers that create or delete a seat take it
 * exclusive, a send's queue write takes it shared. Which side waits for which is the whole
 * mechanism, and no fake can judge an advisory lock - so each ordering is run here deterministically:
 * a raw client holds the lock in an open transaction, the test reads `pg_blocking_pids` until the
 * service's own transaction is parked on it, then commits. No sleep anywhere.
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
import { claimSeat, seatClaimHolds, withSeatLock } from '../utils/seat-eviction';

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
    opts: { seats?: { exempt: ReadonlySet<string> }; welcome?: unknown }
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
});
