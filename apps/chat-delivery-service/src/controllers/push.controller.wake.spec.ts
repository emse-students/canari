/// <reference types="jest" />

import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { PushSecretThrottlerGuard } from '../guards/push-secret-throttler.guard';
import { PushController } from './push.controller';
import { PushToken } from '../entities/push-token.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';
import type { PushMessageInput } from '../services/push-payload';

/**
 * The two server halves a wake-up push needs from this controller
 * (docs/wiki/backlog.d/push-payloads-carry-nothing-for-google-and-apple.md):
 *
 * - `POST /mls/push/register` records whether the binary understands a wake, on EVERY registration;
 * - `GET /mls/push/wake` hands the woken device the map the full push would have carried, behind
 *   the same PushSecret as `fetch-proto`, or says the row is gone.
 */
describe('PushController - the wake-up push', () => {
  const SECRET = 'the-push-secret';
  const Q = '7c1d2e3f-aaaa-4bbb-8ccc-dddddddddddd';
  let controller: PushController;
  const pushTokenRepo = {
    upsert: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const queuedRepo = { findOne: jest.fn(), find: jest.fn(), save: jest.fn() };
  const emptyRepo = () => ({ findOne: jest.fn(), find: jest.fn(), save: jest.fn() });
  const describeQueuedFrame = jest.fn();

  const input = (over: Partial<PushMessageInput> = {}): PushMessageInput => ({
    groupId: 'g1',
    queuedMessageId: Q,
    senderId: 'u2',
    senderName: 'Alice',
    groupName: '',
    isGroup: false,
    isKeyDistribution: false,
    proto: '',
    silent: false,
    isWelcome: false,
    createdAt: '2026-11-02T10:00:00.000Z',
    ...over,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    pushTokenRepo.findOne.mockResolvedValue({
      pushSecret: crypto.createHash('sha256').update(SECRET).digest('hex'),
    });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PushController],
      providers: [
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(QueuedMessage), useValue: queuedRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: MessagingService, useValue: { describeQueuedFrame } },
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

  describe('POST mls/push/register', () => {
    const body = { token: 'fcm-token', deviceId: 'phone-1', platform: 'android' };

    it('records a binary that declares it understands a wake', async () => {
      await controller.registerPushToken({ ...body, wake: true }, 'user-1', undefined);
      expect(pushTokenRepo.upsert.mock.calls[0][0]).toHaveProperty('wakeCapable', true);
    });

    it('writes false - not nothing - for a binary that does not say so, so a downgrade is never woken', async () => {
      await controller.registerPushToken(body, 'user-1', undefined);
      await controller.registerPushToken(
        { ...body, wake: 'yes' as unknown as boolean },
        'user-1',
        undefined
      );
      for (const [row] of pushTokenRepo.upsert.mock.calls) {
        expect(row).toHaveProperty('wakeCapable', false);
      }
    });
  });

  describe('GET mls/push/wake', () => {
    const fetch = (silent = 'false', auth = `PushSecret ${SECRET}`) =>
      controller.fetchWakeFrame(auth, Q, 'user-1', 'phone-1', silent);

    it('answers the full data map, ciphertext inline whatever its size', async () => {
      const longProto = 'A'.repeat(20_000);
      queuedRepo.findOne.mockResolvedValue({
        id: Q,
        recipientId: 'user-1',
        deviceId: 'phone-1',
        groupId: 'g1',
        senderId: 'u2',
        proto: longProto,
      });
      describeQueuedFrame.mockResolvedValue(input());
      const answer = await fetch();
      expect(answer.status).toBe('frame');
      if (answer.status !== 'frame') return;
      expect(answer.fields).toMatchObject({
        type: 'message',
        groupId: 'g1',
        queuedMessageId: Q,
        senderId: 'u2',
        senderName: 'Alice',
        silent: 'false',
        proto: longProto,
      });
      // The row is looked up in THIS device's own queue only.
      expect(queuedRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: Q, recipientId: 'user-1', deviceId: 'phone-1' },
        })
      );
      // The sender's "draw nothing" travels with the device, the rest is decided here.
      expect(describeQueuedFrame).toHaveBeenCalledWith(
        expect.objectContaining({ id: Q }),
        'g1',
        'u2',
        false,
        expect.any(String)
      );
    });

    it('carries no ciphertext for a Welcome, whose bundle comes from fetch-proto', async () => {
      queuedRepo.findOne.mockResolvedValue({ id: Q, groupId: 'g1', senderId: 'u2', proto: 'W' });
      describeQueuedFrame.mockResolvedValue(input({ isWelcome: true }));
      const answer = await fetch();
      expect(answer.status === 'frame' && answer.fields.proto).toBe('');
    });

    it('says gone, as an answer, when the row was drained or acknowledged since', async () => {
      queuedRepo.findOne.mockResolvedValue(null);
      await expect(fetch()).resolves.toEqual({ status: 'gone' });
      expect(describeQueuedFrame).not.toHaveBeenCalled();
    });

    it('refuses a silent value it was not given rather than guessing one', async () => {
      await expect(
        controller.fetchWakeFrame(`PushSecret ${SECRET}`, Q, 'user-1', 'phone-1', undefined)
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(fetch('1')).rejects.toBeInstanceOf(BadRequestException);
      expect(queuedRepo.findOne).not.toHaveBeenCalled();
    });

    it('opens nothing without the device secret', async () => {
      await expect(fetch('false', 'PushSecret wrong')).rejects.toBeInstanceOf(ForbiddenException);
      expect(queuedRepo.findOne).not.toHaveBeenCalled();
    });
  });
});
