/// <reference types="jest" />

import { buildMailForgetMessage, MAIL_FORGET_TYPE, sendMailForget } from './mail-forget';

/** The remote forget (mail lot 5, D6): what travels, and that a failure never stops the others. */
describe('mail forget', () => {
  const android = {
    userId: 'user-1',
    deviceId: 'dev-a',
    token: 'tok-a',
    platform: 'android' as const,
  };
  const ios = { userId: 'user-1', deviceId: 'dev-i', token: 'tok-i', platform: 'ios' as const };
  const logger = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });

  it('Android: a high-priority data message carrying the type and the account only', () => {
    const msg = buildMailForgetMessage(android, 0) as any;
    expect(msg).toEqual({
      token: 'tok-a',
      data: { type: MAIL_FORGET_TYPE, userId: 'user-1' },
      android: { priority: 'high', ttl: 28 * 24 * 3600 * 1000 },
    });
  });

  it('iOS: a background push that draws nothing, kept 28 days for a phone that is off', () => {
    const msg = buildMailForgetMessage(ios, 1_000_000) as any;
    expect(msg.apns.payload).toEqual({
      aps: { 'content-available': 1 },
      type: MAIL_FORGET_TYPE,
      userId: 'user-1',
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
