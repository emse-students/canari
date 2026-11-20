import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import { parseRetryAfterMs } from '$lib/mls-client/mlsDeliveryApi';
import { refusalFromResponse } from '$lib/utils/apiRefusalError';
import { LoginFailure } from './loginErrors';

/**
 * A 429 FROM A PIN ROUTE IS AN ANSWER, AND IT IS NOT "SERVER UNREACHABLE" (PIN audit row 12,
 * 2026-11-20). `pin-check` is throttled per user (`UserThrottlerGuard`), and its refusal reached the
 * same `!res.ok` branch as a 5xx: the person was told the server could not be reached, and retried
 * at once into the same refusal. It is classified HERE, at the throw, as its own code, and its text
 * says what to do: wait.
 *
 * THE WAIT IS SHOWN AS A PLAIN TIME, NEVER A COUNTDOWN. It is read from the refusal's BODY first
 * (`retryAfterMs`, which `refuseThrottled` sets and `refusalFromResponse` reads - a cross-origin
 * WebView cannot always read the header), then from `Retry-After` (`parseRetryAfterMs`, the app's
 * one parser). It is shown only when it names a minute the person can use: a finite wait, in the
 * future, landing on the same local day. Anything else - a 14-digit header, a date in the past, a
 * wait into tomorrow - falls back to the text without a time, never "Invalid Date". No timer runs.
 */

/** `at` rounded UP to the next whole minute (unchanged when already on one). */
function ceilToMinute(at: Date): Date {
  const minute = 60_000;
  return new Date(Math.ceil(at.getTime() / minute) * minute);
}

/**
 * The minute to retry at, or `null` when the wait does not name a usable one (see the file header):
 * not finite, not in the future, or not on `now`'s local day once rounded up.
 */
export function retryMinute(waitMs: number | null, now: Date): Date | null {
  if (waitMs === null || !Number.isFinite(waitMs) || waitMs <= 0) return null;
  const at = ceilToMinute(new Date(now.getTime() + waitMs));
  if (Number.isNaN(at.getTime())) return null;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return sameDay ? at : null;
}

/**
 * The login failure for a PIN route that answered 429: `pin_attempts_throttled`, with the minute to
 * try again when the wait names a usable one.
 *
 * @param formatTime renders the minute; the default is the active locale's `HH:MM`. Passed by tests.
 */
export function pinAttemptsThrottledFailure(
  waitMs: number | null,
  now: Date = new Date(),
  formatTime: (at: Date) => string = (at) =>
    at.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })
): LoginFailure {
  const at = retryMinute(waitMs, now);
  return new LoginFailure(
    'pin_attempts_throttled',
    at
      ? m.auth_pin_attempts_throttled_until({ time: formatTime(at) })
      : m.auth_pin_attempts_throttled()
  );
}

/**
 * Throws {@link pinAttemptsThrottledFailure} when `res` is a 429; returns otherwise. Reads the body
 * through a clone, so a caller that goes on reads it whole.
 */
export async function throwIfPinThrottled(
  res: Response,
  log: (msg: string) => void,
  now: Date = new Date()
): Promise<void> {
  if (res.status !== 429) return;
  const refusal = await refusalFromResponse(res, 'PIN attempt throttled');
  const header = res.headers.get('Retry-After');
  const waitMs = refusal.retryAfterMs ?? parseRetryAfterMs(header, now.getTime());
  log(
    `[PIN] The server refused the attempt as too many (429, wait ${waitMs ?? 'unknown'} ms, Retry-After ${header ?? 'none'}).`
  );
  throw pinAttemptsThrottledFailure(waitMs, now);
}
