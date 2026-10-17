/// <reference types="jest" />

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { NginxAuthGuard } from './nginx-auth.guard';

function makeContext(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

function makeToken(userId: string, secret: string, minuteOffset = 0): string {
  const min = Math.floor(Date.now() / 60000) + minuteOffset;
  return createHmac('sha256', secret).update(`${userId}:${min}`).digest('hex');
}

describe('NginxAuthGuard', () => {
  let guard: NginxAuthGuard;

  beforeEach(() => {
    delete process.env.INTERNAL_SHARED_SECRET;
    guard = new NginxAuthGuard();
  });

  it.each(['development', 'test', undefined, 'production'])(
    'FAILS CLOSED when no secret is set, with NODE_ENV=%s',
    (env) => {
      const saved = process.env.NODE_ENV;
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      try {
        const ctx = makeContext({ 'x-user-id': 'user-1' });
        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
      } finally {
        process.env.NODE_ENV = saved;
      }
    }
  );

  it('throws when X-User-Id is missing', () => {
    const ctx = makeContext({});
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('throws when X-User-Id is an empty string', () => {
    const ctx = makeContext({ 'x-user-id': '   ' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  describe('with INTERNAL_SHARED_SECRET set', () => {
    const SECRET = 'test-secret-32bytes-long-enough';

    beforeEach(() => {
      process.env.INTERNAL_SHARED_SECRET = SECRET;
    });

    afterEach(() => {
      delete process.env.INTERNAL_SHARED_SECRET;
    });

    it('passes with a valid current-minute token', () => {
      const userId = 'user-1';
      const token = makeToken(userId, SECRET);
      const ctx = makeContext({
        'x-user-id': userId,
        'x-internal-token': token,
      });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('passes with a previous-minute token (clock skew tolerance)', () => {
      const userId = 'user-1';
      const token = makeToken(userId, SECRET, -1);
      const ctx = makeContext({
        'x-user-id': userId,
        'x-internal-token': token,
      });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('throws when X-Internal-Token is missing', () => {
      const ctx = makeContext({ 'x-user-id': 'user-1' });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws when X-Internal-Token is invalid', () => {
      const ctx = makeContext({
        'x-user-id': 'user-1',
        'x-internal-token': 'deadbeef',
      });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws when token is for a different userId', () => {
      const token = makeToken('other-user', SECRET);
      const ctx = makeContext({
        'x-user-id': 'user-1',
        'x-internal-token': token,
      });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws when token is from two minutes ago', () => {
      const token = makeToken('user-1', SECRET, -2);
      const ctx = makeContext({
        'x-user-id': 'user-1',
        'x-internal-token': token,
      });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
  });
});
