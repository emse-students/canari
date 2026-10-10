/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, HttpException, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import * as crypto from 'crypto';
import { PushController } from './push.controller';
import { PushToken } from '../entities/push-token.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { MessagingService } from '../services/messaging.service';

/**
 * `POST /mls/push/channel-read` - "Mark as read" on a salon notification, from a phone whose app is
 * shut. Judged on what reaches social-service (and with which secret), and on every refusal being an
 * answer rather than a silent success.
 */
describe('PushController - POST mls/push/channel-read', () => {
  let controller: PushController;
  let fetchSpy: jest.SpyInstance;
  const env = { ...process.env };
  const SECRET = 'push-secret-1';
  const hashed = crypto.createHash('sha256').update(SECRET).digest('hex');
  const auth = `PushSecret ${SECRET}`;
  const body = { userId: 'user-1', deviceId: 'dev-1', channelId: 'chan-1', at: 1_700_000_000_000 };

  const pushTokenRepo = { findOne: jest.fn(), update: jest.fn() };
  const emptyRepo = () => ({ findOne: jest.fn(), find: jest.fn(), save: jest.fn() });
  const social = (status: number, json: unknown = { at: null }) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => json }) as Response;

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.INTERNAL_SECRET = 'internal-secret';
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    pushTokenRepo.findOne.mockResolvedValue({
      userId: 'user-1',
      deviceId: 'dev-1',
      pushSecret: hashed,
    });
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(social(200, { at: 1_700_000_000_000 }));
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

  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('carries the proven user and the notification instant to social-service under the internal secret', async () => {
    await expect(controller.markChannelReadForPush(auth, body)).resolves.toEqual({
      at: 1_700_000_000_000,
    });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://social-service:3014/api/internal/channels/chan-1/read');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-internal-secret']).toBe('internal-secret');
    expect(JSON.parse(init.body as string)).toEqual({ userId: 'user-1', at: 1_700_000_000_000 });
  });

  it('refuses a caller without the device push secret, and calls nobody', async () => {
    await expect(
      controller.markChannelReadForPush('PushSecret wrong', body)
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses an instant that is not a positive integer', async () => {
    for (const at of [0, -1, 1.5, '5', undefined]) {
      await expect(controller.markChannelReadForPush(auth, { ...body, at })).rejects.toBeInstanceOf(
        BadRequestException
      );
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses to forward anything when the internal secret is unset', async () => {
    delete process.env.INTERNAL_SECRET;
    await expect(controller.markChannelReadForPush(auth, body)).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers 403 when social-service says the user cannot read that salon', async () => {
    fetchSpy.mockResolvedValue(social(403));
    await expect(controller.markChannelReadForPush(auth, body)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('answers 502 for any other upstream failure, and 503 when it is unreachable', async () => {
    fetchSpy.mockResolvedValue(social(500));
    await expect(controller.markChannelReadForPush(auth, body)).rejects.toMatchObject({
      status: 502,
    });
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    const err = await controller.markChannelReadForPush(auth, body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(503);
  });
});
