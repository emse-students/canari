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

import { saveUserLocally, clearUserLocally, currentUserId } from '$lib/stores/user';
import { setGlobalAdmin } from '$lib/stores/userState.svelte';
import { isTauri } from '@tauri-apps/api/core';

const OIDC_STATE_KEY = 'canari_oidc_state';
const OIDC_RETURN_KEY = 'canari_oidc_return';

let _accessToken: string | null = null;

function setWsSessionCookie(token: string): void {
  if (typeof document === 'undefined') return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `canari_ws_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax${secure}`;
  console.log('[AUTH] setWsSessionCookie — cookie WS mis à jour');
}

function clearWsSessionCookie(): void {
  if (typeof document === 'undefined') return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `canari_ws_token=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  console.log('[AUTH] clearWsSessionCookie — cookie WS supprimé');
}

function isEnvFlagEnabled(value: string | boolean | undefined): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    default:
      return false;
  }
}

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

function oidcRedirectUri(): string {
  const configured = (import.meta.env.VITE_AUTHENTIK_REDIRECT_URI as string | undefined)?.trim();
  if (configured) return configured;
  // On Tauri mobile use a custom-scheme deep link so Authentik redirects back
  // to the app via Android intent rather than navigating the main WebView.
  if (typeof window !== 'undefined' && isTauri() && /android/i.test(navigator.userAgent)) {
    return 'fr.emse.canari://callback';
  }
  return `${window.location.origin}/auth/callback`;
}

export function devRoutesEnabled(): boolean {
  return isEnvFlagEnabled(import.meta.env.VITE_ENABLE_DEV_ROUTES as string | undefined);
}

/**
 * Redirect the user to Authentik's authorize endpoint.
 * After login, Authentik will redirect back to `/auth/callback`.
 */
export async function startOidcLogin(returnTo = '/chat'): Promise<void> {
  const baseUrl = authentikUrl();
  const clientId = authentikClientId();
  if (!baseUrl || !clientId) {
    throw new Error(
      'Authentik OIDC is not configured (VITE_AUTHENTIK_URL / VITE_AUTHENTIK_CLIENT_ID)'
    );
  }

  // Generate random state for CSRF protection
  const state = crypto.randomUUID();
  localStorage.setItem(OIDC_STATE_KEY, state);
  localStorage.setItem(OIDC_RETURN_KEY, returnTo);

  const redirectUri = oidcRedirectUri();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile promo name formation',
    state,
  });

  const authUrl = `${baseUrl}/application/o/authorize/?${params}`;
  console.log(`[AUTH] startOidcLogin — returnTo=${returnTo}, redirectUri=${redirectUri}`);
  console.log(`[AUTH] Redirection vers Authentik (baseUrl=${baseUrl})`);

  // On Android Tauri, open in the system browser (Chrome Custom Tabs) so the
  // main WebView is never navigated away and the Tauri IPC bridge stays intact.
  // The callback returns via the fr.emse.canari://callback deep link.
  if (typeof window !== 'undefined' && isTauri() && /android/i.test(navigator.userAgent)) {
    const { open } = await import('@tauri-apps/plugin-opener');
    await open(authUrl);
  } else {
    window.location.href = authUrl;
  }
}

/**
 * Exchange the authorization code received from Authentik for internal tokens.
 * Called from the `/auth/callback` page.
 */
export async function handleOidcCallback(
  code: string,
  state: string
): Promise<{ id: string; email: string; displayName: string }> {
  // CSRF state check.
  // In a native Tauri desktop context, WebKitGTK clears localStorage during
  // full cross-origin navigation (app → Authentik → back), so the saved state
  // is gone by the time the callback page loads. CSRF is also not a meaningful
  // threat in a local desktop webview, so we skip the check there.
  // In a normal browser (web deployment) the check is enforced strictly.
  const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  console.debug('[auth] handleOidcCallback isDesktop:', isDesktop);
  const savedState = localStorage.getItem(OIDC_STATE_KEY);
  console.debug('[auth] savedState present:', !!savedState, 'matches:', savedState === state);
  if (!isDesktop) {
    if (!savedState || savedState !== state) {
      throw new Error('Invalid OIDC state — possible CSRF attack');
    }
  } else if (savedState && savedState !== state) {
    // State was preserved but doesn't match — still reject.
    throw new Error('Invalid OIDC state — possible CSRF attack');
  }
  localStorage.removeItem(OIDC_STATE_KEY);

  const redirectUri = oidcRedirectUri();
  console.debug('[auth] redirectUri:', redirectUri, 'coreUrl:', coreUrl());

  console.debug('[auth] POSTing to core-service /api/auth/oidc/callback…');
  const res = await fetch(`${coreUrl()}/api/auth/oidc/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // receive HttpOnly cookie
    body: JSON.stringify({ code, redirect_uri: redirectUri }),
  });
  console.debug('[auth] core-service response status:', res.status);

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

  console.debug('[auth] got access_token, saving user:', data.user?.id);
  _accessToken = data.access_token;
  setWsSessionCookie(data.access_token);

  saveUserLocally(data.user);
  console.debug('[auth] handleOidcCallback complete');

  return data.user;
}

/**
 * DEV-ONLY: bypass Authentik and log in directly via core-service.
 * Only works when the backend is running in non-production mode.
 */
export async function devLogin(
  id?: string
): Promise<{ id: string; email: string; displayName: string }> {
  if (!devRoutesEnabled()) {
    throw new Error('Dev login is disabled');
  }

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
  setWsSessionCookie(data.access_token);

  saveUserLocally(data.user);

  return data.user;
}

/** Get the intended return path after OIDC callback, then clear it. */
export function getOidcReturnTo(): string {
  const returnTo = localStorage.getItem(OIDC_RETURN_KEY) || '/chat';
  localStorage.removeItem(OIDC_RETURN_KEY);
  return returnTo;
}

/**
 * Rotate the access token using the HttpOnly refresh cookie.
 * The browser sends the cookie automatically with `credentials: 'include'`.
 */
export async function refresh(): Promise<string> {
  const endpoint = `${coreUrl()}/api/auth/refresh`;
  console.log(`[AUTH] refresh → POST ${endpoint}`);
  const t0 = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    credentials: 'include', // send HttpOnly cookie
  });

  if (!res.ok) {
    console.warn(`[AUTH] refresh FAILED — status=${res.status} (${Date.now() - t0}ms)`);
    await clearAuth();
    throw new Error('Session expired — please log in again');
  }

  const data = (await res.json()) as { access_token: string };
  _accessToken = data.access_token;
  setWsSessionCookie(data.access_token);

  // Decode admin claim from the new JWT and keep reactive state in sync.
  let tokenExp: number | null = null;
  try {
    const payload = data.access_token.split('.')[1];
    if (payload) {
      const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
        admin?: boolean;
        exp?: number;
      };
      setGlobalAdmin(!!decoded.admin);
      tokenExp = decoded.exp ?? null;
    }
  } catch {
    /* ignore malformed token */
  }

  const expIn = tokenExp ? tokenExp - Math.floor(Date.now() / 1000) : null;
  console.log(
    `[AUTH] refresh OK (${Date.now() - t0}ms)${expIn !== null ? ` — token expire dans ${expIn}s` : ''}`
  );
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
    const remaining = exp !== null ? exp - Math.floor(Date.now() / 1000) : null;
    if (remaining === null || remaining >= 60) return _accessToken;
    console.log(`[AUTH] getToken — token expire dans ${remaining}s, refresh forcé`);
    _accessToken = null;
  } else {
    console.log('[AUTH] getToken — aucun token en mémoire, appel refresh()');
  }
  return await refresh();
}

/** Override the in-memory token (used when a token is received externally). */
export function setToken(token: string): void {
  _accessToken = token;
  setWsSessionCookie(token);
}

export async function clearAuth(): Promise<void> {
  console.log('[AUTH] clearAuth — déconnexion, token mémoire effacé');
  _accessToken = null;
  clearWsSessionCookie();
  // Tell the backend to clear the HttpOnly cookie
  await fetch(`${coreUrl()}/api/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  }).catch((e) => console.warn('[AUTH] logout POST failed (ignoré):', e));
  clearUserLocally();
  console.log('[AUTH] clearAuth — terminé');
}

/**
 * Check if we have a session: try a silent refresh.
 * Returns true if the refresh cookie exists and is valid,
 * AND we have a saved user in localStorage (prevents loops after logout).
 */
export async function hasStoredSession(): Promise<boolean> {
  const uid = currentUserId();
  console.log(`[AUTH] hasStoredSession — userId=${uid ?? 'null'}`);
  if (!uid) {
    console.log('[AUTH] hasStoredSession → false (aucun utilisateur local)');
    return false;
  }
  try {
    await refresh();
    console.log('[AUTH] hasStoredSession → true (refresh OK)');
    return true;
  } catch {
    console.log('[AUTH] hasStoredSession → false (refresh échoué)');
    return false;
  }
}
