/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import * as jwt from 'jsonwebtoken';
import { AccountThrottlerGuard, verifiedAccessSubject } from './account-throttler.guard';
import { ClientIpThrottlerGuard } from './client-ip-throttler.guard';
import { AuthController } from '../../auth/auth.controller';

/**
 * The restore routes (WP-RESTORE-1) are throttled per VISITOR: the bucket is the `X-Real-IP` nginx
 * writes, never the nginx container every request arrives from.
 */
describe('ClientIpThrottlerGuard', () => {
  const tracker = (req: Record<string, unknown>) =>
    (
      ClientIpThrottlerGuard.prototype as unknown as {
        getTracker: (r: Record<string, unknown>) => Promise<string>;
      }
    ).getTracker.call({}, req);

  it('counts on the visitor address nginx forwards', async () => {
    await expect(
      tracker({ headers: { 'x-real-ip': '203.0.113.7' }, ip: '172.18.0.5' })
    ).resolves.toBe('ip:203.0.113.7');
  });

  it('falls on the socket, and says so, when nginx was not in the path', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(
      tracker({ headers: {}, ip: '127.0.0.1', method: 'POST', path: '/x' })
    ).resolves.toBe('ip:127.0.0.1');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each(['restoreAssertionOptions', 'restoreAssertion'] as const)(
    'counts the anonymous restore route %s per visitor address',
    (route) => {
      const guards: unknown[] =
        Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype[route]) ?? [];
      expect(guards).toEqual([ClientIpThrottlerGuard]);
    }
  );

  it.each(['restoreRegistrationOptions', 'restoreRegistration'] as const)(
    'counts the registration route %s per ACCOUNT, never per campus address',
    (route) => {
      const guards: unknown[] =
        Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype[route]) ?? [];
      expect(guards).toEqual([AccountThrottlerGuard]);
    }
  );
});

describe('AccountThrottlerGuard', () => {
  const SECRET = 'test-secret-not-the-production-one';
  const tracker = (req: Record<string, unknown>) =>
    (
      AccountThrottlerGuard.prototype as unknown as {
        getTracker: (r: Record<string, unknown>) => Promise<string>;
      }
    ).getTracker.call(Object.create(AccountThrottlerGuard.prototype), req);

  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
  });

  it('counts on the account a VERIFIED access token names, whatever the address', async () => {
    const token = jwt.sign({ sub: 'user-1' }, SECRET);
    await expect(
      tracker({ headers: { authorization: `Bearer ${token}`, 'x-real-ip': '203.0.113.7' } })
    ).resolves.toBe('user:user-1');
  });

  it('never lets a forged or refresh token pick a bucket: those count per visitor', async () => {
    const forged = jwt.sign({ sub: 'victim' }, 'another-secret');
    const refresh = jwt.sign({ sub: 'user-1', type: 'refresh' }, SECRET);
    for (const token of [forged, refresh]) {
      await expect(
        tracker({ headers: { authorization: `Bearer ${token}`, 'x-real-ip': '203.0.113.7' } })
      ).resolves.toBe('ip:203.0.113.7');
    }
    expect(verifiedAccessSubject(undefined, SECRET)).toBeNull();
  });
});
