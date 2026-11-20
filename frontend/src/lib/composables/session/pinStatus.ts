import { m } from '$lib/paraglide/messages';
import { fetchOrUnreachable, isServerUnreachable } from '$lib/utils/fetchOrUnreachable';
import { SessionExpiredError } from '$lib/stores/auth';
import { LoginFailure } from './loginErrors';
import { throwIfPinThrottled } from './pinThrottle';

/**
 * Whether this account has chosen a PIN yet, as `GET pin-status` answers it - or why it did not.
 *
 * NO ANSWER IS NOT "FIRST SETUP" (PIN audit row 16, 2026-11-20). The question used to default to
 * `false` - "returning" - on any failure, so the gate drew an unlock keypad for an account that may
 * never have chosen a PIN, and the PIN typed into it was then REGISTERED as the account's PIN with no
 * confirmation (`pin-check` registers on a first check). A fallback is a signal, never a path: an
 * unanswered question is its own outcome, `unanswered`, with the sentence the gate shows and a retry.
 */
export type PinStatus =
  | { kind: 'first-setup' }
  | { kind: 'returning' }
  | { kind: 'unanswered'; message: string }
  /** A 401/403, or a refresh credential proven dead: an answer about the SESSION, never "retry". */
  | { kind: 'session-ended' };

export interface PinStatusDeps {
  /** `.../api/mls/security/pin-status/<userId>`. */
  url: string;
  getToken: () => Promise<string>;
  log: (msg: string) => void;
}

/**
 * Asks the server whether the account has a PIN, under the request deadline (`fetchOrUnreachable`).
 * Never rejects: every failure is an `unanswered` outcome, logged by kind.
 */
export async function askPinStatus(deps: PinStatusDeps): Promise<PinStatus> {
  try {
    const token = await deps.getToken();
    const res = await fetchOrUnreachable(
      deps.url,
      { headers: { Authorization: `Bearer ${token}` } },
      m.auth_server_unreachable()
    );
    await throwIfPinThrottled(res, deps.log);
    if (res.status === 401 || res.status === 403) {
      deps.log(`[PIN] pin-status answered ${res.status} - the session is over, not a retry.`);
      return { kind: 'session-ended' };
    }
    if (!res.ok) {
      console.warn(`[PIN] pin-status answered ${res.status} - the gate asks to retry.`);
      return { kind: 'unanswered', message: m.auth_pin_status_failed() };
    }
    const body = (await res.json()) as { registered?: unknown };
    if (typeof body.registered !== 'boolean') {
      console.error(
        '[PIN] pin-status answered without a `registered` boolean - the gate asks to retry.'
      );
      return { kind: 'unanswered', message: m.auth_pin_status_failed() };
    }
    return { kind: body.registered ? 'returning' : 'first-setup' };
  } catch (e: unknown) {
    if (e instanceof SessionExpiredError) {
      deps.log('[PIN] pin-status: the refresh credential is dead - the session is over.');
      return { kind: 'session-ended' };
    }
    if (isServerUnreachable(e)) {
      deps.log('[PIN] pin-status could not be reached - the gate asks to retry.');
      return { kind: 'unanswered', message: (e as Error).message };
    }
    if (e instanceof LoginFailure) {
      // A typed refusal (too many attempts): its own sentence.
      return { kind: 'unanswered', message: e.message };
    }
    console.error('[PIN] pin-status failed - the gate asks to retry:', e);
    return { kind: 'unanswered', message: m.auth_pin_status_failed() };
  }
}
