/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { CallsService } from './calls.service';
import { ApnsVoipService } from './apns-voip.service';
import { GroupMember } from '../entities/group-member.entity';
import { PushToken } from '../entities/push-token.entity';

// Firebase Admin is mocked so the ring fan-out is observable without credentials.
const fcmSend = jest.fn();
jest.mock('firebase-admin/app', () => ({ getApps: jest.fn(() => [{}]) }));
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(() => ({ send: fcmSend })),
}));

describe('CallsService', () => {
  let service: CallsService;
  const groupMemberRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
    manager: { query: jest.fn(() => Promise.resolve([])) },
  };
  const pushTokenRepo = {
    find: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const apnsVoip = {
    isConfigured: jest.fn(() => true),
    sendVoipPush: jest.fn(),
  };
  const redisStore = new Map<string, string>();
  const redis = {
    get: jest.fn((key: string) => Promise.resolve(redisStore.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      redisStore.set(key, value);
      return Promise.resolve('OK');
    }),
    del: jest.fn((key: string) => {
      redisStore.delete(key);
      return Promise.resolve(1);
    }),
    incrbyfloat: jest.fn((key: string, n: number) => {
      const cur = parseFloat(redisStore.get(key) ?? '0') || 0;
      const next = cur + Number(n);
      redisStore.set(key, String(next));
      return Promise.resolve(String(next));
    }),
    expire: jest.fn(() => Promise.resolve(1)),
  };

  /** Current month's TURN-usage Redis key (matches the service's bucket). */
  const turnUsageKey = `turn:usage:${new Date().toISOString().slice(0, 7)}`;

  beforeEach(async () => {
    jest.clearAllMocks();
    redisStore.clear();
    delete process.env.CLOUDFLARE_CALLS_API_TOKEN;
    delete process.env.CLOUDFLARE_TURN_KEY_ID;
    delete process.env.CLOUDFLARE_TURN_MONTHLY_BUDGET_GB;
    delete process.env.CALL_RELAY_KBPS_PER_DEVICE;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CallsService,
        {
          provide: getRepositoryToken(GroupMember),
          useValue: groupMemberRepo,
        },
        {
          provide: getRepositoryToken(PushToken),
          useValue: pushTokenRepo,
        },
        {
          provide: 'REDIS_CLIENT',
          useValue: redis,
        },
        {
          provide: ApnsVoipService,
          useValue: apnsVoip,
        },
      ],
    }).compile();

    service = module.get(CallsService);
  });

  it('rejects non-members', async () => {
    groupMemberRepo.findOne.mockResolvedValue(null);
    await expect(service.getIceServers('user-1', 'group-1', 'call-1')).rejects.toThrow(
      ForbiddenException
    );
  });

  it('returns 503 when Cloudflare TURN is not configured', async () => {
    groupMemberRepo.findOne.mockResolvedValue({
      groupId: 'group-1',
      userId: 'user-1',
    });
    await expect(service.getIceServers('user-1', 'group-1', 'call-1')).rejects.toThrow(
      ServiceUnavailableException
    );
  });

  it('refuses TURN credentials once the monthly budget is reached', async () => {
    groupMemberRepo.findOne.mockResolvedValue({
      groupId: 'group-1',
      userId: 'user-1',
    });
    process.env.CLOUDFLARE_CALLS_API_TOKEN = 'token';
    process.env.CLOUDFLARE_TURN_KEY_ID = 'key';
    process.env.CLOUDFLARE_TURN_MONTHLY_BUDGET_GB = '10';
    // 10 GB budget = 10000 MB; seed just over it.
    redisStore.set(turnUsageKey, '10001');

    await expect(service.getIceServers('user-1', 'group-1', 'call-1')).rejects.toThrow(
      ServiceUnavailableException
    );
  });

  it('accumulates estimated TURN usage when a call ends', async () => {
    process.env.CALL_RELAY_KBPS_PER_DEVICE = '3000';
    // Seed an active presence that started 10 minutes ago.
    redisStore.set(
      'call:user_active:user-1',
      JSON.stringify({
        deviceId: 'device-a',
        updatedAt: Date.now() - 10 * 60 * 1000,
      })
    );

    await service.reportCallPresence('user-1', 'device-a', { active: false });

    // 3000 kbps * 600 s / 8000 = 225 MB.
    const used = parseFloat(redisStore.get(turnUsageKey) ?? '0');
    expect(used).toBeGreaterThan(200);
    expect(used).toBeLessThan(250);
  });

  it('stores and clears call presence per device', async () => {
    await service.reportCallPresence('user-1', 'device-a', {
      active: true,
      callId: 'call-1',
      groupId: 'group-1',
    });

    const sibling = await service.getSiblingCallStatus('user-1', 'device-b');
    expect(sibling).toEqual({
      active: true,
      deviceId: 'device-a',
      callId: 'call-1',
      groupId: 'group-1',
    });

    const sameDevice = await service.getSiblingCallStatus('user-1', 'device-a');
    expect(sameDevice).toEqual({ active: false });

    await service.reportCallPresence('user-1', 'device-a', { active: false });
    const afterClear = await service.getSiblingCallStatus('user-1', 'device-b');
    expect(afterClear).toEqual({ active: false });
  });

  describe('ring fan-out (WP-XP-5)', () => {
    beforeEach(() => {
      groupMemberRepo.findOne.mockResolvedValue({ groupId: 'group-1', userId: 'caller' });
      groupMemberRepo.find.mockResolvedValue([
        { userId: 'caller' },
        { userId: 'callee-android' },
        { userId: 'callee-ios-voip' },
        { userId: 'callee-ios-legacy' },
      ]);
      fcmSend.mockResolvedValue('msg-id');
      apnsVoip.sendVoipPush.mockResolvedValue(true);
    });

    it('rejects ring from non-members', async () => {
      groupMemberRepo.findOne.mockResolvedValue(null);
      await expect(service.ringGroup('intruder', 'group-1', 'call-1', false)).rejects.toThrow(
        ForbiddenException
      );
    });

    it('routes each platform to its ring transport and never rings the caller', async () => {
      pushTokenRepo.find.mockResolvedValue([
        {
          id: '1',
          userId: 'callee-android',
          deviceId: 'd1',
          token: 'fcm-a',
          platform: 'android',
          voipToken: null,
        },
        {
          id: '2',
          userId: 'callee-ios-voip',
          deviceId: 'd2',
          token: 'fcm-b',
          platform: 'ios',
          voipToken: 'voip-b',
        },
        {
          id: '3',
          userId: 'callee-ios-legacy',
          deviceId: 'd3',
          token: 'fcm-c',
          platform: 'ios',
          voipToken: null,
        },
      ]);

      const result = await service.ringGroup('caller', 'group-1', 'call-1', true);

      expect(result.rang).toBe(3);
      // Caller's own userId is excluded from the token lookup.
      const lookup = pushTokenRepo.find.mock.calls[0][0].where.userId._value as string[];
      expect(lookup).not.toContain('caller');
      // Android + legacy iOS ride FCM; the VoIP-capable iOS device rides APNs directly.
      expect(fcmSend).toHaveBeenCalledTimes(2);
      expect(fcmSend.mock.calls[0][0].data.type).toBe('call_ring');
      expect(fcmSend.mock.calls[0][0].data.hasVideo).toBe('true');
      expect(apnsVoip.sendVoipPush).toHaveBeenCalledWith(
        'voip-b',
        expect.objectContaining({ type: 'call_ring', callId: 'call-1', groupId: 'group-1' })
      );
    });

    it('clears the voipToken when APNs reports it gone', async () => {
      pushTokenRepo.find.mockResolvedValue([
        {
          id: '2',
          userId: 'callee-ios-voip',
          deviceId: 'd2',
          token: 'fcm-b',
          platform: 'ios',
          voipToken: 'voip-b',
        },
      ]);
      apnsVoip.sendVoipPush.mockResolvedValue('gone');

      const result = await service.ringGroup('caller', 'group-1', 'call-1', false);

      expect(result.rang).toBe(0);
      expect(pushTokenRepo.update).toHaveBeenCalledWith({ id: '2' }, { voipToken: null });
    });

    it('ring-end notifies every member device including the sender user', async () => {
      pushTokenRepo.find.mockResolvedValue([
        {
          id: '1',
          userId: 'caller',
          deviceId: 'd0',
          token: 'fcm-0',
          platform: 'android',
          voipToken: null,
        },
        {
          id: '2',
          userId: 'callee-android',
          deviceId: 'd1',
          token: 'fcm-a',
          platform: 'android',
          voipToken: null,
        },
      ]);

      const result = await service.endRing('caller', 'group-1', 'call-1', 'answered');

      expect(result.notified).toBe(2);
      const lookup = pushTokenRepo.find.mock.calls[0][0].where.userId._value as string[];
      expect(lookup).toContain('caller');
      expect(fcmSend.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ type: 'call_ring_end', callId: 'call-1', reason: 'answered' })
      );
    });
  });
});
