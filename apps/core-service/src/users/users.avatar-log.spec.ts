import { BadRequestException, Logger } from '@nestjs/common';
import { UsersController, etagMatches } from './users.controller';
import type { AvatarOutcome, AvatarService } from './avatar.service';
import type { UsersService } from './users.service';
import type { UserBlocksService } from './user-blocks.service';
import type { ProfileEditService } from './profile-edit.service';
import type { ProfileCorrectionService } from './profile-correction.service';
import type { AccountErasureService } from '../account-erasure/account-erasure.service';
import { mintAvatarToken } from '../auth/avatar-token';

/**
 * `GET /users/:id/avatar` - ONE `[AVATAR]` line per request, whatever the outcome. Status codes are
 * unchanged by it; the assertions pin the vocabulary, the level (info for served/absent, warn for
 * the rest) and the 8-character target truncation.
 */
describe('GET /users/:id/avatar logging', () => {
  const ID = 'abcdef0123456789';
  const INTERNAL = 'the-internal-secret';
  const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
  let info: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    info = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    savedEnv = { ...process.env };
    process.env.INTERNAL_SECRET = INTERNAL;
    process.env.AVATAR_TOKEN_SECRET = 's'.repeat(40);
  });
  afterEach(() => {
    info.mockRestore();
    warn.mockRestore();
    process.env = savedEnv;
  });

  /** How a request asks: the INTERNAL credential, or as a viewer (a `?t=` token, or nothing). */
  type Asker = 'internal' | { token?: string; headers?: Record<string, string>; live?: boolean };

  /**
   * One avatar request. By default it carries the INTERNAL credential, so the outcome tests below
   * read the outcome alone; `asker` asks as a viewer instead.
   */
  async function run(
    fetchUserAvatar: () => Promise<AvatarOutcome>,
    ifNoneMatch?: string,
    asker: Asker = 'internal'
  ) {
    const controller = new UsersController(
      {} as UsersService,
      { fetchUserAvatar } as unknown as AvatarService,
      {} as UserBlocksService,
      {} as ProfileEditService,
      {} as ProfileCorrectionService,
      {} as AccountErasureService,
      {
        isLiveSession: jest.fn(async () => asker === 'internal' || asker.live !== false),
      } as never
    );
    const res = { set: jest.fn(), status: jest.fn(), end: jest.fn(), send: jest.fn() };
    res.status.mockReturnValue(res);
    const headers: Record<string, string> = {
      ...(ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}),
      ...(asker === 'internal' ? { 'x-internal-secret': INTERNAL } : (asker.headers ?? {})),
    };
    const query = asker !== 'internal' && asker.token !== undefined ? { t: asker.token } : {};
    await controller.getAvatar(ID, { headers, query } as never, res as never);
    return res;
  }

  describe('who may ask (avatar-access.ts)', () => {
    const IMAGE_OUTCOME = async (): Promise<AvatarOutcome> => ({
      kind: 'image',
      body: Buffer.from([1]),
      contentType: 'image/png',
    });

    it('a viewer with a valid token of a live session is served, logged access=signed', async () => {
      const res = await run(IMAGE_OUTCOME, undefined, { token: mintAvatarToken(SID)! });
      expect(res.send).toHaveBeenCalled();
      expect(String(info.mock.calls[0][0])).toMatch(/outcome=served status=200 .* access=signed$/);
      expect(warn).not.toHaveBeenCalled();
    });

    it('an invalid token is a bodyless, unstored 403 - and the provider is never asked', async () => {
      const fetchUserAvatar = jest.fn(IMAGE_OUTCOME);
      const res = await run(fetchUserAvatar, undefined, { token: `${SID}.${'A'.repeat(43)}` });
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.end).toHaveBeenCalled();
      expect(res.send).not.toHaveBeenCalled();
      expect(headersOf(res)['Cache-Control']).toBe('no-store');
      expect(fetchUserAvatar).not.toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toMatch(
        /^\[AVATAR\] outcome=refused status=403 ms=\d+ target=abcdef01 access=refused reason=bad-signature$/
      );
    });

    it('a token of an ended session is refused 403', async () => {
      const res = await run(IMAGE_OUTCOME, undefined, {
        token: mintAvatarToken(SID)!,
        live: false,
      });
      expect(res.status).toHaveBeenCalledWith(403);
      expect(String(warn.mock.calls[0][0])).toContain('reason=session-ended');
    });

    it('PHASE 1: no token is still served, and counted at warn as [AVATAR_UNSIGNED] with its evidence', async () => {
      const res = await run(IMAGE_OUTCOME, undefined, {
        headers: { 'x-real-ip': '203.0.113.7', origin: 'tauri://localhost' },
      });
      expect(res.send).toHaveBeenCalled();
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        '[AVATAR_UNSIGNED] via=nginx origin=native target=abcdef01',
      ]);
      expect(String(info.mock.calls[0][0])).toMatch(/outcome=served .* access=unsigned$/);
    });

    it('an unsigned request from inside the network names itself via=direct origin=none', async () => {
      await run(IMAGE_OUTCOME, undefined, {});
      expect(String(warn.mock.calls[0][0])).toBe(
        '[AVATAR_UNSIGNED] via=direct origin=none target=abcdef01'
      );
    });

    it('the internal exemption: a service credential needs no token and is not counted', async () => {
      const res = await run(IMAGE_OUTCOME);
      expect(res.send).toHaveBeenCalled();
      expect(String(info.mock.calls[0][0])).toMatch(/access=internal$/);
      expect(warn).not.toHaveBeenCalled();
    });

    it('a session store that does not answer is a bodyless 503, never a 403 verdict', async () => {
      const controller = new UsersController(
        {} as UsersService,
        { fetchUserAvatar: jest.fn() } as unknown as AvatarService,
        {} as UserBlocksService,
        {} as ProfileEditService,
        {} as ProfileCorrectionService,
        {} as AccountErasureService,
        {
          isLiveSession: jest.fn(async () => {
            throw new Error('connection terminated');
          }),
        } as never
      );
      const res = { set: jest.fn(), status: jest.fn(), end: jest.fn(), send: jest.fn() };
      res.status.mockReturnValue(res);
      await controller.getAvatar(
        ID,
        { headers: {}, query: { t: mintAvatarToken(SID)! } } as never,
        res as never
      );
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.send).not.toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toContain('outcome=unavailable status=503');
    });
  });

  it('a review account: a bodyless 404 never cached, and no provider asked (review-cohort.ts)', async () => {
    const saved = process.env.SERVICE_ACCOUNT_USER_ID;
    process.env.SERVICE_ACCOUNT_USER_ID = ID;
    try {
      const fetchUserAvatar = jest.fn(async () => IMAGE);
      const res = await run(fetchUserAvatar);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(headersOf(res)['Cache-Control']).toBe('no-store');
      expect(res.send).not.toHaveBeenCalled();
      expect(fetchUserAvatar).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.SERVICE_ACCOUNT_USER_ID;
      else process.env.SERVICE_ACCOUNT_USER_ID = saved;
    }
  });

  it('served: info, 200, truncated target', async () => {
    await run(async () => ({ kind: 'image', body: Buffer.from([1]), contentType: 'image/png' }));
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toMatch(
      /^\[AVATAR\] outcome=served status=200 ms=\d+ target=abcdef01 access=internal$/
    );
    expect(warn).not.toHaveBeenCalled();
  });

  /** The headers the browser, Cloudflare and the browser cache actually receive. */
  function headersOf(res: { set: jest.Mock }): Record<string, unknown> {
    return Object.assign({}, ...res.set.mock.calls.map((c) => c[0]));
  }
  const IMAGE = {
    kind: 'image',
    body: Buffer.from([1, 2]),
    contentType: 'image/png',
    etag: '"asset-1"',
  } as const;

  it('image: no-cache + the upstream ETag, never a max-age', async () => {
    const res = await run(async () => IMAGE);
    const h = headersOf(res);
    expect(h['Cache-Control']).toBe('public, no-cache');
    expect(String(h['Cache-Control'])).not.toMatch(/max-age/);
    expect(h['ETag']).toBe('"asset-1"');
    expect(res.send).toHaveBeenCalledWith(IMAGE.body);
  });

  it('image: a matching If-None-Match is a bodyless 304 that keeps the validator', async () => {
    const res = await run(async () => IMAGE, '"other", W/"asset-1"');
    expect(res.status).toHaveBeenCalledWith(304);
    expect(res.send).not.toHaveBeenCalled();
    expect(headersOf(res)['ETag']).toBe('"asset-1"');
    expect(headersOf(res)['Cache-Control']).toBe('public, no-cache');
    expect(String(info.mock.calls[0][0])).toContain('outcome=not-modified status=304');
  });

  it('image: a stale If-None-Match gets the full 200', async () => {
    const res = await run(async () => IMAGE, '"asset-0"');
    expect(res.status).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith(IMAGE.body);
  });

  it('etagMatches: weak comparison, lists and *', () => {
    expect(etagMatches(undefined, '"a"')).toBe(false);
    expect(etagMatches('"a"', 'W/"a"')).toBe(true);
    expect(etagMatches('W/"a"', '"a"')).toBe(true);
    expect(etagMatches('"b", "a"', '"a"')).toBe(true);
    expect(etagMatches('*', '"a"')).toBe(true);
    expect(etagMatches('"b"', '"a"')).toBe(false);
  });

  it('absent: info, 404', async () => {
    const res = await run(async () => ({ kind: 'absent' }));
    expect(res.status).toHaveBeenCalledWith(404);
    expect(String(info.mock.calls[0][0])).toContain('outcome=absent status=404');
    expect(warn).not.toHaveBeenCalled();
  });

  it('unavailable: warn, 502', async () => {
    const res = await run(async () => ({ kind: 'unavailable' }));
    expect(res.status).toHaveBeenCalledWith(502);
    expect(String(warn.mock.calls[0][0])).toContain('outcome=unavailable status=502');
    expect(info).not.toHaveBeenCalled();
  });

  it('disabled: warn, 404', async () => {
    const res = await run(async () => ({ kind: 'disabled' }));
    expect(res.status).toHaveBeenCalledWith(404);
    expect(String(warn.mock.calls[0][0])).toContain('outcome=disabled status=404');
  });

  it('rejected: a malformed id still throws 400 and logs', async () => {
    await expect(
      run(async () => {
        throw new BadRequestException('Invalid user ID');
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(String(warn.mock.calls[0][0])).toContain('outcome=rejected status=400');
  });
});
