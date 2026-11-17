/// <reference types="jest" />

import { fcmErrorCode, isTerminalPushTokenError } from './fcm-errors';

/** What Firebase Admin throws: an `Error` whose message never names the code it carries. */
function fcmError(code: string, message = 'Requested entity was not found.'): Error {
  return Object.assign(new Error(message), { code });
}

describe('fcm-errors', () => {
  it('reads the structured code, and null when the throw carries none', () => {
    expect(fcmErrorCode(fcmError('messaging/internal-error'))).toBe('messaging/internal-error');
    expect(fcmErrorCode(new Error('messaging/registration-token-not-registered'))).toBeNull();
    expect(fcmErrorCode('messaging/registration-token-not-registered')).toBeNull();
    expect(fcmErrorCode({ code: 42 })).toBeNull();
    expect(fcmErrorCode(null)).toBeNull();
  });

  it.each(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'])(
    'calls %s a dead token although its message never says so',
    (code) => {
      expect(String(fcmError(code))).not.toContain(code);
      expect(isTerminalPushTokenError(fcmError(code))).toBe(true);
    }
  );

  it.each([
    'messaging/invalid-argument',
    'messaging/payload-size-limit-exceeded',
    'messaging/server-unavailable',
    'messaging/internal-error',
  ])('never calls %s a dead token: the token may still work', (code) => {
    expect(isTerminalPushTokenError(fcmError(code))).toBe(false);
  });

  it('never decides on prose: a message naming the code is not the code', () => {
    expect(isTerminalPushTokenError(new Error('registration-token-not-registered'))).toBe(false);
  });
});
