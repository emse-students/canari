/**
 * A 429 from a PIN route is "too many attempts, wait", never "server unreachable" (PIN audit row 12,
 * 2026-11-20); the wait is a plain time, rounded up, never a countdown, and only ever a usable one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { loginErrorCode, isExpectedLoginOutcome } from './loginErrors';
import { pinAttemptsThrottledFailure, retryMinute, throwIfPinThrottled } from './pinThrottle';

// A local wall-clock instant, so "the same day" is the machine's own day whatever its zone.
const NOW = new Date(2026, 10, 20, 14, 31, 50);
const hhmm = (at: Date) =>
  `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;

const throttled = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 429,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

describe('retryMinute - only a usable minute is ever named', () => {
  it('rounds UP, so the time shown is never earlier than the server set', () => {
    expect(hhmm(retryMinute(60_000, NOW)!)).toBe('14:33');
  });

  it('names nothing for no wait, a wait in the past, or one that is not finite', () => {
    expect(retryMinute(null, NOW)).toBeNull();
    expect(retryMinute(0, NOW)).toBeNull();
    expect(retryMinute(-5_000, NOW)).toBeNull();
    expect(retryMinute(Number.NaN, NOW)).toBeNull();
    expect(retryMinute(Number.POSITIVE_INFINITY, NOW)).toBeNull();
  });

  it('names nothing for a wait landing on another day - a 14-digit header among them', () => {
    expect(retryMinute(10 * 3_600_000, NOW)).toBeNull();
    expect(retryMinute(99_999_999_999_999 * 1000, NOW)).toBeNull();
  });
});

describe('pinAttemptsThrottledFailure', () => {
  it('names the minute when there is one', () => {
    const failure = pinAttemptsThrottledFailure(60_000, NOW, hhmm);
    expect(failure.code).toBe('pin_attempts_throttled');
    expect(failure.message).toBe(m.auth_pin_attempts_throttled_until({ time: '14:33' }));
  });

  it('asks to wait without a time otherwise, and never says "Invalid Date"', () => {
    for (const wait of [null, 99_999_999_999_999 * 1000]) {
      const failure = pinAttemptsThrottledFailure(wait, NOW);
      expect(failure.message).toBe(m.auth_pin_attempts_throttled());
      expect(failure.message).not.toContain('Invalid');
    }
  });

  it('is its own code, an ordinary outcome, and not "unreachable"', () => {
    const failure = pinAttemptsThrottledFailure(null, NOW, hhmm);
    expect(loginErrorCode(failure)).toBe('pin_attempts_throttled');
    expect(isExpectedLoginOutcome('pin_attempts_throttled')).toBe(true);
    expect(failure.message).not.toBe(m.auth_pin_check_unreachable());
  });
});

describe('throwIfPinThrottled', () => {
  it('prefers the refusal body retryAfterMs over the header', async () => {
    const res = throttled({ code: 'RATE_LIMITED', retryAfterMs: 60_000 }, { 'Retry-After': '600' });
    const logs: string[] = [];
    const e = await throwIfPinThrottled(res, (l) => logs.push(l), NOW).catch((x: unknown) => x);
    expect(loginErrorCode(e)).toBe('pin_attempts_throttled');
    expect(logs[0]).toContain('wait 60000 ms');
    // A minute is named (the body's), so it is not the time-less text.
    expect((e as Error).message).not.toBe(m.auth_pin_attempts_throttled());
  });

  it('falls back to Retry-After when the body names no wait', async () => {
    const logs: string[] = [];
    const res = throttled({ code: 'RATE_LIMITED' }, { 'Retry-After': '120' });
    await expect(throwIfPinThrottled(res, (l) => logs.push(l), NOW)).rejects.toMatchObject({
      code: 'pin_attempts_throttled',
    });
    expect(logs[0]).toContain('wait 120000 ms');
  });

  it('a body wait of 0 does not win over a usable Retry-After', async () => {
    const logs: string[] = [];
    const res = throttled({ code: 'RATE_LIMITED', retryAfterMs: 0 }, { 'Retry-After': '120' });
    const e = await throwIfPinThrottled(res, (l) => logs.push(l), NOW).catch((x: unknown) => x);
    expect(logs[0]).toContain('wait 120000 ms');
    expect((e as Error).message).not.toBe(m.auth_pin_attempts_throttled());
  });

  it('a 14-digit Retry-After falls back to the text without a time', async () => {
    const res = throttled({}, { 'Retry-After': '99999999999999' });
    await expect(throwIfPinThrottled(res, () => {}, NOW)).rejects.toMatchObject({
      message: m.auth_pin_attempts_throttled(),
    });
  });

  it('lets every other status through to its own branch', async () => {
    for (const status of [200, 401, 500, 503]) {
      await expect(
        throwIfPinThrottled(new Response('', { status }), () => {}, NOW)
      ).resolves.toBeUndefined();
    }
  });
});

describe('every PIN request of the login reads the 429 (wiring)', () => {
  // A call site removed reverts that request to "Serveur injoignable" for a 429, with every
  // behavioural test above still green - so each is pinned where it lives.
  const source = readFileSync(
    join(process.cwd(), 'src/lib/composables/session/sessionAuth.ts'),
    'utf8'
  );
  const bodyOf = (start: string, end: string) => {
    const from = source.indexOf(start);
    expect(from, start).toBeGreaterThan(-1);
    return source.slice(from, source.indexOf(end, from + start.length));
  };

  it.each([
    [
      'the login PIN check',
      'checkPin: ({ verifier, deviceId, salt, intent }) =>',
      'return (await res.json()) as PinCheckAnswer;',
    ],
    ['the salt', 'async function fetchPinSalt(', 'return salt;'],
    ['the recovery check', 'async function recoverPinSteps(', 'auth_pin_new_incorrect'],
  ])('%s', (_name, start, end) => {
    const body = bodyOf(start, end);
    const at = body.indexOf('await throwIfPinThrottled(res');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(body.indexOf('if (!res.ok)'));
  });
});
