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
import { ApnsService } from './apns.service';

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
  const redisStore = new Map<string, string>();
  const redis = {
    set: jest.fn(() => Promise.resolve('OK')),
    eval: jest.fn(() => Promise.resolve(1)),
    get: jest.fn((k: string) => Promise.resolve(redisStore.get(k) ?? null)),
    del: jest.fn(),
  };

  const emptyRepo = () => ({
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(),
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: groupMemberRepo },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        {
          provide: getRepositoryToken(OneTimeKeyPackage),
          useValue: emptyRepo(),
        },
        {
          provide: getRepositoryToken(DeviceGroupMembership),
          useValue: emptyRepo(),
        },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: commitLogRepo },
        { provide: 'REDIS_CLIENT', useValue: redis },
        { provide: ApnsService, useValue: {} },
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
      expect(groupRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ activeEpoch: 6 }),
      );
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
        }),
      );
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
      await expect(
        service.getCommitsSince('group-1', 0, 'stranger'),
      ).rejects.toBeInstanceOf(ForbiddenException);
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
