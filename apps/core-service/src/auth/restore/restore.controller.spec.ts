/// <reference types="jest" />

import {
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as jwt from 'jsonwebtoken';
import { AuthController } from '../auth.controller';

/**
 * The four restore routes of `AuthController` (WP-RESTORE-1, docs/wiki/account-restore.md): who may
 * register a key, and what a verified restore does to the two sessions involved. The WebAuthn
 * verification itself is `restore-credentials.service.spec.ts`; here it is a double.
 */

const JWT_SECRET = 'test-secret-not-the-production-one';
const ANDROID = 'http://tauri.localhost';

function makeReq(opts: { bearer?: string; origin?: string; refresh?: string } = {}): Request {
  const headers: Record<string, string> = { 'user-agent': 'jest' };
  if (opts.bearer) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.origin) headers['origin'] = opts.origin;
  return {
    cookies: opts.refresh ? { canari_refresh: opts.refresh } : {},
    headers,
    get: (name: string) => headers[name.toLowerCase()],
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
}

function makeRes() {
  const cookies: Record<string, string> = {};
  const res = {
    cookie: (name: string, value: string) => {
      cookies[name] = value;
      return res;
    },
    clearCookie: () => res,
  };
  return { res: res as unknown as Response, cookies };
}

const access = (sub: string) => jwt.sign({ sub }, JWT_SECRET, { expiresIn: '1h' });
const refresh = (sub: string, sid: string) =>
  jwt.sign({ sub, type: 'refresh', sid, jti: 'jti-1' }, JWT_SECRET, { expiresIn: '7d' });

describe('AuthController restore routes', () => {
  let restore: {
    available: boolean;
    isLiveSessionOf: jest.Mock;
    registrationOptions: jest.Mock;
    register: jest.Mock;
    assertionOptions: jest.Mock;
    authenticate: jest.Mock;
  };
  let sessions: { create: jest.Mock; revoke: jest.Mock };
  let erasure: { erasureState: jest.Mock; confirmAfterSignIn: jest.Mock };
  let platform: { getConfig: jest.Mock; isAccessBlockedByMaintenance: jest.Mock };
  let controller: AuthController;
  const order: string[] = [];

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    order.length = 0;
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_INSECURE_COOKIES = 'false';
    restore = {
      available: true,
      isLiveSessionOf: jest.fn().mockResolvedValue(true),
      registrationOptions: jest.fn().mockResolvedValue({ challenge: 'c' }),
      register: jest.fn().mockResolvedValue({ status: 'registered', credentialId: 'cred' }),
      assertionOptions: jest.fn().mockResolvedValue({ challenge: 'c' }),
      authenticate: jest.fn().mockImplementation(async () => {
        order.push('consume');
        return { status: 'ok', userId: 'user-1', credentialId: 'cred', sessionId: 'sid-old' };
      }),
    };
    sessions = {
      create: jest.fn().mockImplementation(async () => {
        order.push('mint');
        return { sessionId: 'sid-new', tokenId: 'jti-new', expiresAt: new Date(0) };
      }),
      revoke: jest.fn().mockImplementation(async () => {
        order.push('revoke-old');
      }),
    };
    erasure = {
      erasureState: jest.fn().mockResolvedValue('none'),
      confirmAfterSignIn: jest.fn().mockResolvedValue('none'),
    };
    platform = {
      getConfig: jest.fn().mockResolvedValue({}),
      isAccessBlockedByMaintenance: jest.fn().mockReturnValue(false),
    };
    controller = new AuthController(
      { findOne: jest.fn().mockResolvedValue({ id: 'user-1', admin: false }) } as never,
      platform as never,
      sessions as never,
      { enabled: false } as never,
      erasure as never,
      restore as never
    );
  });

  describe('registration', () => {
    const fromApp = () =>
      makeReq({ bearer: access('user-1'), origin: ANDROID, refresh: refresh('user-1', 'sid-1') });

    it('issues options for the calling session when the Android app asks', async () => {
      await controller.restoreRegistrationOptions(fromApp());
      expect(restore.isLiveSessionOf).toHaveBeenCalledWith('user-1', 'sid-1', expect.any(Date));
      expect(restore.registrationOptions).toHaveBeenCalledWith('sid-1', expect.any(Date));
    });

    it('refuses any origin but the Android app, so a web session (an XSS) cannot register a key', async () => {
      for (const origin of ['https://canari.emse.fr', 'tauri://localhost', undefined]) {
        const req = makeReq({
          bearer: access('user-1'),
          origin,
          refresh: refresh('user-1', 'sid-1'),
        });
        await expect(controller.restoreRegistrationOptions(req)).rejects.toBeInstanceOf(
          ForbiddenException
        );
        await expect(
          controller.restoreRegistration(req, { response: {}, cloudBackup: true })
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(restore.registrationOptions).not.toHaveBeenCalled();
      expect(restore.register).not.toHaveBeenCalled();
    });

    it('refuses a caller with no access token, and one whose session is not live', async () => {
      await expect(
        controller.restoreRegistrationOptions(makeReq({ origin: ANDROID }))
      ).rejects.toBeInstanceOf(UnauthorizedException);
      restore.isLiveSessionOf.mockResolvedValue(false);
      await expect(controller.restoreRegistrationOptions(fromApp())).rejects.toBeInstanceOf(
        NotFoundException
      );
    });

    it('stores the key with what the phone did with its backup', async () => {
      await expect(
        controller.restoreRegistration(fromApp(), { response: { id: 'x' }, cloudBackup: false })
      ).resolves.toEqual({ registered: true });
      expect(restore.register).toHaveBeenCalledWith(
        'user-1',
        'sid-1',
        { id: 'x' },
        false,
        expect.any(Date)
      );
    });

    it('answers a key held by another session with its own code', async () => {
      restore.register.mockResolvedValue({ status: 'taken' });
      await expect(
        controller.restoreRegistration(fromApp(), { response: {}, cloudBackup: true })
      ).rejects.toMatchObject({ response: { code: 'RESTORE_KEY_TAKEN' } });
    });
  });

  describe('assertion', () => {
    it('mints the new phone a session, THEN revokes the old one - a transfer', async () => {
      const out = makeRes();
      const answer = await controller.restoreAssertion(makeReq({ origin: ANDROID }), out.res, {
        response: { id: 'cred' },
      });
      expect(order).toEqual(['consume', 'mint', 'revoke-old']);
      expect(sessions.revoke).toHaveBeenCalledWith('sid-old');
      expect(answer.user.id).toBe('user-1');
      expect(jwt.verify(answer.access_token, JWT_SECRET)).toMatchObject({ sub: 'user-1' });
      // Android keeps the cookie on an HTTPS estate, exactly as after a MiConnect sign-in.
      expect(out.cookies['canari_refresh']).toBeDefined();
    });

    it('answers an unknown key with RESTORE_KEY_UNKNOWN and touches no session', async () => {
      restore.authenticate.mockResolvedValue({ status: 'unknown' });
      await expect(
        controller.restoreAssertion(makeReq(), makeRes().res, { response: {} })
      ).rejects.toMatchObject({ status: 401, response: { code: 'RESTORE_KEY_UNKNOWN' } });
      expect(sessions.create).not.toHaveBeenCalled();
      expect(sessions.revoke).not.toHaveBeenCalled();
    });

    it('answers a key that did not verify with RESTORE_ASSERTION_INVALID', async () => {
      restore.authenticate.mockResolvedValue({ status: 'invalid', reason: 'replay' });
      await expect(
        controller.restoreAssertion(makeReq(), makeRes().res, { response: {} })
      ).rejects.toMatchObject({ response: { code: 'RESTORE_ASSERTION_INVALID' } });
    });

    it('refuses during an erasure exactly as a MiConnect sign-in does, and keeps the old session', async () => {
      erasure.erasureState.mockResolvedValue('pending');
      await expect(
        controller.restoreAssertion(makeReq(), makeRes().res, { response: {} })
      ).rejects.toMatchObject({ response: { code: 'ACCOUNT_ERASURE_PENDING' } });
      expect(sessions.create).not.toHaveBeenCalled();
      expect(sessions.revoke).not.toHaveBeenCalled();
    });

    it('refuses during maintenance, and keeps the old session', async () => {
      platform.isAccessBlockedByMaintenance.mockReturnValue(true);
      await expect(
        controller.restoreAssertion(makeReq(), makeRes().res, { response: {} })
      ).rejects.toMatchObject({ response: { code: 'MAINTENANCE' } });
      expect(sessions.revoke).not.toHaveBeenCalled();
    });
  });

  it('answers 503 RESTORE_UNAVAILABLE on every route of an estate with no fingerprint', async () => {
    restore.available = false;
    const req = makeReq({
      bearer: access('user-1'),
      origin: ANDROID,
      refresh: refresh('user-1', 'sid-1'),
    });
    for (const call of [
      () => controller.restoreRegistrationOptions(req),
      () => controller.restoreRegistration(req, { response: {}, cloudBackup: true }),
      () => controller.restoreAssertionOptions(),
      () => controller.restoreAssertion(req, makeRes().res, { response: {} }),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
  });
});
