/// <reference types="jest" />

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { HeaderAuthGuard } from './header-auth.guard';

function makeContext(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers, originalUrl: '/api/mls/groups' }),
    }),
  } as unknown as ExecutionContext;
}

function makeToken(userId: string, secret: string, minuteOffset = 0): string {
  const min = Math.floor(Date.now() / 60000) + minuteOffset;
  return createHmac('sha256', secret).update(`${userId}:${min}`).digest('hex');
}

describe('HeaderAuthGuard', () => {
  let guard: HeaderAuthGuard;

  beforeEach(() => {
    delete process.env.INTERNAL_SHARED_SECRET;
    guard = new HeaderAuthGuard();
  });

  it('REFUSES a bare x-user-logged-in "true" when no secret is configured, in EVERY environment (CodeQL 2547)', () => {
    const previous = process.env.NODE_ENV;
    try {
      for (const env of [undefined, 'development', 'test', 'production']) {
        if (env === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = env;
        expect(() =>
          guard.canActivate(makeContext({ 'x-user-logged-in': 'true', 'x-user-id': 'victim' }))
        ).toThrow(UnauthorizedException);
      }
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('refuses a signed token when x-user-id is empty', () => {
    process.env.INTERNAL_SHARED_SECRET = 'test-secret-32bytes-long-enough';
    try {
      const token = makeToken('', 'test-secret-32bytes-long-enough');
      expect(() =>
        guard.canActivate(makeContext({ 'x-user-logged-in': 'true', 'x-internal-token': token }))
      ).toThrow(UnauthorizedException);
    } finally {
      delete process.env.INTERNAL_SHARED_SECRET;
    }
  });

  it('throws when x-user-logged-in is absent', () => {
    const ctx = makeContext({});
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('throws when x-user-logged-in is "false"', () => {
    const ctx = makeContext({ 'x-user-logged-in': 'false' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('throws when x-user-logged-in is "True" (case-sensitive check)', () => {
    const ctx = makeContext({ 'x-user-logged-in': 'True' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('throws when x-user-logged-in is empty or forged without the edge token', () => {
    process.env.INTERNAL_SHARED_SECRET = 'test-secret-32bytes-long-enough';
    try {
      expect(() => guard.canActivate(makeContext({ 'x-user-logged-in': '' }))).toThrow(
        UnauthorizedException
      );
      expect(() =>
        guard.canActivate(makeContext({ 'x-user-logged-in': 'true', 'x-user-id': 'victim' }))
      ).toThrow(UnauthorizedException);
    } finally {
      delete process.env.INTERNAL_SHARED_SECRET;
    }
  });

  it('fails closed in production when INTERNAL_SHARED_SECRET is unset, even with the header', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => guard.canActivate(makeContext({ 'x-user-logged-in': 'true' }))).toThrow(
        UnauthorizedException
      );
    } finally {
      process.env.NODE_ENV = previous;
    }
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
        'x-user-logged-in': 'true',
        'x-user-id': userId,
        'x-internal-token': token,
      });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('passes with a previous-minute token (clock skew tolerance)', () => {
      const userId = 'user-1';
      const token = makeToken(userId, SECRET, -1);
      const ctx = makeContext({
        'x-user-logged-in': 'true',
        'x-user-id': userId,
        'x-internal-token': token,
      });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('throws when x-internal-token is missing', () => {
      const ctx = makeContext({
        'x-user-logged-in': 'true',
        'x-user-id': 'user-1',
      });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws when x-internal-token is invalid', () => {
      const ctx = makeContext({
        'x-user-logged-in': 'true',
        'x-user-id': 'user-1',
        'x-internal-token': 'deadbeef00000000',
      });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws when token is for a different userId', () => {
      const token = makeToken('other-user', SECRET);
      const ctx = makeContext({
        'x-user-logged-in': 'true',
        'x-user-id': 'user-1',
        'x-internal-token': token,
      });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws when token is from two minutes ago', () => {
      const token = makeToken('user-1', SECRET, -2);
      const ctx = makeContext({
        'x-user-logged-in': 'true',
        'x-user-id': 'user-1',
        'x-internal-token': token,
      });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('refuses an absent x-user-id even with a token minted for the empty id', () => {
      const ctx = makeContext({
        'x-user-logged-in': 'true',
        'x-internal-token': makeToken('', SECRET),
      });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
  });
});
