import { describe, expect, it } from 'vitest';
import { isUnavailableAnswer, isUnavailableStatus } from './unavailableAnswer';
import { ApiRefusalError } from './apiRefusalError';
import { TransportFailureError } from './transportFailure';

describe('isUnavailableAnswer - "not now" read from the status the throw carried', () => {
  it('is true for 502, 503 and 504 only', () => {
    expect([502, 503, 504].every(isUnavailableStatus)).toBe(true);
    for (const status of [400, 403, 404, 409, 410, 429, 500, 501, 505, null, undefined]) {
      expect(isUnavailableStatus(status)).toBe(false);
    }
  });

  it('reads the TYPE: a refusal carrying the status, never a message', () => {
    expect(isUnavailableAnswer(new ApiRefusalError(503, null, 'whatever'))).toBe(true);
    // A sentence naming the status is not a status.
    expect(isUnavailableAnswer(new Error('HTTP 503 Service Unavailable'))).toBe(false);
  });

  it('is false for a transport failure: nobody answered', () => {
    expect(isUnavailableAnswer(new TransportFailureError(new TypeError('Failed to fetch')))).toBe(
      false
    );
  });
});
