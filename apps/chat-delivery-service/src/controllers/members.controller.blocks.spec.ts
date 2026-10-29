/// <reference types="jest" />

import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MembersController } from './members.controller';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import { GroupMember } from '../entities/group-member.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { RevokedDeviceGroup } from '../entities/revoked-device-group.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { writePendingSeats } from '../utils/group-membership';

// The admitted-person path writes device seats under the seat lock; what it decides is pinned against
// Postgres (`add-enrolment.integration.spec.ts`). Here only WHETHER it is reached matters.
jest.mock('../utils/group-membership', () => ({
  ...jest.requireActual('../utils/group-membership'),
  writePendingSeats: jest.fn(),
}));

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
  let groupMemberRepo: { count: jest.Mock; findOne: jest.Mock };
  let keyPackageRepo: { find: jest.Mock };
  let blockQuery: jest.Mock;
  let transaction: jest.Mock;
  let groupRepo: { findOne: jest.Mock };

  const GROUP = 'g-1';
  const CALLER = 'alice';
  const TARGET = 'bob';

  beforeEach(async () => {
    // The caller is already a member, so the authorization guard passes and the block check is the
    // only thing that can refuse - which is what this suite is about.
    groupMemberRepo = {
      count: jest.fn().mockResolvedValue(1),
      findOne: jest.fn().mockResolvedValue({ id: 'seat', awaitingAdmission: false }),
    };
    keyPackageRepo = { find: jest.fn().mockResolvedValue([]) };
    blockQuery = jest.fn().mockResolvedValue([]);
    transaction = jest.fn().mockResolvedValue(undefined);
    groupRepo = { findOne: jest.fn().mockResolvedValue({ id: GROUP }) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MembersController],
      providers: [
        { provide: getRepositoryToken(GroupMember), useValue: groupMemberRepo },
        { provide: getRepositoryToken(UserDismissedGroup), useValue: {} },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: getRepositoryToken(QueuedMessage), useValue: {} },
        { provide: getRepositoryToken(RevokedDevice), useValue: {} },
        { provide: getRepositoryToken(RevokedDeviceGroup), useValue: {} },
        {
          provide: getRepositoryToken(MlsGroupInfo),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: 'REDIS_CLIENT', useValue: { sadd: jest.fn() } },
        { provide: DataSource, useValue: { manager: { query: blockQuery }, transaction } },
      ],
    })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(MembersController);
    jest.spyOn(controller['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(controller['logger'], 'warn').mockImplementation(() => undefined);
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
    // Through to the admitted-person path: device seats written, nobody enrolled (ADM-3).
    jest.mocked(writePendingSeats).mockResolvedValue('written');
    await expect(
      controller.addGroupMember(GROUP, { userId: TARGET }, CALLER, undefined)
    ).resolves.toEqual({ status: 'added' });
    expect(writePendingSeats).toHaveBeenCalledWith(expect.anything(), GROUP, TARGET, [], false, {
      requireAdmitted: true,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('never refuses an account adding itself, which is the group-creation bootstrap', async () => {
    // `isBlockedBetween` short-circuits on a === b, so the creator registering itself into its own
    // empty group cannot be refused by a block row that could not exist in the first place.
    groupMemberRepo.count.mockResolvedValue(0);
    jest.mocked(writePendingSeats).mockResolvedValue('written');
    await expect(
      controller.addGroupMember(GROUP, { userId: CALLER }, CALLER, undefined)
    ).resolves.toEqual({ status: 'added' });
    expect(blockQuery).not.toHaveBeenCalled();
    // The one enrolment this route still writes: the creator, into its empty roster - through the
    // one pending-seat writer, under the seat lock and beside each device's key package.
    expect(writePendingSeats).toHaveBeenCalledWith(expect.anything(), GROUP, CALLER, [], 'creator');
    expect(transaction).not.toHaveBeenCalled();
  });

  it("answers 410 when the creator's group ended before its enrolment, and enrols nobody", async () => {
    groupMemberRepo.count.mockResolvedValue(0);
    jest.mocked(writePendingSeats).mockResolvedValue('group_gone');

    await expect(
      controller.addGroupMember(GROUP, { userId: CALLER }, CALLER, undefined)
    ).rejects.toMatchObject({ response: { error: 'group_deleted' } });
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['community', { distributionWorkspaceId: 'ws-1' }],
    ['private salon', { distributionChannelId: 'ch-1' }],
  ])(
    'refuses a self-join into a %s key-distribution group, which holds no member row to bootstrap past',
    async (_scope, flag) => {
      // The shape of the escalation: a non-member, an empty `dm_group_members`, adding itself.
      groupMemberRepo.count.mockResolvedValue(0);
      groupMemberRepo.findOne.mockResolvedValue(null);
      groupRepo.findOne.mockResolvedValue({ id: GROUP, ...flag });

      const err = await controller
        .addGroupMember(GROUP, { userId: CALLER }, CALLER, undefined)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: 'KEY_DISTRIBUTION_GROUP',
      });
      expect(transaction).not.toHaveBeenCalled();
    }
  );
});
