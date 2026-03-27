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
  let token = '';
  try {
    token = await getToken();
  } catch {
    // Not logged in — proceed without a token; the server will 401 if needed.
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...init.headers,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let res = await fetch(url, { ...init, headers });

  if (res.status === 401) {
    // One retry with a fresh token.
    try {
      const newToken = await refresh();
      headers['Authorization'] = `Bearer ${newToken}`;
      res = await fetch(url, { ...init, headers });
    } catch {
      clearAuth();
      throw new Error('Session expirée — veuillez vous reconnecter.');
    }
  }

  return res;
}
