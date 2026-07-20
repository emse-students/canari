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

describe('MessagingService - group-info (external-join base)', () => {
  let service: MessagingService;

  const groupMemberRepo = { findOne: jest.fn() };
  const updateBuilder = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({}),
  };
  const insertBuilder = {
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({}),
  };
  const groupInfoRepo = {
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
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
    groupInfoRepo.createQueryBuilder.mockImplementation((): unknown => ({
      ...insertBuilder,
      ...updateBuilder,
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: groupMemberRepo },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
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
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: groupInfoRepo },
        { provide: 'REDIS_CLIENT', useValue: {} },
      ],
    }).compile();

    service = module.get(MessagingService);
  });

  describe('storeGroupInfo (membership-gated, monotonic)', () => {
    it('forbids a non-member', async () => {
      groupMemberRepo.findOne.mockResolvedValue(null);
      await expect(service.storeGroupInfo('g1', 'stranger', 'Z2k=', 5)).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });

    it('inserts when no GroupInfo exists yet', async () => {
      groupMemberRepo.findOne.mockResolvedValue({ id: 'm' });
      groupInfoRepo.findOne.mockResolvedValue(null);

      const res = await service.storeGroupInfo('g1', 'member-1', 'Z2k=', 5);

      expect(res.stored).toBe(true);
      expect(insertBuilder.values).toHaveBeenCalledWith({
        groupId: 'g1',
        groupInfo: 'Z2k=',
        baseEpoch: 5,
      });
    });

    it('ignores a write with a lower baseEpoch than the stored one (monotonic)', async () => {
      groupMemberRepo.findOne.mockResolvedValue({ id: 'm' });
      groupInfoRepo.findOne.mockResolvedValue({ groupId: 'g1', baseEpoch: 9 });

      const res = await service.storeGroupInfo('g1', 'member-1', 'Z2k=', 5);

      expect(res.stored).toBe(false);
      expect(insertBuilder.execute).not.toHaveBeenCalled();
      expect(updateBuilder.execute).not.toHaveBeenCalled();
    });

    it('updates when the incoming baseEpoch is newer', async () => {
      groupMemberRepo.findOne.mockResolvedValue({ id: 'm' });
      groupInfoRepo.findOne.mockResolvedValue({ groupId: 'g1', baseEpoch: 5 });

      const res = await service.storeGroupInfo('g1', 'member-1', 'bmV3', 6);

      expect(res.stored).toBe(true);
      expect(updateBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({ groupInfo: 'bmV3', baseEpoch: 6 })
      );
    });
  });

  describe('getGroupInfo (membership-gated)', () => {
    it('forbids a non-member', async () => {
      groupMemberRepo.findOne.mockResolvedValue(null);
      await expect(service.getGroupInfo('g1', 'stranger')).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });

    it('returns null when no GroupInfo is stored', async () => {
      groupMemberRepo.findOne.mockResolvedValue({ id: 'm' });
      groupInfoRepo.findOne.mockResolvedValue(null);
      expect(await service.getGroupInfo('g1', 'member-1')).toBeNull();
    });

    it('returns the stored GroupInfo and its base epoch to a member', async () => {
      groupMemberRepo.findOne.mockResolvedValue({ id: 'm' });
      groupInfoRepo.findOne.mockResolvedValue({
        groupId: 'g1',
        groupInfo: 'Z2k=',
        baseEpoch: 7,
      });
      expect(await service.getGroupInfo('g1', 'member-1')).toEqual({
        groupInfo: 'Z2k=',
        baseEpoch: 7,
      });
    });
  });
});
