/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, GoneException, ServiceUnavailableException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessagingService } from './messaging.service';
import { QueuedMessage } from '../entities/queued-message.entity';
import { QueuedPayload } from '../entities/queued-payload.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { mlsFrame } from '../testing/mlsFrameFixture';
import { sentFrameLockKey } from '../utils/sent-frame-receipt';

/**
 * A SEND MAY NOT WRITE ROWS FOR A GROUP THAT STOPPED EXISTING WHILE IT WAS IN FLIGHT.
 *
 * `sendMessage` resolves its recipients from the membership table and then saves; `deleteGroup`
 * writes the tombstone and sweeps everything the group owns - its queue included - in one
 * transaction. Nothing ordered the two, so a send that read its recipients BEFORE the sweep and
 * saved AFTER it wrote rows into a queue that had just been emptied. Measured on the local estate
 * 2026-09-05, three consecutive lines of the delivery log:
 *
 *     [SEND][send-bc9c9815] START group=7e931024...
 *     [DELETE_GROUP] 7e931024... soft-deleted, 14 row(s) purged: {"queuedMessages":4,...}
 *     [SEND][send-bc9c9815] QUEUED count=2
 *
 * Nine milliseconds between the tombstone and the two rows, and the rows are permanent: no device
 * can decrypt or ACK a frame for a tombstoned group, so `fetchMessages` drops them on every
 * connection and nothing consumes them before the 90-day reaper. Twenty `dropped 1 undeliverable
 * message(s)` warnings in a thirty-minute window came from those two rows alone.
 *
 * THE ASSERTION THAT MATTERS IS STRUCTURAL, and it is the last test here: the liveness read and the
 * write must be ONE unit of work, with the group row locked. A check made anywhere else is a fact
 * read over a window it does not hold, which is what the client's own pre-flight `deletedAt` check
 * already is - it answered `found=true` one log line before the trace above.
 */
describe('MessagingService - a send cannot outlive its group', () => {
  let service: MessagingService;

  /** What `dm_groups` holds, by id. A missing key is a group with no row at all. */
  let groups: Record<
    string,
    {
      id: string;
      deletedAt: Date | null;
      activeEpoch?: number;
      distributionWorkspaceId?: string | null;
    }
  >;
  /** Rows written through the TRANSACTIONAL manager - the only legitimate way in. */
  let committed: Partial<QueuedMessage>[];
  /** Rows written through the bare repository, which after the fix must never happen for a group. */
  let bareSaved: Partial<QueuedMessage>[];
  /** Every option object the transaction's `Group.find` was called with. */
  let lockedReads: Array<{ lock?: { mode?: string } }>;
  let warnings: string[];
  /** The seats the group holds when read UNDER A LOCK - an eviction after the roster read removes one. */
  let seats: Array<{ userId: string; deviceId: string }>;
  /** What the transactions did, in order: each advisory lock taken and each group-row read. */
  let order: string[];
  /** Shared payloads written through the transactional manager. */
  let payloadSaves: object[];
  /** Builds the service again, so a test can boot it under another writer's switch. */
  let compile: () => Promise<MessagingService>;
  /** `dm_sent_frame_receipt`, keyed `group|sender|device|messageId`. */
  let receipts: Map<string, { receivedAt: Date; protoSha256: string; settled: boolean }>;
  /** Every history-stream append (`XADD` through the pipeline), by group key. */
  let historyAppends: string[];
  /**
   * The session advisory locks PostgreSQL holds, by key. Each query runner is one session: its
   * locks end with it, through its unlock or through the connection being destroyed.
   */
  let advisoryLocks: Set<string>;
  /** Whether the next advisory unlock fails - the connection must then be destroyed, not pooled. */
  let unlockFails: boolean;
  /** Every query runner a send opened, to see how each one ended. */
  let runners: Array<{ release: jest.Mock; releasePostgresConnection: jest.Mock }>;
  /** The stream entries those appends wrote, as `XRANGE` returns them. */
  let historyEntries: Array<[string, string[]]>;

  /**
   * The receipt table (migration 048), as the statements in `utils/sent-frame-receipt.ts` use it.
   * Its primary key is the whole mechanism, so the mock honours exactly that: an insert of a held
   * key does nothing and returns no row; an UPDATE answers `[rows, rowCount]` as TypeORM does.
   */
  const receiptQuery = (sql: string, params: unknown[]): unknown => {
    const key = params.slice(0, 4).join('|');
    const row = receipts.get(key);
    const statement = sql.trimStart();
    if (statement.startsWith('INSERT')) {
      if (row) return [];
      receipts.set(key, {
        receivedAt: params[4] as Date,
        protoSha256: params[5] as string,
        settled: false,
      });
      return [{ messageId: params[3] }];
    }
    if (statement.startsWith('UPDATE')) {
      const onlyUnsettled = sql.includes('"settled" = false');
      if (!row || (onlyUnsettled && row.settled)) return [[], 0];
      row.settled = true;
      return [[], 1];
    }
    return row ? [{ ...row }] : [];
  };

  const GROUP = 'g-1';
  const SENDER = { userId: 'u-sender', deviceId: 'dev-sender' };
  const PEER = { userId: 'u-peer', deviceId: 'dev-peer' };

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
  });

  const redis = {
    xadd: jest.fn(),
    expire: jest.fn(),
    xrange: jest.fn(async () => historyEntries),
    xrevrange: jest.fn().mockResolvedValue([]),
    smembers: jest.fn().mockResolvedValue([]),
    sadd: jest.fn().mockResolvedValue(0),
    // Every member already routed, unless a test says otherwise.
    smismember: jest.fn(async (_key: string, ...members: string[]) => members.map(() => 1)),
    exists: jest.fn().mockResolvedValue(1),
    publish: jest.fn(),
    del: jest.fn().mockResolvedValue(1),
    keys: jest.fn().mockResolvedValue([]),
    hdel: jest.fn().mockResolvedValue(0),
    pipeline: jest.fn(() => {
      const chain = {
        // `key, 'MAXLEN', '~', n, '*', ...fields`
        xadd: (key: string, ...args: string[]) => {
          historyAppends.push(key);
          historyEntries.push([`${historyEntries.length + 1}-0`, args.slice(4)]);
          return chain;
        },
        xtrim: () => chain,
        expire: () => chain,
        exec: async () => [
          [null, '1-0'],
          [null, 0],
          [null, 1],
        ],
      };
      return chain;
    }),
  };

  /** One ordinary application frame from the sender's device into `groupId`. */
  const send = (groupId?: string) =>
    service.sendMessage(
      {
        proto: 'Y2lwaGVydGV4dA==',
        groupId,
        senderId: SENDER.userId,
        senderDeviceId: SENDER.deviceId,
      },
      SENDER.userId
    );

  beforeEach(async () => {
    jest.clearAllMocks();
    groups = { [GROUP]: { id: GROUP, deletedAt: null } };
    committed = [];
    bareSaved = [];
    lockedReads = [];
    warnings = [];
    seats = [SENDER, PEER];
    order = [];
    payloadSaves = [];
    receipts = new Map();
    historyAppends = [];
    historyEntries = [];
    advisoryLocks = new Set();
    unlockFails = false;
    runners = [];

    // The transaction the fix runs in. `getRepository` hands back the two repositories it uses, and
    // both record what they were asked - the Group read so the test can see the lock, the queue
    // write so it can see WHERE the rows went.
    const transaction = async (cb: (m: unknown) => Promise<unknown>) =>
      cb({
        query: async (sql: string, params: unknown[]) => {
          if (sql.includes('dm_sent_frame_receipt')) return receiptQuery(sql, params);
          order.push(`${sql.includes('_shared') ? 'shared' : 'exclusive'} ${String(params[0])}`);
          return [];
        },
        getRepository: (entity: unknown) => {
          if (entity === DeviceGroupMembership) {
            return {
              find: async () => seats.map((s) => ({ ...s, groupId: GROUP, status: 'active' })),
            };
          }
          if (entity === Group) {
            return {
              find: async (opts: { lock?: { mode?: string }; where: { id: string } }) => {
                order.push('group row');
                lockedReads.push(opts);
                const row = groups[opts.where.id];
                return row ? [row] : [];
              },
            };
          }
          if (entity === QueuedPayload) {
            // A key-group fan-out stores its ciphertext once, in the same transaction - only while
            // the writer's switch is on.
            return {
              save: async (p: object) => {
                payloadSaves.push(p);
                return { ...p, id: 'payload-1' };
              },
            };
          }
          return {
            save: async (rows: Partial<QueuedMessage>[]) => {
              committed.push(...rows);
              return rows;
            },
          };
        },
      });

    const queuedRepo = {
      ...emptyRepo(),
      save: jest.fn(async (rows: Partial<QueuedMessage>[]) => {
        bareSaved.push(...rows);
        return rows;
      }),
      // The rows a repeat reads back: what is still queued (`committed`, which a test empties to
      // stand for copies pulled and acknowledged), matched on the columns the query names.
      find: jest.fn(
        async (opts: { where?: { groupId?: string; senderDeviceId?: string; createdAt?: Date } }) =>
          committed
            .filter(
              (r) =>
                r.groupId === opts.where?.groupId &&
                r.senderDeviceId === opts.where?.senderDeviceId &&
                r.createdAt?.getTime() === opts.where?.createdAt?.getTime()
            )
            .map((r) => ({ ...r }))
      ),
      manager: {
        transaction: jest.fn(transaction),
        query: jest.fn(async (sql: string, params: unknown[]) => receiptQuery(sql, params)),
        getRepository: jest.fn(() => queuedRepo),
        // ONE dedicated connection per runner, a session whose advisory locks are its own.
        connection: {
          createQueryRunner: jest.fn(() => {
            const mine = new Set<string>();
            const runner = {
              connect: jest.fn(async () => undefined),
              query: jest.fn(async (sql: string, params: unknown[]) => {
                const lockKey = String(params[0]);
                if (sql.includes('pg_try_advisory_lock')) {
                  if (advisoryLocks.has(lockKey)) return [{ locked: false }];
                  advisoryLocks.add(lockKey);
                  mine.add(lockKey);
                  return [{ locked: true }];
                }
                if (sql.includes('pg_advisory_unlock')) {
                  if (unlockFails) throw new Error('connection reset');
                  advisoryLocks.delete(lockKey);
                  mine.delete(lockKey);
                  return [{ pg_advisory_unlock: true }];
                }
                throw new Error(`unexpected runner query: ${sql}`);
              }),
              release: jest.fn(async () => undefined),
              // The pool destroys the client: the session ends, and its locks with it.
              releasePostgresConnection: jest.fn(async () => {
                for (const k of mine) advisoryLocks.delete(k);
              }),
            };
            runners.push(runner);
            return runner;
          }),
        },
      },
    };

    const deviceGroupRepo = {
      ...emptyRepo(),
      // The sender's own membership, read first and required to be `active`.
      findOne: jest.fn(async () => ({ ...SENDER, groupId: GROUP, status: 'active' })),
      // The roster the fan-out is built from: the sender plus one peer.
      find: jest.fn(async () => [
        { ...SENDER, groupId: GROUP, status: 'active' },
        { ...PEER, groupId: GROUP, status: 'active' },
      ]),
    };

    // Every roster device has a KeyPackage, so none is skipped as a ghost.
    const keyPackageRepo = {
      ...emptyRepo(),
      find: jest.fn(async () => [{ ...SENDER, deviceAppVersion: '1.2.3' }, PEER]),
    };

    const providers = [
      MessagingService,
      { provide: getRepositoryToken(QueuedMessage), useValue: queuedRepo },
      { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
      {
        provide: getRepositoryToken(Group),
        useValue: { ...emptyRepo(), manager: { transaction: jest.fn(transaction) } },
      },
      { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
      { provide: getRepositoryToken(OneTimeKeyPackage), useValue: emptyRepo() },
      { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
      { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
      { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
      { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
      { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
      { provide: 'REDIS_CLIENT', useValue: redis },
    ];
    compile = async () => {
      const module: TestingModule = await Test.createTestingModule({ providers }).compile();
      const built = module.get(MessagingService);
      jest.spyOn(built['logger'], 'log').mockImplementation(() => undefined);
      jest.spyOn(built['logger'], 'error').mockImplementation(() => undefined);
      jest.spyOn(built['logger'], 'warn').mockImplementation((m: unknown) => {
        warnings.push(String(m));
      });
      return built;
    };
    service = await compile();
  });

  afterEach(() => jest.restoreAllMocks());

  it('queues for a live group', async () => {
    await send(GROUP);

    expect(committed.map((r) => r.deviceId)).toEqual([PEER.deviceId]);
    expect(bareSaved).toEqual([]);
  });

  it('refuses a send whose group was tombstoned while it was in flight', async () => {
    // The delete landed after the recipients were resolved. Before the fix these rows were written
    // and were undeliverable for the life of the tombstone.
    groups[GROUP] = { id: GROUP, deletedAt: new Date('2026-09-05T04:00:58.960Z') };

    await expect(send(GROUP)).rejects.toBeInstanceOf(GoneException);
    expect(committed).toEqual([]);
    expect(bareSaved).toEqual([]);
  });

  it('refuses a send whose group row went away entirely', async () => {
    delete groups[GROUP];

    await expect(send(GROUP)).rejects.toBeInstanceOf(GoneException);
    expect(committed).toEqual([]);
  });

  it('names the group and the row count it refused to write', async () => {
    groups[GROUP] = { id: GROUP, deletedAt: new Date('2026-09-05T04:00:58.960Z') };

    await send(GROUP).catch(() => undefined);

    // A refusal nobody can read is a silent drop. The line has to carry which group, which cause,
    // and how many rows did NOT go out - the count is what says a message was lost rather than a
    // no-op refused.
    const line = warnings.find((w) => w.includes('REJECT group_deleted'));
    expect(line).toContain(GROUP);
    expect(line).toContain('tombstoned at 2026-09-05T04:00:58.960Z');
    expect(line).toContain('1 row(s)');
  });

  it('appends nothing to the history stream of a group it refused', async () => {
    groups[GROUP] = { id: GROUP, deletedAt: new Date() };

    await send(GROUP).catch(() => undefined);

    // The stream outlives the tombstone until the reaper, so a frame appended here would be read
    // back by a device catching up on history and be exactly as undecryptable as a queued row.
    expect(redis.xadd).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('refuses a send into a group deleted BEFORE it, whose roster the deletion swept', async () => {
    // `tombstoneGroups` deletes the device memberships, so the recipient set resolves empty and the
    // check above used to be skipped: 200, a history append, and a client marking its message sent.
    groups[GROUP] = { id: GROUP, deletedAt: new Date('2026-10-12T10:00:00.000Z') };
    const roster = (
      service as unknown as { deviceGroupRepo: { findOne: jest.Mock; find: jest.Mock } }
    ).deviceGroupRepo;
    roster.findOne.mockResolvedValue(null);
    roster.find.mockResolvedValue([]);

    await expect(send(GROUP)).rejects.toBeInstanceOf(GoneException);
    expect(committed).toEqual([]);
    expect(warnings.find((w) => w.includes('REJECT group_deleted'))).toContain('0 row(s)');
  });

  it('still answers a live group whose roster names nobody else', async () => {
    const roster = (
      service as unknown as { deviceGroupRepo: { findOne: jest.Mock; find: jest.Mock } }
    ).deviceGroupRepo;
    roster.find.mockResolvedValue([{ ...SENDER, groupId: GROUP, status: 'active' }]);

    await expect(send(GROUP)).resolves.toBeDefined();
    expect(committed).toEqual([]);
    expect(lockedReads).toHaveLength(1);
  });

  it('reads the group row under a shared lock, in the same transaction as the write', async () => {
    // THE STRUCTURAL CLAIM, and the only one that distinguishes this fix from another stale read.
    // The lock is what orders the send against the delete in BOTH directions: it blocks behind a
    // delete that got there first, and it holds a delete that arrives second until these rows are
    // committed - so that delete's own sweep, which runs after its `UPDATE`, takes them.
    await send(GROUP);

    expect(lockedReads).toHaveLength(1);
    expect(lockedReads[0].lock).toEqual({ mode: 'pessimistic_read' });
    // And the write went through the transaction, not around it.
    expect(committed).toHaveLength(1);
    expect(bareSaved).toEqual([]);
  });

  /**
   * A SEND MAY NOT OUTLIVE A SEAT EITHER. Its recipients are read with no lock, and an eviction that
   * lands before its write deletes the seat, its queued frames and its route - so the write takes
   * the seat lock SHARED, before the group row, and re-reads who still holds a seat.
   */
  describe('a seat evicted while the send was in flight', () => {
    it('takes the seat lock shared, before the group row', async () => {
      await send(GROUP);

      expect(order).toEqual([`shared seat:${GROUP}`, 'group row']);
    });

    it('queues nothing for it and delivers nothing to it', async () => {
      seats = [SENDER];
      const deliver = jest.spyOn(
        service as unknown as { deliverQueuedFrame: () => Promise<boolean> },
        'deliverQueuedFrame'
      );

      const res = await send(GROUP);

      expect(committed).toEqual([]);
      expect(deliver).not.toHaveBeenCalled();
      expect(res).toEqual(expect.objectContaining({ queued: 0 }));
    });

    it('puts no route back for it, re-reading the seats under the seat lock', async () => {
      seats = [SENDER];
      redis.smismember.mockResolvedValueOnce([1, 0]);

      await send(GROUP);

      expect(order).toContain(`exclusive seat:${GROUP}`);
      expect(redis.sadd).not.toHaveBeenCalled();
    });

    it('puts back the route of a seat still held, under the same lock', async () => {
      redis.smismember.mockResolvedValueOnce([1, 0]);

      await send(GROUP);

      expect(redis.sadd).toHaveBeenCalledWith(
        `group:members:${GROUP}`,
        `${PEER.userId}:${PEER.deviceId}`
      );
    });
  });

  // The same locked read names a frame sealed beyond the past-epoch window (backlog, 2026-10-12:
  // seed requests sealed at 135-138 into a key group at 141). Reported, never refused: the line is
  // the measurement of which sender builds lag.
  describe('a frame sealed too far behind its group', () => {
    const sendAt = (epoch: bigint, extra: { isCommit?: boolean } = {}) =>
      service.sendMessage(
        {
          proto: mlsFrame(extra.isCommit ? 1 : 2, GROUP, epoch),
          groupId: GROUP,
          senderId: SENDER.userId,
          senderDeviceId: SENDER.deviceId,
          ...extra,
        },
        SENDER.userId
      );
    const staleLines = () => warnings.filter((w) => w.includes('STALE_EPOCH_FRAME'));

    beforeEach(() => {
      groups[GROUP] = {
        id: GROUP,
        deletedAt: null,
        activeEpoch: 141,
        distributionWorkspaceId: 'ws-1',
      };
    });

    it('names the sender, its build and the distance, and still queues the frame', async () => {
      await sendAt(138n);

      const [line] = staleLines();
      expect(line).toContain(`group=${GROUP} keyGroup=true`);
      expect(line).toContain('frameEpoch=138 activeEpoch=141 behind=3');
      expect(line).toContain(`sender=${SENDER.userId}:${SENDER.deviceId} app=1.2.3`);
      // Contained, not equal: this roster mock answers the pending-admitted read with the same rows.
      expect(committed.map((r) => r.deviceId)).toContain(PEER.deviceId);
    });

    it('stays silent for a frame inside the window - two epochs behind still decrypts', async () => {
      await sendAt(139n);
      await sendAt(141n);

      expect(staleLines()).toEqual([]);
    });

    it("stays silent for a commit, whose epoch is its base and is the commit gate's business", async () => {
      await sendAt(130n, { isCommit: true }).catch(() => undefined);

      expect(staleLines()).toEqual([]);
    });

    it('reads a conversation group as not a key group', async () => {
      groups[GROUP] = { id: GROUP, deletedAt: null, activeEpoch: 9, distributionWorkspaceId: null };

      await sendAt(4n);

      expect(staleLines()[0]).toContain('keyGroup=false');
    });
  });

  // THE READERS SHIP BEFORE THE WRITER. A record written as a shared payload stores a NULL `proto`
  // that an image older than the readers would serve as an empty frame, so the writer is a switch
  // that boots OFF, and OFF must be exactly the per-seat inline write every release has made.
  describe("the shared-payload writer's switch", () => {
    const PEER2 = { userId: 'u-peer-2', deviceId: 'dev-peer-2' };
    const ENV = 'QUEUED_PAYLOAD_SHARED_WRITES';
    const saved = process.env[ENV];

    beforeEach(() => {
      groups[GROUP] = { id: GROUP, deletedAt: null, distributionWorkspaceId: 'ws-1' };
      // The second peer holds a seat under the lock too, or the send would drop its row as evicted.
      seats = [SENDER, PEER, PEER2];
      const internals = service as unknown as {
        deviceGroupRepo: { find: jest.Mock };
        keyPackageRepo: { find: jest.Mock };
      };
      internals.deviceGroupRepo.find.mockResolvedValue(
        [SENDER, PEER, PEER2].map((s) => ({ ...s, groupId: GROUP, status: 'active' }))
      );
      internals.keyPackageRepo.find.mockResolvedValue([SENDER, PEER, PEER2]);
    });

    afterEach(() => {
      if (saved === undefined) delete process.env[ENV];
      else process.env[ENV] = saved;
    });

    const peerRecords = () =>
      committed.filter((r) => r.deviceId === PEER.deviceId || r.deviceId === PEER2.deviceId);

    it('OFF (unset, the default): a key-group fan-out is one inline copy per seat, no payload', async () => {
      delete process.env[ENV];
      service = await compile();
      // The roster mocks live on the shared providers, so the rebuilt service reads the same ones.

      await send(GROUP);

      expect(payloadSaves).toEqual([]);
      expect(peerRecords().length).toBeGreaterThanOrEqual(2);
      for (const row of peerRecords()) {
        expect(row.proto).toBe('Y2lwaGVydGV4dA==');
        expect(row.payloadId).toBeUndefined();
      }
    });

    it('ON: the same fan-out stores ONE payload and records that point at it', async () => {
      process.env[ENV] = 'true';
      service = await compile();

      await send(GROUP);

      expect(payloadSaves).toHaveLength(1);
      expect(peerRecords().length).toBeGreaterThanOrEqual(2);
      for (const row of peerRecords()) expect(row.payloadId).toBe('payload-1');
    });

    it('a value that is neither true nor false stops the service from booting', async () => {
      process.env[ENV] = 'yes';

      await expect(compile()).rejects.toThrow(/QUEUED_PAYLOAD_SHARED_WRITES/);
    });
  });
  /**
   * ONE ID IS ONE MESSAGE (migration 048). A native background send reads an answer past its 10 s
   * read timeout as a failure and sends the same message again under the same `messageId` - a fresh
   * ciphertext each time, so only the id says it is a repeat. The repeat must reach nobody: no second
   * queued row, no second history append, no second delivery, and the sender is answered with the
   * first copy's receive time.
   */
  describe('a message sent again under the same messageId', () => {
    const MSG = '6f1d2c3b-0000-4000-8000-000000000001';
    const sendId = (messageId: unknown, deviceId = SENDER.deviceId) =>
      service.sendMessage(
        {
          proto: 'Y2lwaGVydGV4dA==',
          groupId: GROUP,
          senderId: SENDER.userId,
          senderDeviceId: deviceId,
          messageId: messageId as string,
        },
        SENDER.userId
      );
    const deliveries = () =>
      jest.spyOn(
        service as unknown as { deliverQueuedFrame: () => Promise<boolean> },
        'deliverQueuedFrame'
      );

    it('queues, appends and delivers the first send once', async () => {
      const deliver = deliveries();

      const res = await sendId(MSG);

      expect(committed.map((r) => r.deviceId)).toEqual([PEER.deviceId]);
      expect(historyAppends).toEqual([`history:${GROUP}`]);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(res.queued).toBe(1);
    });

    it('stores the repeat nowhere and answers it with the receive time of the first copy', async () => {
      const first = await sendId(MSG);
      const deliver = deliveries();
      committed = [];
      historyAppends = [];

      const again = await sendId(MSG);

      expect(committed).toEqual([]);
      expect(bareSaved).toEqual([]);
      expect(historyAppends).toEqual([]);
      expect(deliver).not.toHaveBeenCalled();
      expect(again).toEqual({
        status: 'processed',
        queued: 0,
        sent: 0,
        receivedAt: first.receivedAt,
      });
      expect(warnings.find((w) => w.includes('REPEATED_MESSAGE_ID'))).toContain(GROUP);
    });

    it('stores the repeat nowhere even when the roster names nobody else', async () => {
      const roster = (service as unknown as { deviceGroupRepo: { find: jest.Mock } })
        .deviceGroupRepo;
      roster.find.mockResolvedValue([{ ...SENDER, groupId: GROUP, status: 'active' }]);
      await sendId(MSG);
      historyAppends = [];
      warnings = [];

      await sendId(MSG);

      // The emptied-roster path appends to the history stream too, so it is owed the same answer -
      // and the repeat is not reported as "nobody to queue for".
      expect(historyAppends).toEqual([]);
      expect(warnings.some((w) => w.includes('No message queued'))).toBe(false);
    });

    it('queues the same id from ANOTHER device of the sender: the key names the device', async () => {
      await sendId(MSG);
      committed = [];

      await sendId(MSG, 'dev-sender-2');

      expect(receipts.size).toBe(2);
      expect(historyAppends).toHaveLength(2);
    });

    it('leaves no receipt behind a refused first send, so its retry is queued', async () => {
      groups[GROUP] = { id: GROUP, deletedAt: new Date('2026-11-13T09:00:00.000Z') };
      await expect(sendId(MSG)).rejects.toBeInstanceOf(GoneException);
      expect(receipts.size).toBe(0);

      groups[GROUP] = { id: GROUP, deletedAt: null };
      await sendId(MSG);

      expect(committed.map((r) => r.deviceId)).toEqual([PEER.deviceId]);
    });

    it('queues every send that names no id, as before', async () => {
      await send(GROUP);
      await send(GROUP);

      expect(committed).toHaveLength(2);
      expect(receipts.size).toBe(0);
    });

    it('refuses a messageId that is not an id, rather than reading it as absent', async () => {
      await expect(sendId('not an id; DROP')).rejects.toBeInstanceOf(BadRequestException);
      await expect(sendId(42)).rejects.toBeInstanceOf(BadRequestException);
      expect(committed).toEqual([]);
    });

    /**
     * THE FIRST SEND MAY DIE BETWEEN ITS COMMIT AND ITS DELIVERY: its rows are queued and its receipt
     * written, but no history entry, no live delivery and no push happened. Its receipt is then
     * unsettled, and the repeat finishes exactly what is left - from durable state (the rows still
     * queued, the stream's own entries), never from a clock.
     */
    describe('a repeat of a first send that died before its delivery', () => {
      const offlinePeer = () => redis.exists.mockResolvedValue(0);
      afterEach(() => redis.exists.mockResolvedValue(1));
      const pushes = () =>
        jest
          .spyOn(
            service as unknown as { sendFcmForQueued: () => Promise<void> },
            'sendFcmForQueued'
          )
          .mockResolvedValue(undefined);
      const dieOnce = (step: 'appendToHistory' | 'deliverQueuedRows') =>
        jest
          .spyOn(service as unknown as Record<typeof step, () => Promise<unknown>>, step)
          .mockRejectedValueOnce(new Error('the process died here'));
      const receipt = () => receipts.get(`${GROUP}|${SENDER.userId}|${SENDER.deviceId}|${MSG}`);

      it('settles the receipt once a whole send ran its delivery', async () => {
        await sendId(MSG);

        expect(receipt()?.settled).toBe(true);
      });

      it('died before the history append: the repeat appends once, delivers once, pushes once', async () => {
        offlinePeer();
        const push = pushes();
        dieOnce('appendToHistory');
        await expect(sendId(MSG)).rejects.toThrow('the process died here');
        expect(committed.map((r) => r.deviceId)).toEqual([PEER.deviceId]);
        expect(historyAppends).toEqual([]);
        expect(push).not.toHaveBeenCalled();
        expect(receipt()?.settled).toBe(false);

        const again = await sendId(MSG);

        expect(historyAppends).toEqual([`history:${GROUP}`]);
        expect(push).toHaveBeenCalledTimes(1);
        expect(committed).toHaveLength(1);
        expect(again.receivedAt).toBe(receipt()?.receivedAt.getTime());
        expect(receipt()?.settled).toBe(true);
        expect(warnings.find((w) => w.includes('REPEAT_FINISHED_FIRST_COPY'))).toContain(
          'stillQueued=1'
        );

        // And a further repeat finds it settled: nothing new, no second push.
        await sendId(MSG);
        expect(historyAppends).toHaveLength(1);
        expect(push).toHaveBeenCalledTimes(1);
      });

      it('died after the history append: the repeat appends NOTHING and delivers once', async () => {
        offlinePeer();
        const push = pushes();
        dieOnce('deliverQueuedRows');
        await expect(sendId(MSG)).rejects.toThrow('the process died here');
        expect(historyAppends).toHaveLength(1);

        await sendId(MSG);

        // The stream already held the first copy (same device, same receive time): one entry.
        expect(historyAppends).toHaveLength(1);
        expect(push).toHaveBeenCalledTimes(1);
      });

      it('delivers nothing for a copy already pulled and acknowledged', async () => {
        const deliver = jest.spyOn(
          service as unknown as { deliverQueuedFrame: () => Promise<boolean> },
          'deliverQueuedFrame'
        );
        dieOnce('deliverQueuedRows');
        await expect(sendId(MSG)).rejects.toThrow('the process died here');
        committed = [];

        await sendId(MSG);

        expect(deliver).not.toHaveBeenCalled();
        expect(historyAppends).toHaveLength(1);
      });

      /**
       * `settled = false` MEANS "NOT FINISHED YET", not "the first send died": a repeat arriving while
       * a slow first send is still in its delivery steps must leave them to it. The proof that the
       * first send is gone is its advisory lock, which it holds until it settled.
       */
      it('a repeat DURING a live first send finishes nothing: one append, one push', async () => {
        offlinePeer();
        const push = pushes();
        const real = (
          service as unknown as { deliverQueuedRows: (...a: unknown[]) => Promise<number> }
        ).deliverQueuedRows.bind(service);
        let reached!: () => void;
        const atDelivery = new Promise<void>((r) => (reached = r));
        let resume!: () => void;
        const held = new Promise<void>((r) => (resume = r));
        jest
          .spyOn(
            service as unknown as { deliverQueuedRows: () => Promise<number> },
            'deliverQueuedRows'
          )
          .mockImplementationOnce(async (...args: unknown[]) => {
            reached();
            await held;
            return real(...args);
          });
        const firstSend = sendId(MSG);
        await atDelivery;
        expect(receipt()?.settled).toBe(false);

        const again = await sendId(MSG);

        expect(again.queued).toBe(0);
        expect(again.receivedAt).toBe(receipt()?.receivedAt.getTime());
        expect(push).not.toHaveBeenCalled();
        expect(warnings.some((w) => w.includes('REPEAT_FINISHED_FIRST_COPY'))).toBe(false);
        expect(warnings.find((w) => w.includes('REPEATED_MESSAGE_ID'))).toContain(GROUP);

        resume();
        await firstSend;
        expect(historyAppends).toHaveLength(1);
        expect(push).toHaveBeenCalledTimes(1);
        expect(receipt()?.settled).toBe(true);
        expect(advisoryLocks.size).toBe(0);
      });

      it('a repeat while the lock is held and nothing is committed yet is refused, to be retried', async () => {
        // Another session holds this message's lock, and its claim has not committed.
        const runner = (
          service as unknown as {
            queuedMessageRepo: {
              manager: { connection: { createQueryRunner: () => { query: jest.Mock } } };
            };
          }
        ).queuedMessageRepo.manager.connection.createQueryRunner();
        await runner.query('SELECT pg_try_advisory_lock($1::bigint)', [
          sentFrameLockKey(GROUP, {
            senderId: SENDER.userId,
            senderDeviceId: SENDER.deviceId,
            messageId: MSG,
          }),
        ]);

        await expect(sendId(MSG)).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(warnings.find((w) => w.includes('SEND_IN_FLIGHT'))).toContain(GROUP);
        expect(receipt()).toBeUndefined();
      });

      it("a repeat once the first send's connection is GONE finishes it, once", async () => {
        offlinePeer();
        const push = pushes();
        // The first send stopped between its commit and its delivery, its session still open: a
        // repeat then cannot tell it from a slow one, and finishes nothing.
        const lockKey = sentFrameLockKey(GROUP, {
          senderId: SENDER.userId,
          senderDeviceId: SENDER.deviceId,
          messageId: MSG,
        });
        dieOnce('appendToHistory');
        await expect(sendId(MSG)).rejects.toThrow('the process died here');
        // (Here the failure released it; a frozen process would not have.)
        advisoryLocks.add(lockKey);

        await sendId(MSG);
        expect(historyAppends).toEqual([]);
        expect(push).not.toHaveBeenCalled();
        expect(receipt()?.settled).toBe(false);

        // The connection is gone: PostgreSQL ended the session and its lock with it.
        advisoryLocks.delete(lockKey);
        await sendId(MSG);
        await sendId(MSG);

        expect(historyAppends).toEqual([`history:${GROUP}`]);
        expect(push).toHaveBeenCalledTimes(1);
        expect(receipt()?.settled).toBe(true);
      });

      it('destroys the connection whose unlock failed, so no pooled session keeps the lock', async () => {
        unlockFails = true;

        await sendId(MSG);

        const [runner] = runners;
        expect(runner.release).not.toHaveBeenCalled();
        expect(runner.releasePostgresConnection).toHaveBeenCalledTimes(1);
        expect(advisoryLocks.size).toBe(0);
        unlockFails = false;
        await sendId(MSG);
        expect(warnings.find((w) => w.includes('REPEATED_MESSAGE_ID'))).toContain(GROUP);
      });

      it('delivers nothing for a queued row of ANOTHER frame received at the same instant', async () => {
        const deliver = jest.spyOn(
          service as unknown as { deliverQueuedFrame: () => Promise<boolean> },
          'deliverQueuedFrame'
        );
        dieOnce('deliverQueuedRows');
        await expect(sendId(MSG)).rejects.toThrow('the process died here');
        // Same group, device and instant, another ciphertext: not the first copy's row.
        committed = committed.map((r) => ({ ...r, proto: 'YW5vdGhlciBmcmFtZQ==' }));

        await sendId(MSG);

        expect(deliver).not.toHaveBeenCalled();
      });
    });
  });
});
