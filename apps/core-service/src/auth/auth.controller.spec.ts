/// <reference types="jest" />

import { UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as jwt from 'jsonwebtoken';
import { AuthController } from './auth.controller';
import type { AuthSessionsService, RotateResult } from './auth-sessions.service';

const JWT_SECRET = 'test-secret-not-the-production-one';

/** Minimal Express response double: records what the controller wrote. */
function makeRes() {
  const cookies: Record<string, string> = {};
  const cleared: string[] = [];
  const headers: Record<string, string> = {};
  let statusCode = 0;
  const res = {
    cookie: (name: string, value: string) => {
      cookies[name] = value;
      return res;
    },
    clearCookie: (name: string) => {
      cleared.push(name);
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
    cleared,
    headers,
    status: () => statusCode,
  };
}

/** Minimal Express request double carrying cookies and headers. */
function makeReq(options: { cookies?: Record<string, string>; bearer?: string } = {}): Request {
  const headers: Record<string, string> = { 'user-agent': 'jest' };
  if (options.bearer) headers['authorization'] = `Bearer ${options.bearer}`;
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
      'create' | 'rotate' | 'revoke' | 'revokeOwned' | 'revokeOthers' | 'listForUser'
    >
  >;

  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

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
    } as never;

    const users = { findOne: jest.fn().mockResolvedValue({ id: 'user-1', admin: false }) };
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
          canari_refresh: signRefresh({ sub: 'user-1', type: 'refresh', sid: 'sid-1', jti: 'old' }),
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
          canari_refresh: signRefresh({ sub: 'user-1', type: 'refresh', sid: 'gone', jti: 'x' }),
        },
      });
      const out = makeRes();

      await expect(controller.refreshToken(req, out.res)).rejects.toThrow(UnauthorizedException);
      expect(out.cleared).toContain('canari_refresh');
    });

    it('adopts a pre-WP-SESS-2 token that carries no session', async () => {
      const req = makeReq({
        cookies: { canari_refresh: signRefresh({ sub: 'user-1', type: 'refresh' }) },
      });
      const out = makeRes();

      await controller.refreshToken(req, out.res);

      expect(sessions.create).toHaveBeenCalledWith('user-1', expect.anything());
      expect(sessions.rotate).not.toHaveBeenCalled();
      const cookie = jwt.verify(out.cookies['canari_refresh'], JWT_SECRET) as { sid: string };
      expect(cookie.sid).toBe('sid-new');
    });

    it('refuses an access token presented as a refresh cookie', async () => {
      const req = makeReq({ cookies: { canari_refresh: signAccess('user-1') } });
      const out = makeRes();

      await expect(controller.refreshToken(req, out.res)).rejects.toThrow(UnauthorizedException);
      expect(sessions.rotate).not.toHaveBeenCalled();
      expect(sessions.create).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('destroys the session named by the cookie, not just the cookie', async () => {
      const req = makeReq({
        cookies: {
          canari_refresh: signRefresh({ sub: 'user-1', type: 'refresh', sid: 'sid-1', jti: 'j' }),
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
        },
        {
          id: 'sid-2',
          createdAt: new Date(),
          lastUsedAt: new Date(),
          expiresAt: new Date(),
          userAgent: null,
          lastIp: null,
        },
      ]);

      const req = makeReq({
        bearer: signAccess('user-1'),
        cookies: {
          canari_refresh: signRefresh({ sub: 'user-1', type: 'refresh', sid: 'sid-2', jti: 'j' }),
        },
      });

      const { sessions: listed } = await controller.listSessions(req);

      expect(listed.map((s) => s.current)).toEqual([false, true]);
    });

    it('refuses a refresh token presented as a bearer access token', async () => {
      const req = makeReq({
        bearer: signRefresh({ sub: 'user-1', type: 'refresh', sid: 'sid-1', jti: 'j' }),
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
          canari_refresh: signRefresh({ sub: 'user-1', type: 'refresh', sid: 'sid-1', jti: 'j' }),
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
          canari_refresh: signRefresh({ sub: 'user-1', type: 'refresh', sid: 'sid-1', jti: 'j' }),
        },
      });

      await expect(controller.revokeOtherSessions(req)).resolves.toEqual({ revoked: 2 });
      expect(sessions.revokeOthers).toHaveBeenCalledWith('user-1', 'sid-1');
    });
  });

  describe('verify (nginx auth_request)', () => {
    it('does not authenticate a refresh token used as a bearer token', async () => {
      const req = makeReq({
        bearer: signRefresh({ sub: 'user-1', type: 'refresh', sid: 'sid-1', jti: 'j' }),
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
