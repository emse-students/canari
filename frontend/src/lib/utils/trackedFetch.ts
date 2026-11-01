/**
 * `fetch` that keeps the connectivity store honest AND lives under a deadline - the ONE place both
 * are done, so `apiFetch` and the MLS delivery POST cannot drift apart on either.
 *
 * - OUR API's answer (any status) proves the server is there: reachable, and its time-to-head feeds
 *   the smoothed latency behind the `slow` hint. WHO ANSWERED is read by the ONE helper the refusal
 *   paths and `assertAnsweredByApi` use, {@link responseOrigin}: a captive portal's `511`, a WAF's
 *   HTML `403` or an edge's 5xx page is not the server, so it proves nothing and moves nothing
 *   (`tracked.unproven`). Not marked unreachable either: a route that answers non-JSON on purpose
 *   (media, files) looks the same from the header, and the reader that knows which it asked for
 *   throws `NotFromApiError` itself.
 * - A transport failure marks the server unreachable.
 * - A deadline expiry ({@link RequestDeadlineError}) is a transport failure too, but one expiry is
 *   only a stall: the store flips to unreachable after two in a row with nothing answered.
 *
 * Only the transport half is a connectivity signal - a 502 is the server telling us it is there and
 * unhappy, and a status code is an ANSWER: it never logs anyone out from here.
 */

import { connectivity } from '$lib/stores/connectivity.svelte';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { responseOrigin } from '$lib/utils/apiJson';
import {
  bodyByteLength,
  classOfMethod,
  deadlineFor,
  fetchUnderDeadline,
  type RequestClass,
} from '$lib/utils/requestDeadline';

/** Bodies above this are mostly upload time, so their head latency says nothing about the link's RTT. */
const LATENCY_BODY_CEILING_BYTES = 16 * 1024;

export interface TrackedFetchOptions {
  /** Defaults to `read` for GET/HEAD and `write` for everything else. */
  requestClass?: RequestClass;
  /** Overrides the class deadline; `0` disables it. */
  deadlineMs?: number;
}

/** See the file header. `fetchImpl` is `globalThis.fetch` on web and `plugin-http`'s on Tauri. */
export async function trackedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  opts: TrackedFetchOptions = {}
): Promise<Response> {
  const requestClass = opts.requestClass ?? classOfMethod(init.method ?? 'GET');
  const bytes = bodyByteLength(init.body);
  const deadlineMs = deadlineFor(requestClass, bytes, opts.deadlineMs);
  const tracked = connectivity.trackRequest({ transfer: bytes >= LATENCY_BODY_CEILING_BYTES });
  try {
    const res = await fetchUnderDeadline(fetchImpl, url, init, requestClass, deadlineMs);
    if (responseOrigin(res) === 'gateway') tracked.answered(bytes < LATENCY_BODY_CEILING_BYTES);
    else {
      tracked.unproven(
        `${init.method ?? 'GET'} ${url} answered ${res.status} with ${res.headers.get('content-type') ?? 'no content type'}`
      );
    }
    return res;
  } catch (e) {
    // TYPED AT THE THROW. The `fetch` CALL rejects with a `TypeError` for exactly one thing by
    // contract: no answer. The browser's is a bare `TypeError: Failed to fetch`, which a reader could
    // not tell from a programming bug that also throws one; re-raised as the one class that says
    // "no answer" by its name, so a consumer can ask for THAT type and nothing broader.
    const failure =
      e instanceof TypeError && !(e instanceof TransportFailureError)
        ? new TransportFailureError(e)
        : e;
    tracked.failed(failure);
    throw failure;
  }
}
