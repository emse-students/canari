/// <reference types="jest" />

import { createHash } from 'crypto';
import {
  buildMailForgetMessage,
  MAIL_FORGET_TYPE,
  registrationFingerprint,
  sendMailForget,
} from './mail-forget';

/** The remote forget (mail lot 5, D6): what travels, and that a failure never stops the others. */
describe('mail forget', () => {
  const RAW = 'a'.repeat(32);
  const STORED = createHash('sha256').update(RAW).digest('hex');
  const android = {
    userId: 'user-1',
    deviceId: 'dev-a',
    token: 'tok-a',
    platform: 'android' as const,
    pushSecret: STORED,
  };
  const ios = {
    userId: 'user-1',
    deviceId: 'dev-i',
    token: 'tok-i',
    platform: 'ios' as const,
    pushSecret: STORED,
  };
  const logger = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });

  it('the fingerprint is the shared vector (Kotlin and Rust compute the same)', () => {
    // The same vector is asserted in frontend/src/lib/mail/mailPushSecret.test.ts.
    expect(registrationFingerprint(STORED)).toBe(
      createHash('sha256').update(`canari-mail-forget|${STORED}`).digest('hex').slice(0, 32)
    );
    expect(registrationFingerprint(STORED)).toMatch(/^[0-9a-f]{32}$/);
    // The fixed vector Kotlin and Rust assert from the raw secret.
    const raw = '0123456789abcdef0123456789abcdef';
    expect(registrationFingerprint(createHash('sha256').update(raw).digest('hex'))).toBe(
      '57cad23f03e18d65f03c862440581f69'
    );
    expect(registrationFingerprint(STORED)).not.toContain(STORED.slice(0, 16));
  });

  it('Android, a session ended: a high-priority data message naming the registration', () => {
    const msg = buildMailForgetMessage(android, 'session-ended', 0) as any;
    expect(msg).toEqual({
      token: 'tok-a',
      data: {
        type: MAIL_FORGET_TYPE,
        userId: 'user-1',
        scope: 'session',
        registration: registrationFingerprint(STORED),
      },
      android: { priority: 'high', ttl: 28 * 24 * 3600 * 1000 },
    });
  });

  it('a legacy row without a secret names no registration: only a signed-out device forgets', () => {
    const msg = buildMailForgetMessage({ ...android, pushSecret: null }, 'session-ended', 0) as any;
    expect(msg.data.registration).toBe('');
  });

  it('a revoked device and an erased account carry their scope and no registration', () => {
    expect((buildMailForgetMessage(android, 'device-revoked', 0) as any).data).toEqual({
      type: MAIL_FORGET_TYPE,
      userId: 'user-1',
      scope: 'device',
    });
    expect((buildMailForgetMessage(android, 'account-erased', 0) as any).data.scope).toBe(
      'account'
    );
  });

  it('iOS: a background push that draws nothing, kept 28 days for a phone that is off', () => {
    const msg = buildMailForgetMessage(ios, 'session-ended', 1_000_000) as any;
    expect(msg.apns.payload).toEqual({
      aps: { 'content-available': 1 },
      type: MAIL_FORGET_TYPE,
      userId: 'user-1',
      scope: 'session',
      registration: registrationFingerprint(STORED),
    });
    expect(msg.apns.payload.aps.alert).toBeUndefined();
    expect(msg.apns.headers['apns-push-type']).toBe('background');
    expect(msg.apns.headers['apns-priority']).toBe('5');
    expect(msg.apns.headers['apns-expiration']).toBe(String(1000 + 28 * 24 * 3600));
  });

  it('one try per device: a refused send is logged and the next one still goes', async () => {
    const send = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('id');
    const log = logger();
    await expect(sendMailForget([android, ios], 'device-revoked', log, send)).resolves.toEqual({
      sent: 1,
      failed: 1,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('[MAIL_FORGET] NOT sent'));
  });

  it('nothing to tell, nothing sent; no Firebase, said and counted', async () => {
    const log = logger();
    await expect(sendMailForget([], 'session-ended', log)).resolves.toEqual({ sent: 0, failed: 0 });
    await expect(sendMailForget([android], 'account-erased', log)).resolves.toEqual({
      sent: 0,
      failed: 1,
    });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Firebase not initialized'));
  });
});
