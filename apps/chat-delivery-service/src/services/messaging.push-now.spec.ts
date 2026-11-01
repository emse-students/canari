/// <reference types="jest" />

/**
 * PUSH-NOW BRINGS A DEFERRED PUSH FORWARD AND DOES NOTHING ELSE.
 *
 * An iPhone page that is not active leaves the frames it receives queued (the notification
 * extension must decrypt them first, or their banner has no content), and asks the server to push
 * them now rather than ten seconds after sending them. Asserted through the real service: the push
 * is sent at once and once only, nothing is deleted, a repeated or foreign ask is a no-op, and a row
 * nobody acknowledged is pushed anyway - the ask is an acceleration, never what the push depends on.
 */
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessagingService } from './messaging.service';
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

const fcmSend = jest.fn();
const G1 = '0b9f3d7e-1111-4222-8333-444455556666';
jest.mock('firebase-admin/app', () => ({ getApps: jest.fn(() => [{}]) }));
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(() => ({ send: fcmSend })),
}));

describe('MessagingService - push-now', () => {
  let service: MessagingService;
  /** Whether the row is still queued, as `runDeferredPush` reads it. */
  let queuedStill: boolean;

  const manager = { findOne: jest.fn(async () => null), query: jest.fn().mockResolvedValue([]) };
  const pushTokenRepo = { find: jest.fn(), delete: jest.fn(), manager };
  const groupRepo = {
    findOne: jest.fn().mockResolvedValue({ name: 'G', isGroup: false }),
    manager,
  };
  const queuedRepo = {
    findOne: jest.fn(async () => (queuedStill ? { id: 'q1' } : null)),
    find: jest.fn(),
    delete: jest.fn(),
    save: jest.fn(),
  };
  const unusedRepo = { find: jest.fn(), findOne: jest.fn(), delete: jest.fn(), save: jest.fn() };

  const queued = {
    id: 'q1',
    recipientId: 'u1',
    deviceId: 'iphone',
    proto: 'AAAA',
    isWelcome: false,
    createdAt: new Date('2026-11-01T10:00:00Z'),
  };
  const schedule = () =>
    (
      service as unknown as { scheduleDeferredPush: (...a: unknown[]) => void }
    ).scheduleDeferredPush(queued, 'trace', G1, 'u2', false);
  const ask = (deviceId = 'iphone', userId = 'u1') =>
    service.pushQueuedNow({ userId, deviceId, messageIds: ['q1'] }, userId, undefined);
  /** Lets the push's own awaits (token read, group read, send) run to their end. */
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    queuedStill = true;
    pushTokenRepo.find.mockResolvedValue([
      { id: 1, userId: 'u1', deviceId: 'iphone', token: 'tok', platform: 'ios', locale: 'fr' },
    ]);
    fcmSend.mockResolvedValue('ok');
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(QueuedMessage), useValue: queuedRepo },
        { provide: getRepositoryToken(GroupMember), useValue: unusedRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: unusedRepo },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: unusedRepo },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: unusedRepo },
        { provide: getRepositoryToken(MlsCommitLog), useValue: unusedRepo },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: unusedRepo },
        { provide: getRepositoryToken(RevokedDevice), useValue: unusedRepo },
        { provide: 'REDIS_CLIENT', useValue: {} },
      ],
    }).compile();
    service = module.get(MessagingService);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends the deferred push at once, and the ten seconds do not send it again', async () => {
    schedule();
    expect(ask()).toEqual({ status: 'ok', count: 1 });
    await flush();
    expect(fcmSend).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(10_000);
    await flush();
    expect(fcmSend).toHaveBeenCalledTimes(1);
  });

  it('deletes nothing - the row stays queued for the pull on return', async () => {
    schedule();
    ask();
    await flush();
    expect(queuedRepo.delete).not.toHaveBeenCalled();
  });

  it('a second ask is a no-op', async () => {
    schedule();
    ask();
    expect(ask()).toEqual({ status: 'ok', count: 0 });
    await flush();
    expect(fcmSend).toHaveBeenCalledTimes(1);
  });

  it("another device's ask brings nothing forward", async () => {
    schedule();
    expect(ask('other-device')).toEqual({ status: 'ok', count: 0 });
    await flush();
    expect(fcmSend).not.toHaveBeenCalled();
  });

  it('a row nobody acknowledged is pushed anyway - the ask only accelerates it', async () => {
    schedule();
    jest.advanceTimersByTime(10_000);
    await flush();
    expect(fcmSend).toHaveBeenCalledTimes(1);
    // And an ask after the push is a no-op, not a second banner.
    expect(ask()).toEqual({ status: 'ok', count: 0 });
  });

  it('a row acknowledged meanwhile is not pushed, asked or not', async () => {
    schedule();
    queuedStill = false;
    ask();
    await flush();
    expect(fcmSend).not.toHaveBeenCalled();
  });
});
