/// <reference types="jest" />

import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CLAIM_SEAT_LUA, CloudflareSfuService, RELEASE_SEAT_LUA } from './cloudflare-sfu.service';
import type { CallsService } from './calls.service';

/**
 * The Cloudflare Realtime proxy (WP-GC3). Cloudflare is a mocked `fetch`; Redis is an in-memory fake
 * whose two scripts are the JS reading of the Lua (their atomicity is judged against a real Redis in
 * `cloudflare-sfu.redis.spec.ts`); the call gates of `CallsService` are stubs, tested in
 * `calls.service.spec.ts`.
 */

const ROOM = 'room-1';
const OFFER = { type: 'offer' as const, sdp: 'v=0 offer' };
const ANSWER = { type: 'answer' as const, sdp: 'v=0 answer' };

/** The subset of Redis the proxy uses, with the two scripts read in JS. */
function fakeRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const sets = new Map<string, Set<string>>();
  const hash = (k: string) => hashes.get(k) ?? hashes.set(k, new Map()).get(k)!;
  const set = (k: string) => sets.get(k) ?? sets.set(k, new Set()).get(k)!;
  const fake = {
    hashes,
    sets,
    /** The room binding's remaining life in ms; `-2` is an expired (absent) binding. */
    roomTtl: 1000,
    pttl: jest.fn(() => Promise.resolve(fake.roomTtl)),
    pexpire: jest.fn(() => Promise.resolve(1)),
    hget: jest.fn((k: string, f: string) => Promise.resolve(hashes.get(k)?.get(f) ?? null)),
    hgetall: jest.fn((k: string) => Promise.resolve(Object.fromEntries(hashes.get(k) ?? []))),
    sadd: jest.fn((k: string, ...m: string[]) => {
      m.forEach((x) => set(k).add(x));
      return Promise.resolve(m.length);
    }),
    sismember: jest.fn((k: string, m: string) => Promise.resolve(sets.get(k)?.has(m) ? 1 : 0)),
    smembers: jest.fn((k: string) => Promise.resolve([...(sets.get(k) ?? [])])),
    eval: jest.fn((script: string, _n: number, ...args: string[]) => {
      if (script === CLAIM_SEAT_LUA) {
        const [key, userId, sessionId, cap] = args;
        const seats = hash(key);
        const previous = seats.get(userId);
        if (previous === undefined && seats.size >= Number(cap)) return Promise.resolve([-1, '']);
        seats.set(userId, sessionId);
        return Promise.resolve([seats.size, previous ?? '']);
      }
      if (script === RELEASE_SEAT_LUA) {
        const [key, tracksKey, userId, sessionId] = args;
        const seats = hash(key);
        if (seats.get(userId) !== sessionId) return Promise.resolve([0, seats.size]);
        seats.delete(userId);
        sets.delete(tracksKey);
        return Promise.resolve([1, seats.size]);
      }
      throw new Error('unknown script');
    }),
  };
  return fake;
}

/** A Cloudflare answer as `fetch` resolves it. */
function cfAnswer(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response;
}

describe('CloudflareSfuService', () => {
  let redis: ReturnType<typeof fakeRedis>;
  let calls: {
    admitToCloudflareRoom: jest.Mock;
    assertCloudflareParticipant: jest.Mock;
  };
  let service: CloudflareSfuService;
  let fetchMock: jest.SpyInstance;
  let sessionCounter = 0;
  let maxSeats = 8;

  const captured = (spy: jest.SpyInstance): string =>
    spy.mock.calls.map((c: unknown[]) => c.map(String).join(' ')).join('\n');

  beforeEach(() => {
    jest.restoreAllMocks();
    redis = fakeRedis();
    sessionCounter = 0;
    maxSeats = 8;
    process.env.CLOUDFLARE_SFU_APP_ID = 'app-id';
    process.env.CLOUDFLARE_SFU_APP_SECRET = 'app-secret';
    calls = {
      admitToCloudflareRoom: jest.fn(() =>
        Promise.resolve({ groupId: 'g', callerId: 'a', maxSeats, video: false, mode: 'cloudflare' })
      ),
      assertCloudflareParticipant: jest.fn(() =>
        Promise.resolve({ groupId: 'g', callerId: 'a', maxSeats, video: false, mode: 'cloudflare' })
      ),
    };
    service = new CloudflareSfuService(calls as unknown as CallsService, redis as never);
    // Cloudflare: a new session per `sessions/new`; `tracks/new` echoes each track as accepted.
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation((url, init) => {
      const path = String(url);
      if (path.endsWith('/sessions/new')) {
        sessionCounter += 1;
        return Promise.resolve(cfAnswer(201, { sessionId: `s${sessionCounter}` }));
      }
      if (path.endsWith('/tracks/new')) {
        const body = JSON.parse(String(init?.body)) as { tracks: { trackName: string }[] };
        return Promise.resolve(
          cfAnswer(200, {
            requiresImmediateRenegotiation: false,
            sessionDescription: ANSWER,
            tracks: body.tracks.map((t) => ({ trackName: t.trackName, mid: '0' })),
          })
        );
      }
      return Promise.resolve(cfAnswer(200, {}));
    });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.CLOUDFLARE_SFU_APP_ID;
    delete process.env.CLOUDFLARE_SFU_APP_SECRET;
  });

  /** The last request the proxy sent Cloudflare. */
  const lastCall = (): [string, RequestInit] =>
    fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];

  /** `user` opens a session and pushes `tracks`; resolves with its session id. */
  async function seatAndPush(user: string, tracks: string[] = []): Promise<string> {
    const { sessionId } = await service.openSession(user, ROOM, 'token');
    if (tracks.length > 0) {
      await service.addTracks(user, ROOM, sessionId, {
        sessionDescription: OFFER,
        tracks: tracks.map((trackName, i) => ({ location: 'local', mid: String(i), trackName })),
      });
    }
    return sessionId;
  }

  describe('openSession', () => {
    it('opens a Cloudflare session with the app secret, claims a seat, and counts the others', async () => {
      const first = await service.openSession('a', ROOM, 'token');
      const second = await service.openSession('b', ROOM, 'token');

      expect(first).toEqual({ sessionId: 's1', others: 0 });
      expect(second).toEqual({ sessionId: 's2', others: 1 });
      expect(calls.admitToCloudflareRoom).toHaveBeenCalledWith('a', ROOM, 'token');
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://rtc.live.cloudflare.com/v1/apps/app-id/sessions/new');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer app-secret');
      expect(Object.fromEntries(redis.hashes.get(`call:room:${ROOM}:cf:seats`)!)).toEqual({
        a: 's1',
        b: 's2',
      });
    });

    it('refuses the user past the cap with GROUP_CALL_ROOM_FULL, and seats nobody more', async () => {
      maxSeats = 2;
      await service.openSession('a', ROOM, 'token');
      await service.openSession('b', ROOM, 'token');

      const refusal = await service.openSession('c', ROOM, 'token').catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(ConflictException);
      expect((refusal as ConflictException).getResponse()).toMatchObject({
        code: 'GROUP_CALL_ROOM_FULL',
      });
      expect(redis.hashes.get(`call:room:${ROOM}:cf:seats`)!.has('c')).toBe(false);
    });

    it('a second device of a seated user REPLACES its seat - even at the cap - and the first can no longer drive it', async () => {
      maxSeats = 2;
      const old = await service.openSession('a', ROOM, 'token');
      await service.openSession('b', ROOM, 'token');
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

      const replaced = await service.openSession('a', ROOM, 'token');

      expect(replaced.others).toBe(1);
      expect(captured(log)).toContain(`replaces session ${old.sessionId}`);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const refusal = await service
        .renegotiate('a', ROOM, old.sessionId, ANSWER)
        .catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect(captured(warn)).toContain('replaced by another device');
    });

    it('a gate refusal (token, room, membership) stops it before Cloudflare is asked', async () => {
      calls.admitToCloudflareRoom.mockRejectedValue(new ForbiddenException('no'));

      await expect(service.openSession('a', ROOM, 'bad')).rejects.toBeInstanceOf(
        ForbiddenException
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(['CLOUDFLARE_SFU_APP_ID', 'CLOUDFLARE_SFU_APP_SECRET'])(
      'without %s: a typed 503, named at ERROR without the secret, Cloudflare never asked',
      async (unset) => {
        delete process.env[unset];
        const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

        const refusal = await service.openSession('a', ROOM, 'token').catch((e: unknown) => e);

        expect(refusal).toBeInstanceOf(ServiceUnavailableException);
        expect((refusal as ServiceUnavailableException).getResponse()).toMatchObject({
          code: 'GROUP_CALL_RELAY_UNAVAILABLE',
          reason: 'unconfigured',
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(captured(error)).toContain(`${unset} is not set`);
        expect(captured(error)).not.toContain('app-secret');
      }
    );

    it('refuses a room whose binding has expired, and seats nobody', async () => {
      redis.roomTtl = -2;
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

      await expect(service.openSession('a', ROOM, 'token')).rejects.toBeInstanceOf(GoneException);
      expect(redis.hashes.get(`call:room:${ROOM}:cf:seats`)).toBeUndefined();
    });
  });

  describe('Cloudflare failing is a typed 502, never anything else', () => {
    const failures: [string, () => Promise<Response>, string][] = [
      ['a non-2xx status', () => Promise.resolve(cfAnswer(401, 'bad token')), 'answered 401'],
      [
        'an errorCode in a 200',
        () => Promise.resolve(cfAnswer(200, { errorCode: 'X', errorDescription: 'nope' })),
        'refused: X nope',
      ],
      ['an unreadable body', () => Promise.resolve(cfAnswer(200, '<html>')), 'failed:'],
      [
        'no answer within the bound',
        () => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })),
        'gave no answer within',
      ],
      ['a transport failure', () => Promise.reject(new TypeError('fetch failed')), 'failed:'],
    ];

    it.each(failures)('%s', async (_what, answer, logged) => {
      fetchMock.mockImplementation(answer);
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

      const refusal = await service.openSession('a', ROOM, 'token').catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(BadGatewayException);
      expect((refusal as BadGatewayException).getResponse()).toMatchObject({
        code: 'GROUP_CALL_RELAY_UNAVAILABLE',
        reason: 'upstream',
      });
      expect(captured(error)).toContain(logged);
      expect(redis.hashes.get(`call:room:${ROOM}:cf:seats`)).toBeUndefined();
    });
  });

  describe('addTracks', () => {
    it("pushes the caller's tracks and records them as pullable; another participant pulls them", async () => {
      const a = await seatAndPush('a', ['audio-a', 'video-a']);
      const b = await seatAndPush('b');

      const pull = { location: 'remote', sessionId: a, trackName: 'audio-a' };
      const answer = await service.addTracks('b', ROOM, b, { tracks: [pull] });

      expect(answer.sessionDescription).toEqual(ANSWER);
      const [url, init] = lastCall();
      expect(url).toBe(`https://rtc.live.cloudflare.com/v1/apps/app-id/sessions/${b}/tracks/new`);
      expect(JSON.parse(String(init.body))).toEqual({ tracks: [pull] });
      expect(
        [...redis.sets.get(`call:room:${ROOM}:cf:tracks:${a}`)!].sort((x, y) => x.localeCompare(y))
      ).toEqual(['audio-a', 'video-a']);
    });

    it('forwards exactly the fields Cloudflare reads - nothing else the client sent', async () => {
      const a = await seatAndPush('a');

      await service.addTracks('a', ROOM, a, {
        roomId: ROOM,
        sessionId: a,
        extra: 'x',
        sessionDescription: { ...OFFER, smuggled: true },
        tracks: [{ location: 'local', mid: '0', trackName: 't', sessionId: 'other' }],
      });

      const [, init] = lastCall();
      expect(JSON.parse(String(init.body))).toEqual({
        sessionDescription: OFFER,
        tracks: [{ location: 'local', mid: '0', trackName: 't' }],
      });
    });

    it('a track Cloudflare refused is not recorded as pullable, and the refusal is logged', async () => {
      const a = await seatAndPush('a');
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          cfAnswer(200, { tracks: [{ trackName: 'bad', errorCode: 'invalid_track' }] })
        )
      );
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

      await service.addTracks('a', ROOM, a, {
        sessionDescription: OFFER,
        tracks: [{ location: 'local', mid: '0', trackName: 'bad' }],
      });

      expect(redis.sets.get(`call:room:${ROOM}:cf:tracks:${a}`)).toBeUndefined();
      expect(captured(warn)).toContain('Cloudflare refused track bad: invalid_track');
    });

    it.each([
      ['a session of no seat in this room', 'stranger', 'audio-a'],
      ['a track the session never pushed', 'A_SESSION', 'video-z'],
      ["the caller's own session", 'OWN', 'audio-a'],
    ])('refuses a pull from %s, before Cloudflare is asked', async (_what, from, trackName) => {
      const a = await seatAndPush('a', ['audio-a']);
      const b = await seatAndPush('b');
      const before = fetchMock.mock.calls.length;
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const sessionId = from === 'A_SESSION' ? a : from === 'OWN' ? b : from;

      const refusal = await service
        .addTracks('b', ROOM, b, { tracks: [{ location: 'remote', sessionId, trackName }] })
        .catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect(fetchMock.mock.calls.length).toBe(before);
    });

    it("refuses to drive another user's session", async () => {
      const a = await seatAndPush('a');
      await seatAndPush('b');
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

      const refusal = await service
        .addTracks('b', ROOM, a, {
          sessionDescription: OFFER,
          tracks: [{ location: 'local', mid: '0', trackName: 'spoof' }],
        })
        .catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(ForbiddenException);
    });

    it.each([
      ['no tracks', { tracks: [] }],
      ['an unknown location', { tracks: [{ location: 'x', trackName: 't' }] }],
      [
        'a local track without its offer',
        { tracks: [{ location: 'local', mid: '0', trackName: 't' }] },
      ],
      [
        'a track name outside the allowlist',
        { sessionDescription: OFFER, tracks: [{ location: 'local', mid: '0', trackName: 'a b' }] },
      ],
      [
        'an SDP of no known type',
        {
          sessionDescription: { type: 'pranswer', sdp: 'x' },
          tracks: [{ location: 'local', mid: '0', trackName: 't' }],
        },
      ],
    ])('answers 400 to %s', async (_what, body) => {
      const a = await seatAndPush('a');

      await expect(service.addTracks('a', ROOM, a, body)).rejects.toBeInstanceOf(
        BadRequestException
      );
    });

    it('re-runs the participant gate on every step (a member removed mid-call is refused)', async () => {
      const a = await seatAndPush('a');
      calls.assertCloudflareParticipant.mockRejectedValue(new ForbiddenException('gone'));

      await expect(
        service.addTracks('a', ROOM, a, {
          sessionDescription: OFFER,
          tracks: [{ location: 'local', mid: '0', trackName: 't' }],
        })
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('renegotiate and closeTracks', () => {
    it("hand the caller's own SDP and mids to its own session", async () => {
      const a = await seatAndPush('a');

      await service.renegotiate('a', ROOM, a, ANSWER);
      let [url, init] = lastCall();
      expect(url).toMatch(new RegExp(`/sessions/${a}/renegotiate$`));
      expect(init.method).toBe('PUT');
      expect(JSON.parse(String(init.body))).toEqual({ sessionDescription: ANSWER });

      await service.closeTracks('a', ROOM, a, { tracks: [{ mid: '0' }], force: true });
      [url, init] = lastCall();
      expect(url).toMatch(new RegExp(`/sessions/${a}/tracks/close$`));
      expect(JSON.parse(String(init.body))).toEqual({ tracks: [{ mid: '0' }], force: true });
    });
  });

  describe('roster and leave', () => {
    it('lists the OTHER seated participants and what each pushed, to a seated caller only', async () => {
      const a = await seatAndPush('a', ['audio-a']);
      const b = await seatAndPush('b', ['audio-b', 'video-b']);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

      expect(await service.roster('a', ROOM)).toEqual({
        participants: [{ userId: 'b', sessionId: b, tracks: ['audio-b', 'video-b'] }],
        others: 1,
      });
      expect((await service.roster('b', ROOM)).participants).toEqual([
        { userId: 'a', sessionId: a, tracks: ['audio-a'] },
      ]);
      await expect(service.roster('c', ROOM)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('leave releases the seat and its tracks, and the last one out says the room is empty', async () => {
      const a = await seatAndPush('a', ['audio-a']);
      const b = await seatAndPush('b');
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

      expect(await service.leave('a', ROOM, a)).toEqual({ others: 1 });
      expect(redis.sets.has(`call:room:${ROOM}:cf:tracks:${a}`)).toBe(false);
      expect(await service.leave('b', ROOM, b)).toEqual({ others: 0 });
      expect(captured(log)).toContain('seats-left=0 - the room is empty');
    });

    it("a replaced device's late leave does not unseat the device that replaced it", async () => {
      const old = await seatAndPush('a');
      const current = await seatAndPush('a');
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

      await service.leave('a', ROOM, old);

      expect(redis.hashes.get(`call:room:${ROOM}:cf:seats`)!.get('a')).toBe(current);
      expect(captured(log)).toContain('nothing released');
    });
  });
});
