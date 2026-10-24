/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { GoneException } from '@nestjs/common';
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
    xrange: jest.fn().mockResolvedValue([]),
    xrevrange: jest.fn().mockResolvedValue([]),
    smembers: jest.fn().mockResolvedValue([]),
    sadd: jest.fn().mockResolvedValue(0),
    // Every member already routed, unless a test says otherwise.
    smismember: jest.fn(async (_key: string, ...members: string[]) => members.map(() => 1)),
    exists: jest.fn().mockResolvedValue(1),
    publish: jest.fn(),
    del: jest.fn().mockResolvedValue(1),
    keys: jest.fn().mockResolvedValue([]),
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

    // The transaction the fix runs in. `getRepository` hands back the two repositories it uses, and
    // both record what they were asked - the Group read so the test can see the lock, the queue
    // write so it can see WHERE the rows went.
    const transaction = async (cb: (m: unknown) => Promise<unknown>) =>
      cb({
        query: async (sql: string, params: unknown[]) => {
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
      manager: { transaction: jest.fn(transaction) },
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
});
