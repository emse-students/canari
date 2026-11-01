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

const fcmSend = jest.fn();
/** A private conversation's id is a uuid, as `dm_group_members.groupId` stores it. */
const G1 = '0b9f3d7e-1111-4222-8333-444455556666';
jest.mock('firebase-admin/app', () => ({ getApps: jest.fn(() => [{}]) }));
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(() => ({ send: fcmSend })),
}));

/**
 * The server is the ONE place a notification category is honoured: a muted social push is not sent
 * at all, and a muted MESSAGE is still delivered (the ciphertext is account state) but silent.
 * Asserted on what reaches FCM, through the real service.
 */
describe('MessagingService - notification categories', () => {
  let service: MessagingService;
  /** What the preference row holds for the recipient; null = never set anything. */
  let disabledRow: { disabledCategories: string[] } | null;
  /** The recipient's membership row in the conversation; null = no row (reads as `all`). */
  let memberRow: { notifLevel: string } | null;

  const manager = {
    findOne: jest.fn(async (entity: unknown) => (entity === GroupMember ? memberRow : disabledRow)),
    query: jest.fn().mockResolvedValue([]),
  };
  const pushTokenRepo = { find: jest.fn(), delete: jest.fn(), manager };
  const groupRepo = {
    findOne: jest.fn().mockResolvedValue({ name: 'G', isGroup: false }),
    manager,
  };
  const unusedRepo = { find: jest.fn(), findOne: jest.fn(), delete: jest.fn(), save: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    disabledRow = null;
    memberRow = null;
    pushTokenRepo.find.mockResolvedValue([
      { id: 1, userId: 'u1', deviceId: 'pixel', token: 'tok', platform: 'android' },
    ]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(QueuedMessage), useValue: unusedRepo },
        { provide: getRepositoryToken(GroupMember), useValue: unusedRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: unusedRepo },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: unusedRepo },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: unusedRepo },
        { provide: getRepositoryToken(MlsCommitLog), useValue: unusedRepo },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: unusedRepo },
        { provide: getRepositoryToken(RevokedDevice), useValue: unusedRepo },
        // The banner claim (`push-claim.ts`) always wins here: no ACK is ever in play in this file.
        { provide: 'REDIS_CLIENT', useValue: { call: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();
    service = module.get(MessagingService);
  });

  describe('sendPushToUser (social, salons, forms, events)', () => {
    it('sends everything when the account never set a preference', async () => {
      const r = await service.sendPushToUser('u1', 't', 'b', {
        type: 'social',
        contentKey: 'social_comment',
      });
      expect(r).toEqual({ sent: 1, failed: 0 });
      expect(fcmSend).toHaveBeenCalledTimes(1);
    });

    it('does not send a push whose category is switched off, and reads no token', async () => {
      disabledRow = { disabledCategories: ['posts'] };
      const r = await service.sendPushToUser('u1', 't', 'b', {
        type: 'social',
        contentKey: 'social_association_post',
      });
      expect(r).toEqual({ sent: 0, failed: 0 });
      expect(fcmSend).not.toHaveBeenCalled();
      expect(pushTokenRepo.find).not.toHaveBeenCalled();
    });

    it('skips a device KNOWN to run a build below the push floor, keeps an unknown one, and never forwards the floor', async () => {
      pushTokenRepo.find.mockResolvedValue([
        { id: 1, userId: 'u1', deviceId: 'old', token: 't-old', platform: 'android' },
        { id: 2, userId: 'u1', deviceId: 'new', token: 't-new', platform: 'android' },
        { id: 3, userId: 'u1', deviceId: 'blank', token: 't-blank', platform: 'android' },
      ]);
      unusedRepo.find.mockResolvedValue([
        { userId: 'u1', deviceId: 'old', deviceAppVersion: '1.5.3' },
        { userId: 'u1', deviceId: 'new', deviceAppVersion: '1.5.4-alpha.1' },
      ]);
      const r = await service.sendPushToUser('u1', 't', 'b', {
        type: 'social',
        contentKey: 'social_live_started',
        minAppVersion: '1.5.4',
      });
      expect(r).toEqual({ sent: 2, failed: 0 });
      const tokens = fcmSend.mock.calls.map((c) => (c[0] as { token: string }).token);
      expect(tokens).toEqual(['t-new', 't-blank']);
      expect(JSON.stringify(fcmSend.mock.calls)).not.toContain('minAppVersion');
    });

    it('only mutes the category named: another category still goes out', async () => {
      disabledRow = { disabledCategories: ['posts'] };
      await service.sendPushToUser('u1', 't', 'b', { type: 'social', contentKey: 'event_updated' });
      expect(fcmSend).toHaveBeenCalledTimes(1);
    });

    it('mutes salon messages and direct-message reactions under their own switches', async () => {
      disabledRow = { disabledCategories: ['channels', 'reactions'] };
      await service.sendPushToUser('u1', 't', 'b', { type: 'channel', channelId: 'c' });
      await service.sendPushToUser('u1', 't', 'b', { type: 'social', reaction: 'true' });
      expect(fcmSend).not.toHaveBeenCalled();
    });

    it('never refuses a read frame or a call ring, whatever is switched off', async () => {
      disabledRow = { disabledCategories: ['messages', 'channels', 'posts', 'forms'] };
      await service.sendPushToUser('u1', 't', 'b', { type: 'channel_read', channelId: 'c' });
      await service.sendPushToUser('u1', 't', 'b', { type: 'call_ring' });
      expect(fcmSend).toHaveBeenCalledTimes(2);
    });

    it('refuses a reaction in a conversation set to mentions or none - a reaction is never a mention', async () => {
      for (const level of ['mentions', 'none']) {
        memberRow = { notifLevel: level };
        const r = await service.sendPushToUser('u1', 't', 'b', {
          type: 'social',
          reaction: 'true',
          groupId: G1,
        });
        expect(r).toEqual({ sent: 0, failed: 0 });
      }
      expect(fcmSend).not.toHaveBeenCalled();
    });

    it('reads no level, and warns nothing, for a SALON reaction - its groupId is channel_<id>', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      await service.sendPushToUser('u1', 't', 'b', {
        type: 'social',
        reaction: 'true',
        groupId: 'channel_5d7c',
      });
      const levelReads = manager.findOne.mock.calls.filter((c) => c[0] === GroupMember);
      expect(levelReads).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
      expect(fcmSend).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('sends a reaction in a conversation left at all', async () => {
      memberRow = { notifLevel: 'all' };
      await service.sendPushToUser('u1', 't', 'b', {
        type: 'social',
        reaction: 'true',
        groupId: G1,
      });
      expect(fcmSend).toHaveBeenCalledTimes(1);
    });

    it('delivers, and says so, when the preference cannot be read', async () => {
      manager.findOne.mockRejectedValueOnce(new Error('relation does not exist'));
      const r = await service.sendPushToUser('u1', 't', 'b', {
        type: 'social',
        contentKey: 'social_mention',
      });
      expect(r.sent).toBe(1);
    });
  });

  describe('MLS message push (sendFcmForQueued)', () => {
    const queued = {
      id: 'q1',
      recipientId: 'u1',
      deviceId: 'pixel',
      proto: 'AAAA',
      isWelcome: false,
      createdAt: new Date('2026-10-05T10:00:00Z'),
    };
    const send = (silent = false, senderId = 'u2') =>
      (
        service as unknown as {
          sendFcmForQueued: (...a: unknown[]) => Promise<void>;
        }
      ).sendFcmForQueued(queued, 'trace', G1, senderId, silent);
    const sentData = () => (fcmSend.mock.calls[0][0] as { data: Record<string, string> }).data;

    it('draws a notification by default', async () => {
      await send();
      expect(sentData().silent).toBe('false');
    });

    it('still delivers the frame but marks it silent when messages are switched off', async () => {
      disabledRow = { disabledCategories: ['messages'] };
      await send();
      expect(fcmSend).toHaveBeenCalledTimes(1);
      expect(sentData().silent).toBe('true');
      // The sender and conversation names stay off a silent frame (confidentiality, not size).
      expect(sentData().senderName).toBeUndefined();
    });

    it('does not read the preference for a frame that was already silent', async () => {
      disabledRow = { disabledCategories: ['messages'] };
      await send(true);
      expect(manager.findOne).not.toHaveBeenCalled();
    });

    it('sends the frame silent, still delivered, when the conversation is set to none', async () => {
      memberRow = { notifLevel: 'none' };
      await send();
      expect(fcmSend).toHaveBeenCalledTimes(1);
      expect(sentData().silent).toBe('true');
      expect(sentData().notifLevel).toBeUndefined();
    });

    it('hands a mentions conversation to the device: visible, carrying notifLevel=mentions', async () => {
      memberRow = { notifLevel: 'mentions' };
      await send();
      expect(sentData().silent).toBe('false');
      expect(sentData().notifLevel).toBe('mentions');
    });

    it('carries no notifLevel at the default level', async () => {
      await send();
      expect(sentData().notifLevel).toBeUndefined();
    });

    it('delivers as all, and says so, when the conversation level cannot be read', async () => {
      manager.findOne
        .mockImplementationOnce(async () => null)
        .mockRejectedValueOnce(new Error('column does not exist'));
      await send();
      expect(sentData().silent).toBe('false');
      expect(sentData().notifLevel).toBeUndefined();
    });

    it('leaves other categories alone', async () => {
      disabledRow = { disabledCategories: ['posts'] };
      await send();
      expect(sentData().silent).toBe('false');
    });
  });
});
