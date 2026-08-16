/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException } from '@nestjs/common';
import { InternalController } from './internal.controller';
import { MessagingService } from '../services/messaging.service';
import { QueuedMessage } from '../entities/queued-message.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { PinVerifier } from '../entities/pin-verifier.entity';
import { GroupInvite } from '../entities/group-invite.entity';

// Firebase Admin is mocked so the message handed to FCM is observable without credentials.
const fcmSend = jest.fn();
jest.mock('firebase-admin/app', () => ({ getApps: jest.fn(() => [{}]) }));
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(() => ({ send: fcmSend })),
}));

/**
 * `POST /internal/push/notify` is the ONE way another service pushes to a user: every community
 * channel message, every silent `channel_read` frame, every post and every form reminder.
 *
 * WHAT THIS PINS, AND WHY IT IS NOT A TEST OF THE BUILDER. `buildInternalApnsRequest` was already
 * covered field by field (push-payload.spec.ts) - and none of that mattered, because this endpoint
 * did not call it. It carried its own `getMessaging().send()` loop, identical to
 * `MessagingService.sendPushToUser` MINUS the `apns` block, and FCM turns a message with no `apns`
 * block into a data-only push: never surfaced by iOS, never handed to the Notification Service
 * Extension. Every community notification was dropped by every iPhone while the endpoint answered
 * `sent`. A green builder test proves nothing about a caller that does not call it.
 *
 * So the assertions below are on the message that actually reaches FCM, through the real
 * controller and the real service.
 */
describe('InternalController - POST internal/push/notify', () => {
  let controller: InternalController;
  const pushTokenRepo = {
    find: jest.fn(),
    delete: jest.fn(),
  };
  /** Repositories this path never touches; present only to satisfy the constructors. */
  const unusedRepo = { find: jest.fn(), findOne: jest.fn(), delete: jest.fn(), save: jest.fn() };
  const redis = { get: jest.fn(), set: jest.fn(), del: jest.fn() };

  const SECRET = 'test-internal-secret';

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.INTERNAL_SECRET = SECRET;
    pushTokenRepo.find.mockResolvedValue([
      { id: 1, userId: 'u1', deviceId: 'iphone', token: 'tok-ios', platform: 'ios' },
    ]);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InternalController],
      providers: [
        MessagingService,
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(QueuedMessage), useValue: unusedRepo },
        { provide: getRepositoryToken(GroupMember), useValue: unusedRepo },
        { provide: getRepositoryToken(Group), useValue: unusedRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: unusedRepo },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: unusedRepo },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: unusedRepo },
        { provide: getRepositoryToken(MlsCommitLog), useValue: unusedRepo },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: unusedRepo },
        { provide: getRepositoryToken(RevokedDevice), useValue: unusedRepo },
        { provide: getRepositoryToken(PinVerifier), useValue: unusedRepo },
        { provide: getRepositoryToken(GroupInvite), useValue: unusedRepo },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();

    controller = module.get<InternalController>(InternalController);
  });

  afterEach(() => {
    delete process.env.INTERNAL_SECRET;
  });

  /**
   * The single message handed to FCM by the call under test. The `apns` block is asserted present
   * here rather than in each case: its ABSENCE is the whole defect, so nothing below should have to
   * cope with it being missing.
   */
  function sentMessage(): {
    data: Record<string, string>;
    apns: { payload: { aps: Record<string, unknown> }; headers: Record<string, string> };
  } {
    expect(fcmSend).toHaveBeenCalledTimes(1);
    const msg = fcmSend.mock.calls[0][0] as {
      data: Record<string, string>;
      apns?: { payload: { aps: Record<string, unknown> }; headers: Record<string, string> };
    };
    expect(msg.apns).toBeDefined();
    if (!msg.apns) throw new Error('no apns block: iOS would never have seen this push');
    return { data: msg.data, apns: msg.apns };
  }

  it('carries an apns alert block for a community channel message', async () => {
    const result = await controller.notifyUser(SECRET, {
      userId: 'u1',
      title: 'general',
      body: '',
      data: { type: 'channel', channelId: 'chan-42', channelName: 'general', mentioned: 'true' },
    });

    expect(result).toEqual({ sent: 1, failed: 0 });
    const msg = sentMessage();
    // Without this block the push never reaches the NSE, so a killed iPhone shows nothing at all.
    expect(msg.apns.headers['apns-push-type']).toBe('alert');
    expect(msg.apns.payload.aps['mutable-content']).toBe(1);
    expect(msg.apns.payload.aps['thread-id']).toBe('channel_chan-42');
    // The data map still reaches Android unchanged.
    expect(msg.data.type).toBe('channel');
    expect(msg.data.mentioned).toBe('true');
  });

  it('carries an apns background block for a silent channel_read frame', async () => {
    await controller.notifyUser(SECRET, {
      userId: 'u1',
      title: 'general',
      body: '',
      data: { type: 'channel_read', channelId: 'chan-42' },
    });

    const msg = sentMessage();
    // Background, so it wakes the app to clear the banner WITHOUT posting one of its own - which is
    // also why the NSE never sees this type (the extension runs on alert pushes only).
    expect(msg.apns.headers['apns-push-type']).toBe('background');
    expect(msg.apns.payload.aps['content-available']).toBe(1);
    expect(msg.apns.payload.aps['mutable-content']).toBeUndefined();
    expect(msg.apns.payload.aps.alert).toBeUndefined();
  });

  it('carries an apns alert block for a post / form reminder', async () => {
    await controller.notifyUser(SECRET, {
      userId: 'u1',
      title: 'BDE',
      body: 'Nouveau post',
      data: { type: 'social', postId: 'p1' },
    });

    const msg = sentMessage();
    expect(msg.apns.headers['apns-push-type']).toBe('alert');
    expect((msg.apns.payload.aps.alert as { body: string }).body).toBe('Nouveau post');
  });

  it('refuses a caller without the internal secret, before any send', async () => {
    await expect(
      controller.notifyUser('wrong', { userId: 'u1', title: 't', body: '', data: {} })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fcmSend).not.toHaveBeenCalled();
  });

  it('sends nothing when the payload names no user, and says so', async () => {
    const result = await controller.notifyUser(SECRET, {
      userId: '',
      title: 'general',
      body: '',
      data: {},
    });
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(fcmSend).not.toHaveBeenCalled();
  });
});
