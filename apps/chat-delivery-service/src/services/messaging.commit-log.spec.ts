/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FindOperator, IsNull } from 'typeorm';
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
import { externalCommitFrame, memberCommitFrame } from '../testing/mlsFrameFixture';

describe('MessagingService - commit-log (rung-1 backbone)', () => {
  let service: MessagingService;

  /**
   * The epoch advance is written through a TRANSACTION now, not `save`, because the external-join
   * base for the epoch it creates has to land with it or not at all (COMM-22). The fake manager
   * hands out the same two repositories the real one would, so a test can assert BOTH writes and
   * see that they happened inside the one callback.
   */
  const groupUpdate = jest.fn().mockResolvedValue({ affected: 1 });
  // The group row read under lock before a carried Welcome is written: live unless a test says not.
  const txGroupFind = jest.fn();
  // `update`: the link seat a commit's admits answer (`awaitingAdmission`), lifted in the advance.
  const txSeatRepo = {
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
    // The roster read of the people a commit admits (`enrolAdmittedPeople`): everyone asked about is
    // already enrolled here, so no seat is written. The enrolment itself is judged against a real
    // database (`add-enrolment.integration.spec.ts`).
    find: jest.fn(async ({ where }: { where: { userId: { value: string[] } } }) =>
      where.userId.value.map((userId) => ({ userId }))
    ),
  };
  const txQueuedRepo = {
    create: jest.fn((row: Record<string, unknown>) => ({ ...row })),
    save: jest.fn(async (row: Record<string, unknown>) => ({ ...row, id: 'queued-welcome-1' })),
  };
  const txGroupInfoRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn(),
  };
  const txInsertBuilder = {
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ raw: [{ groupId: 'group-1' }] }),
  };
  const txUpdateBuilder = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({}),
  };
  /**
   * The `dm_seat_evictions` row the advance's transaction reads under the seat lock - none unless a
   * test says an eviction committed after the claims were read.
   */
  let txEvictionRow: { generation: number; owedDeparture: number | null } | null = null;
  const transaction = jest.fn(async (cb: (m: unknown) => Promise<void>) =>
    cb({
      // The seat lock's `pg_advisory_xact_lock` and the eviction record: a no-op here, a real queue
      // and a real table in the interleaving cases below.
      query: jest.fn(async (sql: string) =>
        sql.includes('FROM dm_seat_evictions') && txEvictionRow ? [txEvictionRow] : []
      ),
      getRepository: (entity: unknown) => {
        if (entity === Group) return { update: groupUpdate, find: txGroupFind };
        // A Welcome carried by the commit is written in the same callback as the advance.
        if (entity === QueuedMessage) return txQueuedRepo;
        // The carried Welcome's target seat, re-read under a lock in the advance's transaction.
        if (entity === GroupMember) return txSeatRepo;
        // THE COMMIT-LOG ROW IS WRITTEN INSIDE THIS TRANSACTION NOW, not best-effort after it: the
        // epoch advance and the commit that lets everyone else replay it land together or neither
        // lands. Routing it here is what lets a test see the two writes in one callback.
        if (entity === MlsCommitLog) return { createQueryBuilder: () => commitInsertBuilder };
        // The newcomers a commit admits are written in the same callback as the advance.
        if (entity === DeviceGroupMembership) return txMembershipRepo;
        // A seat's key package, read FOR SHARE under the seat lock before the seat is written.
        if (entity === KeyPackage) return txKeyPackageRepo;
        if (entity === RevokedDevice) return revokedDeviceRepo;
        return txGroupInfoRepo;
      },
    })
  );
  /**
   * The key packages as the advance's transaction re-reads them under the seat lock: every device
   * asked for is still registered unless a test says an erasure took it since the gate's read.
   */
  const txKeyPackageRepo = {
    find: jest.fn(async ({ where }: { where: Array<{ userId: string; deviceId: string }> }) =>
      where.filter((d) => !txErasedDevices.has(`${d.userId}:${d.deviceId}`))
    ),
  };
  /** `userId:deviceId` of devices whose key package is gone by the time the lock is held. */
  const txErasedDevices = new Set<string>();
  const membershipInsertBuilder = {
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({}),
  };
  const txMembershipRepo = {
    createQueryBuilder: jest.fn(() => membershipInsertBuilder),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    // A claimed activation writes its seat in the seat lock's transaction; it lands on the same
    // `upsert` the assertions read.
    upsert: (...args: unknown[]) => deviceGroupRepo.upsert(...(args as [])),
    // The seat re-read under the lock before its route is written: still active here.
    findOne: jest.fn().mockResolvedValue({ deviceId: 'routed' }),
  };
  // `query` answers the seat claim read before the gate (`claimSeat`): no eviction on record.
  const groupRepo = {
    findOne: jest.fn(),
    save: jest.fn(),
    manager: { transaction, query: jest.fn().mockResolvedValue([]) },
  };
  const groupMemberRepo = { findOne: jest.fn() };
  // The insert answers the row it wrote (`RETURNING`); a conflict answers none.
  const commitInsertBuilder = {
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ raw: [{ baseEpoch: 0 }] }),
  };
  const commitLogRepo = {
    createQueryBuilder: jest.fn(() => commitInsertBuilder),
    find: jest.fn(),
    findOne: jest.fn(),
    delete: jest.fn(),
    query: jest.fn(),
  };
  // The committing device's membership row: absent for an external-commit join, present and
  // active for an ordinary commit from an existing member.
  const deviceGroupRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(),
    upsert: jest.fn().mockResolvedValue(undefined),
    // Active devices of a person whose seat awaits a member: none unless a case says so.
    count: jest.fn().mockResolvedValue(0),
  };
  // The addressability guard (WP-GHOST-1): a device may only be promoted to `active` if it is not
  // on the revocation denylist AND still has a static KeyPackage. Both default to "device exists",
  // so the promotion tests keep testing promotion; the refusal tests set them explicitly.
  const keyPackageRepo = {
    find: jest.fn(),
    findOne: jest.fn().mockResolvedValue({ id: 'kp-1', userId: 'user-1', deviceId: 'device-1' }),
    save: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(),
  };
  const revokedDeviceRepo = {
    find: jest.fn(),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(),
  };
  const redisStore = new Map<string, string>();
  const redis = {
    set: jest.fn(() => Promise.resolve('OK')),
    eval: jest.fn(() => Promise.resolve(1)),
    get: jest.fn((k: string) => Promise.resolve(redisStore.get(k) ?? null)),
    del: jest.fn(),
    sadd: jest.fn(() => Promise.resolve(1)),
    xrange: jest.fn(() => Promise.resolve([])),
    // The parting hint (`partingKey`): read for a commit that declares removals, cleared for a
    // device back in the tree.
    hgetall: jest.fn(() => Promise.resolve({} as Record<string, string>)),
    hdel: jest.fn(() => Promise.resolve(0)),
    // Presence of a Welcome's target, asked once before its delivery.
    exists: jest.fn(() => Promise.resolve(0)),
  };

  /**
   * A repository that holds nothing - which is NOT the same as one that answers `undefined`.
   *
   * `find` on a real TypeORM repository returns `[]`, and a bare `jest.fn()` returns `undefined`,
   * so every caller reading `.length` off the result threw a TypeError instead of taking the
   * empty-set branch. Isolated, the throw landed inside a caller that swallows it; alongside
   * another spec it surfaced as a failure, which is why this read as cross-file pollution and was
   * not - the fixture was simply lying about what a repository does.
   */
  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default: the committer is already an active member, so the promotion path stays inert
    // unless a test explicitly makes the row absent.
    deviceGroupRepo.findOne.mockResolvedValue({ status: 'active' });
    deviceGroupRepo.find.mockResolvedValue([]);
    groupMemberRepo.findOne.mockResolvedValue(null);
    keyPackageRepo.findOne.mockResolvedValue({
      id: 'kp-1',
      userId: 'user-1',
      deviceId: 'device-1',
    });
    revokedDeviceRepo.findOne.mockResolvedValue(null);
    txErasedDevices.clear();
    txGroupFind.mockResolvedValue([{ id: 'group-1', deletedAt: null }]);
    txSeatRepo.findOne.mockResolvedValue({ groupId: 'group-1', userId: 'user-2' });
    txQueuedRepo.save.mockImplementation(async (row: Record<string, unknown>) => ({
      ...row,
      id: 'queued-welcome-1',
    }));
    txGroupInfoRepo.findOne.mockResolvedValue(null);
    txGroupInfoRepo.createQueryBuilder.mockImplementation((): unknown => ({
      ...txInsertBuilder,
      ...txUpdateBuilder,
    }));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: groupMemberRepo },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
        {
          provide: getRepositoryToken(OneTimeKeyPackage),
          useValue: emptyRepo(),
        },
        {
          provide: getRepositoryToken(DeviceGroupMembership),
          useValue: deviceGroupRepo,
        },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: commitLogRepo },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: revokedDeviceRepo },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();

    service = module.get(MessagingService);
  });

  describe('validateCommit stores the commit and fans it out', () => {
    it('records the accepted commit keyed by baseEpoch, then broadcasts it', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5 });
      const fanOut = jest
        .spyOn(service, 'sendMessage')
        .mockResolvedValue({ status: 'processed', queued: 0, sent: 0, receivedAt: 0 });

      const res = await service.validateCommit(
        {
          groupId: 'group-1',
          deviceId: 'device-1',
          baseEpoch: 5,
          proto: memberCommitFrame('group-1', 5n),
          senderId: 'user-1',
          excludeDeviceIds: ['user-1:device-1'],
        },
        'user-1'
      );

      expect(res.accepted).toBe(true);
      expect(res.newEpoch).toBe(6);
      // Epoch advanced and persisted, inside the transaction.
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(groupUpdate).toHaveBeenCalledWith(
        { id: 'group-1', activeEpoch: 5 },
        { activeEpoch: 6 }
      );
      // Commit stored keyed by the epoch it advances FROM.
      expect(commitInsertBuilder.values).toHaveBeenCalledWith({
        groupId: 'group-1',
        baseEpoch: 5,
        commit: memberCommitFrame('group-1', 5n),
        senderDeviceId: 'device-1',
      });
      expect(commitInsertBuilder.orIgnore).toHaveBeenCalled();
      // Fanned out as a commit, honouring the exclude list.
      expect(fanOut).toHaveBeenCalledWith(
        expect.objectContaining({
          groupId: 'group-1',
          proto: memberCommitFrame('group-1', 5n),
          isCommit: true,
          excludeDeviceIds: ['user-1:device-1'],
        }),
        undefined,
        // A commit declaring no removal reaches no parted device.
        []
      );
    });

    // -- COMM-22: the base for the epoch a commit creates travels WITH the commit ---------------
    //
    // It used to be minted by a second client round-trip made after this one returned, and nothing
    // else ever mints one. An external joiner reloads by construction, so that call was the one
    // certain to be lost - after which the published base trailed `activeEpoch` for good and the
    // strict gate refused every later external commit. Measured on production 2026-08-26.

    it('stores the base for the new epoch in the same transaction as the advance', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5 });
      jest
        .spyOn(service, 'sendMessage')
        .mockResolvedValue({ status: 'processed', queued: 0, sent: 0, receivedAt: 0 });

      const res = await service.validateCommit(
        {
          groupId: 'group-1',
          deviceId: 'device-1',
          baseEpoch: 5,
          proto: memberCommitFrame('group-1', 5n),
          senderId: 'user-1',
          groupInfo: 'Z2k=',
        },
        'user-1'
      );

      expect(res.accepted).toBe(true);
      // Under the epoch the commit CREATES, not the one it was built on: a base stored at 5 is the
      // very staleness this closes.
      expect(txInsertBuilder.values).toHaveBeenCalledWith({
        groupId: 'group-1',
        groupInfo: 'Z2k=',
        baseEpoch: 6,
      });
      // One transaction for both writes - which is the whole claim.
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(groupUpdate).toHaveBeenCalledWith(
        { id: 'group-1', activeEpoch: 5 },
        { activeEpoch: 6 }
      );
    });

    it('advances the epoch alone when the committer sends no base', async () => {
      // An ordinary staged add/remove cannot export one: its commit is unapplied at submit time, so
      // the device does not hold the resulting epoch's tree yet. Those keep the follow-up refresh
      // and a holder's `republishStaleBase` as their repair - what must NOT happen is a base
      // written for an epoch nobody described.
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5 });
      jest
        .spyOn(service, 'sendMessage')
        .mockResolvedValue({ status: 'processed', queued: 0, sent: 0, receivedAt: 0 });

      const res = await service.validateCommit(
        {
          groupId: 'group-1',
          deviceId: 'device-1',
          baseEpoch: 5,
          proto: memberCommitFrame('group-1', 5n),
          senderId: 'user-1',
        },
        'user-1'
      );

      expect(res.accepted).toBe(true);
      expect(groupUpdate).toHaveBeenCalledWith(
        { id: 'group-1', activeEpoch: 5 },
        { activeEpoch: 6 }
      );
      expect(txInsertBuilder.values).not.toHaveBeenCalled();
      expect(txUpdateBuilder.set).not.toHaveBeenCalled();
    });

    it('refuses to store a base for a commit the gate rejected', async () => {
      // The base is monotonic and cannot be walked back, so publishing one for an epoch that never
      // happened would strand the group permanently - worse than the staleness it replaces.
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 7 });

      const res = await service.validateCommit(
        {
          groupId: 'group-1',
          deviceId: 'device-1',
          baseEpoch: 5,
          proto: memberCommitFrame('group-1', 5n),
          senderId: 'user-1',
          groupInfo: 'Z2k=',
        },
        'user-1'
      );

      expect(res).toEqual({ accepted: false, currentEpoch: 7, reason: 'epoch_mismatch' });
      expect(transaction).not.toHaveBeenCalled();
      expect(txInsertBuilder.values).not.toHaveBeenCalled();
    });

    it('promotes the committing device to active when it has no membership row (external join)', async () => {
      // An external-commit join never receives a Welcome, so nothing else creates the row.
      // Without the promotion, recipient resolution (status='active') skips the device and it
      // receives neither the history bundle it solicits nor any later message.
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 1 });
      deviceGroupRepo.findOne.mockResolvedValue(null);
      groupMemberRepo.findOne.mockResolvedValue({ groupId: 'group-1', userId: 'user-2' });
      jest
        .spyOn(service, 'sendMessage')
        .mockResolvedValue({ status: 'processed', queued: 0, sent: 0, receivedAt: 0 });

      const res = await service.validateCommit(
        {
          groupId: 'group-1',
          deviceId: 'device-new',
          baseEpoch: 1,
          proto: externalCommitFrame('group-1', 1n, 'user-2:device-new'),
          senderId: 'user-2',
          excludeDeviceIds: ['user-2:device-new'],
        },
        'user-2'
      );

      expect(res.accepted).toBe(true);
      // `kickedAt: null` is part of the payload since 2026-09-04: activating a device answers
      // "is a re-add still owed to it?" with no, and the stranded report reads that column to
      // separate a device never added from one kicked and never re-added.
      expect(deviceGroupRepo.upsert).toHaveBeenCalledWith(
        {
          userId: 'user-2',
          deviceId: 'device-new',
          groupId: 'group-1',
          status: 'active',
          kickedAt: null,
          admittedAtEpoch: null,
        },
        { conflictPaths: ['deviceId', 'groupId'] }
      );
      expect(redis.sadd).toHaveBeenCalledWith('group:members:group-1', 'user-2:device-new');
      // Nothing replayed: the joiner landed at the current epoch and cannot decrypt anything sent
      // before its commit - those messages come back via the history bundle.
      expect(redis.xrange).not.toHaveBeenCalled();
    });

    it('does not re-promote a device that is already an active member', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5 });
      deviceGroupRepo.findOne.mockResolvedValue({ status: 'active' });
      jest
        .spyOn(service, 'sendMessage')
        .mockResolvedValue({ status: 'processed', queued: 0, sent: 0, receivedAt: 0 });

      await service.validateCommit(
        {
          groupId: 'group-1',
          deviceId: 'device-1',
          baseEpoch: 5,
          proto: memberCommitFrame('group-1', 5n),
          senderId: 'user-1',
        },
        'user-1'
      );

      expect(deviceGroupRepo.upsert).not.toHaveBeenCalled();
    });

    // ── WP-GHOST-1: a device that may not be INVITED may not be ROUTED TO either ──────────────
    // The commit path promotes the COMMITTING device, so a device its owner had deleted could
    // re-enrol itself in every group it still held MLS state for - and then be messaged forever,
    // invisible in the device list and uncollectable by the GC. Since 2026-10-23 its COMMIT is
    // refused at the door, so it is neither promoted nor allowed to move any group's epoch.
    it('refuses a commit from a device on the revocation denylist, before anything moves', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 1 });
      deviceGroupRepo.findOne.mockResolvedValue(null);
      groupMemberRepo.findOne.mockResolvedValue({ groupId: 'group-1', userId: 'user-2' });
      revokedDeviceRepo.findOne.mockResolvedValue({ id: 'r1' });
      const fanOut = jest.spyOn(service, 'sendMessage');

      await expect(
        service.validateCommit(
          {
            groupId: 'group-1',
            deviceId: 'device-revoked',
            baseEpoch: 1,
            proto: externalCommitFrame('group-1', 1n, 'user-2:device-revoked'),
            senderId: 'user-2',
          },
          'user-2'
        )
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'DEVICE_REVOKED', error: 'device_revoked' },
      });

      // Read by the PAIR, under the one active-revocation rule (the unique index it already has).
      expect(revokedDeviceRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-2', deviceId: 'device-revoked' }),
        })
      );
      expect(redis.set).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(commitInsertBuilder.execute).not.toHaveBeenCalled();
      expect(fanOut).not.toHaveBeenCalled();
      expect(deviceGroupRepo.upsert).not.toHaveBeenCalled();
      expect(redis.sadd).not.toHaveBeenCalledWith('group:members:group-1', 'user-2:device-revoked');
    });

    it('refuses a member commit from a revoked device that still holds an active row', async () => {
      // The routing purge and the denylist are two writes: a row that outlived the purge must not
      // be what lets the revoked device commit.
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5 });
      deviceGroupRepo.findOne.mockResolvedValue({ deviceId: 'device-1' });
      revokedDeviceRepo.findOne.mockResolvedValue({ id: 'r1' });

      await expect(
        service.validateCommit(
          {
            groupId: 'group-1',
            deviceId: 'device-1',
            baseEpoch: 5,
            proto: memberCommitFrame('group-1', 5n),
            senderId: 'user-1',
          },
          'user-1'
        )
      ).rejects.toMatchObject({ response: { code: 'DEVICE_REVOKED' } });
      expect(transaction).not.toHaveBeenCalled();
    });

    it('names the revocation, not the ownership, when the revocation also purged the KeyPackage', async () => {
      // The ordinary shape of a revoked device: denylisted AND its static KeyPackage gone. The
      // answer its client acts on must be the true one, so the denylist is asked first.
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5 });
      deviceGroupRepo.findOne.mockResolvedValue({ deviceId: 'device-1' });
      revokedDeviceRepo.findOne.mockResolvedValue({ id: 'r1' });
      keyPackageRepo.findOne.mockResolvedValue(null);

      await expect(
        service.validateCommit(
          {
            groupId: 'group-1',
            deviceId: 'device-1',
            baseEpoch: 5,
            proto: memberCommitFrame('group-1', 5n),
            senderId: 'user-1',
          },
          'user-1'
        )
      ).rejects.toMatchObject({ response: { code: 'DEVICE_REVOKED', error: 'device_revoked' } });
      expect(transaction).not.toHaveBeenCalled();
    });

    it('refuses a commit from a device with no static KeyPackage, before promoting anything', async () => {
      // It is registered to nobody, so it is not the committer's device: refused at the door, where
      // it used to be accepted and only its promotion refused.
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 1 });
      deviceGroupRepo.findOne.mockResolvedValue(null);
      keyPackageRepo.findOne.mockResolvedValue(null);

      await expect(
        service.validateCommit(
          {
            groupId: 'group-1',
            deviceId: 'device-ghost',
            baseEpoch: 1,
            proto: externalCommitFrame('group-1', 1n, 'user-2:device-ghost'),
            senderId: 'user-2',
          },
          'user-2'
        )
      ).rejects.toMatchObject({ response: { error: 'device_not_owned' } });

      expect(transaction).not.toHaveBeenCalled();
      expect(deviceGroupRepo.upsert).not.toHaveBeenCalled();
    });

    it('rejects on epoch mismatch without storing or broadcasting', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 9 });
      const fanOut = jest.spyOn(service, 'sendMessage');

      const res = await service.validateCommit(
        {
          groupId: 'group-1',
          deviceId: 'device-1',
          baseEpoch: 5,
          proto: memberCommitFrame('group-1', 5n),
          senderId: 'user-1',
        },
        'user-1'
      );

      expect(res.accepted).toBe(false);
      expect(res.reason).toBe('epoch_mismatch');
      expect(commitInsertBuilder.execute).not.toHaveBeenCalled();
      expect(fanOut).not.toHaveBeenCalled();
    });

    /**
     * A RESUBMISSION OF THE SAME COMMIT IS ANSWERED, NOT REFUSED. A committer whose first submission
     * got no answer cannot tell "not landed yet" from "never landed"; resending the SAME bytes makes
     * the answer definitive only if the gate recognises its own accepted commit. Before this it
     * answered `epoch_mismatch`, and the committer cleared a commit everyone else had applied.
     */
    describe('a resubmission of an accepted commit', () => {
      const resend = (proto = memberCommitFrame('group-1', 5n)) =>
        service.validateCommit(
          { groupId: 'group-1', deviceId: 'device-1', baseEpoch: 5, proto, senderId: 'user-1' },
          'user-1'
        );

      it('is an idempotent success: no second advance, no second fan-out', async () => {
        groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 6 });
        commitLogRepo.findOne.mockResolvedValue({
          groupId: 'group-1',
          baseEpoch: 5,
          commit: memberCommitFrame('group-1', 5n),
          senderDeviceId: 'device-1',
        });
        const fanOut = jest.spyOn(service, 'sendMessage');

        await expect(resend()).resolves.toEqual({ accepted: true, newEpoch: 6, duplicate: true });
        expect(commitLogRepo.findOne).toHaveBeenCalledWith({
          where: { groupId: 'group-1', baseEpoch: 5 },
        });
        expect(transaction).not.toHaveBeenCalled();
        expect(fanOut).not.toHaveBeenCalled();
      });

      it('is refused, not answered as accepted, once the device is revoked', async () => {
        // A resubmission is a commit too: a revoked device is told so, never told it landed.
        groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 6 });
        commitLogRepo.findOne.mockResolvedValue({
          groupId: 'group-1',
          baseEpoch: 5,
          commit: memberCommitFrame('group-1', 5n),
          senderDeviceId: 'device-1',
        });
        revokedDeviceRepo.findOne.mockResolvedValue({ id: 'r1' });

        await expect(resend()).rejects.toMatchObject({ response: { code: 'DEVICE_REVOKED' } });
        expect(commitLogRepo.findOne).not.toHaveBeenCalled();
      });

      it.each([
        ['other bytes took the epoch', { commit: 'b3RoZXI=', senderDeviceId: 'device-1' }],
        [
          'the same bytes from another device',
          { commit: memberCommitFrame('group-1', 5n), senderDeviceId: 'device-2' },
        ],
        ['the log row is gone', null],
      ])('is still a mismatch when %s', async (_n, row) => {
        groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 6 });
        commitLogRepo.findOne.mockResolvedValue(
          row && { groupId: 'group-1', baseEpoch: 5, ...row }
        );

        await expect(resend()).resolves.toEqual({
          accepted: false,
          currentEpoch: 6,
          reason: 'epoch_mismatch',
        });
        expect(transaction).not.toHaveBeenCalled();
      });
    });

    it('refuses a commit with no proto instead of advancing the epoch past it', async () => {
      // The epoch it would create is one NOTHING can ever replay: the commit-log is keyed UNIQUE on
      // (groupId, baseEpoch), so the row skipped here cannot be written later by anybody. Every
      // device that misses that epoch is then owed a full rung-2 re-Welcome for ever.
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5 });
      const fanOut = jest.spyOn(service, 'sendMessage');

      await expect(
        service.validateCommit(
          { groupId: 'group-1', deviceId: 'device-1', baseEpoch: 5, senderId: 'user-1' },
          'user-1'
        )
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(groupUpdate).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(fanOut).not.toHaveBeenCalled();
    });

    it('fails the whole commit when the log row cannot be written', async () => {
      // The insert used to sit AFTER the transaction behind a `catch -> warn`, so a failed write
      // left the group advanced, the committer told `accepted: true`, and the epoch unrefillable.
      // Inside the transaction the two writes share one fate; the caller retries at the same base.
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5 });
      const fanOut = jest.spyOn(service, 'sendMessage');
      commitInsertBuilder.execute.mockRejectedValueOnce(new Error('deadlock detected'));

      await expect(
        service.validateCommit(
          {
            groupId: 'group-1',
            deviceId: 'device-1',
            baseEpoch: 5,
            proto: memberCommitFrame('group-1', 5n),
            senderId: 'user-1',
          },
          'user-1'
        )
      ).rejects.toThrow('deadlock detected');

      // The fan-out is the LAST step for exactly this reason: nobody is handed a commit whose
      // epoch the server did not keep.
      expect(fanOut).not.toHaveBeenCalled();
    });

    /**
     * THE GATE READS THE EPOCH OUTSIDE THE TRANSACTION, AND THE ADVANCE MAY WAIT ON THE SEAT LOCK.
     * Two commits at one base that both passed the read must not both land: the advance is
     * conditional on the base, so the second moves nothing and is refused - nothing logged, nothing
     * fanned out.
     */
    it('refuses an advance whose base another commit moved while it waited', async () => {
      groupRepo.findOne
        .mockResolvedValueOnce({ id: 'group-1', activeEpoch: 5 })
        .mockResolvedValue({ id: 'group-1', activeEpoch: 6 });
      const fanOut = jest.spyOn(service, 'sendMessage');
      groupUpdate.mockResolvedValueOnce({ affected: 0 });

      await expect(
        service.validateCommit(
          {
            groupId: 'group-1',
            deviceId: 'device-1',
            baseEpoch: 5,
            proto: memberCommitFrame('group-1', 5n),
            senderId: 'user-1',
          },
          'user-1'
        )
      ).resolves.toEqual({ accepted: false, currentEpoch: 6, reason: 'epoch_mismatch' });
      expect(commitInsertBuilder.execute).not.toHaveBeenCalled();
      expect(fanOut).not.toHaveBeenCalled();
    });

    /**
     * THE COMMIT THAT MOVED THE BASE MAY BE THIS ONE. The Redis lock lives 5 s and the client waits
     * 30 s: an earlier request of the SAME bytes from the SAME device can pass the read with this
     * one, commit first, and leave this copy to lose the advance - while a third device's commit,
     * queued behind, has already moved the epoch past `base + 1` by the re-read. Its log row is
     * committed when the update affects nothing, so it decides, not the epoch.
     */
    it('answers a lost advance as a duplicate when its OWN earlier request made it', async () => {
      groupRepo.findOne
        .mockResolvedValueOnce({ id: 'group-1', activeEpoch: 5 })
        .mockResolvedValue({ id: 'group-1', activeEpoch: 7 });
      commitLogRepo.findOne.mockResolvedValueOnce({
        groupId: 'group-1',
        baseEpoch: 5,
        commit: memberCommitFrame('group-1', 5n),
        senderDeviceId: 'device-1',
      });
      const fanOut = jest.spyOn(service, 'sendMessage');
      groupUpdate.mockResolvedValueOnce({ affected: 0 });

      await expect(
        service.validateCommit(
          {
            groupId: 'group-1',
            deviceId: 'device-1',
            baseEpoch: 5,
            proto: memberCommitFrame('group-1', 5n),
            senderId: 'user-1',
          },
          'user-1'
        )
      ).resolves.toEqual({ accepted: true, newEpoch: 6, duplicate: true });
      expect(commitLogRepo.findOne).toHaveBeenCalledWith({
        where: { groupId: 'group-1', baseEpoch: 5 },
      });
      expect(commitInsertBuilder.execute).not.toHaveBeenCalled();
      expect(fanOut).not.toHaveBeenCalled();
    });

    it('refuses an advance whose base already has a logged commit, rather than logging neither', async () => {
      // The advance and the log row say the same thing or the commit is refused: a log row from
      // another commit at this base would be replayed in place of the one accepted.
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5 });
      const fanOut = jest.spyOn(service, 'sendMessage');
      commitInsertBuilder.execute.mockResolvedValueOnce({ raw: [] });

      await expect(
        service.validateCommit(
          {
            groupId: 'group-1',
            deviceId: 'device-1',
            baseEpoch: 5,
            proto: memberCommitFrame('group-1', 5n),
            senderId: 'user-1',
          },
          'user-1'
        )
      ).resolves.toEqual({ accepted: false, currentEpoch: 5, reason: 'epoch_mismatch' });
      expect(fanOut).not.toHaveBeenCalled();
      // The epoch still stood on the base: no request of ours advanced from it, so nothing is asked.
      expect(commitLogRepo.findOne).not.toHaveBeenCalled();
    });

    it.each([
      ['other bytes took the base', { commit: 'b3RoZXI=', senderDeviceId: 'device-1' }],
      [
        'the same bytes came from another device',
        { commit: memberCommitFrame('group-1', 5n), senderDeviceId: 'device-2' },
      ],
    ])('still refuses a lost advance when %s', async (_n, row) => {
      groupRepo.findOne
        .mockResolvedValueOnce({ id: 'group-1', activeEpoch: 5 })
        .mockResolvedValue({ id: 'group-1', activeEpoch: 6 });
      commitLogRepo.findOne.mockResolvedValueOnce({ groupId: 'group-1', baseEpoch: 5, ...row });
      groupUpdate.mockResolvedValueOnce({ affected: 0 });

      await expect(
        service.validateCommit(
          {
            groupId: 'group-1',
            deviceId: 'device-1',
            baseEpoch: 5,
            proto: memberCommitFrame('group-1', 5n),
            senderId: 'user-1',
          },
          'user-1'
        )
      ).resolves.toEqual({ accepted: false, currentEpoch: 6, reason: 'epoch_mismatch' });
    });
  });

  describe('getCommitsSince (membership-gated replay)', () => {
    it('forbids a non-member', async () => {
      groupMemberRepo.findOne.mockResolvedValue(null);
      await expect(service.getCommitsSince('group-1', 0, 'stranger')).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });

    /**
     * A KEY-DISTRIBUTION GROUP RECORDS ITS MEMBERS PER DEVICE, and only there. On production
     * 2026-09-27 all eight held zero `dm_group_members` rows, so the user-table gate refused every
     * catch-up on them (`push/commits` 403 x173 in eight hours) and a shut phone one commit behind
     * showed every salon message as "Nouveau message".
     */
    it('serves a key-distribution group to a user with an active device in it', async () => {
      groupRepo.findOne.mockResolvedValue({
        id: 'group-1',
        activeEpoch: 5,
        distributionWorkspaceId: 'ws-1',
      });
      groupMemberRepo.findOne.mockResolvedValue(null);
      deviceGroupRepo.findOne.mockResolvedValue({ status: 'active' });
      commitLogRepo.find.mockResolvedValue([{ baseEpoch: 4, commit: 'c4' }]);
      commitLogRepo.findOne.mockResolvedValue({ baseEpoch: 4 });

      const res = await service.getCommitsSince('group-1', 4, 'member-1');

      expect(res.commits).toEqual([{ baseEpoch: 4, proto: 'c4' }]);
      expect(deviceGroupRepo.findOne).toHaveBeenCalledWith({
        where: { groupId: 'group-1', userId: 'member-1', status: 'active' },
      });
    });

    it('refuses a key-distribution group to a user with no active device in it', async () => {
      groupRepo.findOne.mockResolvedValue({
        id: 'group-1',
        activeEpoch: 5,
        distributionChannelId: 'salon-1',
      });
      deviceGroupRepo.findOne.mockResolvedValue(null);
      await expect(service.getCommitsSince('group-1', 0, 'stranger')).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });

    it('returns ordered commits and belowFloor=false when the floor is covered', async () => {
      groupMemberRepo.findOne.mockResolvedValue({ id: 'm' });
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5 });
      commitLogRepo.find.mockResolvedValue([
        { baseEpoch: 3, commit: 'c3' },
        { baseEpoch: 4, commit: 'c4' },
      ]);
      commitLogRepo.findOne.mockResolvedValue({ baseEpoch: 3 });

      const res = await service.getCommitsSince('group-1', 3, 'member-1');

      expect(res.belowFloor).toBe(false);
      expect(res.activeEpoch).toBe(5);
      expect(res.commits).toEqual([
        { baseEpoch: 3, proto: 'c3' },
        { baseEpoch: 4, proto: 'c4' },
      ]);
    });

    it('sets belowFloor when the oldest retained commit starts after sinceEpoch', async () => {
      groupMemberRepo.findOne.mockResolvedValue({ id: 'm' });
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5 });
      commitLogRepo.find.mockResolvedValue([{ baseEpoch: 3, commit: 'c3' }]);
      commitLogRepo.findOne.mockResolvedValue({ baseEpoch: 3 });

      const res = await service.getCommitsSince('group-1', 1, 'member-1');

      expect(res.belowFloor).toBe(true);
      // Pruning is not a hole. Reporting both would accuse the commit path of a defect it did not
      // commit, and the caller already terminates on `belowFloor`.
      expect(res.gapAt).toBeUndefined();
    });

    it('truncates at a hole and NAMES the epoch the log cannot supply', async () => {
      // Measured on prod 2026-09-02: group `7da231f8` ran 0..129 with 121 absent. The tail is
      // unreachable - commits apply in order - so handing it back only invites the caller to apply
      // 120, throw on 122, and wait out a watchdog clock for a fact the server holds right here.
      groupMemberRepo.findOne.mockResolvedValue({ id: 'm' });
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 124 });
      commitLogRepo.find.mockResolvedValue([
        { baseEpoch: 120, commit: 'c120' },
        { baseEpoch: 122, commit: 'c122' },
        { baseEpoch: 123, commit: 'c123' },
      ]);
      commitLogRepo.findOne.mockResolvedValue({ baseEpoch: 0 });

      const res = await service.getCommitsSince('group-1', 120, 'member-1');

      expect(res.belowFloor).toBe(false);
      expect(res.gapAt).toBe(121);
      expect(res.commits).toEqual([{ baseEpoch: 120, proto: 'c120' }]);
    });

    it('names the hole when the log stops short of the active epoch', async () => {
      // The same defect from the other end: the log is contiguous but ends before the group does,
      // so the last epochs were never recorded rather than sitting behind a gap.
      groupMemberRepo.findOne.mockResolvedValue({ id: 'm' });
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 8 });
      commitLogRepo.find.mockResolvedValue([
        { baseEpoch: 5, commit: 'c5' },
        { baseEpoch: 6, commit: 'c6' },
      ]);
      commitLogRepo.findOne.mockResolvedValue({ baseEpoch: 0 });

      const res = await service.getCommitsSince('group-1', 5, 'member-1');

      expect(res.gapAt).toBe(7);
      expect(res.commits).toHaveLength(2);
    });

    it('reports no hole when the log reaches the active epoch', async () => {
      groupMemberRepo.findOne.mockResolvedValue({ id: 'm' });
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 7 });
      commitLogRepo.find.mockResolvedValue([
        { baseEpoch: 5, commit: 'c5' },
        { baseEpoch: 6, commit: 'c6' },
      ]);
      commitLogRepo.findOne.mockResolvedValue({ baseEpoch: 0 });

      const res = await service.getCommitsSince('group-1', 5, 'member-1');

      expect(res.gapAt).toBeUndefined();
      expect(res.belowFloor).toBe(false);
    });
  });

  /**
   * A COMMIT RECORDS THE NEWCOMERS IT ADMITS, WITH THE ADVANCE (user, 2026-09-28).
   *
   * The epoch a pending device may be queued from is exact only here: no member can seal at
   * `baseEpoch + 1` before it has this commit, and the fan-out follows the transaction. Recorded
   * at the Welcome instead, a frame sent in between skipped the newcomer, and a second commit
   * landing first named the wrong epoch.
   */
  /**
   * A commit's routing fields come from the client, so they are bounded by what the commit itself
   * establishes: the committer is the caller, and the fan-out skips only the devices it admits and
   * the committing device.
   */
  describe('who a client commit may name', () => {
    type Row = Record<string, unknown>;
    /** Every key of `where` must match: a lookup on the wrong columns finds nothing. */
    const hits = (rows: Row[], where: Row | Row[]): Row[] =>
      (Array.isArray(where) ? where : [where]).flatMap((w) =>
        rows.filter((r) =>
          Object.entries(w).every(([k, v]) =>
            v instanceof FindOperator && v.type === 'isNull' ? r[k] == null : r[k] === v
          )
        )
      );
    /**
     * The three tables the gate reads, as rows the mocks answer from by their `where` - so a test
     * fails when the service asks the wrong question, not only when it gets a wrong answer.
     */
    const tables = (t: { keyPackages?: Row[]; devices?: Row[]; roster?: Row[]; group?: Row }) => {
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5, ...t.group });
      keyPackageRepo.findOne.mockImplementation(
        async ({ where }: { where: Row }) => hits(t.keyPackages ?? [], where)[0] ?? null
      );
      keyPackageRepo.find.mockImplementation(async ({ where }: { where: Row[] }) =>
        hits(t.keyPackages ?? [], where)
      );
      deviceGroupRepo.findOne.mockImplementation(
        async ({ where }: { where: Row }) => hits(t.devices ?? [], where)[0] ?? null
      );
      deviceGroupRepo.find.mockImplementation(async ({ where }: { where: Row[] }) =>
        hits(t.devices ?? [], where)
      );
      groupMemberRepo.findOne.mockImplementation(
        async ({ where }: { where: Row }) => hits(t.roster ?? [], where)[0] ?? null
      );
    };
    const ownKey = { userId: 'user-1', deviceId: 'device-1' };
    const ownDevice = {
      groupId: 'group-1',
      userId: 'user-1',
      deviceId: 'device-1',
      status: 'active',
    };
    /** A member commit and an external commit, as their clear headers say (RFC 9420 section 6). */
    const MEMBER_COMMIT = memberCommitFrame('group-1', 5n);
    const EXTERNAL_COMMIT = externalCommitFrame('group-1', 5n);
    const fanOut = () =>
      jest
        .spyOn(service, 'sendMessage')
        .mockResolvedValue({ status: 'processed', queued: 0, sent: 0, receivedAt: 0 });
    const commit = (extra: Record<string, unknown> = {}, caller?: string) =>
      service.validateCommit(
        {
          groupId: 'group-1',
          deviceId: 'device-1',
          baseEpoch: 5,
          proto: MEMBER_COMMIT,
          senderId: 'user-1',
          ...extra,
        },
        caller
      );

    it('refuses a commit whose sender is not the caller, before the epoch moves', async () => {
      tables({ keyPackages: [ownKey], devices: [ownDevice] });
      const sent = fanOut();

      await expect(commit({}, 'user-2')).rejects.toBeInstanceOf(ForbiddenException);
      expect(transaction).not.toHaveBeenCalled();
      expect(sent).not.toHaveBeenCalled();
    });

    it("refuses a commit naming someone else's device, before the epoch moves", async () => {
      tables({ keyPackages: [{ userId: 'user-2', deviceId: 'device-1' }], devices: [ownDevice] });
      const sent = fanOut();

      await expect(commit({}, 'user-1')).rejects.toMatchObject({
        response: { error: 'device_not_owned' },
      });
      expect(keyPackageRepo.findOne).toHaveBeenCalledWith({
        where: { userId: 'user-1', deviceId: 'device-1' },
        select: { id: true },
      });
      expect(transaction).not.toHaveBeenCalled();
      expect(sent).not.toHaveBeenCalled();
    });

    it("reads the owner by the PAIR: another account's row under the same id does not shadow the caller's", async () => {
      // A lookup by device id alone answers whichever row comes first - here the other account's.
      tables({
        keyPackages: [{ userId: 'user-2', deviceId: 'device-1' }, ownKey],
        devices: [ownDevice],
      });
      fanOut();

      await expect(commit({}, 'user-1')).resolves.toMatchObject({ accepted: true });
    });

    it('refuses a commit from a device registered to nobody', async () => {
      tables({ devices: [ownDevice] });

      await expect(commit({}, 'user-1')).rejects.toMatchObject({
        response: { error: 'device_not_owned' },
      });
      expect(transaction).not.toHaveBeenCalled();
    });

    it('refuses a client commit that names no sender', async () => {
      tables({ keyPackages: [ownKey], devices: [ownDevice] });
      await expect(commit({ senderId: undefined }, 'user-1')).rejects.toBeInstanceOf(
        BadRequestException
      );
      expect(transaction).not.toHaveBeenCalled();
    });

    it('refuses a member commit from a KICKED device - its row is pending and stamped', async () => {
      tables({
        keyPackages: [ownKey],
        devices: [{ ...ownDevice, status: 'pending', kickedAt: new Date('2026-10-20T00:00:00Z') }],
      });
      const sent = fanOut();

      await expect(commit({}, 'user-1')).rejects.toMatchObject({
        response: { code: 'NOT_A_MEMBER', error: 'committer_not_member' },
      });
      expect(deviceGroupRepo.findOne).toHaveBeenCalledWith({
        where: [
          { groupId: 'group-1', userId: 'user-1', deviceId: 'device-1', status: 'active' },
          {
            groupId: 'group-1',
            userId: 'user-1',
            deviceId: 'device-1',
            status: 'pending',
            kickedAt: IsNull(),
          },
        ],
        select: { deviceId: true },
      });
      expect(transaction).not.toHaveBeenCalled();
      expect(sent).not.toHaveBeenCalled();
    });

    it('accepts a member commit from a device whose Welcome is processed but not yet reported', async () => {
      // `updateInvitationStatus(..., 'active')` is not awaited after a Welcome, so the device's first
      // commit can reach the gate while its row is still `pending` - never kicked.
      tables({
        keyPackages: [ownKey],
        devices: [{ ...ownDevice, status: 'pending', kickedAt: null }],
      });
      fanOut();

      await expect(commit({}, 'user-1')).resolves.toMatchObject({ accepted: true });
    });

    it('refuses a member commit from a REMOVED member - the removal deleted its rows', async () => {
      tables({ keyPackages: [ownKey] });

      await expect(commit({}, 'user-1')).rejects.toMatchObject({
        response: { code: 'NOT_A_MEMBER', error: 'committer_not_member' },
      });
      expect(transaction).not.toHaveBeenCalled();
    });

    it('accepts an EXTERNAL commit from a person on the roster, with no device row yet', async () => {
      tables({ keyPackages: [ownKey], roster: [{ groupId: 'group-1', userId: 'user-1' }] });
      fanOut();

      await expect(commit({ proto: EXTERNAL_COMMIT }, 'user-1')).resolves.toMatchObject({
        accepted: true,
      });
      expect(groupMemberRepo.findOne).toHaveBeenCalledWith({
        where: { groupId: 'group-1', userId: 'user-1' },
        select: { id: true, awaitingAdmission: true },
      });
    });

    it('refuses an external commit from a person who is not on the roster', async () => {
      tables({ keyPackages: [ownKey], roster: [{ groupId: 'group-1', userId: 'user-2' }] });

      await expect(commit({ proto: EXTERNAL_COMMIT }, 'user-1')).rejects.toMatchObject({
        response: { code: 'NOT_A_MEMBER', error: 'committer_not_member' },
      });
      expect(transaction).not.toHaveBeenCalled();
    });

    /**
     * AN INVITATION LINK'S SEAT IS AN ASK UNTIL A MEMBER'S ADD ANSWERS IT (`awaitingAdmission`): the
     * person on it holds no leaf and enters by that Add, never by a commit of their own - neither the
     * external join that let a link joiner in around the member, nor a member commit from the
     * `pending` device the link seated.
     */
    it("refuses an external commit from a seat awaiting a member's admission, before the epoch moves", async () => {
      tables({
        keyPackages: [ownKey],
        roster: [{ groupId: 'group-1', userId: 'user-1', awaitingAdmission: true }],
      });

      await expect(commit({ proto: EXTERNAL_COMMIT }, 'user-1')).rejects.toMatchObject({
        response: { code: 'NOT_A_MEMBER', error: 'committer_not_member' },
      });
      expect(transaction).not.toHaveBeenCalled();
    });

    it("refuses a member commit from the pending device of a seat awaiting a member's admission", async () => {
      tables({
        keyPackages: [ownKey],
        devices: [{ ...ownDevice, status: 'pending', kickedAt: null }],
        roster: [{ groupId: 'group-1', userId: 'user-1', awaitingAdmission: true }],
      });

      await expect(commit({}, 'user-1')).rejects.toMatchObject({
        response: { code: 'NOT_A_MEMBER', error: 'committer_not_member' },
      });
      expect(transaction).not.toHaveBeenCalled();
    });

    /**
     * AN ACTIVE DEVICE IS IN THE TREE WHATEVER THE FLAG SAYS. A member whose flag outlived their
     * admission (a Welcome that reached them past the lift) must not be refused every commit for good.
     */
    it('accepts a commit from an ACTIVE device under a seat still flagged awaiting, and accuses the state', async () => {
      tables({
        keyPackages: [ownKey],
        devices: [ownDevice],
        roster: [{ groupId: 'group-1', userId: 'user-1', awaitingAdmission: true }],
      });
      deviceGroupRepo.count.mockResolvedValueOnce(1);
      fanOut();
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

      await expect(commit({}, 'user-1')).resolves.toMatchObject({ accepted: true });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('[ADMISSION]'));
      error.mockRestore();
    });

    /**
     * A KEY GROUP'S EXTERNAL COMMIT IS ASKED OF SOCIAL-SERVICE (WP-KEYGROUP-JOIN-GATE): accepted and
     * activated only on `entitled: true`; a `false` is a 403 and an unanswered question a 503, both
     * before the epoch moves and before any activation.
     */
    describe("a key group's external commit", () => {
      let previous: string | undefined;
      let fetchSpy: jest.SpyInstance;
      let activate: jest.SpyInstance;
      // A fresh Response per call: the gate and the activation each read one, and a body is read once.
      const social = (status: number, body: unknown) =>
        fetchSpy.mockImplementation(async () => new Response(JSON.stringify(body), { status }));

      beforeEach(() => {
        previous = process.env.INTERNAL_SECRET;
        process.env.INTERNAL_SECRET = 'sekret';
        fetchSpy = jest.spyOn(globalThis, 'fetch');
        activate = jest.spyOn(service, 'activateDeviceMembership').mockResolvedValue({ ok: true });
      });

      afterEach(() => {
        fetchSpy.mockRestore();
        if (previous === undefined) delete process.env.INTERNAL_SECRET;
        else process.env.INTERNAL_SECRET = previous;
      });

      it.each([
        [
          'a community',
          { distributionWorkspaceId: 'ws-1' },
          { kind: 'workspace', scopeId: 'ws-1' },
        ],
        [
          'a private salon',
          { distributionChannelId: 'ch-1' },
          { kind: 'channel', scopeId: 'ch-1' },
        ],
      ])(
        'is accepted and activates its committer once %s entitles them',
        async (_n, group, asked) => {
          tables({ keyPackages: [ownKey], group });
          social(200, { entitled: true });
          fanOut();

          await expect(commit({ proto: EXTERNAL_COMMIT }, 'user-1')).resolves.toMatchObject({
            accepted: true,
          });
          // Asked ONCE, by the gate before the epoch moves and before any lock: the activation is
          // written against the claim taken before that question, never by asking it again.
          expect(fetchSpy).toHaveBeenCalledTimes(1);
          expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body))).toEqual({
            ...asked,
            userId: 'user-1',
          });
          // The committer's seat is written IN the advance's transaction, against its claim re-read
          // there - never after it, where any eviction of the group would leave a leaf with no seat.
          expect(deviceGroupRepo.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
              userId: 'user-1',
              deviceId: 'device-1',
              groupId: 'group-1',
              status: 'active',
            }),
            { conflictPaths: ['deviceId', 'groupId'] }
          );
          expect(activate).not.toHaveBeenCalled();
        }
      );

      it('is refused, before the epoch moves and before activation, when not entitled', async () => {
        tables({ keyPackages: [ownKey], group: { distributionWorkspaceId: 'ws-1' } });
        social(200, { entitled: false });
        const sent = fanOut();

        await expect(commit({ proto: EXTERNAL_COMMIT }, 'user-1')).rejects.toMatchObject({
          response: { code: 'NOT_A_MEMBER', error: 'committer_not_member' },
        });
        expect(transaction).not.toHaveBeenCalled();
        expect(activate).not.toHaveBeenCalled();
        expect(sent).not.toHaveBeenCalled();
      });

      it('is a retryable 503 - never an acceptance - when social-service cannot answer', async () => {
        tables({ keyPackages: [ownKey], group: { distributionWorkspaceId: 'ws-1' } });
        fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
        const sent = fanOut();

        await expect(commit({ proto: EXTERNAL_COMMIT }, 'user-1')).rejects.toBeInstanceOf(
          ServiceUnavailableException
        );
        expect(transaction).not.toHaveBeenCalled();
        expect(activate).not.toHaveBeenCalled();
        expect(sent).not.toHaveBeenCalled();
      });

      it('never asks social-service about a member commit', async () => {
        tables({
          keyPackages: [ownKey],
          devices: [ownDevice],
          group: { distributionWorkspaceId: 'ws-1' },
        });
        fanOut();

        await expect(commit({}, 'user-1')).resolves.toMatchObject({ accepted: true });
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      /**
       * THE ACTIVATION AND A DEPARTURE'S EVICTIONS ARE ORDERED BY ONE LOCK AND ONE RECORD.
       *
       * Social-service evicts, deletes the roster row, then evicts again, and its entitlement answer
       * is read by the gate BEFORE any lock - so that answer may predate all three. The activation is
       * written under the group's seat lock against the claim the gate took before asking, and every
       * eviction rewrites that claim's row under the same lock (`utils/seat-eviction.ts`). Driven by
       * hand, never by a clock: each answer is a deferred the case resolves, the fake transaction
       * queues on the advisory key exactly as Postgres does, and `dm_seat_evictions` is a map.
       */
      describe('against a departure that races it', () => {
        type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
        const deferred = <T>(): Deferred<T> => {
          let resolve!: (v: T) => void;
          const promise = new Promise<T>((r) => (resolve = r));
          return { promise, resolve };
        };
        /** Lets every already-runnable continuation run, so a case can observe who is blocked. */
        const settle = async () => {
          for (let i = 0; i < 50; i++) await Promise.resolve();
        };

        let events: string[];
        let seats: Map<string, unknown>;
        /** `dm_seat_evictions`, by `groupId:userId`. */
        let evictions: Map<string, { generation: number; owedDeparture: number | null }>;
        /** `dm_groups."seatGeneration"`, by group: what a claim compares. */
        let seatGenerations: Map<string, number>;
        /** When armed, the seat write waits on it - an activation caught holding the lock. */
        let upsertGate: Deferred<void> | null;
        let upsertStarted: Deferred<void>;
        let originalTx: ReturnType<typeof transaction.getMockImplementation>;
        let originalManagerQuery: unknown;

        /** The rows of `dm_seat_evictions` as its SQL reads and writes them. */
        const evictionTable = (sql: string, params: unknown[] = []): unknown[] => {
          const key = `${String(params[0])}:${String(params[1])}`;
          if (sql.includes('UPDATE dm_groups SET "seatGeneration"')) {
            const groupId = String(params[0]);
            seatGenerations.set(groupId, (seatGenerations.get(groupId) ?? 0) + 1);
            return [];
          }
          if (sql.includes('SELECT "seatGeneration" FROM dm_groups')) {
            return [
              {
                generation: seatGenerations.get(String(params[0])) ?? 0,
                owedDeparture: evictions.get(key)?.owedDeparture ?? null,
              },
            ];
          }
          if (sql.includes('INSERT INTO dm_seat_evictions')) {
            const generation = (evictions.get(key)?.generation ?? 0) + 1;
            const next = {
              generation,
              owedDeparture: params[2] ? generation : (evictions.get(key)?.owedDeparture ?? null),
            };
            evictions.set(key, next);
            return [{ generation }];
          }
          if (sql.includes('SELECT "generation", "owedDeparture" FROM dm_seat_evictions')) {
            const row = evictions.get(key);
            return row ? [row] : [];
          }
          if (sql.includes('SELECT "groupId", "userId", "owedDeparture" FROM dm_seat_evictions')) {
            return [...evictions.entries()]
              .filter(([, row]) => row.owedDeparture !== null)
              .map(([k, row]) => {
                const [groupId, userId] = k.split(':');
                return { groupId, userId, owedDeparture: row.owedDeparture };
              });
          }
          if (sql.includes('UPDATE dm_seat_evictions SET "owedDeparture" = NULL')) {
            const row = evictions.get(key);
            if (!row || row.owedDeparture !== params[2]) return [];
            row.owedDeparture = null;
            return [{ generation: row.generation }];
          }
          return [];
        };

        beforeEach(() => {
          activate.mockRestore();
          events = [];
          seats = new Map();
          evictions = new Map();
          seatGenerations = new Map();
          upsertGate = null;
          upsertStarted = deferred<void>();
          redis.sadd.mockImplementation(() => {
            events.push('route');
            return Promise.resolve(1);
          });
          Object.assign(redis, {
            smembers: jest.fn(() => Promise.resolve([...seats.keys()])),
            srem: jest.fn(() => Promise.resolve(1)),
          });
          const manager = groupRepo.manager as unknown as { query?: unknown };
          originalManagerQuery = manager.query;
          manager.query = jest.fn(async (sql: string, params: unknown[]) =>
            evictionTable(sql, params)
          );
          // One FIFO tail per advisory key, held until the transaction's callback settles.
          const tails = new Map<string, Promise<void>>();
          originalTx = transaction.getMockImplementation();
          transaction.mockImplementation(async (cb: (m: unknown) => Promise<void>) => {
            const releases: Array<() => void> = [];
            const seatRepo = {
              upsert: jest.fn(async (row: { userId: string; deviceId: string }) => {
                upsertStarted.resolve();
                if (upsertGate) await upsertGate.promise;
                events.push('activate');
                seats.set(`${row.userId}:${row.deviceId}`, row);
              }),
              delete: jest.fn(async ({ userId }: { userId: string }) => {
                events.push('evict');
                for (const key of seats.keys()) {
                  if (key.startsWith(`${userId}:`)) seats.delete(key);
                }
                return { affected: 1 };
              }),
              createQueryBuilder: () => membershipInsertBuilder,
              update: jest.fn().mockResolvedValue({ affected: 0 }),
              findOne: jest.fn(
                async ({ where }: { where: { userId: string; deviceId: string } }) =>
                  seats.get(`${where.userId}:${where.deviceId}`) ?? null
              ),
            };
            const m = {
              query: async (sql: string, params: unknown[]) => {
                if (!sql.includes('pg_advisory_xact_lock')) return evictionTable(sql, params);
                const key = String(params[0]);
                const previous = tails.get(key) ?? Promise.resolve();
                const mine = deferred<void>();
                tails.set(
                  key,
                  previous.then(() => mine.promise)
                );
                releases.push(() => mine.resolve());
                await previous;
                return [];
              },
              getRepository: (entity: unknown) => {
                if (entity === Group) return { update: groupUpdate };
                if (entity === MlsCommitLog)
                  return { createQueryBuilder: () => commitInsertBuilder };
                if (entity === DeviceGroupMembership) return seatRepo;
                // A key group has no roster rows: the admits lift no link ask.
                if (entity === GroupMember) return txSeatRepo;
                if (entity === KeyPackage) return txKeyPackageRepo;
                if (entity === RevokedDevice) return revokedDeviceRepo;
                if (entity === QueuedMessage)
                  return { delete: jest.fn().mockResolvedValue({ affected: 0 }) };
                return txGroupInfoRepo;
              },
            };
            try {
              return await cb(m);
            } finally {
              releases.forEach((release) => release());
            }
          });
        });

        afterEach(() => {
          transaction.mockImplementation(originalTx);
          (groupRepo.manager as unknown as { query?: unknown }).query = originalManagerQuery;
          redis.sadd.mockImplementation(() => Promise.resolve(1));
        });

        const entitled = (yes: boolean) =>
          new Response(JSON.stringify({ entitled: yes }), { status: 200 });
        const outcome = (o: 'departed' | 'cancelled') =>
          new Response(JSON.stringify({ outcome: o }), { status: 200 });

        it('an eviction arriving while the activation holds the lock waits, then deletes the seat it wrote', async () => {
          tables({ keyPackages: [ownKey], group: { distributionWorkspaceId: 'ws-1' } });
          fanOut();
          fetchSpy.mockResolvedValueOnce(entitled(true));
          upsertGate = deferred<void>();

          const committed = commit({ proto: EXTERNAL_COMMIT }, 'user-1');
          await upsertStarted.promise;
          // The activation holds the seat lock, mid-write.
          const evicted = service.evictSeats('group-1', 'user-1', 'begin');
          await settle();
          expect(events).toEqual([]);

          upsertGate.resolve();
          await expect(committed).resolves.toMatchObject({ accepted: true });
          await evicted;

          // The activation, then the eviction queued on the lock - and the route, re-read after
          // both, finds no seat and is never written.
          expect(events).toEqual(['activate', 'evict']);
          expect(seats.size).toBe(0);
          expect(redis.sadd).not.toHaveBeenCalled();
          // And no HTTP call was made under any lock: the gate's one question, before it.
          expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it('an entitlement answer arriving AFTER the whole departure is refused before the epoch moves', async () => {
          tables({ keyPackages: [ownKey], group: { distributionWorkspaceId: 'ws-1' } });
          const sent = fanOut();
          // The gate's question is in flight when the departure runs: social-service answered
          // `true` from a roster that still held the leaver, and the answer lands afterwards.
          const answer = deferred<Response>();
          const asked = deferred<void>();
          fetchSpy.mockImplementationOnce(() => {
            asked.resolve();
            return answer.promise;
          });

          const committed = commit({ proto: EXTERNAL_COMMIT }, 'user-1');
          await asked.promise;
          await service.evictSeats('group-1', 'user-1', 'begin'); // before the roster write
          await service.evictSeats('group-1', 'user-1', { settles: 1 }); // after it
          answer.resolve(entitled(true));

          // The claim the gate took was overtaken, and the external commit's own claim is re-read
          // under the seat lock in the advance's transaction: the join is refused there, so no
          // leaf enters the tree for a person with no seat. The group's generation cannot say whose
          // eviction it was, so the refusal is the retryable one - and the retry meets the gate,
          // where this person's departure refuses it.
          await expect(committed).rejects.toMatchObject({
            response: { code: 'SEAT_CLAIM_OVERTAKEN', error: 'seat_claim_overtaken' },
          });
          expect(groupUpdate).not.toHaveBeenCalled();
          expect(sent).not.toHaveBeenCalled();
          expect(events).toEqual(['evict', 'evict']);
          expect(seats.size).toBe(0);
          expect(redis.sadd).not.toHaveBeenCalled();
        });

        it('a join between the two evictions is refused by the gate, before the epoch moves', async () => {
          tables({ keyPackages: [ownKey], group: { distributionWorkspaceId: 'ws-1' } });
          const sent = fanOut();
          // The first eviction has run, the roster row is still there, so social-service would
          // still say yes - the departure in progress is read from the claim instead.
          await service.evictSeats('group-1', 'user-1', 'begin');
          fetchSpy.mockResolvedValue(entitled(true));

          await expect(commit({ proto: EXTERNAL_COMMIT }, 'user-1')).rejects.toMatchObject({
            response: { code: 'NOT_A_MEMBER', error: 'committer_not_member' },
          });
          // Nothing moved: no epoch, no seat, no fan-out - and nobody was asked.
          expect(groupUpdate).not.toHaveBeenCalled();
          expect(events).toEqual(['evict']);
          expect(seats.size).toBe(0);
          expect(sent).not.toHaveBeenCalled();
          expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('a person who leaves and comes back is seated again once the departure is settled', async () => {
          tables({ keyPackages: [ownKey], group: { distributionWorkspaceId: 'ws-1' } });
          fanOut();
          await service.evictSeats('group-1', 'user-1', 'begin');
          await service.evictSeats('group-1', 'user-1', { settles: 1 });
          // Re-entitled: the claim is taken after the departure, so nothing overtakes it.
          fetchSpy.mockResolvedValueOnce(entitled(true));

          await expect(commit({ proto: EXTERNAL_COMMIT }, 'user-1')).resolves.toMatchObject({
            accepted: true,
          });
          expect(events).toEqual(['evict', 'evict', 'activate', 'route']);
          expect(seats.size).toBe(1);
        });

        it('a late second eviction settles ITS departure only, never a later one in progress', async () => {
          await service.evictSeats('group-1', 'user-1', 'begin'); // departure 1
          await service.evictSeats('group-1', 'user-1', 'begin'); // departure 2, before 1 settled

          const late = await service.evictSeats('group-1', 'user-1', { settles: 1 });

          expect(late.settled).toBe(false);
          expect(evictions.get('group-1:user-1')).toEqual({ generation: 3, owedDeparture: 2 });
        });

        /**
         * A SECOND EVICTION THAT NEVER ARRIVED is settled from the durable row by the hourly drain,
         * which asks social-service for THAT departure's outcome - never the entitlement - OUTSIDE
         * the lock, and writes under it only if that departure is still the one owed.
         */
        describe('the drain of departures left in progress', () => {
          beforeEach(async () => {
            tables({ keyPackages: [ownKey], group: { distributionWorkspaceId: 'ws-1' } });
            seats.set('user-1:device-1', { userId: 'user-1' });
            await service.evictSeats('group-1', 'user-1', 'begin');
            // A seat written meanwhile by some path the drain must cut again.
            seats.set('user-1:device-9', { userId: 'user-1' });
            events = [];
          });

          it('asks the outcome of the departure by its name, never the entitlement', async () => {
            fetchSpy.mockResolvedValueOnce(outcome('cancelled'));

            await service.drainOwedSeatEvictions();
            const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
            expect(url).toMatch(/internal\/distribution-groups\/departure-outcome$/);
            expect(JSON.parse(String(init.body))).toEqual({
              groupId: 'group-1',
              userId: 'user-1',
              departure: 1,
            });
          });

          it('cuts again and settles a departure social-service says committed', async () => {
            fetchSpy.mockResolvedValueOnce(outcome('departed'));

            await expect(service.drainOwedSeatEvictions()).resolves.toBe(1);
            expect(events).toEqual(['evict']);
            expect(seats.size).toBe(0);
            expect(evictions.get('group-1:user-1')).toEqual({ generation: 2, owedDeparture: null });
          });

          it('settles without cutting a departure social-service cancelled - the person is still a member', async () => {
            fetchSpy.mockResolvedValueOnce(outcome('cancelled'));

            await expect(service.drainOwedSeatEvictions()).resolves.toBe(1);
            expect(events).toEqual([]);
            expect(evictions.get('group-1:user-1')).toEqual({ generation: 1, owedDeparture: null });
          });

          it('leaves the row owed when social-service cannot answer', async () => {
            fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));

            await expect(service.drainOwedSeatEvictions()).resolves.toBe(0);
            expect(evictions.get('group-1:user-1')).toEqual({ generation: 1, owedDeparture: 1 });
          });

          it('asks nothing about a row an account erasure removed after the batch was read', async () => {
            const manager = groupRepo.manager as unknown as { query: jest.Mock };
            const answer = manager.query.getMockImplementation() as (
              sql: string,
              params: unknown[]
            ) => Promise<unknown>;
            manager.query.mockImplementation(async (sql: string, params: unknown[]) => {
              const rows = await answer(sql, params);
              // The erasure lands just after the drain read its batch.
              if (sql.includes('WHERE "owedDeparture" IS NOT NULL')) evictions.clear();
              return rows;
            });

            await expect(service.drainOwedSeatEvictions()).resolves.toBe(0);
            expect(fetchSpy).not.toHaveBeenCalled();
            // And nothing was written back for it.
            expect(evictions.size).toBe(0);
          });

          it('a cancelled answer for an old departure leaves a NEWER one owed', async () => {
            // While the drain asks about departure 1, it is settled and the person leaves again.
            fetchSpy.mockImplementationOnce(async () => {
              await service.evictSeats('group-1', 'user-1', { settles: 1 });
              await service.evictSeats('group-1', 'user-1', 'begin'); // departure 3
              return outcome('cancelled');
            });

            await expect(service.drainOwedSeatEvictions()).resolves.toBe(0);
            expect(evictions.get('group-1:user-1')).toEqual({ generation: 3, owedDeparture: 3 });
          });
        });

        describe("a key group's admits", () => {
          beforeEach(() => {
            tables({
              keyPackages: [ownKey, { userId: 'user-2', deviceId: 'device-2' }],
              devices: [ownDevice],
              group: { distributionWorkspaceId: 'ws-1' },
            });
            fanOut();
          });
          const admitUser2 = () =>
            commit({ admits: [{ userId: 'user-2', deviceId: 'device-2' }] }, 'user-1');

          it('admits an entitled person, asked before any lock', async () => {
            fetchSpy.mockResolvedValueOnce(entitled(true));

            await expect(admitUser2()).resolves.toMatchObject({ accepted: true });
            expect(membershipInsertBuilder.values).toHaveBeenCalledWith(
              expect.objectContaining({ userId: 'user-2', deviceId: 'device-2' })
            );
            expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body))).toEqual({
              kind: 'workspace',
              scopeId: 'ws-1',
              userId: 'user-2',
            });
          });

          it('admits nobody whose departure has settled and who is no longer entitled', async () => {
            await service.evictSeats('group-1', 'user-2', 'begin');
            await service.evictSeats('group-1', 'user-2', { settles: 1 });
            fetchSpy.mockResolvedValueOnce(entitled(false));

            await expect(admitUser2()).resolves.toMatchObject({ accepted: true });
            expect(membershipInsertBuilder.values).not.toHaveBeenCalled();
          });

          it('admits nobody whose departure is in progress', async () => {
            await service.evictSeats('group-1', 'user-2', 'begin');
            fetchSpy.mockResolvedValueOnce(entitled(true));

            await expect(admitUser2()).resolves.toMatchObject({ accepted: true });
            expect(membershipInsertBuilder.values).not.toHaveBeenCalled();
          });

          it('refuses the whole commit, retryably, when an eviction lands between the question and the lock', async () => {
            fetchSpy.mockImplementationOnce(async () => {
              await service.evictSeats('group-1', 'user-2', 'begin');
              await service.evictSeats('group-1', 'user-2', { settles: 1 });
              return entitled(true);
            });

            // Dropping the admit alone would accept a commit whose newcomer is in the tree with no
            // seat; the group's generation cannot say whose eviction it was, so nothing advances.
            await expect(admitUser2()).rejects.toMatchObject({
              response: { code: 'SEAT_CLAIM_OVERTAKEN', seat: 'admit' },
            });
            expect(groupUpdate).not.toHaveBeenCalled();
            expect(membershipInsertBuilder.values).not.toHaveBeenCalled();
          });

          // The seat this copy met can be the one its OWN earlier request wrote, committed while
          // this one waited on the seat lock: the log row says so, and a 409 would make the client
          // drop the commit the group holds.
          it('answers a duplicate, not a 409, when the commit that overtook the claim is its own', async () => {
            fetchSpy.mockImplementationOnce(async () => {
              await service.evictSeats('group-1', 'user-2', 'begin');
              await service.evictSeats('group-1', 'user-2', { settles: 1 });
              return entitled(true);
            });
            commitLogRepo.findOne.mockResolvedValueOnce({
              groupId: 'group-1',
              baseEpoch: 5,
              commit: MEMBER_COMMIT,
              senderDeviceId: 'device-1',
            });

            await expect(admitUser2()).resolves.toEqual({
              accepted: true,
              newEpoch: 6,
              duplicate: true,
            });
            expect(groupUpdate).not.toHaveBeenCalled();
          });

          it.each([
            ['other bytes', { commit: 'b3RoZXI=', senderDeviceId: 'device-1' }],
            [
              'the same bytes from another device',
              { commit: MEMBER_COMMIT, senderDeviceId: 'device-2' },
            ],
          ])('still answers the 409 when the logged commit is %s', async (_n, row) => {
            fetchSpy.mockImplementationOnce(async () => {
              await service.evictSeats('group-1', 'user-2', 'begin');
              await service.evictSeats('group-1', 'user-2', { settles: 1 });
              return entitled(true);
            });
            commitLogRepo.findOne.mockResolvedValueOnce({
              groupId: 'group-1',
              baseEpoch: 5,
              ...row,
            });

            await expect(admitUser2()).rejects.toMatchObject({
              response: { code: 'SEAT_CLAIM_OVERTAKEN', seat: 'admit' },
            });
          });

          it('asks nobody for a commit built on another epoch', async () => {
            tables({
              keyPackages: [ownKey, { userId: 'user-2', deviceId: 'device-2' }],
              devices: [ownDevice],
              group: { distributionWorkspaceId: 'ws-1', activeEpoch: 6 },
            });

            await expect(admitUser2()).resolves.toEqual({
              accepted: false,
              currentEpoch: 6,
              reason: 'epoch_mismatch',
            });
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(groupUpdate).not.toHaveBeenCalled();
          });

          // A resubmission of an Add whose first answer was lost reaches this check BEFORE the
          // gate's: refused here, the committer cleared the commit the group had applied.
          it('answers a resubmission of its OWN accepted Add as a duplicate, before asking anyone', async () => {
            tables({
              keyPackages: [ownKey, { userId: 'user-2', deviceId: 'device-2' }],
              devices: [ownDevice],
              group: { distributionWorkspaceId: 'ws-1', activeEpoch: 6 },
            });
            commitLogRepo.findOne.mockResolvedValueOnce({
              groupId: 'group-1',
              baseEpoch: 5,
              commit: MEMBER_COMMIT,
              senderDeviceId: 'device-1',
            });

            await expect(admitUser2()).resolves.toEqual({
              accepted: true,
              newEpoch: 6,
              duplicate: true,
            });
            expect(commitLogRepo.findOne).toHaveBeenCalledWith({
              where: { groupId: 'group-1', baseEpoch: 5 },
            });
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(groupUpdate).not.toHaveBeenCalled();
          });

          it('asks about every admitted person at once, not one after another', async () => {
            tables({
              keyPackages: [
                ownKey,
                { userId: 'user-2', deviceId: 'device-2' },
                { userId: 'user-3', deviceId: 'device-3' },
              ],
              devices: [ownDevice],
              group: { distributionWorkspaceId: 'ws-1' },
            });
            const answers: Array<(r: Response) => void> = [];
            fetchSpy.mockImplementation(
              () => new Promise<Response>((resolve) => answers.push(resolve))
            );

            const committed = commit(
              {
                admits: [
                  { userId: 'user-2', deviceId: 'device-2' },
                  { userId: 'user-3', deviceId: 'device-3' },
                ],
              },
              'user-1'
            );
            await settle();
            // Both questions are in flight before either is answered.
            expect(fetchSpy).toHaveBeenCalledTimes(2);
            answers.forEach((answer) => answer(entitled(true)));
            await expect(committed).resolves.toMatchObject({ accepted: true });
          });

          it('is a retryable 503 for the whole commit when social-service cannot answer', async () => {
            fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));

            await expect(admitUser2()).rejects.toBeInstanceOf(ServiceUnavailableException);
            expect(groupUpdate).not.toHaveBeenCalled();
          });
        });
      });
    });

    it("writes the CALLER's id downstream of the gate, never the body's spelling of it", async () => {
      tables({
        keyPackages: [ownKey],
        roster: [{ groupId: 'group-1', userId: 'user-1' }],
      });
      const sent = fanOut();

      await expect(
        commit({ proto: EXTERNAL_COMMIT, senderId: 'USER-1' }, 'user-1')
      ).resolves.toMatchObject({ accepted: true });
      // The committer's own row is read by the pair, then its seat written under the caller's id...
      expect(deviceGroupRepo.findOne).toHaveBeenCalledWith({
        where: { userId: 'user-1', deviceId: 'device-1', groupId: 'group-1' },
      });
      expect(deviceGroupRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', deviceId: 'device-1', status: 'active' }),
        { conflictPaths: ['deviceId', 'groupId'] }
      );
      // ...against a claim that is the CALLER's too, taken under the caller's id before the check.
      expect(groupRepo.manager.query).toHaveBeenCalledWith(expect.any(String), [
        'group-1',
        'user-1',
      ]);
      // ...and the fan-out names the caller as the commit's author.
      expect(sent.mock.calls[0][0]).toMatchObject({
        senderId: 'user-1',
        senderDeviceId: 'device-1',
      });
    });

    it('lets the fan-out skip only the devices it admits and the committer', async () => {
      tables({
        keyPackages: [ownKey, { userId: 'user-2', deviceId: 'phone-2' }],
        devices: [ownDevice],
      });
      const sent = fanOut();

      await commit(
        {
          admits: [{ userId: 'user-2', deviceId: 'phone-2' }],
          excludeDeviceIds: ['user-1:device-1', 'user-2:phone-2', 'user-3:laptop-3'],
        },
        'user-1'
      );

      // user-3 is a member this commit does not admit: it must receive the commit.
      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({ excludeDeviceIds: ['user-1:device-1', 'user-2:phone-2'] }),
        undefined,
        []
      );
    });

    it('does not admit - so cannot exclude - a device the group already routes to', async () => {
      const routed = {
        groupId: 'group-1',
        userId: 'user-2',
        deviceId: 'phone-2',
        status: 'active',
      };
      tables({
        keyPackages: [ownKey, { userId: 'user-2', deviceId: 'phone-2' }],
        devices: [ownDevice, routed],
      });
      const sent = fanOut();

      await commit(
        {
          admits: [{ userId: 'user-2', deviceId: 'phone-2' }],
          excludeDeviceIds: ['user-2:phone-2'],
        },
        'user-1'
      );

      expect(deviceGroupRepo.find).toHaveBeenCalledWith({
        where: [{ userId: 'user-2', deviceId: 'phone-2', groupId: 'group-1', status: 'active' }],
        select: { userId: true, deviceId: true },
      });
      expect(membershipInsertBuilder.values).not.toHaveBeenCalled();
      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({ excludeDeviceIds: [] }),
        undefined,
        []
      );
    });

    it.each([
      ['another group', memberCommitFrame('group-2', 5n)],
      ['another epoch', memberCommitFrame('group-1', 4n)],
      ['an unframed body', 'Y29tbWl0'],
      ['a truncated external commit', externalCommitFrame('group-1', 5n).slice(0, 24)],
    ])('refuses a commit whose header is %s, before the membership gate', async (_name, proto) => {
      tables({
        keyPackages: [ownKey],
        devices: [ownDevice],
        roster: [{ groupId: 'group-1', userId: 'user-1' }],
      });
      const sent = fanOut();

      await expect(commit({ proto }, 'user-1')).rejects.toMatchObject({
        response: { error: 'commit_malformed' },
      });
      expect(groupMemberRepo.findOne).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(sent).not.toHaveBeenCalled();
    });

    it.each([
      ['another user', 'user-2:device-1'],
      ['another device of the caller', 'user-1:device-2'],
      ['a bare user id', 'user-1'],
    ])(
      'refuses an external commit whose new leaf names %s, before the membership gate',
      async (_name, leafIdentity) => {
        tables({
          keyPackages: [ownKey],
          devices: [ownDevice],
          roster: [{ groupId: 'group-1', userId: 'user-1' }],
        });
        const sent = fanOut();

        await expect(
          commit({ proto: externalCommitFrame('group-1', 5n, leafIdentity) }, 'user-1')
        ).rejects.toMatchObject({ response: { error: 'commit_identity_mismatch' } });
        expect(groupMemberRepo.findOne).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
        expect(sent).not.toHaveBeenCalled();
      }
    );

    it("holds a key group's external commit to the same header: its own group and epoch", async () => {
      tables({ keyPackages: [ownKey], group: { distributionWorkspaceId: 'ws-1' } });

      await expect(
        commit({ proto: externalCommitFrame('group-2', 5n) }, 'user-1')
      ).rejects.toMatchObject({ response: { error: 'commit_malformed' } });
      expect(transaction).not.toHaveBeenCalled();
    });

    /**
     * AN ACCEPTED COMMIT THAT ADDS A DEVICE ALWAYS HAS ITS WELCOME. The background re-add queued its
     * Welcome in a second call after the advance; when that call failed, the newcomer sat in the
     * tree with no Welcome, every holder then answered it `already-member`, and nothing durable
     * recovered it. The Welcome row is now written in the advance's own transaction.
     */
    describe('a commit carrying the Welcome of the device it adds', () => {
      const newcomer = { userId: 'user-2', deviceId: 'phone-2' };
      const welcome = {
        userId: 'user-2',
        deviceId: 'phone-2',
        payload: 'd2VsY29tZQ==',
        ratchetTree: 'dHJlZQ==',
      };
      const withWelcome = () =>
        commit({ admits: [newcomer], welcome }, 'user-1') as ReturnType<
          typeof service.validateCommit
        >;
      let deliver: jest.SpyInstance;

      beforeEach(() => {
        deliver = jest
          .spyOn(
            service as unknown as { deliverQueuedFrame: () => Promise<boolean> },
            'deliverQueuedFrame'
          )
          .mockResolvedValue(false);
      });

      it('writes the Welcome row in the transaction that advances the epoch, then delivers that row', async () => {
        tables({
          keyPackages: [ownKey, newcomer],
          devices: [ownDevice],
          roster: [{ groupId: 'group-1', userId: 'user-2' }],
        });
        const sent = fanOut();
        // The order the writes happen in: the Welcome row must be written while the transaction
        // that moves the epoch is open, never after it closed.
        let insideTransaction = false;
        let writtenInside: boolean | null = null;
        transaction.mockImplementationOnce(async (cb: (m: unknown) => Promise<void>) => {
          insideTransaction = true;
          try {
            return await (
              transaction.getMockImplementation() as (
                c: (m: unknown) => Promise<void>
              ) => Promise<void>
            )(cb);
          } finally {
            insideTransaction = false;
          }
        });
        txQueuedRepo.save.mockImplementationOnce(async (row: Record<string, unknown>) => {
          writtenInside = insideTransaction;
          return { ...row, id: 'queued-welcome-1' };
        });

        await expect(withWelcome()).resolves.toEqual({ accepted: true, newEpoch: 6 });

        expect(writtenInside).toBe(true);
        expect(txQueuedRepo.save).toHaveBeenCalledWith(
          expect.objectContaining({
            recipientId: 'user-2',
            deviceId: 'phone-2',
            senderId: 'user-1',
            groupId: 'group-1',
            proto: 'd2VsY29tZQ==',
            ratchetTree: 'dHJlZQ==',
            isWelcome: true,
          })
        );
        expect(groupUpdate).toHaveBeenCalledWith(
          { id: 'group-1', activeEpoch: 5 },
          { activeEpoch: 6 }
        );
        // Delivered FROM the stored row - its id is what lets the device ACK it - as a silent,
        // pushable Welcome, after the members have the commit.
        expect(deliver).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'queued-welcome-1', isWelcome: true }),
          expect.objectContaining({ tag: 'WELCOME', silent: true, pushable: true })
        );
        expect(sent.mock.invocationCallOrder[0]).toBeLessThan(deliver.mock.invocationCallOrder[0]);
      });

      it('fails the whole commit when the Welcome row cannot be written - nothing is fanned out', async () => {
        tables({
          keyPackages: [ownKey, newcomer],
          devices: [ownDevice],
          roster: [{ groupId: 'group-1', userId: 'user-2' }],
        });
        const sent = fanOut();
        txQueuedRepo.save.mockRejectedValueOnce(new Error('connection lost'));

        await expect(withWelcome()).rejects.toThrow('connection lost');
        expect(sent).not.toHaveBeenCalled();
        expect(deliver).not.toHaveBeenCalled();
      });

      it('stays accepted when the realtime delivery fails: the stored row is the delivery', async () => {
        tables({
          keyPackages: [ownKey, newcomer],
          devices: [ownDevice],
          roster: [{ groupId: 'group-1', userId: 'user-2' }],
        });
        fanOut();
        deliver.mockRejectedValueOnce(new Error('redis down'));

        await expect(withWelcome()).resolves.toEqual({ accepted: true, newEpoch: 6 });
        expect(txQueuedRepo.save).toHaveBeenCalledTimes(1);
      });

      it("refuses the commit when the Welcome target's key package is gone under the seat lock", async () => {
        // Registered when the target was resolved; an account erasure took it before the advance.
        tables({
          keyPackages: [ownKey, newcomer],
          devices: [ownDevice],
          roster: [{ groupId: 'group-1', userId: 'user-2' }],
        });
        const sent = fanOut();
        txErasedDevices.add('user-2:phone-2');

        await expect(withWelcome()).resolves.toMatchObject({
          accepted: false,
          reason: 'welcome_target_not_member',
        });
        expect(groupUpdate).not.toHaveBeenCalled();
        expect(txQueuedRepo.save).not.toHaveBeenCalled();
        expect(sent).not.toHaveBeenCalled();
      });

      // The seat this copy found gone may have been taken by its OWN earlier request, committed
      // while it waited on the seat lock: the log row decides, not the seat.
      it('answers a duplicate, not a refusal, when its own earlier request landed the Welcome', async () => {
        tables({
          keyPackages: [ownKey, newcomer],
          devices: [ownDevice],
          roster: [{ groupId: 'group-1', userId: 'user-2' }],
        });
        const sent = fanOut();
        txErasedDevices.add('user-2:phone-2');
        commitLogRepo.findOne.mockResolvedValueOnce({
          groupId: 'group-1',
          baseEpoch: 5,
          commit: MEMBER_COMMIT,
          senderDeviceId: 'device-1',
        });

        await expect(withWelcome()).resolves.toEqual({
          accepted: true,
          newEpoch: 6,
          duplicate: true,
        });
        expect(groupUpdate).not.toHaveBeenCalled();
        expect(sent).not.toHaveBeenCalled();
      });

      it('refuses, before the epoch moves, a Welcome to a person the group does not name', async () => {
        tables({ keyPackages: [ownKey, newcomer], devices: [ownDevice], roster: [] });
        const sent = fanOut();

        await expect(withWelcome()).resolves.toEqual({
          accepted: false,
          currentEpoch: 5,
          reason: 'welcome_target_not_member',
        });
        expect(transaction).not.toHaveBeenCalled();
        expect(sent).not.toHaveBeenCalled();
      });

      it('refuses, before the epoch moves, a Welcome to a device registered to nobody', async () => {
        tables({
          keyPackages: [ownKey],
          devices: [ownDevice],
          roster: [{ groupId: 'group-1', userId: 'user-2' }],
        });
        const sent = fanOut();

        await expect(withWelcome()).resolves.toEqual({
          accepted: false,
          currentEpoch: 5,
          reason: 'welcome_target_unknown',
        });
        expect(transaction).not.toHaveBeenCalled();
        expect(sent).not.toHaveBeenCalled();
      });

      it('refuses a Welcome for a group that ended while the commit was in flight', async () => {
        tables({
          keyPackages: [ownKey, newcomer],
          devices: [ownDevice],
          roster: [{ groupId: 'group-1', userId: 'user-2' }],
        });
        const sent = fanOut();
        txGroupFind.mockResolvedValueOnce([{ id: 'group-1', deletedAt: new Date(0) }]);

        await expect(withWelcome()).rejects.toBeInstanceOf(GoneException);
        expect(txQueuedRepo.save).not.toHaveBeenCalled();
        expect(sent).not.toHaveBeenCalled();
      });

      /**
       * A REMOVAL RACING THE STORE serialises with it on the target's roster seat: the advance's
       * transaction re-reads it under a share lock, after the group row and before anything is
       * written. A removal that committed first leaves no seat, and the commit is refused whole.
       */
      it("re-reads the target's seat under a lock, after the group and before any write", async () => {
        tables({
          keyPackages: [ownKey, newcomer],
          devices: [ownDevice],
          roster: [{ groupId: 'group-1', userId: 'user-2' }],
        });
        fanOut();

        await expect(withWelcome()).resolves.toEqual({ accepted: true, newEpoch: 6 });
        expect(txSeatRepo.findOne).toHaveBeenCalledWith({
          where: { groupId: 'group-1', userId: 'user-2' },
          lock: { mode: 'pessimistic_write' },
        });
        expect(txGroupFind.mock.invocationCallOrder[0]).toBeLessThan(
          txSeatRepo.findOne.mock.invocationCallOrder[0]
        );
        expect(txSeatRepo.findOne.mock.invocationCallOrder[0]).toBeLessThan(
          groupUpdate.mock.invocationCallOrder[0]
        );
      });

      /**
       * A CLIENT OLDER THAN `admits` STILL ADMITS BY ITS WELCOME. Its commit declares nobody, so the
       * ask is lifted for the Welcome's target - without it the joiner turned active under a flag
       * nothing would ever clear, and every commit of theirs was refused.
       */
      it("lifts the invitation-link ask of the Welcome's target, with no `admits` declared", async () => {
        tables({
          keyPackages: [ownKey, newcomer],
          devices: [ownDevice],
          roster: [{ groupId: 'group-1', userId: 'user-2' }],
        });
        fanOut();
        txSeatRepo.update.mockResolvedValueOnce({ affected: 1 });

        await expect(commit({ welcome }, 'user-1')).resolves.toEqual({
          accepted: true,
          newEpoch: 6,
        });
        expect(txSeatRepo.update).toHaveBeenCalledTimes(1);
        const [where, set] = txSeatRepo.update.mock.calls[0] as [
          { groupId: string; userId: FindOperator<string[]>; awaitingAdmission: boolean },
          unknown,
        ];
        expect(where.awaitingAdmission).toBe(true);
        expect(where.userId.value).toEqual(['user-2']);
        expect(set).toEqual({ awaitingAdmission: false });
      });

      it('refuses the whole commit when the seat is gone by the time the transaction reads it', async () => {
        tables({
          keyPackages: [ownKey, newcomer],
          devices: [ownDevice],
          roster: [{ groupId: 'group-1', userId: 'user-2' }],
        });
        const sent = fanOut();
        txSeatRepo.findOne.mockResolvedValue(null);

        await expect(withWelcome()).resolves.toEqual({
          accepted: false,
          currentEpoch: 5,
          reason: 'welcome_target_not_member',
        });
        expect(groupUpdate).not.toHaveBeenCalled();
        expect(txQueuedRepo.save).not.toHaveBeenCalled();
        expect(sent).not.toHaveBeenCalled();
      });

      /**
       * A KEY GROUP HAS NO USER ROSTER HERE, so its Welcome's target is asked of social-service
       * (WP-KEYGROUP-JOIN-GATE) - about the TARGET, never the committer - before the epoch moves.
       */
      describe("in a key group, the target's entitlement", () => {
        let previous: string | undefined;
        let fetchSpy: jest.SpyInstance;
        // A fresh body per call: the admit and the Welcome's target are each asked.
        const social = (status: number, answer: unknown) =>
          fetchSpy.mockImplementation(async () => new Response(JSON.stringify(answer), { status }));
        const askedBodies = () =>
          fetchSpy.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
        const keyGroup = () =>
          tables({
            keyPackages: [ownKey, newcomer],
            devices: [ownDevice],
            roster: [],
            group: { distributionWorkspaceId: 'ws-1' },
          });

        beforeEach(() => {
          previous = process.env.INTERNAL_SECRET;
          process.env.INTERNAL_SECRET = 'sekret';
          fetchSpy = jest.spyOn(globalThis, 'fetch');
        });

        afterEach(() => {
          fetchSpy.mockRestore();
          txEvictionRow = null;
          if (previous === undefined) delete process.env.INTERNAL_SECRET;
          else process.env.INTERNAL_SECRET = previous;
        });

        /**
         * THE ANSWER IS READ BEFORE THE LOCK, SO AN EVICTION MAY COMMIT AFTER IT. The target's claim
         * is taken before social-service is asked and re-read under the seat lock the advance holds,
         * which is the lock the eviction takes: one that committed in between moved the generation,
         * and the whole commit is refused before the epoch moves.
         */
        it('refuses the whole commit when the target is evicted after social-service answered', async () => {
          keyGroup();
          social(200, { entitled: true });
          const sent = fanOut();
          txEvictionRow = { generation: 1, owedDeparture: null };

          // The target is also this commit's admit, whose claim the eviction overtook: the whole
          // commit is refused retryably, and the retry meets the target's entitlement afresh.
          await expect(withWelcome()).rejects.toMatchObject({
            response: { code: 'SEAT_CLAIM_OVERTAKEN', seat: 'admit' },
          });
          expect(groupUpdate).not.toHaveBeenCalled();
          expect(txQueuedRepo.save).not.toHaveBeenCalled();
          expect(sent).not.toHaveBeenCalled();
        });

        it('stores the Welcome when social-service entitles the target', async () => {
          keyGroup();
          social(200, { entitled: true });
          fanOut();

          await expect(withWelcome()).resolves.toEqual({ accepted: true, newEpoch: 6 });
          expect(askedBodies()).toContainEqual({
            kind: 'workspace',
            scopeId: 'ws-1',
            userId: 'user-2',
          });
          expect(txQueuedRepo.save).toHaveBeenCalledTimes(1);
        });

        it('refuses before the epoch moves when social-service does not entitle the target', async () => {
          keyGroup();
          social(200, { entitled: false });
          const sent = fanOut();

          await expect(withWelcome()).resolves.toEqual({
            accepted: false,
            currentEpoch: 5,
            reason: 'welcome_target_not_member',
          });
          expect(transaction).not.toHaveBeenCalled();
          expect(sent).not.toHaveBeenCalled();
        });

        it('is a retryable 503, recording nothing, when social-service cannot answer', async () => {
          keyGroup();
          fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
          const sent = fanOut();

          await expect(withWelcome()).rejects.toBeInstanceOf(ServiceUnavailableException);
          expect(transaction).not.toHaveBeenCalled();
          expect(sent).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe('the newcomers a commit admits', () => {
    const accept = (admits?: { userId: string; deviceId: string }[]) => {
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5 });
      return service.validateCommit(
        {
          groupId: 'group-1',
          deviceId: 'device-1',
          baseEpoch: 5,
          proto: memberCommitFrame('group-1', 5n),
          senderId: 'user-1',
          admits,
        },
        'user-1'
      );
    };

    it('writes each admitted device pending at the epoch the commit creates, inside the advance', async () => {
      keyPackageRepo.find.mockResolvedValue([{ userId: 'user-2', deviceId: 'phone-2' }]);

      const res = await accept([{ userId: 'user-2', deviceId: 'phone-2' }]);

      expect(res.accepted).toBe(true);
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(membershipInsertBuilder.values).toHaveBeenCalledWith({
        userId: 'user-2',
        deviceId: 'phone-2',
        groupId: 'group-1',
        status: 'pending',
      });
      // Guarded on `pending` and read by the PAIR: an active device is routed by its status and never
      // touched. The admitting commit is the Add a kick was owed, so it ends the kick.
      expect(txMembershipRepo.update).toHaveBeenCalledWith(
        { userId: 'user-2', deviceId: 'phone-2', groupId: 'group-1', status: 'pending' },
        { admittedAtEpoch: 6, kickedAt: null }
      );
    });

    it("lifts the invitation-link ask of every person it admits, in the advance's transaction", async () => {
      keyPackageRepo.find.mockResolvedValue([
        { userId: 'user-2', deviceId: 'phone-2' },
        { userId: 'user-2', deviceId: 'web-2' },
      ]);
      txSeatRepo.update.mockResolvedValueOnce({ affected: 1 });

      const res = await accept([
        { userId: 'user-2', deviceId: 'phone-2' },
        { userId: 'user-2', deviceId: 'web-2' },
      ]);

      expect(res.accepted).toBe(true);
      // One update per commit, by person - guarded on the flag, so a seat no link wrote is untouched.
      expect(txSeatRepo.update).toHaveBeenCalledTimes(1);
      const [where, set] = txSeatRepo.update.mock.calls[0] as [
        { groupId: string; userId: FindOperator<string[]>; awaitingAdmission: boolean },
        unknown,
      ];
      expect(where.groupId).toBe('group-1');
      expect(where.awaitingAdmission).toBe(true);
      expect(where.userId.value).toEqual(['user-2']);
      expect(set).toEqual({ awaitingAdmission: false });
    });

    it('lifts no ask when it admits nobody', async () => {
      await accept();

      expect(txSeatRepo.update).not.toHaveBeenCalled();
    });

    it('refuses the committer itself and a device with no KeyPackage, recording neither', async () => {
      keyPackageRepo.find.mockResolvedValue([]);

      await accept([
        { userId: 'user-1', deviceId: 'device-1' },
        { userId: 'user-9', deviceId: 'ghost-9' },
      ]);

      expect(txMembershipRepo.update).not.toHaveBeenCalled();
      expect(membershipInsertBuilder.values).not.toHaveBeenCalled();
    });

    it('writes no row for an admit whose key package an erasure took after the gate read it', async () => {
      // Registered when the admits were resolved, before the lock; gone when it is held.
      keyPackageRepo.find.mockResolvedValue([{ userId: 'user-2', deviceId: 'phone-2' }]);
      txErasedDevices.add('user-2:phone-2');

      const res = await accept([{ userId: 'user-2', deviceId: 'phone-2' }]);

      expect(res.accepted).toBe(true);
      expect(txKeyPackageRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_read' } })
      );
      expect(membershipInsertBuilder.values).not.toHaveBeenCalled();
      expect(txMembershipRepo.update).not.toHaveBeenCalled();
    });

    it('records nothing for a client predating the field', async () => {
      await accept(undefined);

      expect(keyPackageRepo.find).not.toHaveBeenCalled();
      expect(txMembershipRepo.update).not.toHaveBeenCalled();
    });

    it('ends the parting entry of a device it puts back in the tree, and of the committer', async () => {
      keyPackageRepo.find.mockResolvedValue([{ userId: 'user-2', deviceId: 'phone-2' }]);
      jest
        .spyOn(service, 'sendMessage')
        .mockResolvedValue({ status: 'processed', queued: 0, sent: 0, receivedAt: 0 });

      await accept([{ userId: 'user-2', deviceId: 'phone-2' }]);

      expect(redis.hdel).toHaveBeenCalledWith(
        'group:parting:group-1',
        'user-2:phone-2',
        'user-1:device-1'
      );
    });
  });

  /**
   * A COMMIT REACHES WHOEVER IT REMOVES, found by what it DECLARES (third review of #1878): the
   * removal deleted their device rows before the commit, so the fan-out is handed them from the
   * parting hint - only the ones this commit names.
   */
  describe('the devices a commit removes', () => {
    it('hands the fan-out the parted devices of the person the commit declares, and only them', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5 });
      redis.hgetall.mockResolvedValue({ 'bob:b1': 'user-1', 'carol:c1': 'user-1' });
      const fanOut = jest
        .spyOn(service, 'sendMessage')
        .mockResolvedValue({ status: 'processed', queued: 0, sent: 0, receivedAt: 0 });

      await service.validateCommit(
        {
          groupId: 'group-1',
          deviceId: 'device-1',
          baseEpoch: 5,
          proto: memberCommitFrame('group-1', 5n),
          senderId: 'user-1',
          removes: [{ userId: 'bob' }],
        },
        'user-1'
      );

      expect(fanOut).toHaveBeenCalledWith(expect.objectContaining({ isCommit: true }), undefined, [
        { userId: 'bob', deviceId: 'b1' },
      ]);
    });

    it('a commit declaring nothing reaches no parted device', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5 });
      redis.hgetall.mockResolvedValue({ 'bob:b1': 'user-1' });
      const fanOut = jest
        .spyOn(service, 'sendMessage')
        .mockResolvedValue({ status: 'processed', queued: 0, sent: 0, receivedAt: 0 });

      await service.validateCommit(
        {
          groupId: 'group-1',
          deviceId: 'device-1',
          baseEpoch: 5,
          proto: memberCommitFrame('group-1', 5n),
          senderId: 'user-1',
        },
        'user-1'
      );

      expect(fanOut).toHaveBeenCalledWith(expect.anything(), undefined, []);
    });
  });
});
