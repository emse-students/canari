/**
 * Shared authenticated fetch wrapper.
 *
 * - Injects the Bearer token automatically.
 * - On a 401 response, attempts one silent token refresh and retries.
 * - On a second 401, throws `SessionExpiredError` so the caller can redirect.
 * - Never issues an anonymous request in place of an expired session (see below).
 * - Every call has a response-head deadline (a typed `RequestDeadlineError`, a transport failure -
 *   never a logout) and feeds the connectivity store's `slow` reading.
 * - Never flattens a refusal into a sentence: what `refresh()` threw is what callers catch.
 */

import { getToken, refresh, SessionExpiredError } from '$lib/stores/auth';
import { IdentitySplitError } from '$lib/stores/tokenIdentity.svelte';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { trackedFetch } from '$lib/utils/trackedFetch';
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
}

/** Authenticated fetch wrapper: injects the Bearer token, retries once on 401, and throws on a second 401. */
export async function apiFetch(url: string, options: ApiFetchOptions = {}): Promise<Response> {
  const { deadlineMs, ...init } = options;
  const method = (init.method ?? 'GET').toUpperCase();
  const logUrl = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  const t0 = Date.now();

  let token = '';
  try {
    token = await getToken();
  } catch (e) {
    // A dead session is an ANSWER, not a hiccup: retrying anonymously turns "you are logged out"
    // into "there is nothing here", which is what left Android showing an empty feed for a revoked
    // session (WP-ANDROID-SESS-1). Only a transport failure earns the unauthenticated attempt -
    // some routes answer without a token, and offline startup depends on that.
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
    // The CAUSE is the whole point of this line. A container restarting mid-deploy needs nothing
    // and a broken refresh needs everything, and without it the two print the same sentence - which
    // is what a fallback owes its reader: not that it was taken, but why the primary path failed.
    const cause = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.warn(
      `[API] getToken failed for ${method} ${logUrl} - proceeding without auth (${cause})`
    );
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

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Polling routes are demoted to debug to avoid drowning the console.
  const POLL_ROUTES = ['/api/presence', '/api/moderation/me/mute-status'];
  const log = POLL_ROUTES.some((r) => logUrl.startsWith(r)) ? console.debug : console.log;

  log(`[API] → ${method} ${logUrl}`);
  let res = await attempt(url, { ...init, headers }, deadlineMs);
  log(`[API] ← ${res.status} ${method} ${logUrl} (${Date.now() - t0}ms)`);

  if (res.status === 401) {
    console.warn(`[API] 401 on ${method} ${logUrl} - tentative de refresh token`);
    try {
      const newToken = await refresh();
      headers['Authorization'] = `Bearer ${newToken}`;
      res = await attempt(url, { ...init, headers }, deadlineMs);
      console.log(`[API] ← ${res.status} ${method} ${logUrl} (retry, ${Date.now() - t0}ms)`);
    } catch (e) {
      // RETHROWN AS IT CAME, because `refresh()` already answered the only question that matters
      // and this frame used to destroy the answer. It separates three outcomes deliberately - a
      // dead cookie (`SessionExpiredError`), a server that answered something else
      // (`RefreshFailedError`, typically a 502 while a container restarts mid-deploy), and a
      // transport failure that reached nobody - and every one of them left here as one untyped
      // French sentence. A caller holding that sentence could tell "you are logged out" from "come
      // back in ten seconds" only by matching prose, which is a distinction exactly one call site
      // ever makes; the other call sites retried a dead session, or gave up on a live one.
      const cause = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.warn(`[API] refresh failed on ${method} ${logUrl} - ${cause}`);
      throw e;
    }
    if (res.status === 401) {
      // A FRESHLY MINTED access token was refused, so the session really is over - which is what
      // `SessionExpiredError` means, and the only reason it was not thrown here is that this line
      // predates the type. Saying it in prose left the logout paths (`ChatBackgroundService`,
      // `sessionConnection`, `promoteOfflineSession`) unable to see the one case they exist for.
      console.warn(`[API] double 401 on ${method} ${logUrl} - session invalide`);
      throw new SessionExpiredError();
    }
  }

  return res;
}
