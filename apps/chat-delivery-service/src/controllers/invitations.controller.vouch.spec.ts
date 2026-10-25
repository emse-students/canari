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
 * TWO CALLERS SAY `active` THROUGH THIS DOOR: a device reporting on ITSELF, and a group member
 * VOUCHING for another user's device because it read the shared MLS tree and the leaf is there.
 * Both retire the invitation through the ONE writer, and a non-member may do neither.
 *
 * They used to differ on one flag: only a self-report replayed the pending window (DF2), because
 * only it fixes a moment the device could decrypt from. DF2 is deleted (user, 2026-09-28) - an
 * admitted device is queued at send time from its admitting commit's epoch - so the two now make
 * the same call, and this file asserts that neither passes anything but its tag.
 */
describe('InvitationsController - who may report a device active', () => {
  let controller: InvitationsController;
  let messaging: { activateDeviceMembership: jest.Mock; deactivateDeviceMembership: jest.Mock };
  let log: jest.SpyInstance;

  type Row = Record<string, unknown>;
  /** Every key of `where` must match, so a lookup on the wrong columns finds nothing. */
  const hit = (rows: Row[], where: Row): Row | null =>
    rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null;
  let seats: Row[];
  let roster: Row[];
  let group: Row | null;
  const deviceGroupRepo = {
    findOne: jest.fn(async ({ where }: { where: Row }) => hit(seats, where)),
    find: jest.fn(),
    save: jest.fn(),
  };
  const groupMemberRepo = {
    findOne: jest.fn(async ({ where }: { where: Row }) => hit(roster, where)),
  };
  const groupRepo = {
    ...emptyRepo(),
    findOne: jest.fn(async ({ where }: { where: Row }) =>
      group && group.id === where.id ? group : null
    ),
  };
  const redis = { srem: jest.fn(), mget: jest.fn() };

  function emptyRepo() {
    return {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
      create: jest.fn(),
      query: jest.fn(),
      createQueryBuilder: jest.fn(),
      metadata: { tableName: 'stub' },
    };
  }

  const MEMBER = 'user-member';
  const TARGET = 'user-target';
  const GROUP = 'group-1';
  const DEVICE = 'web-target-1';

  /** The options object handed to the ONE writer - the assertion subject of every case here. */
  const promotion = () =>
    messaging.activateDeviceMembership.mock.calls[0][3] as Record<string, unknown>;

  beforeEach(async () => {
    jest.clearAllMocks();
    // The voucher and the target are on the conversation's roster, and the target's device holds a
    // `pending` seat - the row its admitting commit wrote.
    group = { id: GROUP };
    roster = [
      { userId: MEMBER, groupId: GROUP },
      { userId: TARGET, groupId: GROUP },
    ];
    seats = [{ userId: TARGET, deviceId: DEVICE, groupId: GROUP, status: 'pending' }];
    const module: TestingModule = await Test.createTestingModule({
      controllers: [InvitationsController],
      providers: [
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        { provide: getRepositoryToken(GroupMember), useValue: groupMemberRepo },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
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
            deactivateDeviceMembership: jest.fn().mockResolvedValue(true),
          },
        },
      ],
    }).compile();

    controller = module.get(InvitationsController);
    messaging = module.get(MessagingService);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => log.mockRestore());

  it('promotes a device reporting on ITSELF through the one writer', async () => {
    await controller.updateInvitationStatus(
      { deviceId: DEVICE, userId: TARGET, groupId: GROUP, status: 'active' },
      TARGET,
      'false'
    );

    expect(promotion()).toEqual({ tag: 'INVITATION_STATUS', authority: 'report' });
  });

  it('promotes the same way when another member vouches for the device', async () => {
    await controller.updateInvitationStatus(
      { deviceId: DEVICE, userId: TARGET, groupId: GROUP, status: 'active' },
      MEMBER,
      'false'
    );

    expect(promotion()).toEqual({ tag: 'INVITATION_STATUS', authority: 'report' });
    // The vouch still retires the invitation - that is the point of allowing it at all.
    expect(messaging.activateDeviceMembership).toHaveBeenCalledWith(
      TARGET,
      DEVICE,
      GROUP,
      expect.objectContaining({ tag: 'INVITATION_STATUS' })
    );
  });

  it('a vouch from a NON-member is refused before anything is written', async () => {
    roster = roster.filter((r) => r.userId !== MEMBER);

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
  it('promotes the same way for a global admin acting on someone else s device', async () => {
    await controller.updateInvitationStatus(
      { deviceId: DEVICE, userId: TARGET, groupId: GROUP, status: 'active' },
      'user-admin',
      'true'
    );

    expect(promotion()).toEqual({ tag: 'INVITATION_STATUS', authority: 'report' });
  });

  /**
   * A REPORT PROMOTES A SEAT AND NEVER CREATES ONE - decided in the one writer
   * (`messaging.one-active-writer.spec.ts`), so this door's part is to ask as a `report` and to say
   * the writer's answer: a missing seat is the caller not being a member.
   */
  describe('the answer to a refused report', () => {
    const report = (caller = TARGET) =>
      controller.updateInvitationStatus(
        { deviceId: DEVICE, userId: TARGET, groupId: GROUP, status: 'active' },
        caller,
        'false'
      );

    it.each(['no_seat', 'kicked', 'not_on_roster'])(
      'is a 403 NOT_A_MEMBER when the writer refuses for %s',
      async (reason) => {
        messaging.activateDeviceMembership.mockResolvedValue({ ok: false, reason });

        await expect(report()).rejects.toMatchObject({
          status: 403,
          response: { code: 'NOT_A_MEMBER', reason },
        });
      }
    );

    it('is a 403 for a member vouching for a device that holds no seat', async () => {
      messaging.activateDeviceMembership.mockResolvedValue({ ok: false, reason: 'no_seat' });

      await expect(report(MEMBER)).rejects.toMatchObject({ status: 403 });
    });

    it('stays a 400 when the device is not addressable', async () => {
      messaging.activateDeviceMembership.mockResolvedValue({ ok: false, reason: 'revoked' });

      await expect(report()).rejects.toMatchObject({ status: 400 });
    });
  });
});
