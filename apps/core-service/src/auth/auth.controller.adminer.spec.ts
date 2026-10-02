/// <reference types="jest" />

/**
 * THE TWO ROUTES BEHIND `/adminer/` (user, 2026-10-02): `POST /api/auth/adminer-session` hands a
 * global admin the short signed cookie, and `GET /api/auth/adminer-verify` is nginx's `auth_request`.
 *
 * Pinned: the route does not exist where it is not enabled (404, not 403 - it does not announce
 * itself), it needs an access token AND the role read from the database (the token's claim can be an
 * hour old), the cookie carries every attribute that keeps it narrow, and verification answers only
 * 200 or 401.
 */
import {
  ForbiddenException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as jwt from 'jsonwebtoken';
import { AuthController } from './auth.controller';
import { AdminerAccessService } from './adminer-access.service';

const JWT_SECRET = 'test-secret-not-the-production-one';
const SHARED = 'a-shared-secret-of-at-least-32-characters-long';

function res() {
  const state: {
    cookie?: { name: string; value: string; options: Record<string, unknown> };
    status?: number;
  } = {};
  const double = {
    cookie: (name: string, value: string, options: Record<string, unknown>) => {
      state.cookie = { name, value, options };
      return double;
    },
    status: (code: number) => {
      state.status = code;
      return double;
    },
    send: () => double,
  };
  return { res: double as unknown as Response, state };
}

const req = (headers: Record<string, string> = {}, cookies: Record<string, string> = {}) =>
  ({ headers, cookies, get: () => undefined }) as unknown as Request;

const bearer = (sub: string, admin: boolean) => ({
  authorization: `Bearer ${jwt.sign({ sub, admin }, JWT_SECRET, { expiresIn: '1h' })}`,
});

function build(opts: { enabled?: boolean; dbAdmin?: boolean } = {}) {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.ALLOW_INSECURE_COOKIES = 'false';
  process.env.INTERNAL_SHARED_SECRET = SHARED;
  process.env.ADMINER_ENABLED = opts.enabled === false ? 'false' : 'true';
  const users = { findOne: jest.fn(async () => ({ id: 'u1', admin: opts.dbAdmin ?? true })) };
  const adminer = new AdminerAccessService(users as never);
  const controller = new AuthController(
    users as never,
    { getConfig: jest.fn(), isAccessBlockedByMaintenance: jest.fn() } as never,
    {} as never,
    adminer
  );
  return { controller, adminer };
}

describe('Adminer routes', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    for (const k of [
      'JWT_SECRET',
      'ALLOW_INSECURE_COOKIES',
      'INTERNAL_SHARED_SECRET',
      'ADMINER_ENABLED',
    ])
      delete process.env[k];
    jest.restoreAllMocks();
  });

  describe('POST adminer-session', () => {
    it('is a 404 where it is not enabled, before it looks at who is asking', async () => {
      const { controller } = build({ enabled: false });
      await expect(
        controller.openAdminerSession(req(bearer('u1', true)), res().res)
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('needs an access token', async () => {
      const { controller } = build();
      await expect(controller.openAdminerSession(req(), res().res)).rejects.toBeInstanceOf(
        UnauthorizedException
      );
    });

    it('refuses an ordinary user', async () => {
      const { controller } = build({ dbAdmin: false });
      const { res: r, state } = res();
      await expect(
        controller.openAdminerSession(req(bearer('u1', false)), r)
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(state.cookie).toBeUndefined();
    });

    it('refuses a token that SAYS admin when the database no longer does', async () => {
      const { controller } = build({ dbAdmin: false });
      const { res: r, state } = res();
      await expect(
        controller.openAdminerSession(req(bearer('u1', true)), r)
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(state.cookie).toBeUndefined();
    });

    it('hands an admin a cookie that is HttpOnly, Secure, SameSite=Strict, on /adminer/ and 15 minutes long', async () => {
      const { controller, adminer } = build();
      const { res: r, state } = res();
      const out = await controller.openAdminerSession(req(bearer('u1', true)), r);
      expect(out).toEqual({ expiresInSeconds: 900 });
      expect(state.cookie?.name).toBe('canari_adminer');
      expect(state.cookie?.options).toEqual({
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/adminer/',
        maxAge: 900_000,
      });
      expect(await adminer.verify(state.cookie?.value)).toBe('u1');
    });
  });

  describe('GET adminer-verify', () => {
    it('answers 200 for a live session of an admin', async () => {
      const { controller, adminer } = build();
      const { res: r, state } = res();
      await controller.verifyAdminer(req({}, { canari_adminer: adminer.mint('u1') }), r);
      expect(state.status).toBe(200);
    });

    it.each([
      ['no cookie', {}],
      ['a forged cookie', { canari_adminer: 'x.y' }],
    ])('answers 401 for %s', async (_, cookies) => {
      const { controller } = build();
      const { res: r, state } = res();
      await controller.verifyAdminer(req({}, cookies), r);
      expect(state.status).toBe(401);
    });

    it('answers 401 when the route is not enabled, even for a cookie that would verify elsewhere', async () => {
      const on = build();
      const cookie = on.adminer.mint('u1');
      const off = build({ enabled: false });
      const { res: r, state } = res();
      await off.controller.verifyAdminer(req({}, { canari_adminer: cookie }), r);
      expect(state.status).toBe(401);
    });

    it('does NOT take the ordinary access token for a session', async () => {
      const { controller } = build();
      const { res: r, state } = res();
      await controller.verifyAdminer(req(bearer('u1', true)), r);
      expect(state.status).toBe(401);
    });
  });
});
