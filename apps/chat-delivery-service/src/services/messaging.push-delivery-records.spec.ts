/// <reference types="jest" />

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
import type { PushMessageInput } from './push-payload';
import { PUSH_DELIVERY_RECORDER } from '../utils/push-delivery-records';

const fcmSend = jest.fn();
jest.mock('firebase-admin/app', () => ({ getApps: jest.fn(() => [{}]) }));
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(() => ({ send: fcmSend })),
}));

/**
 * THE PUSH DELIVERY RECORD ON THE SEND PATHS (migration 054, owner 2026-11-21): a `sendPushToUser`
 * push and a message fan-out each write their record ONCE for the batch - one counter upsert, one
 * `lastPushSentAt` stamp of the accepted devices - after their pushes, and a record that cannot be
 * written never changes what the send answers.
 */
describe('MessagingService - the push delivery record', () => {
  let service: MessagingService;
  let warn: jest.SpyInstance;
  /** What the record's writes answer; an Error makes them throw. */
  let recordAnswer: unknown[] | Error;
  const manager = {
    findOne: jest.fn().mockResolvedValue(null),
    query: jest.fn(async (sql: string, _params?: unknown[]) => {
      if (/push_delivery_daily|lastPushSentAt/.test(sql)) {
        if (recordAnswer instanceof Error) throw recordAnswer;
        return recordAnswer;
      }
      return [];
    }),
  };
  const pushTokenRepo = { find: jest.fn(), delete: jest.fn(), manager };
  const unusedRepo = { find: jest.fn(), findOne: jest.fn(), delete: jest.fn(), save: jest.fn() };

  const token = (id: string, userId: string, deviceId: string, platform: 'android' | 'ios') => ({
    id,
    userId,
    deviceId,
    token: `tok-${deviceId}`,
    platform,
    locale: 'fr',
    wakeVersion: 0,
    wakeCapable: false,
  });
  const notRegistered = Object.assign(new Error('Requested entity was not found.'), {
    code: 'messaging/registration-token-not-registered',
  });
  /** The record is written without being awaited: let it run. */
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await PUSH_DELIVERY_RECORDER.settled();
  };
  const writes = (pattern: RegExp) =>
    manager.query.mock.calls.filter(([sql]) => pattern.test(sql as string));

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    recordAnswer = [];
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(Group), useValue: unusedRepo },
        { provide: getRepositoryToken(QueuedMessage), useValue: unusedRepo },
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
  });

  afterEach(() => jest.restoreAllMocks());

  describe('sendPushToUser', () => {
    const push = () =>
      service.sendPushToUser('u1', 'Alice', 'a commenté', {
        type: 'social',
        contentKey: 'social_comment',
      });

    it('counts the batch under kind social, and stamps only the device the provider accepted', async () => {
      pushTokenRepo.find.mockResolvedValue([
        token('t-ios', 'u1', 'iphone', 'ios'),
        token('t-and', 'u1', 'pixel', 'android'),
      ]);
      fcmSend.mockImplementation(async (m: { token: string }) => {
        if (m.token === 'tok-iphone') throw notRegistered;
        return 'id';
      });

      await expect(push()).resolves.toEqual({ sent: 1, failed: 1 });
      await settle();

      const increments = writes(/push_delivery_daily/);
      expect(increments).toHaveLength(1);
      expect(increments[0][1]).toEqual([
        'social',
        ['android', 'android', 'ios', 'ios', 'ios'],
        ['accepted', 'attempted', 'attempted', 'failed', 'pruned'],
        ['', '', '', 'messaging/registration-token-not-registered', ''],
        [1, 1, 1, 1, 1],
      ]);
      expect(writes(/"lastPushSentAt"/).map(([, p]) => p)).toEqual([[['t-and']]]);
    });

    it('a record that cannot be written is a WARN, and the send answers exactly the same', async () => {
      pushTokenRepo.find.mockResolvedValue([token('t-and', 'u1', 'pixel', 'android')]);
      fcmSend.mockResolvedValue('id');
      recordAnswer = new Error('connection terminated');

      await expect(push()).resolves.toEqual({ sent: 1, failed: 0 });
      await settle();

      const lines = warn.mock.calls.map(([m]) => String(m));
      expect(lines.some((l) => l.includes('daily counts NOT recorded kind=social'))).toBe(true);
      expect(lines.some((l) => l.includes('lastPushSentAt NOT stamped kind=social'))).toBe(true);
    });

    it('a token prune that throws still records the batch - in a finally', async () => {
      pushTokenRepo.find.mockResolvedValue([token('t-ios', 'u1', 'iphone', 'ios')]);
      fcmSend.mockRejectedValue(notRegistered);
      pushTokenRepo.delete.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(push()).rejects.toThrow('connection terminated');
      await settle();

      const increments = writes(/push_delivery_daily/);
      expect(increments).toHaveLength(1);
      // Failed, never pruned: the row is still there.
      expect(increments[0][1]).toEqual([
        'social',
        ['ios', 'ios'],
        ['attempted', 'failed'],
        ['', 'messaging/registration-token-not-registered'],
        [1, 1],
      ]);
    });

    it('writes nothing when no push was attempted', async () => {
      pushTokenRepo.find.mockResolvedValue([]);
      await push();
      await settle();
      expect(writes(/push_delivery_daily|lastPushSentAt/)).toEqual([]);
    });
  });

  describe('a message fan-out', () => {
    const input = (queuedMessageId: string): PushMessageInput => ({
      groupId: 'g1',
      queuedMessageId,
      senderId: 's1',
      senderName: 'Alice',
      groupName: '',
      isGroup: false,
      isKeyDistribution: false,
      proto: '',
      silent: false,
      isWelcome: false,
      createdAt: '2026-11-21T10:00:00.000Z',
    });
    const queued = (i: number) =>
      ({
        id: `q${i}`,
        recipientId: `u${i}`,
        deviceId: `d${i}`,
        groupId: 'g1',
        senderId: 's1',
        proto: 'AAAA',
        createdAt: new Date(0),
      }) as unknown as QueuedMessage;

    it('records three offline devices in ONE upsert and ONE stamp, after the last push settled', async () => {
      jest
        .spyOn(service, 'describeQueuedFrame')
        .mockImplementation(async (q: QueuedMessage) => input(q.id));
      pushTokenRepo.find.mockImplementation(
        async ({ where }: { where: { userId: string; deviceId: string } }) => [
          token(`t-${where.deviceId}`, where.userId, where.deviceId, 'android'),
        ]
      );
      fcmSend.mockImplementation(async (m: { token: string }) => {
        if (m.token === 'tok-d2')
          throw Object.assign(new Error('x'), { code: 'messaging/internal-error' });
        return 'id';
      });
      const deliverQueuedRows = (
        service as unknown as {
          deliverQueuedRows: (
            rows: QueuedMessage[],
            online: Map<string, boolean>,
            silent: boolean,
            durable: boolean,
            traceId: string
          ) => Promise<number>;
        }
      ).deliverQueuedRows.bind(service);

      await deliverQueuedRows([queued(1), queued(2), queued(3)], new Map(), false, true, 'tr');
      await settle();
      await settle();

      const increments = writes(/push_delivery_daily/);
      expect(increments).toHaveLength(1);
      expect(increments[0][1]).toEqual([
        'message',
        ['android', 'android', 'android'],
        ['accepted', 'attempted', 'failed'],
        ['', '', 'messaging/internal-error'],
        [2, 3, 1],
      ]);
      expect(writes(/"lastPushSentAt"/).map(([, p]) => p)).toEqual([[['t-d1', 't-d3']]]);
    });
  });
});
