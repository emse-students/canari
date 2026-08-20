/// <reference types="jest" />

import { ForbiddenException } from '@nestjs/common';
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
import { RETENTION_WINDOW_MS } from '../retention.constants';

/**
 * The device count a SERVICE may ask for.
 *
 * WHY THE ROUTE EXISTS AT ALL is the whole of this suite's value: `mls/devices/:userId` answers the
 * same question behind `HeaderAuthGuard`, which wants `x-user-logged-in` and a per-minute HMAC only
 * Nginx mints. Social-service asked it over the Docker network with `X-Internal-Secret` alone, got
 * 401 every time, and turned that into the 503 an inviter read as "the key service is down" - for a
 * day, on production, with every unit test green.
 *
 * TWO THINGS ARE ASSERTED AND NEITHER IS THE HAPPY PATH ALONE: that the internal secret is really
 * demanded, and that the RETENTION WINDOW is the same one `getUserDevices` applies. A device outside
 * that window is dropped from new-group invites, so counting it would tell the caller a key DM can
 * reach someone no group will ever add - the exact fail-open this guard was rewritten to stop.
 */
describe('InternalController - the MLS device count', () => {
  const SECRET = 'internal-secret-for-tests';
  const USER = 'u-target';

  let controller: InternalController;
  let keyPackageRepo: { count: jest.Mock };
  let previousSecret: string | undefined;

  beforeEach(async () => {
    previousSecret = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = SECRET;

    keyPackageRepo = { count: jest.fn().mockResolvedValue(2) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InternalController],
      providers: [
        { provide: getRepositoryToken(PushToken), useValue: {} },
        { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: {} },
        { provide: getRepositoryToken(Group), useValue: {} },
        { provide: getRepositoryToken(GroupMember), useValue: {} },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: getRepositoryToken(QueuedMessage), useValue: {} },
        { provide: getRepositoryToken(PinVerifier), useValue: {} },
        { provide: getRepositoryToken(RevokedDevice), useValue: {} },
        { provide: getRepositoryToken(GroupInvite), useValue: {} },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: MessagingService, useValue: {} },
      ],
    }).compile();

    controller = module.get(InternalController);
    jest.spyOn(controller['logger'], 'log').mockImplementation(() => undefined);
    // Read into a field at construction, so it is re-asserted here for the same reason the
    // distribution-group suite does: a later mutation must not silently disarm the guard test.
    Object.defineProperty(controller, 'secret', { value: SECRET, writable: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previousSecret;
  });

  it('answers the count for a caller carrying the internal secret', async () => {
    await expect(controller.userDeviceCount(SECRET, USER)).resolves.toEqual({ count: 2 });
  });

  it('answers zero as a fact, not as a refusal', async () => {
    keyPackageRepo.count.mockResolvedValue(0);
    await expect(controller.userDeviceCount(SECRET, USER)).resolves.toEqual({ count: 0 });
  });

  it('refuses a caller with the wrong secret', async () => {
    await expect(controller.userDeviceCount('not-the-secret', USER)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(keyPackageRepo.count).not.toHaveBeenCalled();
  });

  it('refuses a caller with no secret at all', async () => {
    await expect(
      controller.userDeviceCount(undefined as unknown as string, USER)
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(keyPackageRepo.count).not.toHaveBeenCalled();
  });

  it('counts only devices inside the retention window the user route uses', async () => {
    const before = Date.now();
    await controller.userDeviceCount(SECRET, USER);
    const after = Date.now();

    const where = keyPackageRepo.count.mock.calls[0][0].where as {
      userId: string;
      createdAt: { value: Date };
    };
    expect(where.userId).toBe(USER);
    // TypeORM's `MoreThanOrEqual` carries its operand, so the cutoff itself is readable - and a
    // wall clock is never asserted, only the window it must fall inside.
    const cutoff = where.createdAt.value.getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before - RETENTION_WINDOW_MS);
    expect(cutoff).toBeLessThanOrEqual(after - RETENTION_WINDOW_MS);
  });
});
