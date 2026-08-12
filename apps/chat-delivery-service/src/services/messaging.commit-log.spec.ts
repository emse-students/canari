/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException } from '@nestjs/common';
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

  const groupRepo = { findOne: jest.fn(), save: jest.fn() };
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
      groupRepo.save.mockResolvedValue(undefined);
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
      // Epoch advanced and persisted.
      expect(groupRepo.save).toHaveBeenCalledWith(expect.objectContaining({ activeEpoch: 6 }));
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

    it('promotes the committing device to active when it has no membership row (external join)', async () => {
      // An external-commit join never receives a Welcome, so nothing else creates the row.
      // Without the promotion, recipient resolution (status='active') skips the device and it
      // receives neither the history bundle it solicits nor any later message.
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 1 });
      groupRepo.save.mockResolvedValue(undefined);
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
      expect(deviceGroupRepo.upsert).toHaveBeenCalledWith(
        { userId: 'user-2', deviceId: 'device-new', groupId: 'group-1', status: 'active' },
        { conflictPaths: ['deviceId', 'groupId'] }
      );
      expect(redis.sadd).toHaveBeenCalledWith('group:members:group-1', 'user-2:device-new');
      // No activation redelivery: the joiner landed at the current epoch and cannot decrypt
      // anything sent before its commit - those messages come back via the history bundle.
      expect(redis.xrange).not.toHaveBeenCalled();
    });

    it('does not re-promote a device that is already an active member', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'group-1', activeEpoch: 5 });
      groupRepo.save.mockResolvedValue(undefined);
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
      groupRepo.save.mockResolvedValue(undefined);
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
      groupRepo.save.mockResolvedValue(undefined);
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
    });
  });
});
