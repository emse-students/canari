/// <reference types="jest" />

import { ForbiddenException } from '@nestjs/common';
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
 * `POST /mls/groups/:groupId/members` IS the enforcement point of a block.
 *
 * Hiding somebody from the user search stops nobody who already knows a uuid, and both paths a
 * block is meant to close - opening a 1-to-1 and pulling somebody into a group - end here. Without
 * a `GroupMember` row the target's devices never receive a pending membership, so no Welcome is
 * ever built for them: this is the refusal that makes a block mean anything at all.
 */
describe('MembersController.addGroupMember - a block refuses the add', () => {
  let controller: MembersController;
  let groupMemberRepo: { count: jest.Mock };
  let keyPackageRepo: { find: jest.Mock };
  let blockQuery: jest.Mock;
  let transaction: jest.Mock;

  const GROUP = 'g-1';
  const CALLER = 'alice';
  const TARGET = 'bob';

  beforeEach(async () => {
    // The caller is already a member, so the authorization guard passes and the block check is the
    // only thing that can refuse - which is what this suite is about.
    groupMemberRepo = { count: jest.fn().mockResolvedValue(1) };
    keyPackageRepo = { find: jest.fn().mockResolvedValue([]) };
    blockQuery = jest.fn().mockResolvedValue([]);
    transaction = jest.fn().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MembersController],
      providers: [
        { provide: getRepositoryToken(GroupMember), useValue: groupMemberRepo },
        { provide: getRepositoryToken(UserDismissedGroup), useValue: {} },
        { provide: getRepositoryToken(Group), useValue: {} },
        { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: 'REDIS_CLIENT', useValue: { sadd: jest.fn() } },
        { provide: DataSource, useValue: { manager: { query: blockQuery }, transaction } },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(MembersController);
    jest.spyOn(controller['logger'], 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('refuses with USER_BLOCKED and writes nothing', async () => {
    blockQuery.mockResolvedValue([{ '?column?': 1 }]);

    const err = await controller
      .addGroupMember(GROUP, { userId: TARGET }, CALLER, undefined)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'USER_BLOCKED' });
    // No membership row means no pending device membership, which means no Welcome. That chain is
    // the whole mechanism, so the assertion is that nothing at all was written.
    expect(transaction).not.toHaveBeenCalled();
  });

  it('says the person cannot be added, never who blocked whom', async () => {
    blockQuery.mockResolvedValue([{ '?column?': 1 }]);

    const err = (await controller
      .addGroupMember(GROUP, { userId: TARGET }, CALLER, undefined)
      .catch((e: unknown) => e)) as ForbiddenException;

    const message = JSON.stringify(err.getResponse());
    expect(message).toContain('cannot be added');
    expect(message).not.toContain(CALLER);
    expect(message).not.toContain(TARGET);
  });

  it('asks in BOTH directions, so the blocker cannot add the person they blocked either', async () => {
    blockQuery.mockResolvedValue([{ '?column?': 1 }]);

    await controller
      .addGroupMember(GROUP, { userId: TARGET }, CALLER, undefined)
      .catch(() => undefined);

    const sql = String(blockQuery.mock.calls[0][0]);
    expect(sql).toContain('"blockerId" = $1 AND "blockedId" = $2');
    expect(sql).toContain('"blockerId" = $2 AND "blockedId" = $1');
  });

  it('lets the add through when no block stands between the two', async () => {
    await expect(
      controller.addGroupMember(GROUP, { userId: TARGET }, CALLER, undefined)
    ).resolves.toEqual({ status: 'added' });
    expect(transaction).toHaveBeenCalled();
  });

  it('never refuses an account adding itself, which is the group-creation bootstrap', async () => {
    // `isBlockedBetween` short-circuits on a === b, so the creator registering itself into its own
    // empty group cannot be refused by a block row that could not exist in the first place.
    await expect(
      controller.addGroupMember(GROUP, { userId: CALLER }, CALLER, undefined)
    ).resolves.toEqual({ status: 'added' });
    expect(blockQuery).not.toHaveBeenCalled();
  });
});
