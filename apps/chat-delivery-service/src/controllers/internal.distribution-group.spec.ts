/// <reference types="jest" />

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { InternalController } from './internal.controller';
import { PushToken } from '../entities/push-token.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { Group } from '../entities/group.entity';
import { GroupMember } from '../entities/group-member.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { PinVerifier } from '../entities/pin-verifier.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { GroupInvite } from '../entities/group-invite.entity';
import { MessagingService } from '../services/messaging.service';

/**
 * The four internal routes a community's Graine key-distribution group is handled through.
 *
 * What is being protected here is not the happy path but two invariants the WP-20 enumeration audit
 * rests on: creating one writes NO `dm_group_members` and NO `DeviceGroupMembership` row. Every
 * conclusion in that audit - that account deletion, device registration and the sidebar can never
 * reach a distribution group - is void the day this stops holding, and nothing else would notice.
 */
describe('InternalController - the community distribution group', () => {
  const SECRET = 'internal-secret-for-tests';
  const WORKSPACE = 'ws-1';

  let controller: InternalController;
  let groupRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let groupMemberRepo: { save: jest.Mock };
  let deviceGroupRepo: { save: jest.Mock; upsert: jest.Mock };
  let messagingService: { readGroupInfo: jest.Mock; putGroupInfo: jest.Mock };
  let previousSecret: string | undefined;

  beforeEach(async () => {
    previousSecret = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = SECRET;

    groupRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: Record<string, unknown>) => Promise.resolve({ ...x, id: 'g-new' })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    groupMemberRepo = { save: jest.fn() };
    deviceGroupRepo = { save: jest.fn(), upsert: jest.fn() };
    messagingService = {
      readGroupInfo: jest.fn().mockResolvedValue(null),
      putGroupInfo: jest.fn().mockResolvedValue({ stored: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InternalController],
      providers: [
        { provide: getRepositoryToken(PushToken), useValue: {} },
        { provide: getRepositoryToken(KeyPackage), useValue: {} },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: {} },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(GroupMember), useValue: groupMemberRepo },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        { provide: getRepositoryToken(QueuedMessage), useValue: {} },
        { provide: getRepositoryToken(PinVerifier), useValue: {} },
        { provide: getRepositoryToken(RevokedDevice), useValue: {} },
        { provide: getRepositoryToken(GroupInvite), useValue: {} },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: MessagingService, useValue: messagingService },
      ],
    }).compile();

    controller = module.get(InternalController);
    jest.spyOn(controller['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(controller['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(controller['logger'], 'error').mockImplementation(() => undefined);
    // The secret is read into a field at construction, so it has to be set before the module is
    // built; re-assert it here so a later mutation cannot silently disarm the guard tests.
    Object.defineProperty(controller, 'secret', { value: SECRET, writable: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previousSecret;
  });

  describe('creation', () => {
    it('creates the group and writes NEITHER a membership row NOR a device membership', async () => {
      const got = await controller.createDistributionGroup(SECRET, { workspaceId: WORKSPACE });

      expect(got).toEqual({ groupId: 'g-new', created: true });
      expect(groupRepo.create).toHaveBeenCalledWith({
        isGroup: true,
        distributionWorkspaceId: WORKSPACE,
      });
      // The two absences the WP-20 audit is built on. Asserted as absences because nothing else
      // in the system would ever complain about their presence.
      expect(groupMemberRepo.save).not.toHaveBeenCalled();
      expect(deviceGroupRepo.save).not.toHaveBeenCalled();
      expect(deviceGroupRepo.upsert).not.toHaveBeenCalled();
    });

    it('returns the existing group rather than a second one', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'g-existing' });

      const got = await controller.createDistributionGroup(SECRET, { workspaceId: WORKSPACE });

      expect(got).toEqual({ groupId: 'g-existing', created: false });
      expect(groupRepo.save).not.toHaveBeenCalled();
    });

    it('re-reads the winner when the unique index rejects a concurrent insert', async () => {
      groupRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'g-winner' });
      groupRepo.save.mockRejectedValue(new Error('duplicate key value violates unique constraint'));

      const got = await controller.createDistributionGroup(SECRET, { workspaceId: WORKSPACE });

      // The caller asked for "the distribution group of this community" and there is exactly one:
      // a conflict it cannot act on would be a worse answer than the winner's id.
      expect(got).toEqual({ groupId: 'g-winner', created: false });
    });

    it('propagates a failure that is not the race, instead of inventing an id', async () => {
      groupRepo.save.mockRejectedValue(new Error('connection terminated'));

      await expect(
        controller.createDistributionGroup(SECRET, { workspaceId: WORKSPACE })
      ).rejects.toThrow('connection terminated');
    });

    it('refuses a call without the internal secret', async () => {
      await expect(
        controller.createDistributionGroup('wrong', { workspaceId: WORKSPACE })
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(groupRepo.save).not.toHaveBeenCalled();
    });

    it('refuses a call with no community', async () => {
      await expect(
        controller.createDistributionGroup(SECRET, { workspaceId: '  ' })
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('reading', () => {
    it('reports a group with nothing published as a group, not as an absence', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'g-1' });

      const got = await controller.getDistributionGroup(WORKSPACE, SECRET);

      // The distinction the caller acts on: this community has a group and is waiting for its
      // first member to initialise the MLS state, which is not the same as having no group at all.
      expect(got).toEqual({ groupId: 'g-1', groupInfo: null, baseEpoch: null });
    });

    it('returns the published GroupInfo when there is one', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'g-1' });
      messagingService.readGroupInfo.mockResolvedValue({ groupInfo: 'Z2k=', baseEpoch: 4 });

      expect(await controller.getDistributionGroup(WORKSPACE, SECRET)).toEqual({
        groupId: 'g-1',
        groupInfo: 'Z2k=',
        baseEpoch: 4,
      });
    });

    it('answers null for a community that has no group', async () => {
      expect(await controller.getDistributionGroup(WORKSPACE, SECRET)).toBeNull();
    });

    it('refuses a call without the internal secret', async () => {
      await expect(controller.getDistributionGroup(WORKSPACE, 'wrong')).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });
  });

  describe('publishing group info', () => {
    it('routes to the same monotonic upsert the public route uses', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'g-1' });

      const got = await controller.publishDistributionGroupInfo(WORKSPACE, SECRET, {
        groupInfo: 'Z2k=',
        baseEpoch: 7,
      });

      expect(got).toEqual({ stored: true });
      expect(messagingService.putGroupInfo).toHaveBeenCalledWith('g-1', 'Z2k=', 7);
    });

    it('refuses a body missing either field', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'g-1' });

      await expect(
        controller.publishDistributionGroupInfo(WORKSPACE, SECRET, { groupInfo: 'Z2k=' })
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        controller.publishDistributionGroupInfo(WORKSPACE, SECRET, { baseEpoch: 1 })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(messagingService.putGroupInfo).not.toHaveBeenCalled();
    });

    it('refuses to publish for a community with no group', async () => {
      await expect(
        controller.publishDistributionGroupInfo(WORKSPACE, SECRET, {
          groupInfo: 'Z2k=',
          baseEpoch: 1,
        })
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('deletion', () => {
    it('tombstones the group the same way every other group dies', async () => {
      groupRepo.findOne.mockResolvedValue({ id: 'g-1' });

      expect(await controller.deleteDistributionGroup(WORKSPACE, SECRET)).toEqual({
        deleted: true,
      });
      expect(groupRepo.update).toHaveBeenCalledWith({ id: 'g-1' }, { deletedAt: expect.any(Date) });
    });

    it('reports nothing to delete rather than failing', async () => {
      expect(await controller.deleteDistributionGroup(WORKSPACE, SECRET)).toEqual({
        deleted: false,
      });
      expect(groupRepo.update).not.toHaveBeenCalled();
    });

    it('refuses a call without the internal secret', async () => {
      await expect(controller.deleteDistributionGroup(WORKSPACE, 'wrong')).rejects.toBeInstanceOf(
        ForbiddenException
      );
      expect(groupRepo.update).not.toHaveBeenCalled();
    });
  });
});
