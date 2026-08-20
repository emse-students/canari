/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MembersController } from './members.controller';
import { GroupMember } from '../entities/group-member.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';

/**
 * `GET /mls/users/:userId/groups` is the ONE place a client learns which groups exist: discovery,
 * lifecycle classification, sync eligibility, the sidebar, badges and `initializeConnection` are
 * all fed from this single answer. A community's Graine key-distribution group carries seeds and
 * never a message, so it is excluded HERE - which is what keeps it out of all of them at once, and
 * is why this endpoint has a test of its own.
 */
describe('MembersController.getUserGroups - the distribution group is not a conversation', () => {
  let controller: MembersController;
  let groupMemberRepo: { find: jest.Mock };
  let groupRepo: { find: jest.Mock };
  let warn: jest.SpyInstance;

  const ORDINARY = {
    id: 'g-ordinary',
    name: 'Amis',
    isGroup: true,
    imageMediaId: null,
    deletedAt: null,
    distributionWorkspaceId: null,
    updatedAt: new Date(2_000),
  };
  const DISTRIBUTION = {
    id: 'g-distribution',
    name: null,
    isGroup: true,
    imageMediaId: null,
    deletedAt: null,
    distributionWorkspaceId: 'w-1',
    updatedAt: new Date(3_000),
  };

  /**
   * A PRIVATE SALON'S distribution group, which is the same object under the other scope column.
   * The partition tested `distributionWorkspaceId` alone until 2026-08-20, so this one was hidden by
   * nothing at all - and this list is, by the audit's own invariant 2, the single place it could be.
   */
  const SALON_DISTRIBUTION = {
    id: 'g-salon-distribution',
    name: null,
    isGroup: true,
    imageMediaId: null,
    deletedAt: null,
    distributionWorkspaceId: null,
    distributionChannelId: 'c-1',
    updatedAt: new Date(4_000),
  };

  beforeEach(async () => {
    groupMemberRepo = { find: jest.fn() };
    groupRepo = { find: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MembersController],
      providers: [
        { provide: getRepositoryToken(GroupMember), useValue: groupMemberRepo },
        { provide: getRepositoryToken(UserDismissedGroup), useValue: {} },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: {} },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: DataSource, useValue: {} },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(MembersController);
    warn = jest.spyOn(controller['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(controller['logger'], 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('omits a distribution group from the conversation list', async () => {
    groupMemberRepo.find.mockResolvedValue([
      { groupId: 'g-ordinary', userId: 'u1' },
      { groupId: 'g-distribution', userId: 'u1' },
    ]);
    groupRepo.find.mockResolvedValue([ORDINARY, DISTRIBUTION]);

    const got = await controller.getUserGroups('u1', 'u1', undefined);

    expect(got.map((g) => g.groupId)).toEqual(['g-ordinary']);
  });

  it('omits the distribution group of a PRIVATE SALON too, which is the other scope', async () => {
    groupMemberRepo.find.mockResolvedValue([
      { groupId: 'g-ordinary', userId: 'u1' },
      { groupId: 'g-salon-distribution', userId: 'u1' },
    ]);
    groupRepo.find.mockResolvedValue([ORDINARY, SALON_DISTRIBUTION]);

    const got = await controller.getUserGroups('u1', 'u1', undefined);

    expect(got.map((g) => g.groupId)).toEqual(['g-ordinary']);
    // And it is REPORTED, for the same reason the community one is: a membership row on a group
    // joined by external commit means something wrote one, and hiding it would be all the notice
    // anybody ever got.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('g-salon-distribution'));
  });

  it('says out loud that a membership row existed on one, rather than only hiding it', async () => {
    groupMemberRepo.find.mockResolvedValue([{ groupId: 'g-distribution', userId: 'u1' }]);
    groupRepo.find.mockResolvedValue([DISTRIBUTION]);

    await controller.getUserGroups('u1', 'u1', undefined);

    // The exclusion working is not the same as nothing being wrong: the group is joined by
    // external commit and holds no membership rows, so one existing is the only warning there is.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('g-distribution'));
  });

  it('stays silent, and keeps its ordering, when no distribution group is involved', async () => {
    const older = { ...ORDINARY, id: 'g-older', updatedAt: new Date(1_000) };
    groupMemberRepo.find.mockResolvedValue([
      { groupId: 'g-older', userId: 'u1' },
      { groupId: 'g-ordinary', userId: 'u1' },
    ]);
    groupRepo.find.mockResolvedValue([older, ORDINARY]);

    const got = await controller.getUserGroups('u1', 'u1', undefined);

    expect(got.map((g) => g.groupId)).toEqual(['g-ordinary', 'g-older']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('still hides a deleted ordinary group, which is a different exclusion', async () => {
    groupMemberRepo.find.mockResolvedValue([{ groupId: 'g-ordinary', userId: 'u1' }]);
    groupRepo.find.mockResolvedValue([{ ...ORDINARY, deletedAt: new Date() }]);

    expect(await controller.getUserGroups('u1', 'u1', undefined)).toEqual([]);
    // A deletion is ordinary and expected; only the distribution case warns.
    expect(warn).not.toHaveBeenCalled();
  });
});
