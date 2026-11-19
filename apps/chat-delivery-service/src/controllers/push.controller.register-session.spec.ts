/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import { ClientIpThrottlerGuard } from '../guards/client-ip-throttler.guard';
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
  // The registration also sweeps the device's push envelopes (`sweepDeviceEnvelopes`): none here.
  const pushTokenRepo = {
    upsert: jest.fn().mockResolvedValue(undefined),
    manager: { query: jest.fn().mockResolvedValue([{ n: 0 }]) },
  };
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
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ClientIpThrottlerGuard)
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

  /*
   * Every access token has named its session since 2026-10-25 and verify answers one that does not
   * as anonymous (#3764), so an authenticated registration with no session is no legitimate caller:
   * refused, typed, never a 401/403, and nothing written.
   */
  it('refuses a registration naming no session, typed SESSION_UNNAMED, writing nothing', async () => {
    for (const sid of ['', undefined]) {
      const failure = await controller
        .registerPushToken(body, 'user-1', sid)
        .catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(BadRequestException);
      expect((failure as BadRequestException).getResponse()).toMatchObject({
        code: 'SESSION_UNNAMED',
      });
    }
    expect(pushTokenRepo.upsert).not.toHaveBeenCalled();
  });

  it('refuses a session header that is not a session id rather than storing it', async () => {
    await expect(controller.registerPushToken(body, 'user-1', 'abc')).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(pushTokenRepo.upsert).not.toHaveBeenCalled();
  });
});
