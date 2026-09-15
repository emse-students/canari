/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { InvitationsController } from './invitations.controller';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { GroupInvite } from '../entities/group-invite.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { MessagingService } from '../services/messaging.service';

/**
 * TWO CALLERS SAY `active` THROUGH THIS DOOR AND THEY ARE NOT MAKING THE SAME CLAIM.
 *
 * A device reporting on ITSELF has processed its Welcome: it is saying it can decrypt from this
 * moment on, and that moment is what `redeliverMissed` (DF2) needs - the pending window it names
 * is a window the device can now open, so replaying it turns into the notifications it missed.
 *
 * A group member VOUCHING for another user's device says something strictly weaker: it read the
 * shared MLS tree and the leaf is there. That retires the invitation, which is the whole question
 * the column answers - nobody owes this device an Add. It fixes NO moment. These rows are old by
 * the time anyone looks: production held 104 pending rows on 2026-09-15, 98 of them older than a
 * day and 19 of them thirteen days old. Replaying thirteen days at a device that may not have
 * opened the group yet is up to 50 undecryptable frames and as many generic pushes, which is the
 * hazard `redeliverMissed: false` exists for.
 *
 * So the flag is the discriminator, and it is carried from where the answer is already KNOWN -
 * the authorization branch a few lines above already had to decide self-report from vouch.
 */
describe('InvitationsController - a vouch is not a self-report', () => {
  let controller: InvitationsController;
  let messaging: { activateDeviceMembership: jest.Mock; deactivateDeviceMembership: jest.Mock };
  let log: jest.SpyInstance;

  const deviceGroupRepo = { findOne: jest.fn(), find: jest.fn(), save: jest.fn() };
  const groupMemberRepo = { findOne: jest.fn() };
  const redis = { srem: jest.fn(), mget: jest.fn() };

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(),
    query: jest.fn(),
    createQueryBuilder: jest.fn(),
    metadata: { tableName: 'stub' },
  });

  const MEMBER = 'user-member';
  const TARGET = 'user-target';
  const GROUP = 'group-1';
  const DEVICE = 'web-target-1';

  /** The options object handed to the ONE writer - the assertion subject of every case here. */
  const promotion = () =>
    messaging.activateDeviceMembership.mock.calls[0][3] as {
      redeliverMissed?: boolean;
      tag: string;
    };

  beforeEach(async () => {
    jest.clearAllMocks();
    // The voucher is an active member of the group, which the non-self branch asserts first.
    groupMemberRepo.findOne.mockResolvedValue({ userId: MEMBER, groupId: GROUP });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [InvitationsController],
      providers: [
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        { provide: getRepositoryToken(GroupMember), useValue: groupMemberRepo },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupInvite), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
        {
          provide: MessagingService,
          useValue: {
            deviceAddressability: jest.fn().mockResolvedValue({ ok: true }),
            activateDeviceMembership: jest.fn().mockResolvedValue({ ok: true }),
            deactivateDeviceMembership: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    controller = module.get(InvitationsController);
    messaging = module.get(MessagingService);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => log.mockRestore());

  it('replays the pending window for a device reporting on ITSELF', async () => {
    await controller.updateInvitationStatus(
      { deviceId: DEVICE, userId: TARGET, groupId: GROUP, status: 'active' },
      TARGET,
      'false'
    );

    expect(promotion().redeliverMissed).toBe(true);
  });

  it('does NOT replay when another member vouches for the device', async () => {
    await controller.updateInvitationStatus(
      { deviceId: DEVICE, userId: TARGET, groupId: GROUP, status: 'active' },
      MEMBER,
      'false'
    );

    expect(promotion().redeliverMissed).toBe(false);
    // The vouch still retires the invitation - that is the point of allowing it at all.
    expect(messaging.activateDeviceMembership).toHaveBeenCalledWith(
      TARGET,
      DEVICE,
      GROUP,
      expect.objectContaining({ tag: 'INVITATION_STATUS' })
    );
  });

  it('a vouch from a NON-member is refused before anything is written', async () => {
    groupMemberRepo.findOne.mockResolvedValue(null);

    await expect(
      controller.updateInvitationStatus(
        { deviceId: DEVICE, userId: TARGET, groupId: GROUP, status: 'active' },
        'user-stranger',
        'false'
      )
    ).rejects.toThrow('Not a member of this group');

    expect(messaging.activateDeviceMembership).not.toHaveBeenCalled();
  });

  // An admin is not the device either, whatever else it is allowed to do.
  it('does NOT replay for a global admin acting on someone else s device', async () => {
    await controller.updateInvitationStatus(
      { deviceId: DEVICE, userId: TARGET, groupId: GROUP, status: 'active' },
      'user-admin',
      'true'
    );

    expect(promotion().redeliverMissed).toBe(false);
  });
});
