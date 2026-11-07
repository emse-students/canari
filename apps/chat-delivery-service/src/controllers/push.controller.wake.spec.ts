/// <reference types="jest" />

import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { PushSecretThrottlerGuard } from '../guards/push-secret-throttler.guard';
import { PushSecretGuard } from '../guards/push-secret.guard';
import { PushController } from './push.controller';
import { PushToken } from '../entities/push-token.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';
import type { PushMessageInput } from '../services/push-payload';
import { serveEnvelope, sweepDeviceEnvelopes } from '../utils/push-envelope';

jest.mock('../utils/push-envelope', () => ({
  serveEnvelope: jest.fn(),
  sweepDeviceEnvelopes: jest.fn(),
}));
const serve = serveEnvelope as jest.MockedFunction<typeof serveEnvelope>;
const sweep = sweepDeviceEnvelopes as jest.MockedFunction<typeof sweepDeviceEnvelopes>;

/**
 * The two server halves a wake-up push needs from this controller
 * (docs/wiki/backlog.d/push-payloads-carry-nothing-for-google-and-apple.md):
 *
 * - `POST /mls/push/register` records whether the binary understands a wake, on EVERY registration;
 * - `GET /mls/push/wake` hands the woken device the map the full push would have carried, behind
 *   `PushSecretGuard` and its per-user throttler, or says the row is gone.
 */
describe('PushController - the wake-up push', () => {
  const SECRET = 'the-push-secret';
  const Q = '7c1d2e3f-aaaa-4bbb-8ccc-dddddddddddd';
  let controller: PushController;
  const pushTokenRepo = {
    upsert: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn(),
    update: jest.fn(),
    manager: { tag: 'the chat-delivery manager' },
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
    sweep.mockResolvedValue(0);
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
        expect(row).toHaveProperty('wakeVersion', 0);
      }
    });

    it('reads a step-1 binary (`wake: true`) as version 1', async () => {
      await controller.registerPushToken({ ...body, wake: true }, 'user-1', undefined);
      expect(pushTokenRepo.upsert.mock.calls[0][0]).toMatchObject({
        wakeVersion: 1,
        wakeCapable: true,
      });
    });

    it('stores a declared version, capped at the highest this server serves', async () => {
      await controller.registerPushToken({ ...body, wakeVersion: 2 }, 'user-1', undefined);
      await controller.registerPushToken({ ...body, wakeVersion: 7 }, 'user-1', undefined);
      for (const [row] of pushTokenRepo.upsert.mock.calls) {
        expect(row).toMatchObject({ wakeVersion: 2, wakeCapable: true });
      }
    });

    it('stores 0 for an unreadable version, and accuses it', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      await controller.registerPushToken(
        { ...body, wake: true, wakeVersion: '2' as unknown as number },
        'user-1',
        undefined
      );
      expect(pushTokenRepo.upsert.mock.calls[0][0]).toMatchObject({
        wakeVersion: 0,
        wakeCapable: false,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable wakeVersion'));
    });

    it('sweeps the envelopes of the device that registered - the app is open', async () => {
      sweep.mockResolvedValue(3);
      await controller.registerPushToken(body, 'user-1', undefined);
      expect(sweep).toHaveBeenCalledWith(pushTokenRepo.manager, 'user-1', 'phone-1');
      expect(sweep.mock.invocationCallOrder[0]).toBeGreaterThan(
        pushTokenRepo.upsert.mock.invocationCallOrder[0]
      );
    });

    it('still hands the device its secret when the sweep fails, and accuses it', async () => {
      sweep.mockRejectedValue(new Error('db down'));
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      const answer = await controller.registerPushToken(body, 'user-1', undefined);
      expect(answer).toMatchObject({ status: 'registered' });
      expect(answer.pushSecret).toEqual(expect.any(String));
      expect(error).toHaveBeenCalledWith(expect.stringContaining('register sweep FAILED'));
    });
  });

  describe('GET mls/push/wake?envelopeId=', () => {
    const E = '11111111-2222-4333-8444-555555555555';
    const fetchEnvelope = (envelopeId: string = E) =>
      controller.fetchWakeFrame(undefined, 'user-1', 'phone-1', undefined, envelopeId);
    const content = {
      title: 'BDE - #general',
      body: '',
      data: { type: 'channel', channelId: 'c-1' },
      inline: { ciphertext: 'C'.repeat(9_000) },
    };

    it('answers the full Android map, its inline group whatever its size', async () => {
      serve.mockResolvedValue({
        kind: 'served',
        content,
        times: 1,
        platform: 'android',
        locale: 'fr',
      });
      const answer = await fetchEnvelope();
      expect(serve).toHaveBeenCalledWith(pushTokenRepo.manager, E, 'user-1', 'phone-1');
      expect(answer).toMatchObject({
        status: 'push',
        fields: {
          type: 'channel',
          channelId: 'c-1',
          ciphertext: content.inline.ciphertext,
          title: 'BDE - #general',
        },
        presentation: { threadId: 'channel_c-1', title: 'BDE - #general' },
      });
      expect(queuedRepo.findOne).not.toHaveBeenCalled();
    });

    it('serves a repeat the same map, and logs it as served again', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      serve.mockResolvedValue({ kind: 'served', content, times: 2, platform: 'ios', locale: 'en' });
      const answer = await fetchEnvelope();
      expect(answer.status).toBe('push');
      expect(answer.status === 'push' && answer.fields).not.toHaveProperty('title');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('served again times=2'));
    });

    it("answers gone for another registration's envelope, and logs it foreign", async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      serve.mockResolvedValue({ kind: 'foreign' });
      await expect(fetchEnvelope()).resolves.toEqual({ status: 'gone' });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('[PUSH_WAKE] foreign'));
    });

    it('answers gone when the envelope is not there', async () => {
      serve.mockResolvedValue({ kind: 'gone' });
      await expect(fetchEnvelope()).resolves.toEqual({ status: 'gone' });
    });

    it('refuses an id that is not a uuid, and a request naming both keys', async () => {
      await expect(fetchEnvelope('nope')).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        controller.fetchWakeFrame(Q, 'user-1', 'phone-1', 'false', E)
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(serve).not.toHaveBeenCalled();
    });
  });

  describe('GET mls/push/wake', () => {
    const fetch = (silent = 'false', messageId = Q) =>
      controller.fetchWakeFrame(messageId, 'user-1', 'phone-1', silent);

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
      // What iOS's `aps` would have said, for the extension to apply (WP-W5).
      expect(answer.presentation).toMatchObject({ threadId: 'g1', title: 'Alice' });
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
        expect.any(String),
        'fetch'
      );
    });

    it('serves a legacy content row as the full push does, and accuses it', async () => {
      queuedRepo.findOne.mockResolvedValue({
        id: Q,
        groupId: 'g1',
        senderId: 'u2',
        proto: null,
        content: 'LEGACY',
      });
      describeQueuedFrame.mockResolvedValue(input());
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const answer = await fetch();
      expect(answer.status === 'frame' && answer.fields.proto).toBe('LEGACY');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('LEGACY_CONTENT_ROW'));
    });

    it('refuses an id that is not a uuid with a 400, before the database sees it', async () => {
      await expect(fetch('false', 'not-a-uuid')).rejects.toBeInstanceOf(BadRequestException);
      expect(queuedRepo.findOne).not.toHaveBeenCalled();
    });

    it('is guarded by the PushSecret, then counted per user, in that order', () => {
      const route = Object.getOwnPropertyDescriptor(PushController.prototype, 'fetchWakeFrame');
      const guards = Reflect.getMetadata('__guards__', route?.value as object) as unknown[];
      expect(guards).toEqual([PushSecretGuard, PushSecretThrottlerGuard]);
    });

    it('tells every cache not to keep the answer', () => {
      const route = Object.getOwnPropertyDescriptor(PushController.prototype, 'fetchWakeFrame');
      const headers = Reflect.getMetadata('__headers__', route?.value as object) as unknown[];
      expect(headers).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
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
        controller.fetchWakeFrame(Q, 'user-1', 'phone-1', undefined)
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(fetch('1')).rejects.toBeInstanceOf(BadRequestException);
      expect(queuedRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('PushSecretGuard on a GET', () => {
    const guardContext = (req: Record<string, unknown>) =>
      ({ switchToHttp: () => ({ getRequest: () => req }) }) as never;
    const guard = () => new PushSecretGuard(pushTokenRepo as never);

    it('proves the device the QUERY names, and opens nothing without its secret', async () => {
      const req = {
        method: 'GET',
        headers: { authorization: `PushSecret ${SECRET}` },
        query: { userId: 'user-1', deviceId: 'phone-1' },
      };
      await expect(guard().canActivate(guardContext(req))).resolves.toBe(true);
      expect(pushTokenRepo.findOne).toHaveBeenCalledWith({
        where: { userId: 'user-1', deviceId: 'phone-1' },
      });
      await expect(
        guard().canActivate(
          guardContext({ ...req, headers: { authorization: 'PushSecret wrong' } })
        )
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('never reads a GET body, so a body cannot name another device', async () => {
      const req = {
        method: 'GET',
        headers: { authorization: `PushSecret ${SECRET}` },
        query: {},
        body: { userId: 'user-1', deviceId: 'phone-1' },
      };
      await expect(guard().canActivate(guardContext(req))).rejects.toBeInstanceOf(
        BadRequestException
      );
      expect(pushTokenRepo.findOne).not.toHaveBeenCalled();
    });
  });
});
