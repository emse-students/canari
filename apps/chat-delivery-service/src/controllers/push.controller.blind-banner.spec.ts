/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import * as crypto from 'crypto';
import { PushController } from './push.controller';
import { PushToken } from '../entities/push-token.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { MessagingService } from '../services/messaging.service';

/**
 * `POST /mls/push/blind-banner` - a shut phone saying its salon banner went up without the
 * plaintext, and which term it lacked. Judged on what the line lets a reader count, and on refusing
 * a caller without the device's push secret.
 */
describe('PushController - POST mls/push/blind-banner', () => {
  let controller: PushController;
  let warn: jest.SpyInstance;
  const SECRET = 'push-secret-1';
  const hashed = crypto.createHash('sha256').update(SECRET).digest('hex');

  const pushTokenRepo = {
    findOne: jest.fn(),
    update: jest.fn(),
    save: jest.fn(),
    upsert: jest.fn(),
  };
  const emptyRepo = () => ({ findOne: jest.fn(), find: jest.fn(), save: jest.fn() });

  beforeEach(async () => {
    jest.clearAllMocks();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    pushTokenRepo.findOne.mockResolvedValue({
      userId: 'user-1',
      deviceId: 'dev-1',
      pushSecret: hashed,
    });
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
      .compile();
    controller = module.get(PushController);
  });

  afterEach(() => warn.mockRestore());

  const blindLines = () =>
    warn.mock.calls.map((c) => c[0] as string).filter((l) => l.startsWith('[PUSH_BLIND]'));

  it('names the missing terms and whether the frame is held, so a GROUP BY separates the causes', async () => {
    const res = await controller.reportBlindBanner(`PushSecret ${SECRET}`, {
      userId: 'user-1',
      deviceId: 'dev-1',
      channelId: 'chan-1',
      platform: 'android',
      missing: ['seed'],
      held: true,
    });
    expect(res).toEqual({ recorded: true });
    expect(blindLines()).toEqual([
      '[PUSH_BLIND] user=user-1 device=dev-1 platform=android channel=chan-1 missing=seed held=true',
    ]);
  });

  it('prints a term outside the allowlist as invalid, never as sent', async () => {
    await controller.reportBlindBanner(`PushSecret ${SECRET}`, {
      userId: 'user-1',
      deviceId: 'dev-1',
      channelId: 'chan-1',
      missing: ['ciphertext', 'x\nforged'],
    });
    expect(blindLines()[0]).toContain('missing=ciphertext,invalid held=false');
  });

  it('refuses a caller without the device push secret, and prints no count', async () => {
    await expect(
      controller.reportBlindBanner('PushSecret wrong', {
        userId: 'user-1',
        deviceId: 'dev-1',
        missing: ['seed'],
      })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(blindLines()).toEqual([]);
  });
});
