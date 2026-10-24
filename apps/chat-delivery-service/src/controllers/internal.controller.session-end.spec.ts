/// <reference types="jest" />

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsNull } from 'typeorm';
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
import { GroupMembershipInterval } from '../entities/group-membership-interval.entity';
import { MessagingService } from '../services/messaging.service';

/**
 * The server half of "a sign-out ends the device's push registration": when core-service ends a
 * session, the push token row THAT session registered - its destination and its push secret - goes,
 * and a row a newer session of the same device wrote stays.
 */
describe('InternalController - a session end ends the device push registration', () => {
  const SECRET = 'internal-secret-for-tests';

  let controller: InternalController;
  let pushTokenRepo: { delete: jest.Mock; findOne: jest.Mock };
  let previousSecret: string | undefined;

  beforeEach(async () => {
    previousSecret = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = SECRET;
    pushTokenRepo = {
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InternalController],
      providers: [
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: {} },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: {} },
        { provide: getRepositoryToken(Group), useValue: {} },
        { provide: getRepositoryToken(GroupMember), useValue: {} },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: getRepositoryToken(QueuedMessage), useValue: {} },
        { provide: getRepositoryToken(PinVerifier), useValue: {} },
        { provide: getRepositoryToken(RevokedDevice), useValue: {} },
        { provide: getRepositoryToken(GroupInvite), useValue: {} },
        { provide: getRepositoryToken(GroupMembershipInterval), useValue: {} },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: MessagingService, useValue: {} },
      ],
    }).compile();

    controller = module.get(InternalController);
    jest.spyOn(controller['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(controller['logger'], 'debug').mockImplementation(() => undefined);
    Object.defineProperty(controller, 'secret', { value: SECRET, writable: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previousSecret;
  });

  const SID = '0f0f0f0f-0000-4000-8000-00000000a1b2';
  const OLD = '0e0e0e0e-0000-4000-8000-00000000a1b2';

  it('removes the row the ended session registered, by session alone when no device is named', async () => {
    await expect(
      controller.endSessionPushRegistration(SECRET, 'user-1', SID, undefined, undefined)
    ).resolves.toEqual({ removed: 1 });
    expect(pushTokenRepo.delete).toHaveBeenCalledTimes(1);
    expect(pushTokenRepo.delete).toHaveBeenCalledWith({ userId: 'user-1', sessionId: SID });
  });

  it("also removes the device's row, only while it is bound to exactly what core-service read", async () => {
    await controller.endSessionPushRegistration(SECRET, 'user-1', SID, 'dev-1', OLD);
    expect(pushTokenRepo.delete).toHaveBeenNthCalledWith(2, {
      userId: 'user-1',
      deviceId: 'dev-1',
      sessionId: OLD,
    });

    await controller.endSessionPushRegistration(SECRET, 'user-1', SID, 'dev-1', 'none');
    expect(pushTokenRepo.delete).toHaveBeenNthCalledWith(4, {
      userId: 'user-1',
      deviceId: 'dev-1',
      sessionId: IsNull(),
    });
  });

  it('answers zero when nothing is left - the second call of an idempotent end', async () => {
    pushTokenRepo.delete.mockResolvedValue({ affected: 0 });
    await expect(
      controller.endSessionPushRegistration(SECRET, 'user-1', SID, undefined, undefined)
    ).resolves.toEqual({ removed: 0 });
  });

  it('refuses a session id that is not one, and a device without its binding', async () => {
    await expect(
      controller.endSessionPushRegistration(SECRET, 'user-1', 'not-a-uuid', undefined, undefined)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.endSessionPushRegistration(SECRET, 'user-1', SID, 'dev-1', undefined)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.endSessionPushRegistration(SECRET, 'user-1', SID, undefined, OLD)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.endSessionPushRegistration(SECRET, 'user-1', SID, 'dev-1', 'garbage')
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(pushTokenRepo.delete).not.toHaveBeenCalled();
  });

  it('refuses a caller without the internal secret, and deletes nothing', async () => {
    await expect(
      controller.endSessionPushRegistration('wrong', 'user-1', SID, undefined, undefined)
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.readDevicePushBinding('wrong', 'user-1', 'dev-1')
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(pushTokenRepo.delete).not.toHaveBeenCalled();
  });

  it('refuses a device id outside the allowlist rather than deleting by it', async () => {
    await expect(
      controller.endSessionPushRegistration(SECRET, 'user-1', SID, 'dev 1; drop', 'none')
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(pushTokenRepo.delete).not.toHaveBeenCalled();
  });

  it('reads the binding of a device registration, and says when there is none', async () => {
    pushTokenRepo.findOne.mockResolvedValueOnce({ id: 'r', sessionId: OLD });
    await expect(controller.readDevicePushBinding(SECRET, 'user-1', 'dev-1')).resolves.toEqual({
      registered: true,
      sessionId: OLD,
    });
    pushTokenRepo.findOne.mockResolvedValueOnce(null);
    await expect(controller.readDevicePushBinding(SECRET, 'user-1', 'dev-1')).resolves.toEqual({
      registered: false,
      sessionId: null,
    });
  });
});
