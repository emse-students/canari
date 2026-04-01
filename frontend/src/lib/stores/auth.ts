/**
 * Client-side auth store — Authentik OIDC flow.
 *
 * 1. `startOidcLogin()` redirects the user to Authentik's authorize endpoint.
 * 2. Authentik redirects back to `/auth/callback?code=…&state=…`.
 * 3. `handleOidcCallback()` sends the code to core-service which exchanges it
 *    server-side (keeping client_secret safe) and returns an internal JWT pair.
 *
 * Access token  → kept in memory only (lost on page reload, recovered via refresh).
 * Refresh token → HttpOnly cookie set by the backend (never accessible to JS).
 */

import { saveUserLocally, clearUserLocally } from '$lib/stores/user';

const OIDC_STATE_KEY = 'canari_oidc_state';
const OIDC_RETURN_KEY = 'canari_oidc_return';

let _accessToken: string | null = null;

function coreUrl(): string {
  const url = import.meta.env.VITE_CORE_URL as string | undefined;
  if (url?.trim()) return url.trim();
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3012';
}

function authentikUrl(): string {
  return ((import.meta.env.VITE_AUTHENTIK_URL as string) || '').replace(/\/+$/, '');
}

function authentikClientId(): string {
  return (import.meta.env.VITE_AUTHENTIK_CLIENT_ID as string) || '';
}

/**
 * Redirect the user to Authentik's authorize endpoint.
 * After login, Authentik will redirect back to `/auth/callback`.
 */
export function startOidcLogin(returnTo = '/chat'): void {
  const baseUrl = authentikUrl();
  const clientId = authentikClientId();
  if (!baseUrl || !clientId) {
    throw new Error(
      'Authentik OIDC is not configured (VITE_AUTHENTIK_URL / VITE_AUTHENTIK_CLIENT_ID)'
    );
  }

  // Generate random state for CSRF protection
  const state = crypto.randomUUID();
  sessionStorage.setItem(OIDC_STATE_KEY, state);
  sessionStorage.setItem(OIDC_RETURN_KEY, returnTo);

  const redirectUri = `${window.location.origin}/auth/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile email',
    state,
  });

  window.location.href = `${baseUrl}/application/o/authorize/?${params}`;
}

/**
 * Exchange the authorization code received from Authentik for internal tokens.
 * Called from the `/auth/callback` page.
 */
export async function handleOidcCallback(
  code: string,
  state: string
): Promise<{ id: string; email: string; displayName: string }> {
  // Verify state
  const savedState = sessionStorage.getItem(OIDC_STATE_KEY);
  if (!savedState || savedState !== state) {
    throw new Error('Invalid OIDC state — possible CSRF attack');
  }
  sessionStorage.removeItem(OIDC_STATE_KEY);

  const redirectUri = `${coreUrl()}/auth/callback`;

  const res = await fetch(`${coreUrl()}/api/auth/oidc/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // receive HttpOnly cookie
    body: JSON.stringify({ code, redirect_uri: redirectUri }),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(msg || `Authentication failed (${res.status})`);
  }

  const data = (await res.json()) as {
    access_token: string;
    user: {
      id: string;
      email: string;
      displayName: string;
      firstYearOfSchool: number | null;
      avatarMediaId: string | null;
      bio: string | null;
      admin: boolean;
    };
  };

  _accessToken = data.access_token;

  saveUserLocally(data.user);

  return data.user;
}

/**
 * DEV-ONLY: bypass Authentik and log in directly via core-service.
 * Only works when the backend is running in non-production mode.
 */
export async function devLogin(
  id?: string
): Promise<{ id: string; email: string; displayName: string }> {
  const res = await fetch(`${coreUrl()}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ id }),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(msg || `Dev login failed (${res.status})`);
  }

  const data = (await res.json()) as {
    access_token: string;
    user: {
      id: string;
      email: string;
      displayName: string;
      firstYearOfSchool: number | null;
      avatarMediaId: string | null;
      bio: string | null;
      admin: boolean;
    };
  };

  _accessToken = data.access_token;

  saveUserLocally(data.user);

  return data.user;
}

/** Get the intended return path after OIDC callback, then clear it. */
export function getOidcReturnTo(): string {
  const returnTo = sessionStorage.getItem(OIDC_RETURN_KEY) || '/chat';
  sessionStorage.removeItem(OIDC_RETURN_KEY);
  return returnTo;
}

/**
 * Rotate the access token using the HttpOnly refresh cookie.
 * The browser sends the cookie automatically with `credentials: 'include'`.
 */
export async function refresh(): Promise<string> {
  const res = await fetch(`${coreUrl()}/api/auth/refresh`, {
    method: 'POST',
    credentials: 'include', // send HttpOnly cookie
  });

  if (!res.ok) {
    await clearAuth();
    throw new Error('Session expired — please log in again');
  }

  const data = (await res.json()) as { access_token: string };
  _accessToken = data.access_token;
  return data.access_token;
}

/** Decode the `exp` claim from a JWT without verifying the signature. */
function jwtExpiresAt(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const { exp } = JSON.parse(json) as { exp?: number };
    return typeof exp === 'number' ? exp : null;
  } catch {
    return null;
  }
}

/**
 * Returns the current access token, attempting a silent refresh if none is
 * held in memory (e.g. after a page reload in Tauri) or if it expires within
 * the next 60 seconds.
 */
export async function getToken(): Promise<string> {
  if (_accessToken) {
    const exp = jwtExpiresAt(_accessToken);
    const expiresWithinGrace = exp !== null && exp - Math.floor(Date.now() / 1000) < 60;
    if (!expiresWithinGrace) return _accessToken;
    // Token is about to expire — clear it so refresh() runs.
    _accessToken = null;
  }
  return await refresh();
}

/** Override the in-memory token (used when a token is received externally). */
export function setToken(token: string): void {
  _accessToken = token;
}

export async function clearAuth(): Promise<void> {
  _accessToken = null;
  // Tell the backend to clear the HttpOnly cookie
  await fetch(`${coreUrl()}/api/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  }).catch(() => {});
  clearUserLocally();
}

/**
 * Check if we have a session: try a silent refresh.
 * Returns true if the refresh cookie exists and is valid,
 * AND we have a saved user in localStorage (prevents loops after logout).
 */
export async function hasStoredSession(): Promise<boolean> {
  // If no saved user, consider the session invalid even if we could refresh
  if (!localStorage.getItem('canari_saved_user')) {
    return false;
  }
  try {
    await refresh();
    return true;
  } catch {
    return false;
  }
}
