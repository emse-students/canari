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

describe('MessagingService - group-info (external-join base)', () => {
  let service: MessagingService;

  const groupMemberRepo = { findOne: jest.fn() };
  /**
   * ONE `execute` for both builders, because the fixture below merges them into a single object and
   * a spread keeps exactly one of any duplicated key.
   *
   * It used to be two, and the insert one was therefore dead - shadowed by the update one, never
   * called, so `expect(insertBuilder.execute).not.toHaveBeenCalled()` was vacuously true and the
   * insert's return value could not be varied at all. Shared, both assertions mean something.
   *
   * `raw` holding a row is `ON CONFLICT DO NOTHING` having inserted; `raw: []` is the conflict, and
   * that is the only signal separating the winner of a first-publish race from the loser.
   */
  const execute = jest.fn();
  const updateBuilder = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute,
  };
  const insertBuilder = {
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    execute,
  };
  const groupInfoRepo = {
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
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
    // Re-armed AFTER the clear, which drops the implementation set at definition time. The default
    // is winning the race; the test that cares about losing it says so.
    execute.mockResolvedValue({ raw: [{ groupId: 'g1' }] });
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
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
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

    it('reports a LOST insert race as not stored, rather than assuming it won', async () => {
      groupMemberRepo.findOne.mockResolvedValue({ id: 'm' });
      groupInfoRepo.findOne.mockResolvedValue(null);
      execute.mockResolvedValueOnce({ raw: [] });

      // Two clients finding a community's distribution group uninitialised both publish at epoch 0,
      // and epoch 0 does not beat epoch 0 - so the monotonic rule cannot separate them. Who won the
      // insert can, and the loser discards its group and joins the winner's. It only can if told.
      expect(await service.storeGroupInfo('g1', 'member-1', 'Z2k=', 0)).toEqual({ stored: false });
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
