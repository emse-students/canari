/// <reference types="jest" />

import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GROUP_ROSTERS_MAX_GROUPS, MembersController } from './members.controller';
import { GroupMember } from '../entities/group-member.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';

/**
 * `POST /mls/group-rosters` answers in ONE request what `GET /mls/groups/:id/user-members` answers
 * per group, and it must answer it under the SAME authorization: a roster is group metadata that
 * leaks the social graph, so a group the caller is not in is refused - by name, in the answer, and
 * never by failing the groups it IS in.
 */
describe('MembersController.getGroupRosters - many rosters, one read, the same refusal per group', () => {
  let controller: MembersController;
  let groupMemberRepo: { find: jest.Mock };

  const ROWS = [
    { groupId: 'g-a', userId: 'alice' },
    { groupId: 'g-a', userId: 'bob' },
    { groupId: 'g-b', userId: 'alice' },
    { groupId: 'g-b', userId: 'carol' },
    { groupId: 'g-other', userId: 'dave' },
  ];

  beforeEach(async () => {
    groupMemberRepo = { find: jest.fn().mockResolvedValue(ROWS) };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MembersController],
      providers: [
        { provide: getRepositoryToken(GroupMember), useValue: groupMemberRepo },
        { provide: getRepositoryToken(UserDismissedGroup), useValue: {} },
        { provide: getRepositoryToken(Group), useValue: {} },
        { provide: getRepositoryToken(KeyPackage), useValue: {} },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: getRepositoryToken(QueuedMessage), useValue: {} },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: {} },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: DataSource, useValue: {} },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(MembersController);
    jest.spyOn(controller['logger'], 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('answers every group the caller is in from ONE query', async () => {
    const got = await controller.getGroupRosters({ groupIds: ['g-a', 'g-b'] }, 'alice', undefined);

    expect(got.rosters).toEqual({ 'g-a': ['alice', 'bob'], 'g-b': ['alice', 'carol'] });
    expect(got.refused).toEqual([]);
    expect(groupMemberRepo.find).toHaveBeenCalledTimes(1);
  });

  it('refuses, by name, a group the caller is not in - and still answers the others', async () => {
    const got = await controller.getGroupRosters(
      { groupIds: ['g-a', 'g-other', 'g-missing'] },
      'alice',
      undefined
    );

    // The single read's 403, per group. A group that does not exist reads exactly like one the
    // caller is not in, as it does on the single read (no row, so no membership).
    expect(got.rosters).toEqual({ 'g-a': ['alice', 'bob'] });
    expect(got.refused).toEqual(['g-other', 'g-missing']);
    expect(JSON.stringify(got)).not.toContain('dave');
  });

  it('lets a global admin read any roster, as the single read does', async () => {
    const got = await controller.getGroupRosters({ groupIds: ['g-other'] }, 'alice', 'true');

    expect(got.rosters).toEqual({ 'g-other': ['dave'] });
    expect(got.refused).toEqual([]);
  });

  it('asks once per distinct group however often it is named', async () => {
    await controller.getGroupRosters({ groupIds: ['g-a', 'g-a'] }, 'alice', undefined);

    const where = groupMemberRepo.find.mock.calls[0][0].where;
    expect(where.groupId.value).toEqual(['g-a']);
  });

  it('answers an empty request without touching the database', async () => {
    expect(await controller.getGroupRosters({ groupIds: [] }, 'alice', undefined)).toEqual({
      rosters: {},
      refused: [],
    });
    expect(groupMemberRepo.find).not.toHaveBeenCalled();
  });

  it('refuses a body that is not a list, a malformed id, and more than the cap', async () => {
    await expect(controller.getGroupRosters({}, 'alice', undefined)).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(
      controller.getGroupRosters({ groupIds: ['g a/../x'] }, 'alice', undefined)
    ).rejects.toBeInstanceOf(BadRequestException);
    const tooMany = Array.from({ length: GROUP_ROSTERS_MAX_GROUPS + 1 }, (_, i) => `g-${i}`);
    await expect(
      controller.getGroupRosters({ groupIds: tooMany }, 'alice', undefined)
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(groupMemberRepo.find).not.toHaveBeenCalled();
  });
});
