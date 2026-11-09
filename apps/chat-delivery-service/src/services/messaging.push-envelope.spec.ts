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
import { storeEnvelopes } from '../utils/push-envelope';

const fcmSend = jest.fn();
jest.mock('firebase-admin/app', () => ({ getApps: jest.fn(() => [{}]) }));
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(() => ({ send: fcmSend })),
}));
jest.mock('../utils/push-envelope', () => ({ storeEnvelopes: jest.fn() }));
const store = storeEnvelopes as jest.MockedFunction<typeof storeEnvelopes>;

const E1 = '11111111-2222-4333-8444-555555555555';
const E2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';

/**
 * THE ENVELOPE WAKE (content-free push WP-W3, docs/wiki/protocols/content-free-push.md section
 * 3.2), asserted on what reaches FCM through the real `sendPushToUser`: two locks ANDed (the
 * estate's `push_mode` and the token's `wakeVersion >= 2`), the push stored before the wake leaves,
 * a wake naming nothing, and no full push in place of a wake that could not be prepared.
 */
describe('MessagingService - the envelope wake', () => {
  let service: MessagingService;
  /** What `SELECT push_mode FROM platform_config` answers; an Error makes the query throw. */
  let modeRows: unknown[] | Error;
  let errorLog: jest.SpyInstance;
  const manager = {
    findOne: jest.fn().mockResolvedValue(null),
    query: jest.fn(async (sql: string) => {
      if (!/push_mode/.test(sql)) return [];
      if (modeRows instanceof Error) throw modeRows;
      return modeRows;
    }),
  };
  const pushTokenRepo = { find: jest.fn(), delete: jest.fn(), manager };
  const unusedRepo = { find: jest.fn(), findOne: jest.fn(), delete: jest.fn(), save: jest.fn() };

  const token = (
    id: string,
    deviceId: string,
    platform: 'android' | 'ios',
    wakeVersion: number,
    wakeCapable = wakeVersion >= 1
  ) => ({
    id,
    userId: 'u1',
    deviceId,
    token: `tok-${deviceId}`,
    platform,
    locale: 'fr',
    wakeVersion,
    wakeCapable,
  });

  const salon = {
    type: 'channel',
    channelId: 'c-1',
    channelName: 'secret-salon',
    workspaceName: 'Secret community',
    senderId: 'u-2',
  };
  const inline = { ciphertext: 'CIPHER', seedFrame: 'SEED' };
  const pushSalon = () =>
    service.sendPushToUser('u1', 'Secret community - #secret-salon', '', salon, inline);
  const sent = (i = 0) =>
    fcmSend.mock.calls[i][0] as {
      token: string;
      data?: Record<string, string>;
      android?: Record<string, unknown>;
      apns?: { payload: Record<string, unknown>; headers: Record<string, string> };
    };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    modeRows = [{ push_mode: 'wake' }];
    store.mockImplementation(async (_m, _u, deviceIds) => {
      const ids = [E1, E2];
      return { ids: new Map(deviceIds.map((d, i) => [d, ids[i]])), notWoken: new Map() };
    });
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

  it('stores the push, then sends Android a wake of exactly three fields', async () => {
    pushTokenRepo.find.mockResolvedValue([token('t1', 'pixel', 'android', 2)]);
    await expect(pushSalon()).resolves.toEqual({ sent: 1, failed: 0 });
    expect(store).toHaveBeenCalledWith(
      manager,
      'u1',
      ['pixel'],
      { title: 'Secret community - #secret-salon', body: '', data: salon, inline },
      expect.anything(),
      expect.any(String)
    );
    expect(store.mock.invocationCallOrder[0]).toBeLessThan(fcmSend.mock.invocationCallOrder[0]);
    expect(sent().data).toEqual({ type: 'wake', envelopeId: E1, silent: 'false' });
    expect(sent().android).toEqual({ priority: 'high' });
    expect(sent().apns).toBeUndefined();
  });

  it('sends iOS an alert that names neither the salon, the community nor the author', async () => {
    pushTokenRepo.find.mockResolvedValue([token('t1', 'iphone', 'ios', 2)]);
    await pushSalon();
    const serialised = JSON.stringify(sent().apns);
    for (const secret of ['secret-salon', 'Secret community', 'u-2', 'c-1', 'CIPHER', 'SEED']) {
      expect(serialised).not.toContain(secret);
    }
    const aps = sent().apns!.payload.aps as Record<string, unknown>;
    expect(aps.alert).toEqual({ title: 'Canari', body: 'Nouveau message' });
    expect(aps['thread-id']).toBeUndefined();
    expect(sent().apns!.payload).toMatchObject({ type: 'wake', envelopeId: E1, silent: 'false' });
  });

  it('keeps a salon read a silent background wake', async () => {
    pushTokenRepo.find.mockResolvedValue([token('t1', 'iphone', 'ios', 2)]);
    await service.sendPushToUser('u1', 'secret-salon', '', {
      type: 'channel_read',
      channelId: 'c-1',
    });
    expect(sent().apns!.payload).toEqual({
      aps: { 'content-available': 1 },
      type: 'wake',
      envelopeId: E1,
      silent: 'true',
    });
    expect(sent().apns!.headers['apns-push-type']).toBe('background');
  });

  it('sends the full push to a binary below version 2, and reads neither switch nor envelope', async () => {
    pushTokenRepo.find.mockResolvedValue([token('t1', 'pixel', 'android', 1)]);
    await pushSalon();
    expect(sent().data).toMatchObject({ type: 'channel', channelName: 'secret-salon' });
    expect(manager.query).not.toHaveBeenCalledWith(expect.stringMatching(/push_mode/));
    expect(store).not.toHaveBeenCalled();
  });

  it('sends the full push to a version-2 binary while the switch is full', async () => {
    modeRows = [{ push_mode: 'full' }];
    pushTokenRepo.find.mockResolvedValue([token('t1', 'pixel', 'android', 2)]);
    await pushSalon();
    expect(sent().data).toMatchObject({ type: 'channel', ciphertext: 'CIPHER' });
    expect(store).not.toHaveBeenCalled();
  });

  it('wakes the capable device and sends the full push to the other, in one send', async () => {
    pushTokenRepo.find.mockResolvedValue([
      token('t1', 'pixel', 'android', 2),
      token('t2', 'old-iphone', 'ios', 1),
    ]);
    await expect(pushSalon()).resolves.toEqual({ sent: 2, failed: 0 });
    expect(store.mock.calls[0][2]).toEqual(['pixel']);
    expect(sent(0).data).toEqual({ type: 'wake', envelopeId: E1, silent: 'false' });
    expect(sent(1).apns!.payload).toMatchObject({ type: 'channel', channelName: 'secret-salon' });
  });

  it('sends a capable device NOTHING when the switch cannot be read - never the full push', async () => {
    modeRows = new Error('connection reset');
    pushTokenRepo.find.mockResolvedValue([
      token('t1', 'pixel', 'android', 2),
      token('t2', 'old-iphone', 'ios', 0),
    ]);
    await expect(pushSalon()).resolves.toEqual({ sent: 1, failed: 1 });
    expect(fcmSend).toHaveBeenCalledTimes(1);
    expect(sent().token).toBe('tok-old-iphone');
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('push_mode unreadable'));
  });

  it('sends a capable device NOTHING when its envelope cannot be stored - never the full push', async () => {
    store.mockRejectedValue(new Error('FK violation'));
    pushTokenRepo.find.mockResolvedValue([token('t1', 'pixel', 'android', 2)]);
    await expect(pushSalon()).resolves.toEqual({ sent: 0, failed: 1 });
    expect(fcmSend).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('[PUSH_ENVELOPE]'));
  });

  it('does not wake a device whose new envelope the cap evicted at once, and calls it no failure', async () => {
    store.mockResolvedValue({ ids: new Map(), notWoken: new Map([['pixel', 'evicted']]) });
    pushTokenRepo.find.mockResolvedValue([token('t1', 'pixel', 'android', 2)]);
    await expect(
      service.sendPushToUser('u1', 'x', '', { type: 'channel_read', channelId: 'c-1' })
    ).resolves.toEqual({ sent: 0, failed: 0 });
    expect(fcmSend).not.toHaveBeenCalled();
  });

  it("wakes the account's other devices when one registration went since it was read", async () => {
    store.mockResolvedValue({
      ids: new Map([['tablet', E2]]),
      notWoken: new Map([['pixel', 'registration-gone']]),
    });
    pushTokenRepo.find.mockResolvedValue([
      token('t1', 'pixel', 'android', 2),
      token('t2', 'tablet', 'android', 2),
    ]);
    await expect(pushSalon()).resolves.toEqual({ sent: 1, failed: 0 });
    expect(fcmSend).toHaveBeenCalledTimes(1);
    expect(sent().token).toBe('tok-tablet');
    expect(sent().data).toEqual({ type: 'wake', envelopeId: E2, silent: 'false' });
  });

  it('sends the full push to a version-2 row a pre-046 server re-registered (wakeCapable false)', async () => {
    pushTokenRepo.find.mockResolvedValue([token('t1', 'pixel', 'android', 2, false)]);
    await pushSalon();
    expect(sent().data).toMatchObject({ type: 'channel', channelName: 'secret-salon' });
    expect(manager.query).not.toHaveBeenCalledWith(expect.stringMatching(/push_mode/));
    expect(store).not.toHaveBeenCalled();
  });

  it('stores nothing for a push its category refuses', async () => {
    manager.findOne.mockResolvedValueOnce({ disabledCategories: ['posts'] });
    pushTokenRepo.find.mockResolvedValue([token('t1', 'pixel', 'android', 2)]);
    await service.sendPushToUser('u1', 't', 'b', {
      type: 'social',
      contentKey: 'social_association_post',
    });
    expect(store).not.toHaveBeenCalled();
    expect(fcmSend).not.toHaveBeenCalled();
  });

  it('never forwards the server-only floor into the envelope', async () => {
    pushTokenRepo.find.mockResolvedValue([token('t1', 'pixel', 'android', 2)]);
    unusedRepo.find.mockResolvedValueOnce([]);
    await service.sendPushToUser('u1', 't', 'b', { type: 'social', minAppVersion: '1.0.0' });
    expect(store.mock.calls[0][3].data).toEqual({ type: 'social' });
  });
});
