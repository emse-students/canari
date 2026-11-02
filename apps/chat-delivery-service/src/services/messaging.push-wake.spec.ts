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
const G1 = '0b9f3d7e-1111-4222-8333-444455556666';
jest.mock('firebase-admin/app', () => ({ getApps: jest.fn(() => [{}]) }));
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(() => ({ send: fcmSend })),
}));

/**
 * THE CONTENT-FREE WAKE-UP PUSH, asserted on what reaches FCM through the real service: two locks
 * ANDed (the estate's `push_mode` and the token's `wakeCapable`), and a wake frame that names
 * nobody (docs/wiki/backlog.d/push-payloads-carry-nothing-for-google-and-apple.md).
 */
describe('MessagingService - the wake-up push', () => {
  let service: MessagingService;
  /** What `SELECT push_mode FROM platform_config` answers. */
  let modeRows: unknown[];
  let errorLog: jest.SpyInstance;
  const manager = {
    findOne: jest.fn().mockResolvedValue(null),
    query: jest.fn(async (sql: string) => (/push_mode/.test(sql) ? modeRows : [])),
  };
  const pushTokenRepo = { find: jest.fn(), delete: jest.fn(), manager };
  const groupRepo = {
    findOne: jest.fn().mockResolvedValue({ name: 'Secret group', isGroup: true }),
    manager,
  };
  const unusedRepo = { find: jest.fn(), findOne: jest.fn(), delete: jest.fn(), save: jest.fn() };

  const queued = {
    id: '7c1d2e3f-aaaa-4bbb-8ccc-dddddddddddd',
    recipientId: 'u1',
    deviceId: 'pixel',
    proto: 'AAAA',
    isWelcome: false,
    createdAt: new Date('2026-11-02T10:00:00Z'),
  };
  const send = (silent = false) =>
    (
      service as unknown as { sendFcmForQueued: (...a: unknown[]) => Promise<void> }
    ).sendFcmForQueued(queued, 'trace', G1, 'sender-u2', silent);
  const sent = (i = 0) =>
    fcmSend.mock.calls[i][0] as {
      data?: Record<string, string>;
      apns?: { payload: Record<string, unknown>; headers: Record<string, string> };
    };

  const token = (platform: 'android' | 'ios', wakeCapable: boolean) => ({
    id: 1,
    userId: 'u1',
    deviceId: 'pixel',
    token: 'tok',
    platform,
    locale: 'fr',
    wakeCapable,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    modeRows = [{ push_mode: 'wake' }];
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
        { provide: 'REDIS_CLIENT', useValue: {} },
      ],
    }).compile();
    service = module.get(MessagingService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends an Android wake frame of exactly three fields when both locks are open', async () => {
    pushTokenRepo.find.mockResolvedValue([token('android', true)]);
    await send();
    expect(sent().data).toEqual({ type: 'wake', queuedMessageId: queued.id, silent: 'false' });
    expect(sent().apns).toBeUndefined();
  });

  it('sends an iOS wake alert that names neither the conversation nor the sender', async () => {
    pushTokenRepo.find.mockResolvedValue([token('ios', true)]);
    await send();
    const payload = sent().apns!.payload;
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain(G1);
    expect(serialised).not.toContain('Secret group');
    expect(serialised).not.toContain('sender-u2');
    expect(payload).toMatchObject({ type: 'wake', queuedMessageId: queued.id, silent: 'false' });
    const aps = payload.aps as Record<string, unknown>;
    expect(aps['thread-id']).toBeUndefined();
    expect(aps.alert).toEqual({ title: 'Canari', body: 'Nouveau message' });
    expect(sent().apns!.headers['apns-push-type']).toBe('alert');
  });

  it('keeps a silent frame a background push on iOS, as the platform requires', async () => {
    pushTokenRepo.find.mockResolvedValue([token('ios', true)]);
    await send(true);
    expect(sent().apns!.payload).toEqual({
      aps: { 'content-available': 1 },
      type: 'wake',
      queuedMessageId: queued.id,
      silent: 'true',
    });
    expect(sent().apns!.headers['apns-push-type']).toBe('background');
  });

  it('sends the full push to a token that never declared a wake, and does not read the switch', async () => {
    pushTokenRepo.find.mockResolvedValue([token('android', false)]);
    await send();
    expect(sent().data?.type).toBe('message');
    expect(sent().data?.groupId).toBe(G1);
    expect(manager.query).not.toHaveBeenCalledWith(expect.stringMatching(/push_mode/));
  });

  it('sends the full push to a capable token while the switch is full', async () => {
    modeRows = [{ push_mode: 'full' }];
    pushTokenRepo.find.mockResolvedValue([token('android', true)]);
    await send();
    expect(sent().data?.type).toBe('message');
  });

  it('reads an absent switch row as full, at error', async () => {
    modeRows = [];
    pushTokenRepo.find.mockResolvedValue([token('android', true)]);
    await send();
    expect(sent().data?.type).toBe('message');
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('MISSING'));
  });

  it('sends nothing when the switch holds a value no service understands', async () => {
    modeRows = [{ push_mode: 'maybe' }];
    pushTokenRepo.find.mockResolvedValue([token('android', true)]);
    await expect(send()).rejects.toThrow(/unknown value/);
    expect(fcmSend).not.toHaveBeenCalled();
  });
});
