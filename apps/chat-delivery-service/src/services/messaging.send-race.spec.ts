/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { GoneException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessagingService } from './messaging.service';
import { QueuedMessage } from '../entities/queued-message.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';

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
  let groups: Record<string, { id: string; deletedAt: Date | null }>;
  /** Rows written through the TRANSACTIONAL manager - the only legitimate way in. */
  let committed: Partial<QueuedMessage>[];
  /** Rows written through the bare repository, which after the fix must never happen for a group. */
  let bareSaved: Partial<QueuedMessage>[];
  /** Every option object the transaction's `Group.find` was called with. */
  let lockedReads: Array<{ lock?: { mode?: string } }>;
  let warnings: string[];

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

    // The transaction the fix runs in. `getRepository` hands back the two repositories it uses, and
    // both record what they were asked - the Group read so the test can see the lock, the queue
    // write so it can see WHERE the rows went.
    const transaction = async (cb: (m: unknown) => Promise<unknown>) =>
      cb({
        getRepository: (entity: unknown) => {
          if (entity === Group) {
            return {
              find: async (opts: { lock?: { mode?: string }; where: { id: string } }) => {
                lockedReads.push(opts);
                const row = groups[opts.where.id];
                return row ? [row] : [];
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
      find: jest.fn(async () => [SENDER, PEER]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: queuedRepo },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();

    service = module.get(MessagingService);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation((m: unknown) => {
      warnings.push(String(m));
    });
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
});
