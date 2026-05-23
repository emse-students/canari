/**
 * Shared authenticated fetch wrapper.
 *
 * - Injects the Bearer token automatically.
 * - On a 401 response, attempts one silent token refresh and retries.
 * - On a second 401, clears auth state and rethrows so the caller can redirect.
 */

import { getToken, refresh } from '$lib/stores/auth';

/** Options for `apiFetch` — extends `RequestInit` with a typed `headers` override. */
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
  } catch {
    console.warn(`[API] getToken failed for ${method} ${logUrl} — proceeding without auth`);
  }

  // Do not set a default Content-Type for FormData/Blob bodies — the browser must
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

  console.log(`[API] → ${method} ${logUrl}`);
  let res = await fetch(url, { ...init, headers });
  console.log(`[API] ← ${res.status} ${method} ${logUrl} (${Date.now() - t0}ms)`);

  if (res.status === 401) {
    console.warn(`[API] 401 on ${method} ${logUrl} — tentative de refresh token`);
    try {
      const newToken = await refresh();
      headers['Authorization'] = `Bearer ${newToken}`;
      res = await fetch(url, { ...init, headers });
      console.log(`[API] ← ${res.status} ${method} ${logUrl} (retry, ${Date.now() - t0}ms)`);
    } catch {
      console.warn(`[API] refresh failed on ${method} ${logUrl} — session expirée`);
      throw new Error('Session expirée — veuillez vous reconnecter.');
    }
    if (res.status === 401) {
      console.warn(`[API] double 401 on ${method} ${logUrl} — session invalide`);
      throw new Error('Session expirée — veuillez vous reconnecter.');
    }
  }

  return res;
}
