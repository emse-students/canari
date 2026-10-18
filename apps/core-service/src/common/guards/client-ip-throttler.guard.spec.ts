/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
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

  it.each([
    'restoreRegistrationOptions',
    'restoreRegistration',
    'restoreAssertionOptions',
    'restoreAssertion',
  ] as const)('guards the restore route %s', (route) => {
    const guards: unknown[] =
      Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype[route]) ?? [];
    expect(guards).toContain(ClientIpThrottlerGuard);
  });
});
