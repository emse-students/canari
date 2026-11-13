/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import type { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import { ClientIpThrottlerGuard } from '../guards/client-ip-throttler.guard';
import { PushSecretGuard } from '../guards/push-secret.guard';
import { PushSecretThrottlerGuard } from '../guards/push-secret-throttler.guard';
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { BLIND_BANNER_REFUSALS, BLIND_BANNER_TERMS, PushController } from './push.controller';
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
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ClientIpThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PushSecretGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PushSecretThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(PushController);
  });

  /**
   * The route as mounted: the REAL `PushSecretGuard` first (it is what refuses a wrong secret, the
   * handler no longer re-checks it), then the handler.
   */
  async function post(auth: string, body: Parameters<PushController['reportBlindBanner']>[0]) {
    const guard = new PushSecretGuard(pushTokenRepo as unknown as Repository<PushToken>);
    const req = { method: 'POST', headers: { authorization: auth }, body };
    await guard.canActivate({
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext);
    return controller.reportBlindBanner(body);
  }

  afterEach(() => warn.mockRestore());

  const blindLines = () =>
    warn.mock.calls.map((c) => c[0] as string).filter((l) => l.startsWith('[PUSH_BLIND]'));

  it('names the missing terms and whether the frame is held, so a GROUP BY separates the causes', async () => {
    const res = await post(`PushSecret ${SECRET}`, {
      userId: 'user-1',
      deviceId: 'dev-1',
      channelId: 'chan-1',
      platform: 'android',
      missing: ['seed'],
      held: true,
    });
    expect(res).toEqual({ recorded: true });
    expect(blindLines()).toEqual([
      '[PUSH_BLIND] user=user-1 device=dev-1 platform=android channel=chan-1 missing=seed held=true refused=none',
    ]);
  });

  it('prints a term outside the allowlist as invalid, never as sent', async () => {
    await post(`PushSecret ${SECRET}`, {
      userId: 'user-1',
      deviceId: 'dev-1',
      channelId: 'chan-1',
      missing: ['ciphertext', 'x\nforged'],
    });
    expect(blindLines()[0]).toContain('missing=ciphertext,invalid held=false refused=none');
  });

  it('names the refusal of an open that ran, with nothing missing', async () => {
    await post(`PushSecret ${SECRET}`, {
      userId: 'user-1',
      deviceId: 'dev-1',
      channelId: 'chan-1',
      platform: 'android',
      missing: [],
      held: false,
      refused: 'signature-refused',
    });
    expect(blindLines()).toEqual([
      '[PUSH_BLIND] user=user-1 device=dev-1 platform=android channel=chan-1 missing=none held=false refused=signature-refused',
    ]);
  });

  it('prints a refusal outside the allowlist as invalid, never as sent', async () => {
    await post(`PushSecret ${SECRET}`, {
      userId: 'user-1',
      deviceId: 'dev-1',
      channelId: 'chan-1',
      refused: 'x\nforged',
    });
    expect(blindLines()[0]).toContain('missing=none held=false refused=invalid');
  });

  it('keeps the shape an older build sends: no refused field prints refused=none', async () => {
    await post(`PushSecret ${SECRET}`, {
      userId: 'user-1',
      deviceId: 'dev-1',
      channelId: 'chan-1',
    });
    expect(blindLines()[0]).toContain('missing=unstated held=false refused=none');
  });

  it('allows exactly the terms of the shared contract', () => {
    const root = resolve(__dirname, '../../../..');
    const contract = JSON.parse(
      readFileSync(resolve(root, 'libs/contracts/blind-banner-terms.json'), 'utf8')
    ) as { missing: string[]; refused: string[]; silent: string[] };
    expect([...BLIND_BANNER_TERMS].sort()).toEqual([...contract.missing].sort());
    expect([...BLIND_BANNER_REFUSALS].sort()).toEqual([...contract.refused].sort());
    // A silent answer is never a banner, so it is never a term a report may carry.
    for (const silent of contract.silent) expect(BLIND_BANNER_REFUSALS.has(silent)).toBe(false);
  });

  it('refuses a caller without the device push secret, and prints no count', async () => {
    await expect(
      post('PushSecret wrong', {
        userId: 'user-1',
        deviceId: 'dev-1',
        missing: ['seed'],
      })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(blindLines()).toEqual([]);
  });
});
