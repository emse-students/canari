/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  ForbiddenException,
  GoneException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { getApps } from 'firebase-admin/app';
import { CALL_RING_TIMEOUT_SEC, CallsService } from './calls.service';
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
    // Honours `NX` as Redis does: no write, and `null`, when the key already exists.
    set: jest.fn((key: string, value: string, ...args: (string | number)[]) => {
      if (args.includes('NX') && redisStore.has(key)) return Promise.resolve(null);
      redisStore.set(key, value);
      return Promise.resolve('OK');
    }),
    /** Every key in this fake lives the binding's full TTL; a missing key is -2, as in Redis. */
    pttl: jest.fn((key: string) =>
      Promise.resolve(redisStore.has(key) ? (60 + 4 * 60 * 60) * 1000 : -2)
    ),
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
    // The room every ring test rings: opened by `caller` in `group-1`, its window not yet open.
    redisStore.set('call:room:call-1', JSON.stringify({ groupId: 'group-1', callerId: 'caller' }));
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

    /** The caller's `POST /calls/ring`, which opens the window (a group with nobody else to ring). */
    const ring = async (roomId: string, callerId = 'caller') => {
      groupMemberRepo.find.mockResolvedValue([{ userId: callerId }]);
      return service.ringGroup(callerId, 'group-1', roomId, false);
    };

    /** The callee's half: asking for a token is the last thing seen before it joins the SFU. */
    it('names the join token, so a callee that never arrives is distinguishable', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      const { roomId } = await service.initiateCall('caller', 'group-1');
      await ring(roomId);

      await service.requestRoomToken('callee', 'group-1', roomId);

      expect(captured(log)).toContain(`[call] join-token room=${roomId} user=callee group=group-1`);
    });

    /**
     * F1: a room id is bound to the conversation it was opened in, for the ring window plus the
     * longest counted call - and the window `initiate` hands back is the one this binding holds.
     */
    it('binds the room to its group at initiate, for the ring window plus the call horizon', async () => {
      const { roomId, ringTimeoutMs } = await service.initiateCall('caller', 'group-1');

      expect(ringTimeoutMs).toBe(CALL_RING_TIMEOUT_SEC * 1000);
      expect(redis.set).toHaveBeenCalledWith(
        `call:room:${roomId}`,
        expect.any(String),
        'EX',
        CALL_RING_TIMEOUT_SEC + 4 * 60 * 60
      );
      expect(JSON.parse(redisStore.get(`call:room:${roomId}`)!).groupId).toBe('group-1');
    });

    /**
     * F1: a member of ANOTHER group who learnt the room id must not get a token for it - the
     * token would be signed for their own group and seat them in a call they are not part of.
     */
    it('refuses a token for a room bound to another group', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const { roomId } = await service.initiateCall('caller', 'group-1');
      groupMemberRepo.findOne.mockResolvedValue({ groupId: 'group-2', userId: 'mallory' });

      await expect(service.requestRoomToken('mallory', 'group-2', roomId)).rejects.toThrow(
        ForbiddenException
      );
    });

    it('answers 410 for a room no initiate ever bound, or whose binding expired', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

      await expect(service.requestRoomToken('callee', 'group-1', 'room-9')).rejects.toThrow(
        GoneException
      );
    });

    /**
     * G1: the window opens when the caller RINGS, not at initiate. Everything between the two -
     * ICE servers, a first-time microphone prompt, the signalling join - used to eat into the
     * callee's 60 s, so the server could refuse an answer while the callee was still ringing.
     */
    it('opens the window at ring, however long the caller took to get there', async () => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(1_000_000);
      const { roomId } = await service.initiateCall('caller', 'group-1');

      // Before the ring there is no window at all: nobody has been rung yet.
      await expect(service.requestRoomToken('callee', 'group-1', roomId)).rejects.toThrow(
        GoneException
      );

      // A slow setup: the caller rings 45 s after initiate. The callee still gets its full 60 s.
      const rungAt = 1_000_000 + 45_000;
      now.mockReturnValue(rungAt);
      await ring(roomId);
      now.mockReturnValue(rungAt + CALL_RING_TIMEOUT_SEC * 1000);
      await expect(service.requestRoomToken('callee', 'group-1', roomId)).resolves.toHaveProperty(
        'roomToken'
      );
    });

    it('opens the window once, from the caller only', async () => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(1_000_000);
      const { roomId } = await service.initiateCall('caller', 'group-1');

      await expect(ring(roomId, 'callee')).rejects.toThrow(ForbiddenException);
      await ring(roomId);
      // A retried ring later must not extend the window it already opened.
      now.mockReturnValue(1_000_000 + 30_000);
      await ring(roomId);
      expect(Number(redisStore.get(`call:room:${roomId}:answer_by`))).toBe(
        1_000_000 + CALL_RING_TIMEOUT_SEC * 1000
      );
    });

    /** "Once" is ONE atomic write, so two rings in flight together cannot both open a window. */
    it('opens the window once under concurrent rings, and never rewrites the binding', async () => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const { roomId } = await service.initiateCall('caller', 'group-1');
      redis.set.mockClear();

      await Promise.all([ring(roomId), ring(roomId)]);

      const writes = redis.set.mock.calls.filter(([key]) => String(key).startsWith('call:room:'));
      expect(writes.map(([key]) => key)).toEqual([
        `call:room:${roomId}:answer_by`,
        `call:room:${roomId}:answer_by`,
      ]);
      expect(writes.every((w) => w.includes('NX'))).toBe(true);
      expect(captured(warn)).toContain('rung again - the first window stands');
    });

    /** The lot 1 binding (no caller) is refused explicitly: nobody may ring it. Dev only, one deploy. */
    it('refuses a binding written before the ring window existed, and says why', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      redisStore.set('call:room:old', JSON.stringify({ groupId: 'group-1', answerBy: 9e15 }));

      await expect(service.requestRoomToken('callee', 'group-1', 'old')).rejects.toThrow(
        GoneException
      );
      expect(captured(warn)).toContain('predates the ring window');
    });

    /** F2: the ring window is enforced HERE, on one clock, whatever the callee's timer did. */
    it('answers 410 once the ring window has closed', async () => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(1_000_000);
      const { roomId } = await service.initiateCall('caller', 'group-1');
      await ring(roomId);

      now.mockReturnValue(1_000_000 + CALL_RING_TIMEOUT_SEC * 1000);
      await expect(service.requestRoomToken('callee', 'group-1', roomId)).resolves.toHaveProperty(
        'roomToken'
      );

      now.mockReturnValue(1_000_000 + CALL_RING_TIMEOUT_SEC * 1000 + 1);
      await expect(service.requestRoomToken('callee', 'group-1', roomId)).rejects.toThrow(
        GoneException
      );
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
