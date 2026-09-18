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

/**
 * This guard had no test at all, which is how it stayed the only one of the three that did not fail
 * closed. The production block is therefore covered first and hardest: what it must REFUSE is the
 * point, and every refusal below was reachable before 2026-09-17.
 */
describe('NginxAuthGuard (social-service)', () => {
  const SECRET = 'test-secret-32bytes-long-enough';
  let guard: NginxAuthGuard;
  const savedEnv = process.env.NODE_ENV;

  beforeEach(() => {
    delete process.env.INTERNAL_SHARED_SECRET;
    delete process.env.NGINX_AUTH_SECRET;
    guard = new NginxAuthGuard();
  });

  afterEach(() => {
    process.env.NODE_ENV = savedEnv;
  });

  it('refuses every request when NODE_ENV is unset, rather than guessing a mode', () => {
    delete process.env.NODE_ENV;
    expect(() => guard.canActivate(makeContext({ 'x-user-id': 'user-1' }))).toThrow(
      UnauthorizedException
    );
  });

  describe('in production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('FAILS CLOSED when INTERNAL_SHARED_SECRET is absent', () => {
      // THE REGRESSION THIS FILE EXISTS FOR. Before 2026-09-17 this returned true: the guard fell
      // through to a `NGINX_AUTH_SECRET` branch that nothing anywhere sets - not a compose file, not
      // an env template, not the production container - so no check ran at all and the bare
      // `X-User-Id` header was accepted as proof of its own authenticity.
      const ctx = makeContext({ 'x-user-id': 'user-1', 'x-internal-token': 'anything' });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('does not accept a bare X-User-Id even when a legacy nginx secret is present', () => {
      // The deleted branch read this variable. Setting it must no longer buy a caller anything.
      process.env.NGINX_AUTH_SECRET = 'legacy-value';
      const ctx = makeContext({ 'x-user-id': 'user-1', 'x-nginx-auth': 'legacy-value' });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws when X-User-Id is missing', () => {
      process.env.INTERNAL_SHARED_SECRET = SECRET;
      expect(() => guard.canActivate(makeContext({}))).toThrow(UnauthorizedException);
    });

    it('throws when X-User-Id is only whitespace', () => {
      process.env.INTERNAL_SHARED_SECRET = SECRET;
      expect(() => guard.canActivate(makeContext({ 'x-user-id': '   ' }))).toThrow(
        UnauthorizedException
      );
    });

    it('throws when the internal token is missing', () => {
      process.env.INTERNAL_SHARED_SECRET = SECRET;
      expect(() => guard.canActivate(makeContext({ 'x-user-id': 'user-1' }))).toThrow(
        UnauthorizedException
      );
    });

    it('throws when the internal token is signed for another user', () => {
      process.env.INTERNAL_SHARED_SECRET = SECRET;
      const ctx = makeContext({
        'x-user-id': 'user-1',
        'x-internal-token': makeToken('user-2', SECRET),
      });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws when the internal token is signed with another secret', () => {
      process.env.INTERNAL_SHARED_SECRET = SECRET;
      const ctx = makeContext({
        'x-user-id': 'user-1',
        'x-internal-token': makeToken('user-1', 'a-different-secret-entirely'),
      });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('accepts a token minted this minute', () => {
      process.env.INTERNAL_SHARED_SECRET = SECRET;
      const ctx = makeContext({
        'x-user-id': 'user-1',
        'x-internal-token': makeToken('user-1', SECRET),
      });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('accepts a token minted in the previous minute, to tolerate clock skew', () => {
      process.env.INTERNAL_SHARED_SECRET = SECRET;
      const ctx = makeContext({
        'x-user-id': 'user-1',
        'x-internal-token': makeToken('user-1', SECRET, -1),
      });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('refuses a token minted two minutes ago', () => {
      process.env.INTERNAL_SHARED_SECRET = SECRET;
      const ctx = makeContext({
        'x-user-id': 'user-1',
        'x-internal-token': makeToken('user-1', SECRET, -2),
      });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
  });

  describe('outside production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
    });

    it('accepts the X-User-Id the local nginx sets', () => {
      expect(guard.canActivate(makeContext({ 'x-user-id': 'user-1' }))).toBe(true);
    });

    it('throws when no user header is present', () => {
      expect(() => guard.canActivate(makeContext({}))).toThrow(UnauthorizedException);
    });

    /**
     * THE BRANCH THIS REPLACES DECIDED IDENTITY FROM AN UNVERIFIED SIGNATURE. It read the Bearer
     * token, decoded the payload without checking the signature, and forwarded its `sub` as
     * `x-user-id` - so anyone able to reach the port could name themselves. It survived because one
     * vite proxy rule was believed to route past nginx; that route never existed (see the guard's
     * docblock), and both are gone. This asserts the deletion rather than describing it: a token
     * whose `sub` is a real user id, arriving with no header, must now be refused.
     */
    it('refuses a Bearer token on its own, however well formed its sub claim is', () => {
      const payload = Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url');
      const ctx = makeContext({ authorization: `Bearer header.${payload}.signature` });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('does not let a Bearer token put an identity on a request that had none', () => {
      const payload = Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url');
      const headers: Record<string, string> = {
        authorization: `Bearer header.${payload}.signature`,
      };
      expect(() => guard.canActivate(makeContext(headers))).toThrow(UnauthorizedException);
      expect(headers['x-user-id']).toBeUndefined();
    });
  });
});
