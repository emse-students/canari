/**
 * Shared authenticated fetch wrapper.
 *
 * - Injects the Bearer token automatically.
 * - On a 401 response, attempts one silent token refresh and retries.
 * - On a second 401, throws `SessionExpiredError` so the caller can redirect.
 * - Never issues an anonymous request: a token that cannot be obtained is rethrown as it came.
 * - Every call has a response-head deadline (a typed `RequestDeadlineError`, a transport failure -
 *   never a logout) and feeds the connectivity store's `slow` reading.
 * - Never flattens a refusal into a sentence: what `refresh()` threw is what callers catch.
 */

import { getToken, refresh, SessionExpiredError } from '$lib/stores/auth';
import { IdentitySplitError } from '$lib/stores/tokenIdentity.svelte';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { trackedFetch } from '$lib/utils/trackedFetch';
import { sendRenewingOn401 } from '$lib/utils/renewOn401';
import { RequestDeadlineError } from '$lib/utils/requestDeadline';

/**
 * One attempt: the shared tracked, deadline-bounded fetch. A transport failure marks the server
 * unreachable, any HTTP answer marks it reachable, and a response head that never arrives raises
 * `RequestDeadlineError` - see `trackedFetch` and `requestDeadline`.
 *
 * A stalled GET is retried ONCE: the connection is probably dead rather than the server slow, and a
 * fresh socket is what fixes that. The retry is bounded so it cannot multiply load - a single
 * attempt, a GET only (a write of unknown fate is never replayed here), jittered so a burst of
 * stalls does not retry in lockstep, and skipped as soon as the store has seen two stalls in a row
 * (`isOffline`), at which point the link, not the call, is the problem.
 */
async function attempt(
  url: string,
  init: RequestInit,
  deadlineMs: number | undefined
): Promise<Response> {
  try {
    return await trackedFetch(fetch, url, init, { deadlineMs });
  } catch (e) {
    const isGet = (init.method ?? 'GET').toUpperCase() === 'GET';
    if (!(e instanceof RequestDeadlineError) || !isGet || connectivity.isOffline) throw e;
    const jitter = 250 + Math.random() * 750;
    console.warn(`[API] ${e.message} - one retry in ${Math.round(jitter)} ms`);
    await new Promise((r) => setTimeout(r, jitter));
    return trackedFetch(fetch, url, init, { deadlineMs });
  }
}

/** Options for `apiFetch` - extends `RequestInit` with a typed `headers` override. */
export interface ApiFetchOptions extends RequestInit {
  /** Extra headers merged in (in addition to Content-Type and Authorization). */
  headers?: Record<string, string>;
  /**
   * Overrides the response-head deadline (ms) chosen from the method and body size; `0` disables
   * it. Only for a route that legitimately computes for longer than a class allows.
   */
  deadlineMs?: number;
  /**
   * Told the bearer token of the attempt whose response is returned - the retry's after a 401. For
   * a caller that must know WHOSE request the server answered (an account deletion), which the
   * page's own idea of the signed-in account cannot tell it.
   */
  onAuthorization?: (bearer: string) => void;
}

/** Authenticated fetch wrapper: injects the Bearer token, retries once on 401, and throws on a second 401. */
export async function apiFetch(url: string, options: ApiFetchOptions = {}): Promise<Response> {
  const { deadlineMs, onAuthorization, ...init } = options;
  const method = (init.method ?? 'GET').toUpperCase();
  const logUrl = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  const t0 = Date.now();

  let token: string;
  try {
    token = await getToken();
  } catch (e) {
    // A dead session is an ANSWER, not a hiccup: retrying anonymously turns "you are logged out"
    // into "there is nothing here", which is what left Android showing an empty feed for a revoked
    // session (WP-ANDROID-SESS-1).
    if (e instanceof SessionExpiredError) {
      console.warn(`[API] session expired on ${method} ${logUrl} - no anonymous retry`);
      throw e;
    }
    // The same for a split identity: the token exists but is for ANOTHER account than the local
    // one, so the request is refused here rather than sent as somebody it does not name.
    if (e instanceof IdentitySplitError) {
      console.warn(`[API] identity split on ${method} ${logUrl} - request not sent`);
      throw e;
    }
    // NOR IS ANY OTHER FAILURE A REASON TO SEND IT ANONYMOUSLY. This branch used to send the request
    // with no token after a transport failure ("some routes answer without a token, and offline
    // startup depends on that"). Measured on the Mi 9T, offline cold start of `v1.2.9-alpha.1`
    // (2026-10-15): 23 requests went out unauthenticated in six seconds, each into the same dead
    // link the refresh had just failed on, each with its own warn line - and no route the app calls
    // through here answers a signed-in user without a token, so the attempt could only fail again or
    // be answered 401. The refresh's failure IS the answer: a transport failure (typed, see
    // `refresh`) or a refusal (`RefreshFailedError`), rethrown as it came. The refresh already said
    // why at its own throw; the caller says what it could not do.
    throw e;
  }

  // Do not set a default Content-Type for FormData/Blob bodies - the browser must
  // generate the correct multipart boundary (or octet-stream) automatically.
  // Forcing application/json on those requests causes the NestJS JSON body-parser
  // to intercept the binary payload and reject it with 413.
  const needsJsonContentType = !(init.body instanceof FormData) && !(init.body instanceof Blob);
  const headers: Record<string, string> = {
    ...(needsJsonContentType && { 'Content-Type': 'application/json' }),
    ...init.headers,
  };

  // Polling routes are demoted to debug to avoid drowning the console.
  const POLL_ROUTES = ['/api/presence', '/api/moderation/me/mute-status'];
  const log = POLL_ROUTES.some((r) => logUrl.startsWith(r)) ? console.debug : console.log;

  log(`[API] → ${method} ${logUrl}`);
  // A 401 renews the token and sends the same request once more, a 401 on the renewed token is a
  // `SessionExpiredError`, and a failed renewal is rethrown AS IT CAME (`refresh()` separates a dead
  // cookie, a non-verdict answer and a transport failure at its own throw) - the one rule, in
  // `renewOn401.ts`, shared with the media upload and the MLS delivery API.
  return sendRenewingOn401(
    async (bearer) => {
      headers['Authorization'] = `Bearer ${bearer}`;
      const answer = await attempt(url, { ...init, headers }, deadlineMs);
      onAuthorization?.(bearer);
      log(`[API] ← ${answer.status} ${method} ${logUrl} (${Date.now() - t0}ms)`);
      return answer;
    },
    token,
    () => refresh(),
    `${method} ${logUrl}`
  );
}
