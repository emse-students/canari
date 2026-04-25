/**
 * Shared authenticated fetch wrapper.
 *
 * - Injects the Bearer token automatically.
 * - On a 401 response, attempts one silent token refresh and retries.
 * - On a second 401, clears auth state and rethrows so the caller can redirect.
 */

import { getToken, refresh, clearAuth } from '$lib/stores/auth';

export interface ApiFetchOptions extends RequestInit {
  /** Extra headers merged in (in addition to Content-Type and Authorization). */
  headers?: Record<string, string>;
}

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

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
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
      console.error(`[API] refresh failed — clearAuth, throw session expirée`);
      await clearAuth();
      throw new Error('Session expirée — veuillez vous reconnecter.');
    }
    if (res.status === 401) {
      console.error(`[API] double 401 on ${method} ${logUrl} — session invalide`);
      await clearAuth();
      throw new Error('Session expirée — veuillez vous reconnecter.');
    }
  }

  return res;
}
