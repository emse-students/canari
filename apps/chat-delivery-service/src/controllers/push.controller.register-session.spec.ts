/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { PushController } from './push.controller';
import { PushToken } from '../entities/push-token.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { PushSecretThrottlerGuard } from '../guards/push-secret-throttler.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * `POST /mls/push/register` binds the row it writes to the session that wrote it (migration 037), so
 * ending that session removes this registration and never a newer one of the same device.
 */
describe('PushController - POST mls/push/register binds the registration to its session', () => {
  const SID = '0f0f0f0f-0000-4000-8000-00000000a1b2';
  let controller: PushController;
  const pushTokenRepo = { upsert: jest.fn().mockResolvedValue(undefined) };
  const emptyRepo = () => ({ findOne: jest.fn(), find: jest.fn(), save: jest.fn() });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PushController],
      providers: [
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: MessagingService, useValue: {} as unknown as MessagingService },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PushSecretThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(PushController);
  });

  afterEach(() => jest.restoreAllMocks());

  const body = { token: 'fcm-token', deviceId: 'phone-1', platform: 'android' };

  it('writes the session the access token names', async () => {
    await controller.registerPushToken(body, 'user-1', SID);
    expect(pushTokenRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', deviceId: 'phone-1', sessionId: SID }),
      { conflictPaths: ['userId', 'deviceId'] }
    );
  });

  it('writes null - not nothing - for a token minted before the claim, so a rewritten row never keeps an older session', async () => {
    await controller.registerPushToken(body, 'user-1', '');
    await controller.registerPushToken(body, 'user-1', undefined);
    for (const [row] of pushTokenRepo.upsert.mock.calls) {
      expect(row).toHaveProperty('sessionId', null);
    }
  });

  it('refuses a session header that is not a session id rather than storing it', async () => {
    await expect(controller.registerPushToken(body, 'user-1', 'abc')).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(pushTokenRepo.upsert).not.toHaveBeenCalled();
  });
});
