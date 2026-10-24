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
import { GroupMembershipInterval } from '../entities/group-membership-interval.entity';
import { MessagingService } from '../services/messaging.service';

/**
 * The server half of "a sign-out ends the device's push registration": when core-service ends a
 * device's session, the device's push token row - its destination and its push secret - goes.
 */
describe('InternalController - a session end ends the device push registration', () => {
  const SECRET = 'internal-secret-for-tests';

  let controller: InternalController;
  let pushTokenRepo: { delete: jest.Mock };
  let previousSecret: string | undefined;

  beforeEach(async () => {
    previousSecret = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = SECRET;
    pushTokenRepo = { delete: jest.fn().mockResolvedValue({ affected: 1 }) };

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
    Object.defineProperty(controller, 'secret', { value: SECRET, writable: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previousSecret;
  });

  it("removes exactly that device's push token row", async () => {
    await expect(controller.endDevicePushRegistration(SECRET, 'user-1', 'dev-1')).resolves.toEqual({
      removed: 1,
    });
    expect(pushTokenRepo.delete).toHaveBeenCalledWith({ userId: 'user-1', deviceId: 'dev-1' });
  });

  it('answers zero for a device with no registration - the second call of an idempotent end', async () => {
    pushTokenRepo.delete.mockResolvedValue({ affected: 0 });
    await expect(controller.endDevicePushRegistration(SECRET, 'user-1', 'dev-1')).resolves.toEqual({
      removed: 0,
    });
  });

  it('refuses a caller without the internal secret, and deletes nothing', async () => {
    await expect(
      controller.endDevicePushRegistration('wrong', 'user-1', 'dev-1')
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.endDevicePushRegistration(undefined as unknown as string, 'user-1', 'dev-1')
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(pushTokenRepo.delete).not.toHaveBeenCalled();
  });

  it('refuses an id outside the allowlist rather than deleting by it', async () => {
    await expect(
      controller.endDevicePushRegistration(SECRET, 'user-1', 'dev 1; drop')
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(pushTokenRepo.delete).not.toHaveBeenCalled();
  });
});
