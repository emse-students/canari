import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import { LoginFailure } from './loginErrors';

/**
 * A 429 FROM A PIN ROUTE IS AN ANSWER, AND IT IS NOT "SERVER UNREACHABLE" (PIN audit row 12,
 * 2026-11-20). `pin-check` is throttled per user (`UserThrottlerGuard`), and its refusal reached the
 * same `!res.ok` branch as a 5xx: the person was told the server could not be reached, and retried
 * at once into the same refusal. It is classified HERE, at the throw, as its own code, and its text
 * says what to do: wait.
 *
 * THE WAIT IS SHOWN AS A PLAIN TIME, NEVER A COUNTDOWN. The server's `Retry-After` (seconds, or an
 * HTTP date) is turned into the wall-clock minute the person may try again, rounded UP so the time
 * shown is never earlier than the one the server set. No timer runs on the gate for it.
 */

/**
 * The instant `Retry-After` names, read from `now`: delta-seconds or an HTTP date. `null` when the
 * header is absent or unreadable - the text then asks to wait without naming a time.
 */
export function retryAfterInstant(header: string | null, now: Date): Date | null {
  const value = header?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return new Date(now.getTime() + Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at);
}

/** `at` rounded UP to the next whole minute (unchanged when already on one). */
function ceilToMinute(at: Date): Date {
  const minute = 60_000;
  return new Date(Math.ceil(at.getTime() / minute) * minute);
}

/**
 * The login failure for a PIN route that answered 429: `pin_attempts_throttled`, with the time to
 * try again when the server named one.
 *
 * @param formatTime renders the minute; the default is the active locale's `HH:MM`. Passed by tests.
 */
export function pinAttemptsThrottledFailure(
  retryAfter: string | null,
  now: Date = new Date(),
  formatTime: (at: Date) => string = (at) =>
    at.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })
): LoginFailure {
  const at = retryAfterInstant(retryAfter, now);
  return new LoginFailure(
    'pin_attempts_throttled',
    at
      ? m.auth_pin_attempts_throttled_until({ time: formatTime(ceilToMinute(at)) })
      : m.auth_pin_attempts_throttled()
  );
}

/** Throws {@link pinAttemptsThrottledFailure} when `res` is a 429; returns otherwise. */
export function throwIfPinThrottled(res: Response, log: (msg: string) => void): void {
  if (res.status !== 429) return;
  const retryAfter = res.headers.get('Retry-After');
  log(
    `[PIN] The server refused the attempt as too many (429, Retry-After ${retryAfter ?? 'none'}).`
  );
  throw pinAttemptsThrottledFailure(retryAfter);
}
