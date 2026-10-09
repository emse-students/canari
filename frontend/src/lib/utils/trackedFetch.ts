/**
 * `fetch` that keeps the connectivity store honest AND lives under a deadline - the ONE place both
 * are done, so `apiFetch` and the MLS delivery POST cannot drift apart on either.
 *
 * - An HTTP answer (any status) proves the server is there: reachable, and its time-to-head feeds
 *   the smoothed latency behind the `slow` hint.
 * - A transport failure marks the server unreachable.
 * - A deadline expiry ({@link RequestDeadlineError}) is a transport failure too, but one expiry is
 *   only a stall: the store flips to unreachable after two in a row with nothing answered.
 *
 * Only the transport half is a connectivity signal - a 502 is the server telling us it is there and
 * unhappy, and a status code is an ANSWER: it never logs anyone out from here.
 */

import { connectivity } from '$lib/stores/connectivity.svelte';
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
  const tracked = connectivity.trackRequest();
  try {
    const res = await fetchUnderDeadline(fetchImpl, url, init, requestClass, deadlineMs);
    tracked.answered(bytes < LATENCY_BODY_CEILING_BYTES);
    return res;
  } catch (e) {
    tracked.failed(e);
    throw e;
  }
}
