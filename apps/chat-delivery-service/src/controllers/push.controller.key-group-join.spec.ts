/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { PushSecretGuard } from '../guards/push-secret.guard';
import { PushSecretThrottlerGuard } from '../guards/push-secret-throttler.guard';
import { PushController } from './push.controller';
import { PushToken } from '../entities/push-token.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * The two PushSecret doors a killed app joins a key group through (channel-encryption section 26).
 * What they decide is `MessagingService`'s (`messaging.key-group-push-join.spec.ts`); what is only
 * true of the doors is that nothing is read or submitted without the device's PushSecret, and that
 * the committer is the device the secret authenticated - never a body field.
 */
describe('PushController - key-group join from a push', () => {
  let controller: PushController;
  const pushTokenRepo = { findOne: jest.fn(), update: jest.fn() };
  const readKeyGroupBaseForPush = jest.fn();
  const submitKeyGroupJoinForPush = jest.fn();
  const messagingService = {
    readKeyGroupBaseForPush,
    submitKeyGroupJoinForPush,
  } as unknown as MessagingService;
  // sha256('sekret')
  const stored = 'bb757689c39373a6cac9ef6ba55616c6249d7500ca4d443f1130c4766453a412';

  beforeEach(async () => {
    jest.clearAllMocks();
    pushTokenRepo.findOne.mockResolvedValue({ pushSecret: stored });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PushController],
      providers: [
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(QueuedMessage), useValue: {} },
        { provide: getRepositoryToken(KeyPackage), useValue: {} },
        { provide: getRepositoryToken(GroupMember), useValue: {} },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: MessagingService, useValue: messagingService },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PushSecretGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PushSecretThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(PushController);
  });

  it('serves the base for the device the guard authenticated', async () => {
    const answer = { scope: { kind: 'workspace', id: 'ws-1' }, welcomeOwed: false, base: null };
    readKeyGroupBaseForPush.mockResolvedValue(answer);

    await expect(
      controller.getKeyGroupBasePush({
        userId: 'u1',
        deviceId: 'd1',
        groupId: 'kg-1',
      })
    ).resolves.toBe(answer);
    expect(readKeyGroupBaseForPush).toHaveBeenCalledWith('kg-1', 'u1', 'd1');
  });

  /**
   * THE PUSHSECRET IS PROVEN ONCE, BY `PushSecretGuard`, and the handlers do not read it again. So
   * the door is the guard: first on both routes, and refusing the body's ids without their secret.
   */
  it.each(['getKeyGroupBasePush', 'submitKeyGroupJoinPush'] as const)(
    '%s reads or submits nothing without the right PushSecret - the guard refuses it first',
    async (name) => {
      const handler = Object.getOwnPropertyDescriptor(PushController.prototype, name)?.value as (
        ...args: unknown[]
      ) => unknown;
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)[0]).toBe(PushSecretGuard);

      const guard = new PushSecretGuard(pushTokenRepo as never);
      const ctx = (authorization: string) =>
        ({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: { authorization },
              body: { userId: 'u1', deviceId: 'd1', groupId: 'kg-1' },
            }),
          }),
        }) as unknown as ExecutionContext;
      await expect(guard.canActivate(ctx('PushSecret wrong'))).rejects.toBeInstanceOf(
        ForbiddenException
      );
      await expect(guard.canActivate(ctx(''))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(guard.canActivate(ctx('PushSecret sekret'))).resolves.toBe(true);
      expect(pushTokenRepo.findOne).toHaveBeenCalledWith({
        where: { userId: 'u1', deviceId: 'd1' },
      });
    }
  );

  it('submits the commit as the authenticated device, and nothing else from the body', async () => {
    submitKeyGroupJoinForPush.mockResolvedValue({ accepted: true, newEpoch: 8 });

    await expect(
      controller.submitKeyGroupJoinPush({
        userId: 'u1',
        deviceId: 'd1',
        groupId: 'kg-1',
        baseEpoch: 7,
        proto: 'AAA=',
        groupInfo: 'R0k=',
      })
    ).resolves.toEqual({ accepted: true, newEpoch: 8 });
    expect(submitKeyGroupJoinForPush).toHaveBeenCalledWith(
      {
        groupId: 'kg-1',
        deviceId: 'd1',
        senderId: 'u1',
        baseEpoch: 7,
        proto: 'AAA=',
        groupInfo: 'R0k=',
      },
      'u1'
    );
  });
});
