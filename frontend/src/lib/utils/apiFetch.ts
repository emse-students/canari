/**
 * Shared authenticated fetch wrapper.
 *
 * - Injects the Bearer token automatically.
 * - On a 401 response, attempts one silent token refresh and retries.
 * - On a second 401, clears auth state and rethrows so the caller can redirect.
 * - Never issues an anonymous request in place of an expired session (see below).
 */

import { getToken, refresh, SessionExpiredError } from '$lib/stores/auth';
import { connectivity, isTransportFailure } from '$lib/stores/connectivity.svelte';

/**
 * `fetch` that keeps the connectivity store honest: a transport failure marks the server
 * unreachable, any HTTP answer marks it reachable. Only the transport half is a connectivity
 * signal - a 502 is the server telling us it is there and unhappy.
 */
async function trackedFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    const res = await fetch(url, init);
    connectivity.notifyServerReachable();
    return res;
  } catch (e) {
    if (isTransportFailure(e)) connectivity.notifyServerUnreachable();
    throw e;
  }
}

/** Options for `apiFetch` - extends `RequestInit` with a typed `headers` override. */
export interface ApiFetchOptions extends RequestInit {
  /** Extra headers merged in (in addition to Content-Type and Authorization). */
  headers?: Record<string, string>;
}

/** Authenticated fetch wrapper: injects the Bearer token, retries once on 401, and throws on a second 401. */
export async function apiFetch(url: string, init: ApiFetchOptions = {}): Promise<Response> {
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
  let res = await trackedFetch(url, { ...init, headers });
  log(`[API] ← ${res.status} ${method} ${logUrl} (${Date.now() - t0}ms)`);

  if (res.status === 401) {
    console.warn(`[API] 401 on ${method} ${logUrl} - tentative de refresh token`);
    try {
      const newToken = await refresh();
      headers['Authorization'] = `Bearer ${newToken}`;
      res = await trackedFetch(url, { ...init, headers });
      console.log(`[API] ← ${res.status} ${method} ${logUrl} (retry, ${Date.now() - t0}ms)`);
    } catch {
      console.warn(`[API] refresh failed on ${method} ${logUrl} - session expired`);
      throw new Error('Session expirée - veuillez vous reconnecter.');
    }
    if (res.status === 401) {
      console.warn(`[API] double 401 on ${method} ${logUrl} - session invalide`);
      throw new Error('Session expirée - veuillez vous reconnecter.');
    }
  }

  return res;
}
