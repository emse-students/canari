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
 * A KICK IS THE ONLY THING THAT CAN WRITE `kickedAt`, AND IF IT DOES NOT, A WHOLE REPORT IS EMPTY.
 *
 * `reportStrandedDeviceMemberships` names devices holding a group seat with no Welcome behind it,
 * and since 2026-09-04 it splits that population in two: a device `addMembersBulk` SKIPPED, which
 * was never in the MLS tree, and a device whose stale leaf a member REMOVED and whose re-add then
 * threw, which was. The second is the one nothing else reports - the Add fails on the answering
 * device, a phone, and the failure is swallowed there.
 *
 * `kickedAt` is the whole discriminator, so these cases pin the writes rather than the reading. A
 * kick that forgot to stamp the row is not a visible bug: the report simply counts zero for ever
 * and reads as health, which is the exact failure mode this repository refuses elsewhere. Same for
 * the clearing: leave it set and every SUCCESSFUL kick-and-re-add is reported as a failed one.
 */
describe('InvitationsController - the kick marker', () => {
  let controller: InvitationsController;
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

  const CALLER = 'user-caller';
  const TARGET = 'user-target';
  const GROUP = 'group-1';
  const DEVICE = 'web-target-1';

  const membership = (overrides: Record<string, unknown> = {}) => ({
    id: 'm-1',
    userId: TARGET,
    deviceId: DEVICE,
    groupId: GROUP,
    status: 'active' as 'active' | 'pending',
    kickedAt: null as Date | null,
    ...overrides,
  });

  /** What `save` was actually handed - the assertion subject of every case here. */
  const saved = () => deviceGroupRepo.save.mock.calls[0][0];

  beforeEach(async () => {
    jest.clearAllMocks();
    // The caller is a member of the group, which every kick endpoint asserts first.
    groupMemberRepo.findOne.mockResolvedValue({ userId: CALLER, groupId: GROUP });
    redis.srem.mockResolvedValue(1);
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
          // Promoting to `active` is gated on the device still being addressable (WP-GHOST-1);
          // every case here is about the marker, so that gate is open.
          useValue: { deviceAddressability: jest.fn().mockResolvedValue({ ok: true }) },
        },
      ],
    }).compile();

    controller = module.get(InvitationsController);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => log.mockRestore());

  it('stamps the row when one device is kicked', async () => {
    deviceGroupRepo.findOne.mockResolvedValue(membership());

    const before = Date.now();
    await controller.kickStaleDevice(
      { deviceId: DEVICE, userId: TARGET, groupId: GROUP },
      CALLER,
      'false'
    );

    expect(saved().status).toBe('pending');
    expect(saved().kickedAt).toBeInstanceOf(Date);
    expect((saved().kickedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('stamps every device of a user with ONE instant, because one Remove reset them all', async () => {
    deviceGroupRepo.find.mockResolvedValue([
      membership({ id: 'm-1', deviceId: 'web-1' }),
      membership({ id: 'm-2', deviceId: 'web-2' }),
      membership({ id: 'm-3', deviceId: 'tauri-3' }),
    ]);

    await controller.kickStaleUser({ userId: TARGET, groupId: GROUP }, CALLER, 'false');

    const rows = saved() as Array<{ status: string; kickedAt: Date }>;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(new Set(rows.map((r) => r.kickedAt.getTime())).size).toBe(1);
  });

  it('clears the marker when a device reports itself ACTIVE - the Welcome was processed', async () => {
    deviceGroupRepo.findOne.mockResolvedValue(
      membership({ status: 'pending', kickedAt: new Date('2026-09-01T10:18:38Z') })
    );

    await controller.updateInvitationStatus(
      { deviceId: DEVICE, userId: TARGET, groupId: GROUP, status: 'active' },
      TARGET,
      'false'
    );

    expect(saved().status).toBe('active');
    expect(saved().kickedAt).toBeNull();
  });

  it('a DEMOTION does not clear it: cleanup promises no Add', async () => {
    // `updateInvitationStatus` documents the demotion as a step towards cleanup. A row demoted
    // after a kick is still a row a kick left behind, and forgetting that would lose the only
    // record that an Add was ever owed.
    const kickedAt = new Date('2026-09-01T10:18:38Z');
    deviceGroupRepo.findOne.mockResolvedValue(membership({ status: 'active', kickedAt }));

    await controller.updateInvitationStatus(
      { deviceId: DEVICE, userId: TARGET, groupId: GROUP, status: 'pending' },
      TARGET,
      'false'
    );

    expect(saved().status).toBe('pending');
    expect(saved().kickedAt).toBe(kickedAt);
  });

  it('writes nothing at all when there is no row to kick', async () => {
    deviceGroupRepo.findOne.mockResolvedValue(null);

    const answer = await controller.kickStaleDevice(
      { deviceId: DEVICE, userId: TARGET, groupId: GROUP },
      CALLER,
      'false'
    );

    expect(answer).toEqual({ status: 'not_found', affected: 0 });
    expect(deviceGroupRepo.save).not.toHaveBeenCalled();
  });
});
