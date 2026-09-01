/// <reference types="jest" />

import {
  BadRequestException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as jwt from 'jsonwebtoken';
import { AuthController } from './auth.controller';
import type { AuthSessionsService, RotateResult } from './auth-sessions.service';

const JWT_SECRET = 'test-secret-not-the-production-one';

/** Minimal Express response double: records what the controller wrote. */
function makeRes() {
  const cookies: Record<string, string> = {};
  // The OPTIONS, not just the value: `secure` and `sameSite` decide whether a refresh credential
  // crosses the network protected, so they are part of what this double has to be able to show.
  const cookieOptions: Record<string, Record<string, unknown>> = {};
  const clearedOptions: Record<string, Record<string, unknown>> = {};
  const cleared: string[] = [];
  const headers: Record<string, string> = {};
  let statusCode = 0;
  const res = {
    cookie: (name: string, value: string, options?: Record<string, unknown>) => {
      cookies[name] = value;
      cookieOptions[name] = options ?? {};
      return res;
    },
    clearCookie: (name: string, options?: Record<string, unknown>) => {
      cleared.push(name);
      clearedOptions[name] = options ?? {};
      return res;
    },
    set: (name: string, value: string) => {
      headers[name] = value;
      return res;
    },
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    send: () => res,
    json: () => res,
  };
  return {
    res: res as unknown as Response,
    cookies,
    cookieOptions,
    cleared,
    clearedOptions,
    headers,
    status: () => statusCode,
  };
}

/** Minimal Express request double carrying cookies and headers. */
function makeReq(
  options: {
    cookies?: Record<string, string>;
    bearer?: string;
    origin?: string;
    carriedRefresh?: string;
  } = {}
): Request {
  const headers: Record<string, string> = { 'user-agent': 'jest' };
  if (options.bearer) headers['authorization'] = `Bearer ${options.bearer}`;
  if (options.origin) headers['origin'] = options.origin;
  if (options.carriedRefresh) headers['x-canari-refresh'] = options.carriedRefresh;
  return {
    cookies: options.cookies ?? {},
    headers,
    get: (name: string) => headers[name.toLowerCase()],
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
}

function signRefresh(claims: Record<string, unknown>): string {
  return jwt.sign(claims, JWT_SECRET, { expiresIn: '7d' });
}

function signAccess(sub: string, admin = false): string {
  return jwt.sign({ sub, admin }, JWT_SECRET, { expiresIn: '1h' });
}

describe('AuthController sessions', () => {
  let controller: AuthController;
  let sessions: jest.Mocked<
    Pick<
      AuthSessionsService,
      'create' | 'rotate' | 'revoke' | 'revokeOwned' | 'revokeOthers' | 'listForUser' | 'bindDevice'
    >
  >;

  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';
    // Required outside production, and deliberately without a default: the controller refuses
    // to start rather than guess whether the refresh cookie should carry `Secure`.
    process.env.ALLOW_INSECURE_COOKIES = 'false';

    sessions = {
      create: jest.fn().mockResolvedValue({
        sessionId: 'sid-new',
        tokenId: 'jti-new',
        expiresAt: new Date(Date.now() + 1000),
      }),
      rotate: jest.fn(),
      revoke: jest.fn().mockResolvedValue(undefined),
      revokeOwned: jest.fn().mockResolvedValue(true),
      revokeOthers: jest.fn().mockResolvedValue(2),
      listForUser: jest.fn().mockResolvedValue([]),
      bindDevice: jest.fn().mockResolvedValue(true),
    } as never;

    const users = {
      findOne: jest.fn().mockResolvedValue({ id: 'user-1', admin: false }),
    };
    const platform = {
      getConfig: jest.fn().mockResolvedValue({}),
      isAccessBlockedByMaintenance: jest.fn().mockReturnValue(false),
    };

    controller = new AuthController(
      users as never,
      platform as never,
      sessions as unknown as AuthSessionsService
    );
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.ALLOW_INSECURE_COOKIES;
  });

  describe('refresh cookie attributes', () => {
    /**
     * Until 2026-09-01 these attributes were decided per request, from `Origin` or `Referer`, so
     * outside production a caller could ask for its own credential to be sent without `Secure`
     * simply by claiming to come from localhost. They are now a deployment fact.
     */
    const buildController = (): AuthController =>
      new AuthController(
        { findOne: jest.fn().mockResolvedValue({ id: 'user-1', admin: false }) } as never,
        {
          getConfig: jest.fn().mockResolvedValue({}),
          isAccessBlockedByMaintenance: jest.fn().mockReturnValue(false),
        } as never,
        sessions as unknown as AuthSessionsService
      );

    const cookieOptionsFor = async (origin: string): Promise<Record<string, unknown>> => {
      sessions.rotate.mockResolvedValue({
        status: 'rotated',
        tokenId: 'jti-2',
        expiresAt: new Date(Date.now() + 1000),
      } as RotateResult);
      const req = makeReq({
        origin,
        cookies: {
          canari_refresh: signRefresh({
            sub: 'user-1',
            type: 'refresh',
            sid: 'sid-1',
            jti: 'jti-1',
          }),
        },
      });
      const out = makeRes();
      await buildController().refreshToken(req, out.res);
      return out.cookieOptions['canari_refresh'] ?? {};
    };

    it('ignores the Origin header, which the caller writes', async () => {
      const fromLocalhost = await cookieOptionsFor('http://localhost:1420');
      const fromProd = await cookieOptionsFor('https://canari-emse.fr');

      expect(fromLocalhost['secure']).toBe(true);
      expect(fromLocalhost['sameSite']).toBe('none');
      expect(fromLocalhost).toEqual(fromProd);
    });

    it('drops Secure only when the deployment says so', async () => {
      process.env.ALLOW_INSECURE_COOKIES = 'true';
      const options = await cookieOptionsFor('http://localhost:1420');

      expect(options['secure']).toBe(false);
      expect(options['sameSite']).toBe('lax');
    });

    it('refuses to start when nothing says which attributes to use', () => {
      delete process.env.ALLOW_INSECURE_COOKIES;

      expect(() => buildController()).toThrow(/ALLOW_INSECURE_COOKIES must be set/);
    });

    it('refuses an insecure cookie in production rather than ignoring the request for one', () => {
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_INSECURE_COOKIES = 'true';

      expect(() => buildController()).toThrow(/without Secure over HTTPS/);
    });
  });

  describe('refresh', () => {
    it('rotates the session and hands back a cookie carrying the new jti', async () => {
      const rotated: RotateResult = {
        status: 'rotated',
        tokenId: 'jti-2',
        expiresAt: new Date(Date.now() + 1000),
      };
      sessions.rotate.mockResolvedValue(rotated);

      const req = makeReq({
        cookies: {
          canari_refresh: signRefresh({
            sub: 'user-1',
            type: 'refresh',
            sid: 'sid-1',
            jti: 'jti-1',
          }),
        },
      });
      const out = makeRes();

      await controller.refreshToken(req, out.res);

      expect(sessions.rotate).toHaveBeenCalledWith('sid-1', 'jti-1', expect.anything());
      const cookie = jwt.verify(out.cookies['canari_refresh'], JWT_SECRET) as {
        sid: string;
        jti: string;
      };
      expect(cookie.sid).toBe('sid-1');
      expect(cookie.jti).toBe('jti-2');
    });

    it('refuses a replayed token and clears the cookie', async () => {
      sessions.rotate.mockResolvedValue({ status: 'replayed' });

      const req = makeReq({
        cookies: {
          canari_refresh: signRefresh({
            sub: 'user-1',
            type: 'refresh',
            sid: 'sid-1',
            jti: 'old',
          }),
        },
      });
      const out = makeRes();

      await expect(controller.refreshToken(req, out.res)).rejects.toThrow(UnauthorizedException);
      expect(out.cleared).toContain('canari_refresh');
      expect(out.cookies['canari_refresh']).toBeUndefined();
    });

    it('refuses a token whose session no longer exists', async () => {
      sessions.rotate.mockResolvedValue({ status: 'unknown' });

      const req = makeReq({
        cookies: {
          canari_refresh: signRefresh({
            sub: 'user-1',
            type: 'refresh',
            sid: 'gone',
            jti: 'x',
          }),
        },
      });
      const out = makeRes();

      await expect(controller.refreshToken(req, out.res)).rejects.toThrow(UnauthorizedException);
      expect(out.cleared).toContain('canari_refresh');
    });

    it('REFUSES a pre-WP-SESS-2 token that carries no session, rather than adopting it', async () => {
      // It used to be adopted into a fresh session, so the release that introduced the table would
      // not sign everyone out. That window was one refresh TTL wide and closed on 2026-08-12, and
      // the branch minted a session for a token nothing had checked against a row - the exact
      // property the table exists to remove. A token with no `sid` is now expired by its own `exp`.
      const req = makeReq({
        cookies: {
          canari_refresh: signRefresh({ sub: 'user-1', type: 'refresh' }),
        },
      });
      const out = makeRes();

      await expect(controller.refreshToken(req, out.res)).rejects.toThrow(UnauthorizedException);
      expect(sessions.create).not.toHaveBeenCalled();
      expect(sessions.rotate).not.toHaveBeenCalled();
      expect(out.cleared).toContain('canari_refresh');
    });

    it('refuses an access token presented as a refresh cookie', async () => {
      const req = makeReq({
        cookies: { canari_refresh: signAccess('user-1') },
      });
      const out = makeRes();

      await expect(controller.refreshToken(req, out.res)).rejects.toThrow(UnauthorizedException);
      expect(sessions.rotate).not.toHaveBeenCalled();
      expect(sessions.create).not.toHaveBeenCalled();
    });
  });

  /**
   * The credential's transport, for the platforms whose WebView refuses a third-party cookie.
   *
   * Measured on production 2026-08-27: an iPhone presented `cookies=[]` on 120 consecutive refreshes
   * while an Android device answered 200 on the same server, and A1 kept its session across an
   * `am force-stop` with a single `refresh 200`. These pin the seam that closes that gap, because a
   * device round trip is otherwise the only witness to it.
   */
  describe('refresh transport', () => {
    const rotated: RotateResult = {
      status: 'rotated',
      tokenId: 'jti-2',
      expiresAt: new Date(Date.now() + 1000),
    };
    const carried = () =>
      signRefresh({ sub: 'user-1', type: 'refresh', sid: 'sid-1', jti: 'jti-1' });

    it('rotates from the HEADER for a custom-scheme client, and returns the new value in the body', async () => {
      sessions.rotate.mockResolvedValue(rotated);
      const req = makeReq({ origin: 'tauri://localhost', carriedRefresh: carried() });
      const out = makeRes();

      const body = await controller.refreshToken(req, out.res);

      expect(sessions.rotate).toHaveBeenCalledWith('sid-1', 'jti-1', expect.anything());
      // Without this the client has nothing to persist, and the next cold start is a fresh login.
      expect(body.refresh_token).toBeDefined();
      const next = jwt.verify(body.refresh_token as string, JWT_SECRET) as { jti: string };
      expect(next.jti).toBe('jti-2');
    });

    it('does NOT return the credential in the body to a web client, where HttpOnly is the point', async () => {
      sessions.rotate.mockResolvedValue(rotated);
      const req = makeReq({
        origin: 'https://canari-emse.fr',
        cookies: { canari_refresh: carried() },
      });
      const out = makeRes();

      const body = await controller.refreshToken(req, out.res);

      expect(body.refresh_token).toBeUndefined();
      expect(out.cookies['canari_refresh']).toBeDefined();
    });

    it('ignores the header entirely for an origin that can keep its cookie', async () => {
      // Android's cookie is proven and stays authoritative there: a header must not become a second
      // way in, nor a way to present a credential the cookie policy would have refused.
      sessions.rotate.mockResolvedValue(rotated);
      const req = makeReq({ origin: 'http://tauri.localhost', carriedRefresh: carried() });
      const out = makeRes();

      await expect(controller.refreshToken(req, out.res)).rejects.toThrow(UnauthorizedException);
      expect(sessions.rotate).not.toHaveBeenCalled();
    });

    it('still sets the cookie for a custom-scheme client, because that origin is desktop too', async () => {
      // `tauri://localhost` is iOS, macOS AND the Linux AppImage. Where the cookie survives it stays
      // the better credential, so dropping it here would log those installs out on a deploy.
      sessions.rotate.mockResolvedValue(rotated);
      const req = makeReq({ origin: 'tauri://localhost', carriedRefresh: carried() });
      const out = makeRes();

      await controller.refreshToken(req, out.res);

      expect(out.cookies['canari_refresh']).toBeDefined();
    });

    it('accepts the COOKIE from a custom-scheme client that sends no header (the shim)', async () => {
      // A client older than this transport, and every desktop build until it updates. Recorded with
      // its removal condition in docs/wiki/legacy-compatibility.md.
      sessions.rotate.mockResolvedValue(rotated);
      const req = makeReq({
        origin: 'tauri://localhost',
        cookies: { canari_refresh: carried() },
      });
      const out = makeRes();

      const body = await controller.refreshToken(req, out.res);

      expect(sessions.rotate).toHaveBeenCalledWith('sid-1', 'jti-1', expect.anything());
      // It is still TOLD to carry it from now on: that is how an updated client stops needing the shim.
      expect(body.refresh_token).toBeDefined();
    });

    it('revokes the session named by the CARRIED credential on logout, not just the cookie', async () => {
      // Without this, a logout on iOS clears the local copy and leaves the row alive for seven days.
      const req = makeReq({ origin: 'tauri://localhost', carriedRefresh: carried() });
      const out = makeRes();

      await controller.logout(req, out.res);

      expect(sessions.revoke).toHaveBeenCalledWith('sid-1');
    });

    it('names the BUILD that asked when it refuses, which is the only thing that attributes it', async () => {
      // Without this field the line reads IDENTICALLY for the two causes it now has: a client too
      // old to carry a credential, which is expected and owes nothing, and a client that should have
      // carried one and whose store write failed, which is a defect. A client with an empty store
      // correctly sends no header, so no other field separates them. Measured 2026-08-27: every iOS
      // device on prod was on 0.14.5, one build before this transport existed.
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const req = makeReq({ origin: 'tauri://localhost' });
      const out = makeRes();

      await expect(controller.refreshToken(req, out.res, '0.14.7')).rejects.toThrow(
        UnauthorizedException
      );

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('client=0.14.7'));
      warn.mockRestore();
    });

    it('says `unstated` rather than nothing when the client is too old to name itself', async () => {
      // An absent parameter must read as an ANSWER - "a build from before this existed" - not as a
      // gap in the line that leaves a reader wondering whether the field was dropped.
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const req = makeReq({ origin: 'tauri://localhost' });
      const out = makeRes();

      await expect(controller.refreshToken(req, out.res)).rejects.toThrow(UnauthorizedException);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('client=unstated'));
      warn.mockRestore();
    });

    it('does not accuse a cookie platform of an empty header - there it is IGNORED, not missing', async () => {
      // The first version of this line called it `empty` for a header that was present and valid, on
      // an origin whose policy is simply to ignore it. A field that accuses on a healthy request is
      // worse than no field at all, so the three states stay three.
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const req = makeReq({ origin: 'http://tauri.localhost', carriedRefresh: carried() });
      const out = makeRes();

      await expect(controller.refreshToken(req, out.res, '0.14.7')).rejects.toThrow(
        UnauthorizedException
      );

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('x-canari-refresh=ignored'));
      warn.mockRestore();
    });
  });

  describe('logout', () => {
    it('destroys the session named by the cookie, not just the cookie', async () => {
      const req = makeReq({
        cookies: {
          canari_refresh: signRefresh({
            sub: 'user-1',
            type: 'refresh',
            sid: 'sid-1',
            jti: 'j',
          }),
        },
      });
      const out = makeRes();

      await controller.logout(req, out.res);

      expect(sessions.revoke).toHaveBeenCalledWith('sid-1');
      expect(out.cleared).toContain('canari_refresh');
    });

    it('still clears the cookie when no session can be read from it', async () => {
      const out = makeRes();
      await controller.logout(makeReq(), out.res);

      expect(sessions.revoke).not.toHaveBeenCalled();
      expect(out.cleared).toContain('canari_refresh');
    });
  });

  describe('session management', () => {
    it('flags the session the request came from', async () => {
      sessions.listForUser.mockResolvedValue([
        {
          id: 'sid-1',
          createdAt: new Date(),
          lastUsedAt: new Date(),
          expiresAt: new Date(),
          userAgent: 'Firefox',
          lastIp: '10.0.0.1',
          deviceId: 'web-a-b',
        },
        {
          id: 'sid-2',
          createdAt: new Date(),
          lastUsedAt: new Date(),
          expiresAt: new Date(),
          userAgent: null,
          lastIp: null,
          deviceId: null,
        },
      ]);

      const req = makeReq({
        bearer: signAccess('user-1'),
        cookies: {
          canari_refresh: signRefresh({
            sub: 'user-1',
            type: 'refresh',
            sid: 'sid-2',
            jti: 'j',
          }),
        },
      });

      const { sessions: listed } = await controller.listSessions(req);

      expect(listed.map((s) => s.current)).toEqual([false, true]);
    });

    it('binds the calling session to the device the client names', async () => {
      sessions.bindDevice.mockResolvedValue(true);
      const req = makeReq({
        bearer: signAccess('user-1'),
        cookies: {
          canari_refresh: signRefresh({
            sub: 'user-1',
            type: 'refresh',
            sid: 'sid-2',
            jti: 'j',
          }),
        },
      });

      await expect(
        controller.bindCurrentSessionDevice(req, { deviceId: 'web-a-b' })
      ).resolves.toEqual({
        bound: true,
      });
      expect(sessions.bindDevice).toHaveBeenCalledWith('user-1', 'sid-2', 'web-a-b');
    });

    it('binds only the session the request came from, never one named in the body', async () => {
      // The session id is read from the caller's own cookie and is not an input, so there is no
      // shape of request that stamps a device onto somebody else's login.
      sessions.bindDevice.mockResolvedValue(true);
      const req = makeReq({
        bearer: signAccess('user-1'),
        cookies: {
          canari_refresh: signRefresh({
            sub: 'user-1',
            type: 'refresh',
            sid: 'sid-mine',
            jti: 'j',
          }),
        },
      });

      await controller.bindCurrentSessionDevice(req, {
        deviceId: 'web-a-b',
        sessionId: 'sid-victim',
      } as { deviceId: unknown });

      expect(sessions.bindDevice).toHaveBeenCalledWith('user-1', 'sid-mine', 'web-a-b');
    });

    it('refuses a binding with no device id, and one from an unauthenticated caller', async () => {
      const authed = makeReq({
        bearer: signAccess('user-1'),
        cookies: {
          canari_refresh: signRefresh({
            sub: 'user-1',
            type: 'refresh',
            sid: 'sid-2',
            jti: 'j',
          }),
        },
      });

      await expect(controller.bindCurrentSessionDevice(authed, {})).rejects.toThrow(
        BadRequestException
      );
      await expect(
        controller.bindCurrentSessionDevice(makeReq(), { deviceId: 'web-a-b' })
      ).rejects.toThrow(UnauthorizedException);
      expect(sessions.bindDevice).not.toHaveBeenCalled();
    });

    it('reports a session that is already gone rather than recreating one', async () => {
      sessions.bindDevice.mockResolvedValue(false);
      const req = makeReq({
        bearer: signAccess('user-1'),
        cookies: {
          canari_refresh: signRefresh({
            sub: 'user-1',
            type: 'refresh',
            sid: 'sid-2',
            jti: 'j',
          }),
        },
      });

      await expect(
        controller.bindCurrentSessionDevice(req, { deviceId: 'web-a-b' })
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses a refresh token presented as a bearer access token', async () => {
      const req = makeReq({
        bearer: signRefresh({
          sub: 'user-1',
          type: 'refresh',
          sid: 'sid-1',
          jti: 'j',
        }),
      });

      await expect(controller.listSessions(req)).rejects.toThrow(UnauthorizedException);
      expect(sessions.listForUser).not.toHaveBeenCalled();
    });

    it('refuses an unauthenticated caller', async () => {
      await expect(controller.listSessions(makeReq())).rejects.toThrow(UnauthorizedException);
    });

    it('scopes a single revocation to the calling user', async () => {
      const req = makeReq({ bearer: signAccess('user-1') });
      const out = makeRes();

      await controller.revokeSession('sid-other', req, out.res);

      expect(sessions.revokeOwned).toHaveBeenCalledWith('user-1', 'sid-other');
      // Not the current session, so the caller keeps its own cookie.
      expect(out.cleared).toHaveLength(0);
    });

    it('clears the cookie when the caller revokes its own session', async () => {
      const req = makeReq({
        bearer: signAccess('user-1'),
        cookies: {
          canari_refresh: signRefresh({
            sub: 'user-1',
            type: 'refresh',
            sid: 'sid-1',
            jti: 'j',
          }),
        },
      });
      const out = makeRes();

      await controller.revokeSession('sid-1', req, out.res);

      expect(out.cleared).toContain('canari_refresh');
    });

    it('keeps the current session when revoking the others', async () => {
      const req = makeReq({
        bearer: signAccess('user-1'),
        cookies: {
          canari_refresh: signRefresh({
            sub: 'user-1',
            type: 'refresh',
            sid: 'sid-1',
            jti: 'j',
          }),
        },
      });

      await expect(controller.revokeOtherSessions(req)).resolves.toEqual({
        revoked: 2,
      });
      expect(sessions.revokeOthers).toHaveBeenCalledWith('user-1', 'sid-1');
    });
  });

  describe('verify (nginx auth_request)', () => {
    it('does not authenticate a refresh token used as a bearer token', async () => {
      const req = makeReq({
        bearer: signRefresh({
          sub: 'user-1',
          type: 'refresh',
          sid: 'sid-1',
          jti: 'j',
        }),
      });
      const out = makeRes();

      await controller.verify(req, out.res);

      expect(out.headers['X-Logged-In']).toBe('false');
      expect(out.headers['X-User-Id']).toBe('');
    });

    it('authenticates a genuine access token', async () => {
      const req = makeReq({ bearer: signAccess('user-1', true) });
      const out = makeRes();

      await controller.verify(req, out.res);

      expect(out.headers['X-Logged-In']).toBe('true');
      expect(out.headers['X-User-Id']).toBe('user-1');
      expect(out.headers['X-Global-Admin']).toBe('true');
    });
  });
});
