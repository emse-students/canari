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
import { CALL_RING_TIMEOUT_SEC, CallsService, readTurnBudget } from './calls.service';
import { ApnsVoipService } from './apns-voip.service';
import { TurnMeterUnavailableError, TurnUsageMeter } from './turn-usage-meter.service';
import { GroupMember } from '../entities/group-member.entity';
import { PushToken } from '../entities/push-token.entity';

// Firebase Admin is mocked so the ring fan-out is observable without credentials.
const fcmSend = jest.fn();
jest.mock('firebase-admin/app', () => ({ getApps: jest.fn(() => [{}]) }));
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(() => ({ send: fcmSend })),
}));

/**
 * Runs a ring the way the endpoint does, then waits for the background fan-out the endpoint does
 * NOT wait for, so a test can read what it sent. `ringGroup` itself answers with nothing.
 */
async function ringAndSettle(
  service: CallsService,
  ...args: Parameters<CallsService['ringGroup']>
): Promise<{ rang: number }> {
  const internals = service as unknown as {
    prepareRing: (...a: typeof args) => Promise<unknown>;
    fanOutRing: (plan: unknown) => Promise<{ rang: number }>;
  };
  const plan = await internals.prepareRing(...args);
  return plan ? internals.fanOutRing(plan) : { rang: 0 };
}

describe('CallsService', () => {
  let service: CallsService;
  /** What `platform_config.calls_mode` holds for the test; open by default so the call paths run. */
  let callsMode: string | undefined = 'audio_video';
  /**
   * The database as the service reads it with plain SQL: the kill switch's row, and nothing else
   * (no block, no group name) unless a test says otherwise. `undefined` = no platform_config row.
   */
  const baseQuery = (sql: string): Promise<unknown[]> =>
    Promise.resolve(
      sql.includes('platform_config') && callsMode !== undefined ? [{ calls_mode: callsMode }] : []
    );
  const groupMemberRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
    manager: {
      query: jest.fn((sql: string, _params?: unknown[]): Promise<unknown[]> => baseQuery(sql)),
    },
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
  };
  /** Cloudflare's metered egress for the month, in bytes - the TURN budget's only evidence (B7). */
  const turnMeter = { monthEgressBytes: jest.fn(() => Promise.resolve(0)) };

  beforeEach(async () => {
    jest.clearAllMocks();
    redisStore.clear();
    callsMode = 'audio_video';
    groupMemberRepo.manager.query.mockImplementation((sql: string) => baseQuery(sql));
    turnMeter.monthEgressBytes.mockImplementation(() => Promise.resolve(0));
    // The room every ring test rings: opened by `caller` in `group-1`, its window not yet open.
    redisStore.set('call:room:call-1', JSON.stringify({ groupId: 'group-1', callerId: 'caller' }));
    delete process.env.CLOUDFLARE_CALLS_API_TOKEN;
    delete process.env.CLOUDFLARE_TURN_KEY_ID;
    delete process.env.CLOUDFLARE_TURN_MONTHLY_BUDGET_GB;

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
        {
          provide: TurnUsageMeter,
          useValue: turnMeter,
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
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    await expect(service.getIceServers('user-1', 'group-1', 'call-1')).rejects.toThrow(
      ServiceUnavailableException
    );
    expect(captured(error)).toContain('[ICE] Cloudflare TURN is not configured');
    error.mockRestore();
  });

  /**
   * B7: the budget is what Cloudflare METERED, never an estimate from call durations - so a month of
   * direct calls (zero relayed bytes) never closes it, and relayed bytes past it always do.
   */
  describe('the TURN budget reads the metered egress', () => {
    beforeEach(() => {
      groupMemberRepo.findOne.mockResolvedValue({ groupId: 'group-1', userId: 'user-1' });
      process.env.CLOUDFLARE_CALLS_API_TOKEN = 'token';
      process.env.CLOUDFLARE_TURN_KEY_ID = 'key';
      process.env.CLOUDFLARE_TURN_MONTHLY_BUDGET_GB = '10';
    });
    afterEach(() => jest.restoreAllMocks());

    it('withholds TURN once the metered egress reaches the budget, and still answers for a direct call', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      turnMeter.monthEgressBytes.mockResolvedValue(10e9);
      const fetchSpy = jest.spyOn(global, 'fetch');

      await expect(service.getIceServers('user-1', 'group-1', 'call-1')).resolves.toEqual({
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
        turn: { status: 'unavailable', code: 'TURN_BUDGET_REACHED' },
      });
      // No credential asked of Cloudflare.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(captured(error)).toContain('call=call-1 TURN withheld (TURN_BUDGET_REACHED)');
    });

    // THE OWNER'S DECISION OF 2026-10-21: an explicit 0 keeps calls open and never relays them.
    it('withholds TURN with a budget of 0, asks no meter, and says it at log, not error', async () => {
      process.env.CLOUDFLARE_TURN_MONTHLY_BUDGET_GB = '0';
      // No TURN secrets at all: an estate set to 0 needs none, and still answers STUN only.
      delete process.env.CLOUDFLARE_CALLS_API_TOKEN;
      delete process.env.CLOUDFLARE_TURN_KEY_ID;
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      const fetchSpy = jest.spyOn(global, 'fetch');

      await expect(service.getIceServers('user-1', 'group-1', 'call-1')).resolves.toEqual({
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
        turn: { status: 'unavailable', code: 'TURN_DISABLED' },
      });
      expect(turnMeter.monthEgressBytes).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(captured(log)).toContain('the budget is 0 GB - STUN only by configuration');
      expect(error).not.toHaveBeenCalled();
    });

    it('withholds TURN, at error, when the budget is not a whole number', async () => {
      process.env.CLOUDFLARE_TURN_MONTHLY_BUDGET_GB = '1.5e3';
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      const fetchSpy = jest.spyOn(global, 'fetch');

      await expect(service.getIceServers('user-1', 'group-1', 'call-1')).resolves.toMatchObject({
        turn: { status: 'unavailable', code: 'TURN_DISABLED' },
      });
      expect(turnMeter.monthEgressBytes).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(captured(error)).toContain('"1.5e3" is not a whole number of GB');
    });

    it('mints credentials below the budget, however long the calls of the month lasted', async () => {
      turnMeter.monthEgressBytes.mockResolvedValue(10e9 - 1);
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          new Response(
            JSON.stringify({ iceServers: [{ urls: ['turn:turn.example:3478?transport=udp'] }] }),
            { status: 200 }
          )
        );

      await expect(service.getIceServers('user-1', 'group-1', 'call-1')).resolves.toEqual({
        iceServers: [{ urls: 'turn:turn.example:3478?transport=udp' }],
        turn: { status: 'available' },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('mints no TURN when the meter cannot be read, typed, and a direct call still gets STUN', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      turnMeter.monthEgressBytes.mockRejectedValue(new TurnMeterUnavailableError('HTTP 403'));
      const fetchSpy = jest.spyOn(global, 'fetch');

      await expect(service.getIceServers('user-1', 'group-1', 'call-1')).resolves.toEqual({
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
        turn: { status: 'unavailable', code: 'TURN_METER_UNAVAILABLE' },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(captured(error)).toContain('TURN withheld (TURN_METER_UNAVAILABLE): HTTP 403');
    });

    it('does not swallow an error that is not the meter s', async () => {
      turnMeter.monthEgressBytes.mockRejectedValue(new Error('redis down'));

      await expect(service.getIceServers('user-1', 'group-1', 'call-1')).rejects.toThrow(
        'redis down'
      );
    });

    it('asks Cloudflare for credentials per request, never sharing one, bounded by a timeout', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation((_u, init) => {
        expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
        return Promise.resolve(
          new Response(JSON.stringify({ iceServers: [{ urls: ['turn:turn.example:3478'] }] }), {
            status: 200,
          })
        );
      });

      await Promise.all([
        service.getIceServers('user-1', 'group-1', 'call-1'),
        service.getIceServers('user-1', 'group-1', 'call-1'),
      ]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('answers 503, logged, when Cloudflare gives no credentials in time', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      const timeout = new Error('The operation was aborted due to timeout');
      timeout.name = 'TimeoutError';
      jest.spyOn(global, 'fetch').mockRejectedValue(timeout);

      await expect(service.getIceServers('user-1', 'group-1', 'call-1')).rejects.toThrow(
        ServiceUnavailableException
      );
      expect(captured(error)).toContain('gave no answer within 5000 ms');
    });

    it('no longer estimates usage when a call ends - a presence clear writes no counter', async () => {
      redisStore.set(
        'call:user_active:user-1',
        JSON.stringify({ deviceId: 'device-a', updatedAt: Date.now() - 10 * 60 * 1000 })
      );

      await service.reportCallPresence('user-1', 'device-a', { active: false });

      expect([...redisStore.keys()].filter((k) => k.startsWith('turn:'))).toEqual([]);
    });
  });

  describe('readTurnBudget', () => {
    it.each([
      [undefined, { gb: 950, source: 'default' }],
      ['', { gb: 950, source: 'default' }],
      ['  ', { gb: 950, source: 'default' }],
      ['0', { gb: 0, source: 'configured' }],
      [' 120 ', { gb: 120, source: 'configured' }],
      ['-1', { gb: 0, source: 'invalid', raw: '-1' }],
      ['abc', { gb: 0, source: 'invalid', raw: 'abc' }],
      // Digits, but past Number.MAX_SAFE_INTEGER: would read as an unreachable budget.
      ['9'.repeat(400), { gb: 0, source: 'invalid', raw: '9'.repeat(400) }],
    ])('reads %p as %p - unset is the default, 0 is a budget of 0', (raw, expected) => {
      expect(readTurnBudget(raw)).toEqual(expected);
    });
  });

  /**
   * B7's report: a token that is missing or refused withholds TURN from every call, so the meter's
   * state is said hourly - at ERROR when calls are open and TURN is withheld, and not at all while
   * calls are off.
   */
  describe('the hourly TURN meter report', () => {
    let error: jest.SpyInstance;
    let log: jest.SpyInstance;
    const now = new Date('2026-10-21T12:00:00Z');
    beforeEach(() => {
      process.env.CLOUDFLARE_TURN_MONTHLY_BUDGET_GB = '10';
      error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    it('reads nothing and says nothing while calls are off', async () => {
      callsMode = 'off';

      await service.reportTurnMeter(now);

      expect(turnMeter.monthEgressBytes).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });

    it('says the month s reading against the budget when TURN is available', async () => {
      turnMeter.monthEgressBytes.mockResolvedValue(2.5e9);

      await service.reportTurnMeter(now);

      expect(captured(log)).toContain(
        '[TURN-METER] 2026-10 (UTC calendar month): 2.50/10 GB metered egress (25.0%) - TURN available'
      );
      expect(error).not.toHaveBeenCalled();
    });

    it('accuses a meter that cannot be read while calls are open', async () => {
      turnMeter.monthEgressBytes.mockRejectedValue(new TurnMeterUnavailableError('HTTP 403'));

      await service.reportTurnMeter(now);

      expect(captured(error)).toContain(
        '[TURN-METER] calls are open (calls_mode=audio_video) and the meter is UNAVAILABLE: HTTP 403'
      );
    });

    it('says a budget of 0 at log and reads no meter', async () => {
      process.env.CLOUDFLARE_TURN_MONTHLY_BUDGET_GB = '0';

      await service.reportTurnMeter(now);

      expect(turnMeter.monthEgressBytes).not.toHaveBeenCalled();
      expect(captured(log)).toContain('the budget is 0 GB (calls_mode=audio_video)');
      expect(error).not.toHaveBeenCalled();
    });

    it('accuses a budget nobody can read, and reads no meter', async () => {
      process.env.CLOUDFLARE_TURN_MONTHLY_BUDGET_GB = 'lots';

      await service.reportTurnMeter(now);

      expect(turnMeter.monthEgressBytes).not.toHaveBeenCalled();
      expect(captured(error)).toContain(
        'CLOUDFLARE_TURN_MONTHLY_BUDGET_GB="lots" is not a whole number'
      );
    });

    it('accuses a spent budget', async () => {
      turnMeter.monthEgressBytes.mockResolvedValue(10e9);

      await service.reportTurnMeter(now);

      expect(captured(error)).toContain('BUDGET REACHED, TURN is withheld from every call');
    });
  });

  /**
   * B12: the server's kill switch, `platform_config.calls_mode`. Every request that starts or joins
   * a call asks it; the ones that stop or record a call do not.
   */
  describe('the calls kill switch', () => {
    beforeEach(() => {
      process.env.CALL_ROOM_SECRET = 'test-secret';
      process.env.CLOUDFLARE_CALLS_API_TOKEN = 'token';
      process.env.CLOUDFLARE_TURN_KEY_ID = 'key';
      groupMemberRepo.findOne.mockResolvedValue({ groupId: 'group-1', userId: 'caller' });
      groupMemberRepo.find.mockResolvedValue([{ userId: 'caller' }, { userId: 'callee' }]);
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    });
    afterEach(() => {
      delete process.env.CALL_ROOM_SECRET;
      jest.restoreAllMocks();
    });

    const disabled = { code: 'CALLS_DISABLED', message: 'Calls are not available on this server.' };

    it.each([
      ['initiate', (s: CallsService) => s.initiateCall('caller', 'group-1')],
      ['ring', (s: CallsService) => s.ringGroup('caller', 'group-1', 'call-1', false)],
      ['room-token', (s: CallsService) => s.requestRoomToken('caller', 'group-1', 'call-1')],
      ['ice-servers', (s: CallsService) => s.getIceServers('caller', 'group-1', 'call-1')],
    ])('off refuses %s with CALLS_DISABLED, writing and minting nothing', async (_name, run) => {
      callsMode = 'off';
      const fetchSpy = jest.spyOn(global, 'fetch');

      const refusal = await run(service).catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect((refusal as ForbiddenException).getResponse()).toEqual(disabled);
      expect(redis.set).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(turnMeter.monthEgressBytes).not.toHaveBeenCalled();
      expect(fcmSend).not.toHaveBeenCalled();
    });

    it('reads a missing row as off, and accuses it at error - unlike a real off', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      callsMode = undefined;

      await expect(service.initiateCall('caller', 'group-1')).rejects.toThrow(ForbiddenException);
      expect(captured(error)).toContain('platform_config row 1 is MISSING');
    });

    it('logs a real off as a refusal, never as a defect', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      callsMode = 'off';

      await expect(service.initiateCall('caller', 'group-1')).rejects.toThrow(ForbiddenException);
      expect(error).not.toHaveBeenCalled();
    });

    it('refuses rather than guesses when the column holds a value nobody understands', async () => {
      callsMode = 'on';

      await expect(service.initiateCall('caller', 'group-1')).rejects.toThrow(/unknown value: on/);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('audio places and rings an audio call', async () => {
      callsMode = 'audio';
      pushTokenRepo.find.mockResolvedValue([]);
      const { roomId } = await service.initiateCall('caller', 'group-1');

      await expect(ringAndSettle(service, 'caller', 'group-1', roomId, false)).resolves.toEqual({
        rang: 0,
      });
      expect(redisStore.has(`call:room:${roomId}:answer_by`)).toBe(true);
    });

    it('audio refuses a ring asking for video with CALLS_VIDEO_DISABLED, and opens no window', async () => {
      callsMode = 'audio';
      const { roomId } = await service.initiateCall('caller', 'group-1');

      const refusal = await service
        .ringGroup('caller', 'group-1', roomId, true)
        .catch((e: unknown) => e);

      expect((refusal as ForbiddenException).getResponse()).toEqual({
        code: 'CALLS_VIDEO_DISABLED',
        message: 'Video calls are not available on this server.',
      });
      expect([...redisStore.keys()].some((k) => k.endsWith(':answer_by'))).toBe(false);
      expect(pushTokenRepo.find).not.toHaveBeenCalled();
    });

    it('audio_video rings a video call', async () => {
      callsMode = 'audio_video';
      pushTokenRepo.find.mockResolvedValue([]);
      const { roomId } = await service.initiateCall('caller', 'group-1');

      await expect(ringAndSettle(service, 'caller', 'group-1', roomId, true)).resolves.toEqual({
        rang: 0,
      });
      expect(redisStore.has(`call:room:${roomId}:answer_by`)).toBe(true);
    });

    it('never gates what stops or records a call: ring-end and presence work when off', async () => {
      callsMode = 'off';
      (getApps as jest.Mock).mockReturnValueOnce([]);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

      await expect(service.endRing('caller', 'group-1', 'call-1', 'ended')).resolves.toEqual({
        notified: 0,
      });
      await expect(
        service.reportCallPresence('caller', 'device-a', { active: false })
      ).resolves.toEqual({ ok: true });
    });

    it('reads the switch on every request - a kill holds from the next one', async () => {
      callsMode = 'audio_video';
      await service.initiateCall('caller', 'group-1');
      callsMode = 'off';

      await expect(service.initiateCall('caller', 'group-1')).rejects.toThrow(ForbiddenException);
    });
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

    it.each([
      ['a review account ringing members', 'caller'],
      ['a member ringing a review account', 'callee-android'],
    ])('refuses %s with REVIEW_COHORT_BOUNDARY and rings nobody', async (_case, reviewer) => {
      const saved = process.env.SERVICE_ACCOUNT_USER_ID;
      process.env.SERVICE_ACCOUNT_USER_ID = reviewer;
      try {
        const err = await service
          .ringGroup('caller', 'group-1', 'call-1', false)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toMatchObject({
          code: 'REVIEW_COHORT_BOUNDARY',
        });
        expect(fcmSend).not.toHaveBeenCalled();
        expect(apnsVoip.sendVoipPush).not.toHaveBeenCalled();
      } finally {
        if (saved === undefined) delete process.env.SERVICE_ACCOUNT_USER_ID;
        else process.env.SERVICE_ACCOUNT_USER_ID = saved;
      }
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

      const result = await ringAndSettle(service, 'caller', 'group-1', 'call-1', true);

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
        expect.objectContaining({ type: 'call_ring', callId: 'call-1', groupId: 'group-1' }),
        expect.any(Number)
      );
    });

    /** WP-C6: Apple requires every VoIP push to raise a CallKit call, so what it carries and when. */
    describe('the VoIP push of the native ring', () => {
      const voipDevice = {
        id: '2',
        userId: 'callee-ios-voip',
        deviceId: 'd2',
        token: 'fcm-b',
        platform: 'ios',
        voipToken: 'voip-b',
      };

      beforeEach(() => {
        pushTokenRepo.find.mockResolvedValue([voipDevice]);
      });

      it('names nobody, and carries the server answer deadline as its expiry', async () => {
        groupMemberRepo.manager.query.mockImplementation((sql: string) =>
          sql.includes('dm_groups')
            ? Promise.resolve([{ name: 'Secret group', isGroup: true }])
            : baseQuery(sql)
        );

        expect(await ringAndSettle(service, 'caller', 'group-1', 'call-1', false)).toEqual({
          rang: 1,
        });

        const [, payload, expiresAtSec] = apnsVoip.sendVoipPush.mock.calls[0];
        expect(Object.keys(payload).sort()).toEqual(
          ['callId', 'callerId', 'groupId', 'hasVideo', 'ringUntil', 'type'].sort()
        );
        expect(JSON.stringify(payload)).not.toContain('Secret group');
        const answerBy = Number(redisStore.get('call:room:call-1:answer_by'));
        expect(payload.ringUntil).toBe(String(answerBy));
        expect(expiresAtSec).toBe(Math.floor(answerBy / 1000));
      });

      it('is withheld once the ring has ended', async () => {
        await service.endRing('caller', 'group-1', 'call-1', 'cancelled');
        const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

        expect(await ringAndSettle(service, 'caller', 'group-1', 'call-1', false)).toEqual({
          rang: 0,
        });
        expect(apnsVoip.sendVoipPush).not.toHaveBeenCalled();
        expect(captured(log)).toContain('VoIP push withheld - the ring ended (cancelled)');
        log.mockRestore();
      });

      it('is withheld once the answer window has closed', async () => {
        redisStore.set('call:room:call-1:answer_by', String(Date.now() - 1));

        expect(await ringAndSettle(service, 'caller', 'group-1', 'call-1', false)).toEqual({
          rang: 0,
        });
        expect(apnsVoip.sendVoipPush).not.toHaveBeenCalled();
      });

      it('lets no member of ANOTHER conversation end this ring', async () => {
        await service.endRing('caller', 'group-other', 'call-1', 'cancelled');

        expect(redisStore.has('call:room:call-1:ring_ended')).toBe(false);
      });

      it('rings no VoIP device, and says why once, without the APNs key - no FCM alert instead', async () => {
        apnsVoip.isConfigured.mockReturnValue(false);
        const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

        expect(await ringAndSettle(service, 'caller', 'group-1', 'call-1', false)).toEqual({
          rang: 0,
        });
        expect(apnsVoip.sendVoipPush).not.toHaveBeenCalled();
        expect(fcmSend).not.toHaveBeenCalled();
        expect(captured(error)).toContain('APNS_VOIP_* is not configured');
        apnsVoip.isConfigured.mockReturnValue(true);
        error.mockRestore();
      });
    });

    it('rings an iPhone without a VoIP token with a GENERIC alert: no caller, no conversation name', async () => {
      pushTokenRepo.find.mockResolvedValue([
        {
          id: '1',
          userId: 'callee-android',
          deviceId: 'd1',
          token: 'fcm-a',
          platform: 'android',
          voipToken: null,
          locale: 'en',
        },
        {
          id: '3',
          userId: 'callee-ios-legacy',
          deviceId: 'd3',
          token: 'fcm-c',
          platform: 'ios',
          voipToken: null,
          locale: 'en',
        },
        {
          id: '4',
          userId: 'callee-ios-legacy',
          deviceId: 'd4',
          token: 'fcm-d',
          platform: 'ios',
          voipToken: null,
          locale: null,
        },
      ]);

      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
      try {
        await ringAndSettle(service, 'caller', 'group-1', 'call-1', false);
      } finally {
        now.mockRestore();
      }

      const sent = (token: string) =>
        fcmSend.mock.calls.map((c) => c[0]).find((m) => m.token === token);
      // Android is handed ids only: its ring names the caller from the phone's own copy (decision 6).
      expect(sent('fcm-a').data).toEqual({
        type: 'call_ring',
        groupId: 'group-1',
        callId: 'call-1',
        callerId: 'caller',
        hasVideo: 'false',
      });
      // The iPhone is told only that a call is coming, in its own language (base locale when unknown).
      expect(sent('fcm-c').apns.payload.aps.alert).toEqual({
        title: 'Canari',
        body: 'Incoming call',
      });
      expect(sent('fcm-d').apns.payload.aps.alert).toEqual({
        title: 'Canari',
        body: 'Appel entrant',
      });
      // What the iPhone's notification extension needs to file the banner (NotificationService.swift
      // `call_ring` case): the type and ids in the payload, an ALERT push the extension runs on,
      // and a ring that dies with its 60 s window.
      const ios = sent('fcm-c');
      expect(ios.apns.payload.type).toBe('call_ring');
      expect(ios.apns.payload.groupId).toBe('group-1');
      expect(ios.apns.payload.callId).toBe('call-1');
      expect(ios.apns.payload.aps['mutable-content']).toBe(1);
      expect(ios.apns.headers['apns-push-type']).toBe('alert');
      expect(ios.apns.headers['apns-collapse-id']).toBe('call-1');
      expect(ios.apns.headers['apns-expiration']).toBe('1000000060');
      // Android's ttl is the same window and carries no APNs header.
      expect(sent('fcm-a').android.ttl).toBe(60_000);
      // Neither the data nor the APNs payload keys carry a name: FCM merges the first into the second.
      for (const token of ['fcm-a', 'fcm-c', 'fcm-d']) {
        const message = sent(token);
        for (const key of ['callerName', 'senderName', 'groupName']) {
          expect(message.data).not.toHaveProperty(key);
          expect(message.apns.payload).not.toHaveProperty(key);
        }
        expect(message.data.type).toBe('call_ring');
      }
    });

    it('never pushes a ring to a member whose call permission refuses this conversation', async () => {
      // First read: who is in the group. Second: each callee's permission and level.
      groupMemberRepo.find
        .mockResolvedValueOnce([
          { userId: 'caller' },
          { userId: 'refused' },
          { userId: 'muted' },
          { userId: 'muted-but-allows' },
          { userId: 'default' },
        ])
        .mockResolvedValueOnce([
          { userId: 'refused', notifLevel: 'all', callsAllowed: false },
          { userId: 'muted', notifLevel: 'none', callsAllowed: null },
          { userId: 'muted-but-allows', notifLevel: 'none', callsAllowed: true },
          { userId: 'default', notifLevel: 'mentions', callsAllowed: null },
        ]);
      pushTokenRepo.find.mockResolvedValue([]);

      await ringAndSettle(service, 'caller', 'group-1', 'call-1', false);

      const lookup = pushTokenRepo.find.mock.calls[0][0].where.userId._value as string[];
      expect(lookup.sort()).toEqual(['default', 'muted-but-allows']);
    });

    it('rings nobody, and asks for no token, when every callee refused calls', async () => {
      groupMemberRepo.find
        .mockResolvedValueOnce([{ userId: 'caller' }, { userId: 'refused' }])
        .mockResolvedValueOnce([{ userId: 'refused', notifLevel: 'all', callsAllowed: false }]);

      expect(await ringAndSettle(service, 'caller', 'group-1', 'call-1', false)).toEqual({
        rang: 0,
      });
      expect(pushTokenRepo.find).not.toHaveBeenCalled();
      expect(fcmSend).not.toHaveBeenCalled();
      expect(apnsVoip.sendVoipPush).not.toHaveBeenCalled();
    });

    it('answers the caller before any push, whatever the callee chose', async () => {
      groupMemberRepo.find.mockResolvedValueOnce([{ userId: 'caller' }, { userId: 'callee' }]);
      // The fan-out starts by reading the callees' permission; it never answers.
      groupMemberRepo.find.mockReturnValueOnce(new Promise(() => {}));

      await expect(
        service.ringGroup('caller', 'group-1', 'call-1', false)
      ).resolves.toBeUndefined();
      expect(pushTokenRepo.find).not.toHaveBeenCalled();
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

      const result = await ringAndSettle(service, 'caller', 'group-1', 'call-1', false);

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
      groupMemberRepo.find.mockResolvedValue([{ userId: 'caller' }, { userId: 'callee' }]);
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

    /**
     * A ring `ring-end` recorded as over refuses an answer INSIDE the window: a native answer whose
     * intent outlived its call (cancelled by the caller, declined, taken by a sibling) must not join.
     */
    it.each(['cancelled', 'answered', 'ended'] as const)(
      'answers 410 once ring-end recorded the ring %s, inside the window',
      async (reason) => {
        const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        const { roomId } = await service.initiateCall('caller', 'group-1');
        await ring(roomId);
        await expect(service.requestRoomToken('callee', 'group-1', roomId)).resolves.toHaveProperty(
          'roomToken'
        );

        await service.endRing('caller', 'group-1', roomId, reason);

        await expect(service.requestRoomToken('callee', 'group-1', roomId)).rejects.toThrow(
          GoneException
        );
        expect(captured(log)).toContain(`the ring ended (${reason})`);
      }
    );

    /** The answering device asks for its token before its own `ring-end answered`: never refused. */
    it('gives the answering device its token before its own ring-end, and its sibling none after', async () => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      const { roomId } = await service.initiateCall('caller', 'group-1');
      await ring(roomId);

      await expect(service.requestRoomToken('callee', 'group-1', roomId)).resolves.toHaveProperty(
        'roomToken'
      );
      await service.endRing('callee', 'group-1', roomId, 'answered');
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

      const result = await ringAndSettle(service, 'caller', 'group-1', 'call-1', false);

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

      const result = await ringAndSettle(service, 'caller', 'group-1', 'call-1', false);

      expect(result.rang).toBe(0);
      expect(pushTokenRepo.find).not.toHaveBeenCalled();
      expect(captured(warn)).toContain('[ring] call=call-1 group=group-1 has no other member');
    });
  });

  /**
   * WP-C7: calling somebody who blocked you - or whom you blocked - must not ring. Refused at
   * `initiate`, so the caller never sends the MLS invite and nothing rings anywhere; and at the
   * join token, for a block set while the call rang.
   */
  describe('a call is never placed across a block', () => {
    /** `user_blocks` holds a row between `caller` and `callee`, whoever set it. */
    const blockBetweenCallerAndCallee = () =>
      groupMemberRepo.manager.query.mockImplementation((sql: string, params?: unknown[]) =>
        sql.includes('user_blocks') && params?.includes('caller') && params?.includes('callee')
          ? Promise.resolve([{ '?column?': 1 }])
          : baseQuery(sql)
      );

    beforeEach(() => {
      process.env.CALL_ROOM_SECRET = 'test-secret';
      groupMemberRepo.findOne.mockResolvedValue({ groupId: 'group-1', userId: 'caller' });
      // Rows are per device: the callee's two devices are one person to check.
      groupMemberRepo.find.mockResolvedValue([
        { userId: 'caller' },
        { userId: 'callee' },
        { userId: 'callee' },
      ]);
    });
    afterEach(() => {
      delete process.env.CALL_ROOM_SECRET;
      groupMemberRepo.manager.query.mockImplementation((sql: string) => baseQuery(sql));
      jest.restoreAllMocks();
    });

    it('refuses initiate with the neutral USER_BLOCKED answer, and binds no room', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      blockBetweenCallerAndCallee();

      const refusal = await service.initiateCall('caller', 'group-1').catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect((refusal as ForbiddenException).getResponse()).toEqual({
        code: 'USER_BLOCKED',
        message: 'This call cannot be placed.',
      });
      // No binding: without one, no ring window can open and no callee can ever get a token.
      expect(redis.set).not.toHaveBeenCalled();
      expect(captured(log)).toContain(
        '[call] initiate group=group-1 REFUSED user=caller: a block stands between the two'
      );
      // Checked once per person, not once per device row.
      const blockQueries = groupMemberRepo.manager.query.mock.calls.filter(([sql]) =>
        String(sql).includes('user_blocks')
      );
      expect(blockQueries).toHaveLength(1);
    });

    it('asks in both directions - the callee may be the one who blocked', async () => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      blockBetweenCallerAndCallee();

      await expect(service.initiateCall('caller', 'group-1')).rejects.toThrow(ForbiddenException);

      const [sql, params] = groupMemberRepo.manager.query.mock.calls.find(([q]) =>
        String(q).includes('user_blocks')
      )!;
      expect(params).toEqual(['caller', 'callee']);
      expect(sql).toMatch(/"blockerId" = \$1 AND "blockedId" = \$2/);
      expect(sql).toMatch(/"blockerId" = \$2 AND "blockedId" = \$1/);
    });

    it('places the call when no block stands', async () => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

      await expect(service.initiateCall('caller', 'group-1')).resolves.toHaveProperty('roomId');
    });

    it('refuses the ring for a block set between initiate and ring, and opens no window', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      // The caller sat on the first microphone prompt; the callee blocked meanwhile.
      const { roomId } = await service.initiateCall('caller', 'group-1');
      blockBetweenCallerAndCallee();

      const refusal = await service
        .ringGroup('caller', 'group-1', roomId, false)
        .catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect((refusal as ForbiddenException).getResponse()).toMatchObject({ code: 'USER_BLOCKED' });
      // Nothing fanned out, and no answer window was left behind.
      expect(pushTokenRepo.find).not.toHaveBeenCalled();
      expect(fcmSend).not.toHaveBeenCalled();
      expect(apnsVoip.sendVoipPush).not.toHaveBeenCalled();
      expect([...redisStore.keys()].some((k) => k.endsWith(':answer_by'))).toBe(false);
      expect(captured(log)).toContain(
        `[call] ring call=${roomId} REFUSED user=caller: a block stands between the two`
      );
    });

    it('refuses the join token for a block set while the call rang', async () => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const { roomId } = await service.initiateCall('caller', 'group-1');
      groupMemberRepo.find.mockResolvedValue([{ userId: 'caller' }]);
      await service.ringGroup('caller', 'group-1', roomId, false);

      blockBetweenCallerAndCallee();
      groupMemberRepo.findOne.mockResolvedValue({ groupId: 'group-1', userId: 'callee' });
      const refusal = await service
        .requestRoomToken('callee', 'group-1', roomId)
        .catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect((refusal as ForbiddenException).getResponse()).toMatchObject({ code: 'USER_BLOCKED' });
    });
  });
});
