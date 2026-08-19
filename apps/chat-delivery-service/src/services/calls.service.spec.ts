/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { getApps } from 'firebase-admin/app';
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

  /** Everything a given level emitted during one call, joined for substring assertions. */
  const captured = (spy: jest.SpyInstance): string =>
    spy.mock.calls.map((c) => String(c[0])).join('\n');

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

  describe('the server-side call record (WP-CALL-LOG)', () => {
    beforeEach(() => {
      process.env.CALL_ROOM_SECRET = 'test-secret';
      groupMemberRepo.findOne.mockResolvedValue({ groupId: 'group-1', userId: 'caller' });
    });
    afterEach(() => {
      delete process.env.CALL_ROOM_SECRET;
      jest.restoreAllMocks();
    });

    /**
     * The roomId this endpoint mints IS the callId every other line is keyed on - the ring
     * fan-out's and call-service's alike. If the invite line ever carried a different value the
     * two halves of a call could no longer be joined at all, which is the whole point of it.
     */
    it('names the invite with the very room id it hands back', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

      const { roomId } = await service.initiateCall('caller', 'group-1');

      expect(captured(log)).toContain(`[call] invite room=${roomId} user=caller group=group-1`);
    });

    /** The callee's half: asking for a token is the last thing seen before it joins the SFU. */
    it('names the join token, so a callee that never arrives is distinguishable', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

      await service.requestRoomToken('callee', 'group-1', 'room-9');

      expect(captured(log)).toContain('[call] join-token room=room-9 user=callee group=group-1');
    });

    /** Both halves fail for one reason, and only the caller's half used to say so. */
    it('accuses the missing room secret on the answer path too', async () => {
      delete process.env.CALL_ROOM_SECRET;
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

      await expect(service.requestRoomToken('callee', 'group-1', 'room-9')).rejects.toThrow(
        ServiceUnavailableException
      );
      expect(captured(error)).toContain('CALL_ROOM_SECRET is not set');
    });

    /**
     * `rang=0/3` on its own reads as "three devices, none reachable". Without Firebase the truth
     * is that this server never asked any of them, and that is a server fault, not a fleet one.
     */
    it('names Firebase once when it is the reason no FCM device was asked', async () => {
      groupMemberRepo.find.mockResolvedValue([{ userId: 'caller' }, { userId: 'callee-android' }]);
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
      ]);
      apnsVoip.sendVoipPush.mockResolvedValue(true);
      (getApps as jest.Mock).mockReturnValueOnce([]);
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

      const result = await service.ringGroup('caller', 'group-1', 'call-1', false);

      // Once for the fan-out, not once per device: two Android handsets are not two faults.
      expect(error).toHaveBeenCalledTimes(1);
      expect(captured(error)).toContain('[ring] Firebase Admin is not initialised');
      expect(fcmSend).not.toHaveBeenCalled();
      // APNs VoIP does not go through Firebase, so that device is still rung.
      expect(result.rang).toBe(1);
    });

    /**
     * The guard used to sit INSIDE the loop and `break`. That stopped the remaining devices and
     * returned a count that read like a partial delivery rather than a server that never tried.
     */
    it('reports ring-end as nothing sent rather than as a partial delivery', async () => {
      groupMemberRepo.find.mockResolvedValue([{ userId: 'caller' }, { userId: 'callee-android' }]);
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
      (getApps as jest.Mock).mockReturnValueOnce([]);
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

      const result = await service.endRing('caller', 'group-1', 'call-1', 'ended');

      expect(result.notified).toBe(0);
      expect(fcmSend).not.toHaveBeenCalled();
      expect(captured(error)).toContain('[ring-end] Firebase Admin is not initialised');
    });

    /** A ring nobody could receive is not the same event as a ring nobody answered. */
    it('names a group with no one else in it', async () => {
      groupMemberRepo.find.mockResolvedValue([{ userId: 'caller' }]);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

      const result = await service.ringGroup('caller', 'group-1', 'call-1', false);

      expect(result.rang).toBe(0);
      expect(pushTokenRepo.find).not.toHaveBeenCalled();
      expect(captured(warn)).toContain('[ring] call=call-1 group=group-1 has no other member');
    });
  });
});
