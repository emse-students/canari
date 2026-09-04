/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
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

describe('MessagingService - commit-log (rung-1 backbone)', () => {
  let service: MessagingService;

  /**
   * The epoch advance is written through a TRANSACTION now, not `save`, because the external-join
   * base for the epoch it creates has to land with it or not at all (COMM-22). The fake manager
   * hands out the same two repositories the real one would, so a test can assert BOTH writes and
   * see that they happened inside the one callback.
   */
  const groupUpdate = jest.fn().mockResolvedValue({ affected: 1 });
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
  const transaction = jest.fn(async (cb: (m: unknown) => Promise<void>) =>
    cb({
      getRepository: (entity: unknown) => {
        if (entity === Group) return { update: groupUpdate };
        // THE COMMIT-LOG ROW IS WRITTEN INSIDE THIS TRANSACTION NOW, not best-effort after it: the
        // epoch advance and the commit that lets everyone else replay it land together or neither
        // lands. Routing it here is what lets a test see the two writes in one callback.
        if (entity === MlsCommitLog) return { createQueryBuilder: () => commitInsertBuilder };
        return txGroupInfoRepo;
      },
    })
  );
  const groupRepo = { findOne: jest.fn(), save: jest.fn(), manager: { transaction } };
  const groupMemberRepo = { findOne: jest.fn() };
  const commitInsertBuilder = {
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({}),
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
  };
  // The addressability guard (WP-GHOST-1): a device may only be promoted to `active` if it is not
  // on the revocation denylist AND still has a static KeyPackage. Both default to "device exists",
  // so the promotion tests keep testing promotion; the refusal tests set them explicitly.
  const keyPackageRepo = {
    find: jest.fn(),
    findOne: jest.fn().mockResolvedValue({ id: 'kp-1' }),
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
    // Activation redelivery reads the history stream; empty keeps it a no-op here.
    xrange: jest.fn(() => Promise.resolve([])),
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
    keyPackageRepo.findOne.mockResolvedValue({ id: 'kp-1' });
    revokedDeviceRepo.findOne.mockResolvedValue(null);
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
        .mockResolvedValue({ status: 'processed', queued: 0, sent: 0 });

      const res = await service.validateCommit({
        groupId: 'group-1',
        deviceId: 'device-1',
        baseEpoch: 5,
        proto: 'Y29tbWl0',
        senderId: 'user-1',
        excludeDeviceIds: ['user-1:device-1'],
      });

      expect(res.accepted).toBe(true);
      expect(res.newEpoch).toBe(6);
      // Epoch advanced and persisted, inside the transaction.
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(groupUpdate).toHaveBeenCalledWith({ id: 'group-1' }, { activeEpoch: 6 });
      // Commit stored keyed by the epoch it advances FROM.
      expect(commitInsertBuilder.values).toHaveBeenCalledWith({
        groupId: 'group-1',
        baseEpoch: 5,
        commit: 'Y29tbWl0',
        senderDeviceId: 'device-1',
      });
      expect(commitInsertBuilder.orIgnore).toHaveBeenCalled();
      // Fanned out as a commit, honouring the exclude list.
      expect(fanOut).toHaveBeenCalledWith(
        expect.objectContaining({
          groupId: 'group-1',
          proto: 'Y29tbWl0',
          isCommit: true,
          excludeDeviceIds: ['user-1:device-1'],
        })
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
        .mockResolvedValue({ status: 'processed', queued: 0, sent: 0 });

      const res = await service.validateCommit({
        groupId: 'group-1',
        deviceId: 'device-1',
        baseEpoch: 5,
        proto: 'Y29tbWl0',
        senderId: 'user-1',
        groupInfo: 'Z2k=',
      });

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
      expect(groupUpdate).toHaveBeenCalledWith({ id: 'group-1' }, { activeEpoch: 6 });
    });

    it('advances the epoch alone when the committer sends no base', async () => {
      // An ordinary staged add/remove cannot export one: its commit is unapplied at submit time, so
      // the device does not hold the resulting epoch's tree yet. Those keep the follow-up refresh
      // and a holder's `republishStaleBase` as their repair - what must NOT happen is a base
      // written for an epoch nobody described.
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5 });
      jest
        .spyOn(service, 'sendMessage')
        .mockResolvedValue({ status: 'processed', queued: 0, sent: 0 });

      const res = await service.validateCommit({
        groupId: 'group-1',
        deviceId: 'device-1',
        baseEpoch: 5,
        proto: 'Y29tbWl0',
        senderId: 'user-1',
      });

      expect(res.accepted).toBe(true);
      expect(groupUpdate).toHaveBeenCalledWith({ id: 'group-1' }, { activeEpoch: 6 });
      expect(txInsertBuilder.values).not.toHaveBeenCalled();
      expect(txUpdateBuilder.set).not.toHaveBeenCalled();
    });

    it('refuses to store a base for a commit the gate rejected', async () => {
      // The base is monotonic and cannot be walked back, so publishing one for an epoch that never
      // happened would strand the group permanently - worse than the staleness it replaces.
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 7 });

      const res = await service.validateCommit({
        groupId: 'group-1',
        deviceId: 'device-1',
        baseEpoch: 5,
        proto: 'Y29tbWl0',
        senderId: 'user-1',
        groupInfo: 'Z2k=',
      });

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
      jest
        .spyOn(service, 'sendMessage')
        .mockResolvedValue({ status: 'processed', queued: 0, sent: 0 });

      const res = await service.validateCommit({
        groupId: 'group-1',
        deviceId: 'device-new',
        baseEpoch: 1,
        proto: 'Y29tbWl0',
        senderId: 'user-2',
        excludeDeviceIds: ['user-2:device-new'],
      });

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
        },
        { conflictPaths: ['deviceId', 'groupId'] }
      );
      expect(redis.sadd).toHaveBeenCalledWith('group:members:group-1', 'user-2:device-new');
      // No activation redelivery: the joiner landed at the current epoch and cannot decrypt
      // anything sent before its commit - those messages come back via the history bundle.
      expect(redis.xrange).not.toHaveBeenCalled();
    });

    it('does not re-promote a device that is already an active member', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5 });
      deviceGroupRepo.findOne.mockResolvedValue({ status: 'active' });
      jest
        .spyOn(service, 'sendMessage')
        .mockResolvedValue({ status: 'processed', queued: 0, sent: 0 });

      await service.validateCommit({
        groupId: 'group-1',
        deviceId: 'device-1',
        baseEpoch: 5,
        proto: 'Y29tbWl0',
        senderId: 'user-1',
      });

      expect(deviceGroupRepo.upsert).not.toHaveBeenCalled();
    });

    // ── WP-GHOST-1: a device that may not be INVITED may not be ROUTED TO either ──────────────
    // The commit path promotes the COMMITTING device, so without these two guards a device its
    // owner had deleted could re-enrol itself in every group it still held MLS state for - and
    // then be messaged forever, invisible in the device list and uncollectable by the GC.
    it('refuses to promote a device on the revocation denylist', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 1 });
      deviceGroupRepo.findOne.mockResolvedValue(null);
      revokedDeviceRepo.findOne.mockResolvedValue({ id: 'r1' });
      jest
        .spyOn(service, 'sendMessage')
        .mockResolvedValue({ status: 'processed', queued: 0, sent: 0 });

      const res = await service.validateCommit({
        groupId: 'group-1',
        deviceId: 'device-revoked',
        baseEpoch: 1,
        proto: 'Y29tbWl0',
        senderId: 'user-2',
      });

      // The COMMIT itself is still accepted - it is cryptographically valid and other members
      // must apply it. Only the routing membership is refused.
      expect(res.accepted).toBe(true);
      expect(deviceGroupRepo.upsert).not.toHaveBeenCalled();
      expect(redis.sadd).not.toHaveBeenCalledWith('group:members:group-1', 'user-2:device-revoked');
    });

    it('refuses to promote a device with no static KeyPackage', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 1 });
      deviceGroupRepo.findOne.mockResolvedValue(null);
      keyPackageRepo.findOne.mockResolvedValue(null);
      jest
        .spyOn(service, 'sendMessage')
        .mockResolvedValue({ status: 'processed', queued: 0, sent: 0 });

      await service.validateCommit({
        groupId: 'group-1',
        deviceId: 'device-ghost',
        baseEpoch: 1,
        proto: 'Y29tbWl0',
        senderId: 'user-2',
      });

      expect(deviceGroupRepo.upsert).not.toHaveBeenCalled();
    });

    it('rejects on epoch mismatch without storing or broadcasting', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 9 });
      const fanOut = jest.spyOn(service, 'sendMessage');

      const res = await service.validateCommit({
        groupId: 'group-1',
        deviceId: 'device-1',
        baseEpoch: 5,
        proto: 'Y29tbWl0',
      });

      expect(res.accepted).toBe(false);
      expect(res.reason).toBe('epoch_mismatch');
      expect(commitInsertBuilder.execute).not.toHaveBeenCalled();
      expect(fanOut).not.toHaveBeenCalled();
    });

    it('refuses a commit with no proto instead of advancing the epoch past it', async () => {
      // The epoch it would create is one NOTHING can ever replay: the commit-log is keyed UNIQUE on
      // (groupId, baseEpoch), so the row skipped here cannot be written later by anybody. Every
      // device that misses that epoch is then owed a full rung-2 re-Welcome for ever.
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5 });
      const fanOut = jest.spyOn(service, 'sendMessage');

      await expect(
        service.validateCommit({ groupId: 'group-1', deviceId: 'device-1', baseEpoch: 5 })
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
        service.validateCommit({
          groupId: 'group-1',
          deviceId: 'device-1',
          baseEpoch: 5,
          proto: 'Y29tbWl0',
          senderId: 'user-1',
        })
      ).rejects.toThrow('deadlock detected');

      // The fan-out is the LAST step for exactly this reason: nobody is handed a commit whose
      // epoch the server did not keep.
      expect(fanOut).not.toHaveBeenCalled();
    });
  });

  describe('getCommitsSince (membership-gated replay)', () => {
    it('forbids a non-member', async () => {
      groupMemberRepo.findOne.mockResolvedValue(null);
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
});
