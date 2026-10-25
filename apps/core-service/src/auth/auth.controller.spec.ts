/// <reference types="jest" />

import {
  BadRequestException,
  ForbiddenException,
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
      | 'create'
      | 'rotate'
      | 'revoke'
      | 'revokeOwned'
      | 'revokeOthers'
      | 'listForUser'
      | 'bindDevice'
      | 'isLive'
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
      isLive: jest.fn().mockResolvedValue(true),
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
      sessions as unknown as AuthSessionsService,
      { enabled: false } as never,
      {
        erasureState: jest.fn().mockResolvedValue('none'),
        confirmAfterSignIn: jest.fn().mockResolvedValue('none'),
      } as never,
      {} as never // RestoreCredentialsService: no restore route here
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
        sessions as unknown as AuthSessionsService,
        { enabled: false } as never,
        {
          erasureState: jest.fn().mockResolvedValue('none'),
          confirmAfterSignIn: jest.fn().mockResolvedValue('none'),
        } as never,
        {} as never // RestoreCredentialsService: no restore route here
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
        type?: string;
      };
      expect(cookie.sid).toBe('sid-1');
      expect(cookie.jti).toBe('jti-2');
      // The refresh credential is typed as such and never carries the admin claim: only the
      // short-lived access token may assert a role.
      expect(cookie.type).toBe('refresh');
      expect(cookie).not.toHaveProperty('admin');
    });

    it('mints an access token naming the session it was refreshed from', async () => {
      sessions.rotate.mockResolvedValue({
        status: 'rotated',
        tokenId: 'jti-2',
        expiresAt: new Date(Date.now() + 1000),
      });
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

      const body = await controller.refreshToken(req, makeRes().res);

      const access = jwt.verify(body.access_token, JWT_SECRET) as { sub: string; sid?: string };
      // `type: 'access'` is what every websocket handshake checks: losing it breaks them silently.
      expect(access).toEqual(
        expect.objectContaining({ sub: 'user-1', sid: 'sid-1', type: 'access' })
      );
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

    // The device answers THIS refusal with a full local reset, so the cause travels as a code - and
    // inside Nest's envelope, so a client older than the code reads the 401 it always read.
    it("refuses a session its owner's device revocation ended with the typed DEVICE_REVOKED_BY_OWNER", async () => {
      sessions.rotate.mockResolvedValue({ status: 'device-revoked' });

      const req = makeReq({
        cookies: {
          canari_refresh: signRefresh({ sub: 'user-1', type: 'refresh', sid: 'sid-1', jti: 'x' }),
        },
      });
      const out = makeRes();

      const refusal = await controller.refreshToken(req, out.res).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(UnauthorizedException);
      expect((refusal as UnauthorizedException).getResponse()).toEqual(
        expect.objectContaining({ statusCode: 401, code: 'DEVICE_REVOKED_BY_OWNER' })
      );
      expect(out.cleared).toContain('canari_refresh');
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

  /**
   * THE SIGN-OUT NEEDS MICONNECT'S id_token, AND ONLY THIS EXCHANGE EVER SEES IT. Authentik's
   * end-session refuses a return address without an `id_token_hint`, so a callback that drops it
   * leaves every sign-out unable to end the MiConnect session (user decision, 2026-10-14).
   */
  describe('oidc callback', () => {
    let fetchSpy: jest.SpyInstance;

    function callbackController(
      erasure: { before: string; after: string } = { before: 'none', after: 'none' },
      users = {
        findOrCreateFromOidc: jest.fn().mockResolvedValue({ id: 'user-1', admin: false }),
        claimLegacyCotisations: jest.fn().mockResolvedValue(undefined),
      }
    ): AuthController {
      process.env.AUTHENTIK_BASE_URL = 'https://auth.example';
      process.env.AUTHENTIK_CLIENT_ID = 'client';
      process.env.AUTHENTIK_CLIENT_SECRET = 'secret';
      const platform = {
        getConfig: jest.fn().mockResolvedValue({}),
        isAccessBlockedByMaintenance: jest.fn().mockReturnValue(false),
      };
      return new AuthController(
        users as never,
        platform as never,
        sessions as unknown as AuthSessionsService,
        { enabled: false } as never,
        {
          erasureState: jest.fn().mockResolvedValue(erasure.before),
          confirmAfterSignIn: jest.fn().mockResolvedValue(erasure.after),
        } as never,
        {} as never // RestoreCredentialsService: no restore route here
      );
    }

    /** Authentik's token endpoint (with or without an id_token), then its userinfo. */
    function authentikAnswers(idToken?: string, sub = 'user-1') {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          new globalThis.Response(
            JSON.stringify({
              access_token: 'ak-access',
              ...(idToken ? { id_token: idToken } : {}),
            }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(new globalThis.Response(JSON.stringify({ sub }), { status: 200 }));
    }

    afterEach(() => {
      fetchSpy?.mockRestore();
      delete process.env.AUTHENTIK_BASE_URL;
      delete process.env.AUTHENTIK_CLIENT_ID;
      delete process.env.AUTHENTIK_CLIENT_SECRET;
    });

    it("hands MiConnect's id_token to the client, for the sign-out's id_token_hint", async () => {
      authentikAnswers('h.idtoken.s');
      const body = await callbackController().oidcCallback(
        {
          code: 'c',
          redirect_uri: 'https://canari.example/auth/callback',
          code_verifier: 'v'.repeat(43),
        } as never,
        makeReq({ origin: 'https://canari.example' }),
        makeRes().res
      );
      expect(body.id_token).toBe('h.idtoken.s');
    });

    it('mints an access token naming the session the sign-in opened', async () => {
      authentikAnswers();
      const out = makeRes();
      const body = await callbackController().oidcCallback(
        { code: 'c', redirect_uri: 'https://canari.example/auth/callback' } as never,
        makeReq({ origin: 'https://canari.example' }),
        out.res
      );
      const access = jwt.verify(body.access_token, JWT_SECRET) as { sid?: string };
      // `type: 'access'` is what every websocket handshake checks: losing it breaks them silently.
      expect(access).toEqual(expect.objectContaining({ sid: 'sid-new', type: 'access' }));
      const cookie = jwt.verify(out.cookies['canari_refresh'], JWT_SECRET) as { type?: string };
      expect(cookie.type).toBe('refresh');
      expect(cookie).not.toHaveProperty('admin');
    });

    /**
     * `users.id` IS the OIDC subject: a sign-in while the erasure is still running would recreate
     * the account under the same id, and the erasure's next pass would delete what it then wrote.
     */
    it.each([
      ['pending', 'ACCOUNT_ERASURE_PENDING'],
      ['blocked', 'ACCOUNT_ERASURE_BLOCKED'],
    ])(
      'refuses a sign-in while the account erasure is %s, before any account is made',
      async (state, code) => {
        authentikAnswers('h.idtoken.s');
        const users = {
          findOrCreateFromOidc: jest.fn(),
          claimLegacyCotisations: jest.fn(),
        };
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const err = await callbackController({ before: state, after: state }, users)
          .oidcCallback(
            { code: 'c', redirect_uri: 'https://canari.example/auth/callback' } as never,
            makeReq({ origin: 'https://canari.example' }),
            makeRes().res
          )
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toMatchObject({ code });
        expect(users.findOrCreateFromOidc).not.toHaveBeenCalled();
        expect(sessions.create).not.toHaveBeenCalled();
        warn.mockRestore();
      }
    );

    /**
     * The race the first check cannot see: the deletion committed while this sign-in was writing the
     * user row and its session. The confirmation runs under the erasure's lock, before any token
     * leaves; the sign-in is refused and no cookie is set.
     */
    it('refuses a sign-in that raced a deletion, after the session but before any token leaves', async () => {
      authentikAnswers('h.idtoken.s');
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { res, cookies } = makeRes();
      const err = await callbackController({ before: 'none', after: 'pending' })
        .oidcCallback(
          { code: 'c', redirect_uri: 'https://canari.example/auth/callback' } as never,
          makeReq({ origin: 'https://canari.example' }),
          res
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: 'ACCOUNT_ERASURE_PENDING',
      });
      expect(cookies).toEqual({});
      warn.mockRestore();
    });

    /**
     * `users.id` IS the subject, and every comparison downstream lowercases ASCII letters only: a
     * subject outside visible ASCII (whitespace included), or holding a ':', is refused before any account is made.
     */
    it.each(['Élise', 'alice:dev'])(
      'refuses a subject that is not a mintable user id (%s), before any account is made',
      async (sub) => {
        authentikAnswers('h.idtoken.s', sub);
        const users = { findOrCreateFromOidc: jest.fn(), claimLegacyCotisations: jest.fn() };
        const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const err = await callbackController(undefined, users)
          .oidcCallback(
            { code: 'c', redirect_uri: 'https://canari.example/auth/callback' } as never,
            makeReq({ origin: 'https://canari.example' }),
            makeRes().res
          )
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: 'USER_ID_INVALID',
        });
        expect(users.findOrCreateFromOidc).not.toHaveBeenCalled();
        expect(sessions.create).not.toHaveBeenCalled();
        expect(error.mock.calls.flat().join(' ')).not.toContain(sub);
        error.mockRestore();
      }
    );

    /** The form body of the token request this controller sent to Authentik. */
    function tokenRequestBody(): URLSearchParams {
      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      return new URLSearchParams(String(init.body));
    }

    it('redeems the code with the PKCE verifier the client sent', async () => {
      authentikAnswers('h.idtoken.s');
      await callbackController().oidcCallback(
        {
          code: 'c',
          redirect_uri: 'https://canari.example/auth/callback',
          code_verifier: 'v'.repeat(43),
        } as never,
        makeReq({ origin: 'https://canari.example' }),
        makeRes().res
      );
      expect(tokenRequestBody().get('code_verifier')).toBe('v'.repeat(43));
    });

    it('names a sign-in with no verifier, and sends none rather than an empty one', async () => {
      authentikAnswers('h.idtoken.s');
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await callbackController().oidcCallback(
        { code: 'c', redirect_uri: 'https://canari.example/auth/callback' } as never,
        makeReq({ origin: 'https://canari.example' }),
        makeRes().res
      );
      expect(tokenRequestBody().has('code_verifier')).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('without a PKCE verifier'));
      warn.mockRestore();
    });

    it('refuses a verifier that is not a string', async () => {
      authentikAnswers('h.idtoken.s');
      const err = await callbackController()
        .oidcCallback(
          {
            code: 'c',
            redirect_uri: 'https://canari.example/auth/callback',
            code_verifier: { $ne: 1 },
          } as never,
          makeReq({ origin: 'https://canari.example' }),
          makeRes().res
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
    });

    it("keeps Authentik's refusal in the log and out of the response", async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
        new globalThis.Response('{"error":"invalid_grant","detail":"provider internals"}', {
          status: 400,
        })
      );
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const err = await callbackController()
        .oidcCallback(
          {
            code: 'c',
            redirect_uri: 'https://canari.example/auth/callback',
            code_verifier: 'v'.repeat(43),
          } as never,
          makeReq({ origin: 'https://canari.example' }),
          makeRes().res
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).message).not.toContain('provider internals');
      expect(JSON.stringify((err as UnauthorizedException).getResponse())).not.toContain(
        'provider internals'
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('provider internals'));
      warn.mockRestore();
    });

    /** Runs a callback that Authentik refuses with `status`, and returns the typed refusal code. */
    async function refusalCode(status: number, verifier: string | undefined): Promise<unknown> {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(new globalThis.Response('{"error":"invalid_grant"}', { status }));
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const err = await callbackController()
        .oidcCallback(
          {
            code: 'c',
            redirect_uri: 'https://canari.example/auth/callback',
            ...(verifier === undefined ? {} : { code_verifier: verifier }),
          } as never,
          makeReq({ origin: 'https://canari.example' }),
          makeRes().res
        )
        .catch((e: unknown) => e);
      warn.mockRestore();
      expect(err).toBeInstanceOf(UnauthorizedException);
      return ((err as UnauthorizedException).getResponse() as { code?: unknown }).code;
    }

    it('types a refused PKCE redemption apart from a refused unchallenged code', async () => {
      expect(await refusalCode(400, 'v'.repeat(43))).toBe('OIDC_PKCE_REFUSED');
      expect(await refusalCode(400, undefined)).toBe('OIDC_CODE_REFUSED');
    });

    it('does not call a provider failure a refusal of the code', async () => {
      expect(await refusalCode(502, 'v'.repeat(43))).toBe('OIDC_TOKEN_EXCHANGE_FAILED');
    });

    it('says so when Authentik sent none, since that sign-out cannot end MiConnect', async () => {
      authentikAnswers();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const body = await callbackController().oidcCallback(
        { code: 'c', redirect_uri: 'https://canari.example/auth/callback' } as never,
        makeReq({ origin: 'https://canari.example' }),
        makeRes().res
      );
      expect(body.id_token).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no id_token'));
      warn.mockRestore();
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

    /**
     * The session routes read the token themselves (`requireAccessToken`), so they apply the same
     * liveness rule as `verify`: a token whose session has ended lists, revokes and binds nothing.
     */
    it('refuses a token whose session has ended, on every session route', async () => {
      sessions.isLive.mockResolvedValue(false);
      const bearer = jwt.sign(
        { sub: 'user-1', type: 'access', sid: '0a0a0a0a-0000-4000-8000-0000000000a2' },
        JWT_SECRET,
        { expiresIn: '1h' }
      );
      const req = makeReq({ bearer });
      await expect(controller.listSessions(req)).rejects.toThrow(UnauthorizedException);
      await expect(controller.revokeSession('sid-other', req, makeRes().res)).rejects.toThrow(
        UnauthorizedException
      );
      await expect(controller.revokeOtherSessions(req)).rejects.toThrow(UnauthorizedException);
      await expect(
        controller.bindCurrentSessionDevice(req, { deviceId: 'web-a-b' })
      ).rejects.toThrow(UnauthorizedException);
      expect(sessions.listForUser).not.toHaveBeenCalled();
      expect(sessions.revokeOwned).not.toHaveBeenCalled();
      expect(sessions.revokeOthers).not.toHaveBeenCalled();
      expect(sessions.bindDevice).not.toHaveBeenCalled();
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

    const SID = '0a0a0a0a-0000-4000-8000-0000000000a1';
    const accessFor = (sid: string | undefined, admin = false): string =>
      jwt.sign({ sub: 'user-1', admin, type: 'access', ...(sid ? { sid } : {}) }, JWT_SECRET, {
        expiresIn: '1h',
      });

    it('authenticates a genuine access token whose session is live', async () => {
      const out = makeRes();

      await controller.verify(makeReq({ bearer: accessFor(SID, true) }), out.res);

      expect(sessions.isLive).toHaveBeenCalledWith(SID, 'user-1');
      expect(out.headers['X-Logged-In']).toBe('true');
      expect(out.headers['X-User-Id']).toBe('user-1');
      expect(out.headers['X-Global-Admin']).toBe('true');
      expect(out.headers['X-Session-Id']).toBe(SID);
    });

    /**
     * THE CHOKE POINT FOR A SESSION THAT HAS ENDED: its access token authenticates nothing, from
     * the moment the session row is gone. Every guarded route of every service reads `X-Logged-In`,
     * so an anonymous answer here is a 401 everywhere.
     */
    it('answers anonymous for an access token whose session has ended', async () => {
      sessions.isLive.mockResolvedValue(false);
      const out = makeRes();

      await controller.verify(makeReq({ bearer: accessFor(SID) }), out.res);

      expect(out.status()).toBe(200);
      expect(out.headers['X-Logged-In']).toBe('false');
      expect(out.headers['X-User-Id']).toBe('');
      expect(out.headers['X-Session-Id']).toBe('');
      expect(out.headers['X-Internal-Token']).toBeUndefined();
    });

    /**
     * A TOKEN NAMING NO SESSION IS ACCEPTED, BY CONSTRUCTION: the one issuer always writes `sid`, so
     * such a token was minted before the deploy and dies by its own `exp` within one token lifetime.
     * No session is read for it, X-Session-Id stays empty, and the acceptance is said once per
     * process, not per request.
     */
    it('accepts an unexpired access token that names no session, without a read, said once', async () => {
      const said = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      try {
        for (let i = 0; i < 3; i++) {
          const out = makeRes();
          await controller.verify(makeReq({ bearer: signAccess('user-1') }), out.res);
          expect(out.headers['X-Logged-In']).toBe('true');
          expect(out.headers['X-User-Id']).toBe('user-1');
          expect(out.headers['X-Session-Id']).toBe('');
        }
        expect(sessions.isLive).not.toHaveBeenCalled();
        const legacyLines = said.mock.calls.filter((c) =>
          String(c[0]).includes('naming no session')
        );
        expect(legacyLines).toHaveLength(1);
      } finally {
        said.mockRestore();
      }
    });

    it('answers anonymous for an expired access token, sid or not, without a read', async () => {
      for (const sid of [SID, undefined]) {
        const expired = jwt.sign(
          {
            sub: 'user-1',
            type: 'access',
            ...(sid ? { sid } : {}),
            exp: Math.floor(Date.now() / 1000) - 60,
          },
          JWT_SECRET
        );
        const out = makeRes();
        await controller.verify(makeReq({ bearer: expired }), out.res);
        expect(out.headers['X-Logged-In']).toBe('false');
        expect(out.headers['X-User-Id']).toBe('');
      }
      expect(sessions.isLive).not.toHaveBeenCalled();
    });

    it('says an ended session at warn once, not once per request', async () => {
      sessions.isLive.mockResolvedValue(false);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        for (let i = 0; i < 3; i++) {
          const out = makeRes();
          await controller.verify(makeReq({ bearer: accessFor(SID) }), out.res);
          expect(out.headers['X-Logged-In']).toBe('false');
        }
        const refusals = warn.mock.calls.filter((c) => String(c[0]).includes('Access refused'));
        expect(refusals).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('does not turn a failed session read into an answer: it propagates', async () => {
      sessions.isLive.mockRejectedValue(new Error('database down'));
      const out = makeRes();

      await expect(controller.verify(makeReq({ bearer: accessFor(SID) }), out.res)).rejects.toThrow(
        'database down'
      );
      expect(out.headers['X-Logged-In']).toBe('false');
    });

    it('names no session for a refresh token used as a bearer token', async () => {
      const out = makeRes();
      await controller.verify(
        makeReq({
          bearer: signRefresh({ sub: 'user-1', type: 'refresh', sid: 'sid-1', jti: 'j' }),
        }),
        out.res
      );
      expect(out.headers['X-Session-Id']).toBe('');
    });
  });
});
