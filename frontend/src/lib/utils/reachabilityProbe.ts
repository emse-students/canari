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
 * ANY ANSWER OF OUR API IS "REACHABLE" - a JSON 502 is a server that is there and unhappy, exactly
 * as in `trackedFetch`. Something that is not the API (a captive portal's `511`, a WAF's HTML `403`,
 * an edge's 5xx page) is no answer from the server: {@link assertAnsweredByApi}, the one proof the
 * writes use, throws `NotFromApiError` and the probe returns `false`, so the store keeps probing
 * instead of ending on the edge's say-so. `/api/version` answers JSON (`VersionController`).
 */

import { connectivity } from '$lib/stores/connectivity.svelte';
import { coreUrl } from '$lib/utils/apiUrl';
import { trackedFetch } from '$lib/utils/trackedFetch';
import { assertAnsweredByApi } from '$lib/utils/apiJson';
import { isMobileTauriRuntime } from '$lib/utils/appVersion';

/** One probe. Resolves true when our API answered (whatever it said), false when it did not. */
export async function probeReachability(): Promise<boolean> {
  try {
    const res = await trackedFetch(
      fetch,
      `${coreUrl()}/api/version`,
      { method: 'GET', cache: 'no-store' },
      { requestClass: 'probe' }
    );
    assertAnsweredByApi(res, 'GET /api/version');
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
  // Only a phone pauses an app off screen and starves its requests; a background tab keeps probing.
  connectivity.setProbePausesOffScreen(isMobileTauriRuntime());
}
