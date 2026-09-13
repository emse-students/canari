/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { GroupsController } from '../controllers/groups.controller';
import { InvitationsController } from '../controllers/invitations.controller';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { QueuedMessage } from '../entities/queued-message.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { GroupInvite } from '../entities/group-invite.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';

/**
 * ONE WRITER FOR `pending -> active`, ASSERTED AS ONE WRITER AND AS THREE DOORS.
 *
 * The entity docblock has said, in bold, that `activateDeviceMembership` is the only thing that
 * writes `active` and the only writer of the Redis routing set. It was not true. Three paths made
 * that transition and agreed on nothing:
 *
 * | Path | Addressability gate | Redis routing set | `kickedAt` | Missed-message replay |
 * | --- | --- | --- | --- | --- |
 * | `activateDeviceMembership` | warn and return | written | cleared | yes |
 * | `updateInvitationStatus` | THROW | **never written** | cleared | **no** |
 * | `createGroup` | **none at all** | written | left unset | n/a |
 *
 * The middle row is the one that cost something. A device that processed its Welcome in the
 * FOREGROUND got a truthful `active` row and was never added to `group:members:{groupId}`, so the
 * gateway could not reach it and could not elect it to answer a `welcome_request` or a
 * `history_request` - silently, because an INCOMPLETE routing set is not an empty one and the
 * reload at each election door only fires on an EMPTY set.
 *
 * The third row is WP-GHOST-1 with no gate at all, plus the 2026-08-27 placeholder defect: group
 * creation stored whatever identity it was handed, including the client's unresolved-identity
 * placeholder that the status endpoint was hardened against.
 *
 * **The decomposition, deliberately.** The one writer's OWN behaviour is asserted against a real
 * `MessagingService`; each door is asserted to DELEGATE to it. That is the fusion's actual claim -
 * "there is one implementation and every door reaches it" - and asserting the routing-set write
 * again at each door would re-pin the duplication this deletes.
 */
describe('the ONE writer of an active membership', () => {
  let service: MessagingService;
  let warn: jest.SpyInstance;

  const redis = {
    sadd: jest.fn().mockResolvedValue(1),
    xrange: jest.fn().mockResolvedValue([]),
    publish: jest.fn().mockResolvedValue(1),
  };
  const revokedDeviceRepo = { findOne: jest.fn().mockResolvedValue(null) };
  const keyPackageRepo = { findOne: jest.fn().mockResolvedValue({ id: 'kp-1' }) };
  const deviceGroupRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockResolvedValue([]),
  };

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    revokedDeviceRepo.findOne.mockResolvedValue(null);
    keyPackageRepo.findOne.mockResolvedValue({ id: 'kp-1' });
    deviceGroupRepo.findOne.mockResolvedValue(null);
    redis.xrange.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: revokedDeviceRepo },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();

    service = module.get(MessagingService);
    const logger = (service as unknown as { logger: { warn: (m: string) => void } }).logger;
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    jest
      .spyOn(logger as unknown as { log: (m: string) => void }, 'log')
      .mockImplementation(() => {});
  });

  it('writes the row AND the routing set - the two facts a reachable device needs', async () => {
    const outcome = await service.activateDeviceMembership('u1', 'd1', 'g1');

    expect(outcome.ok).toBe(true);
    expect(deviceGroupRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', deviceId: 'd1', groupId: 'g1', status: 'active' }),
      expect.anything()
    );
    expect(redis.sadd).toHaveBeenCalledWith('group:members:g1', 'u1:d1');
  });

  it('clears `kickedAt`: the device is IN, so no Add is outstanding', async () => {
    await service.activateDeviceMembership('u1', 'd1', 'g1');

    expect(deviceGroupRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ kickedAt: null }),
      expect.anything()
    );
  });

  it('refuses a REVOKED device and writes neither the row nor the set (WP-GHOST-1)', async () => {
    revokedDeviceRepo.findOne.mockResolvedValue({ userId: 'u1', deviceId: 'd1' });

    const outcome = await service.activateDeviceMembership('u1', 'd1', 'g1');

    expect(outcome).toEqual({ ok: false, reason: 'revoked' });
    expect(deviceGroupRepo.upsert).not.toHaveBeenCalled();
    expect(redis.sadd).not.toHaveBeenCalled();
  });

  it('refuses a device with NO KeyPackage - one good enough to be messaged is one good enough to be invited', async () => {
    keyPackageRepo.findOne.mockResolvedValue(null);

    const outcome = await service.activateDeviceMembership('u1', 'd1', 'g1');

    expect(outcome).toEqual({ ok: false, reason: 'no_key_package' });
    expect(deviceGroupRepo.upsert).not.toHaveBeenCalled();
  });

  it('ACCUSES under the CALLER tag, so a refusal names the door that asked', async () => {
    revokedDeviceRepo.findOne.mockResolvedValue({ userId: 'u1', deviceId: 'd1' });

    await service.activateDeviceMembership('u1', 'd1', 'g1', { tag: 'CREATE_GROUP' });

    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('REFUSED'));
    expect(line).toBeDefined();
    expect(line).toContain('CREATE_GROUP');
    expect(line).toContain('revoked');
  });

  it('logs the refusal even when the caller ignores the returned reason', async () => {
    keyPackageRepo.findOne.mockResolvedValue(null);

    // The return value is dropped on purpose: a best-effort seam may do exactly this, and the
    // record must survive it.
    await service.activateDeviceMembership('u1', 'd1', 'g1');

    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('REFUSED');
  });

  it('replays nothing when told the device joined at the current epoch', async () => {
    deviceGroupRepo.findOne.mockResolvedValue({ status: 'pending', createdAt: new Date() });

    await service.activateDeviceMembership('u1', 'd1', 'g1', { redeliverMissed: false });

    // Forward secrecy: it cannot decrypt anything sent before its join, so a replay would be up to
    // fifty undecryptable frames and as many generic pushes.
    expect(redis.xrange).not.toHaveBeenCalled();
  });

  it('does not replay to a device that was ALREADY active - re-processing must not double notify', async () => {
    deviceGroupRepo.findOne.mockResolvedValue({ status: 'active', createdAt: new Date() });

    await service.activateDeviceMembership('u1', 'd1', 'g1');

    expect(redis.xrange).not.toHaveBeenCalled();
  });
});

describe('the INVITATION_STATUS door', () => {
  let controller: InvitationsController;
  const messaging = {
    activateDeviceMembership: jest.fn().mockResolvedValue({ ok: true }),
    deviceAddressability: jest.fn().mockResolvedValue({ ok: true }),
  };
  const deviceGroupRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
  };

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn(),
    delete: jest.fn(),
    create: jest.fn().mockImplementation((e: unknown) => e),
    query: jest.fn(),
    createQueryBuilder: jest.fn(),
    metadata: { tableName: 'stub' },
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    messaging.activateDeviceMembership.mockResolvedValue({ ok: true });
    deviceGroupRepo.findOne.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InvitationsController],
      providers: [
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupInvite), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: { srem: jest.fn(), mget: jest.fn() } },
        { provide: MessagingService, useValue: messaging },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(InvitationsController);
  });

  const promote = () =>
    controller.updateInvitationStatus(
      { deviceId: 'd1', userId: 'u1', groupId: 'g1', status: 'active' },
      'u1',
      'false'
    );

  it('promotes through the one writer instead of writing the row itself', async () => {
    const answer = await promote();

    expect(messaging.activateDeviceMembership).toHaveBeenCalledWith(
      'u1',
      'd1',
      'g1',
      expect.objectContaining({ tag: 'INVITATION_STATUS' })
    );
    // The local save is what left the routing set unwritten for a year; it must be gone.
    expect(deviceGroupRepo.save).not.toHaveBeenCalled();
    expect(answer).toEqual({ status: 'active' });
  });

  it('still THROWS on a refusal - this door has a user to tell', async () => {
    messaging.activateDeviceMembership.mockResolvedValue({ ok: false, reason: 'revoked' });

    await expect(promote()).rejects.toBeInstanceOf(BadRequestException);
  });

  it('writes the DEMOTION itself - it is a different question and stays local', async () => {
    deviceGroupRepo.findOne.mockResolvedValue({
      userId: 'u1',
      deviceId: 'd1',
      groupId: 'g1',
      status: 'active',
      kickedAt: new Date('2026-09-01T10:18:38Z'),
    });

    await controller.updateInvitationStatus(
      { deviceId: 'd1', userId: 'u1', groupId: 'g1', status: 'pending' },
      'u1',
      'false'
    );

    expect(messaging.activateDeviceMembership).not.toHaveBeenCalled();
    expect(deviceGroupRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' })
    );
  });
});

describe('the CREATE_GROUP door', () => {
  let controller: GroupsController;
  const messaging = {
    activateDeviceMembership: jest.fn().mockResolvedValue({ ok: true }),
    deviceAddressability: jest.fn().mockResolvedValue({ ok: true }),
  };
  const groupRepo = {
    create: jest.fn().mockImplementation((e: unknown) => e),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    findOne: jest.fn().mockResolvedValue(null),
  };

  const BODY = { name: 'Amis', createdBy: 'u1', creatorDeviceId: 'd1' };

  beforeEach(async () => {
    jest.clearAllMocks();
    messaging.activateDeviceMembership.mockResolvedValue({ ok: true });
    messaging.deviceAddressability.mockResolvedValue({ ok: true });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GroupsController],
      providers: [
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: { findOne: jest.fn() } },
        { provide: 'REDIS_CLIENT', useValue: { sadd: jest.fn() } },
        { provide: MessagingService, useValue: messaging },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(GroupsController);
  });

  it('enrols the creator through the one writer, with no replay to a group made this instant', async () => {
    await controller.createGroup(BODY);

    expect(messaging.activateDeviceMembership).toHaveBeenCalledWith(
      'u1',
      'd1',
      expect.any(String),
      expect.objectContaining({ redeliverMissed: false, tag: 'CREATE_GROUP' })
    );
  });

  it('REFUSES an unaddressable creator - the door that used to ask nothing', async () => {
    messaging.deviceAddressability.mockResolvedValue({ ok: false, reason: 'revoked' });

    await expect(controller.createGroup(BODY)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('writes NO group row when it refuses, so a 400 leaves no orphan behind', async () => {
    messaging.deviceAddressability.mockResolvedValue({ ok: false, reason: 'no_key_package' });

    await expect(controller.createGroup(BODY)).rejects.toBeInstanceOf(BadRequestException);
    expect(groupRepo.save).not.toHaveBeenCalled();
    expect(messaging.activateDeviceMembership).not.toHaveBeenCalled();
  });

  it("refuses the client's unresolved-identity placeholder - the 2026-08-27 defect reached this door too", async () => {
    // `updateInvitationStatus` was hardened against this and group creation never was, so a
    // placeholder could be stored as a real member of a real conversation.
    await expect(controller.createGroup({ ...BODY, createdBy: 'unknown' })).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(groupRepo.save).not.toHaveBeenCalled();
  });

  it('creates a memberless group without asking anything, when no creator device is given', async () => {
    // Not an error: the creator reaches it through the ordinary invitation path, and there is no
    // membership to gate.
    await controller.createGroup({ name: 'Amis', createdBy: 'u1' });

    expect(groupRepo.save).toHaveBeenCalled();
    expect(messaging.deviceAddressability).not.toHaveBeenCalled();
    expect(messaging.activateDeviceMembership).not.toHaveBeenCalled();
  });
});
