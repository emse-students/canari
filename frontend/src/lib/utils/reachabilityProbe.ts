/**
 * The one cheap question the connectivity store asks the server when it believes the link just came
 * back: "are you there?" (WP-OFF-6).
 *
 * WHY IT EXISTS. After the browser's `online` event `serverReachable` is deliberately left alone - a
 * link says nothing about the backend - so the outbox stayed refused until SOME OTHER call happened
 * to succeed. Measured 2026-10-09: 3.8-5.3 s from "link back" to the first resent frame, all of it
 * waiting for an unrelated request (a presence poll, a socket reconnect). The probe is that request,
 * sent at once and on purpose.
 *
 * `GET /api/version` is the existing unauthenticated, always-cheap route, so a probe needs no token
 * (an expired one must not be able to keep the device "offline") and costs the server nothing.
 *
 * ANY HTTP ANSWER IS "REACHABLE" - a 502 is a server that is there and unhappy, exactly as in
 * `trackedFetch`. The probe returns `false` only for the absence of an answer.
 */

import { connectivity } from '$lib/stores/connectivity.svelte';
import { coreUrl } from '$lib/utils/apiUrl';
import { trackedFetch } from '$lib/utils/trackedFetch';

/** One probe. Resolves true when the server answered (whatever it said), false when nothing did. */
export async function probeReachability(): Promise<boolean> {
  try {
    await trackedFetch(
      fetch,
      `${coreUrl()}/api/version`,
      { method: 'GET', cache: 'no-store' },
      { requestClass: 'probe' }
    );
    return true;
  } catch (e) {
    console.warn(`[CONNECTIVITY] reachability probe got no answer: ${String(e)}`);
    return false;
  }
}

/**
 * Registers {@link probeReachability} with the store. Idempotent. Called from `registerOutbox`, the
 * one production consumer of a prompt resume, rather than as an import side effect: a test that merely
 * imports `apiFetch` and fails a request must not find an extra `fetch` it did not ask for.
 */
export function installReachabilityProbe(): void {
  connectivity.setReachabilityProbe(probeReachability);
}
