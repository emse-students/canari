/**
 * A 429 from a PIN route is "too many attempts, wait", never "server unreachable" (PIN audit row 12,
 * 2026-11-20); the wait is a plain time, rounded up, never a countdown.
 */
import { describe, it, expect } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { loginErrorCode, isExpectedLoginOutcome } from './loginErrors';
import { pinAttemptsThrottledFailure, retryAfterInstant, throwIfPinThrottled } from './pinThrottle';

const NOW = new Date('2026-11-20T14:31:50Z');
const hhmm = (at: Date) => at.toISOString().slice(11, 16);

describe('retryAfterInstant', () => {
  it('reads delta-seconds from now', () => {
    expect(retryAfterInstant('60', NOW)?.toISOString()).toBe('2026-11-20T14:32:50.000Z');
  });

  it('reads an HTTP date', () => {
    expect(retryAfterInstant('Fri, 20 Nov 2026 14:40:00 GMT', NOW)?.toISOString()).toBe(
      '2026-11-20T14:40:00.000Z'
    );
  });

  it('answers null for an absent or unreadable header', () => {
    expect(retryAfterInstant(null, NOW)).toBeNull();
    expect(retryAfterInstant('  ', NOW)).toBeNull();
    expect(retryAfterInstant('soon', NOW)).toBeNull();
  });
});

describe('pinAttemptsThrottledFailure', () => {
  it('names the minute to try again, rounded UP so it is never earlier than the server set', () => {
    const failure = pinAttemptsThrottledFailure('60', NOW, hhmm);
    expect(failure.code).toBe('pin_attempts_throttled');
    expect(failure.message).toBe(m.auth_pin_attempts_throttled_until({ time: '14:33' }));
  });

  it('asks to wait without a time when the server named none', () => {
    const failure = pinAttemptsThrottledFailure(null, NOW, hhmm);
    expect(failure.message).toBe(m.auth_pin_attempts_throttled());
  });

  it('is its own code, an ordinary outcome, and not "unreachable"', () => {
    const failure = pinAttemptsThrottledFailure(null, NOW, hhmm);
    expect(loginErrorCode(failure)).toBe('pin_attempts_throttled');
    expect(isExpectedLoginOutcome('pin_attempts_throttled')).toBe(true);
    expect(failure.message).not.toBe(m.auth_pin_check_unreachable());
  });
});

describe('throwIfPinThrottled', () => {
  it('throws the typed refusal on a 429, reading Retry-After', () => {
    const logs: string[] = [];
    const res = new Response('', { status: 429, headers: { 'Retry-After': '120' } });
    expect(() => throwIfPinThrottled(res, (l) => logs.push(l))).toThrow(
      expect.objectContaining({ code: 'pin_attempts_throttled' })
    );
    expect(logs[0]).toContain('Retry-After 120');
  });

  it('lets every other status through to its own branch', () => {
    for (const status of [200, 401, 500, 503]) {
      expect(() => throwIfPinThrottled(new Response('', { status }), () => {})).not.toThrow();
    }
  });
});
