/**
 * Client-side auth store - Authentik OIDC flow.
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
import { coreUrl } from '$lib/utils/apiUrl';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { clearPersistedPendingAcks } from '$lib/mls-client/ackRetry';

const OIDC_STATE_KEY = 'canari_oidc_state';
const OIDC_RETURN_KEY = 'canari_oidc_return';
const OIDC_STORE_FILE = 'oidc-state.json';

/**
 * Writes an OIDC state entry.
 * On Tauri desktop uses `tauri-plugin-store` (survives WebKitGTK navigation
 * which clears `localStorage`). Falls back to `localStorage` on web.
 */
async function setOidcEntry(key: string, value: string): Promise<void> {
  if (isTauriRuntime()) {
    const { load } = await import('@tauri-apps/plugin-store');
    const store = await load(OIDC_STORE_FILE, { autoSave: true, defaults: {} });
    await store.set(key, value);
  } else {
    localStorage.setItem(key, value);
  }
}

/** Reads an OIDC state entry (Tauri Store on desktop, localStorage on web). */
async function getOidcEntry(key: string): Promise<string | null> {
  if (isTauriRuntime()) {
    const { load } = await import('@tauri-apps/plugin-store');
    const store = await load(OIDC_STORE_FILE, { autoSave: true, defaults: {} });
    return (await store.get<string>(key)) ?? null;
  }
  return localStorage.getItem(key);
}

/** Removes an OIDC state entry (Tauri Store on desktop, localStorage on web). */
async function removeOidcEntry(key: string): Promise<void> {
  if (isTauriRuntime()) {
    const { load } = await import('@tauri-apps/plugin-store');
    const store = await load(OIDC_STORE_FILE, { autoSave: true, defaults: {} });
    await store.delete(key);
  } else {
    localStorage.removeItem(key);
  }
}

let _accessToken: string | null = null;
// Shared in-flight refresh promise - prevents concurrent getToken() callers from
// each firing a separate /api/auth/refresh request.
let _pendingRefresh: Promise<string> | null = null;

/**
 * Thrown when the HttpOnly refresh cookie has expired or been revoked (HTTP 401).
 * Callers must distinguish this from transient network errors to avoid retrying
 * a definitively dead session.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired - please log in again');
    this.name = 'SessionExpiredError';
  }
}

const alog = (msg: string) => console.log('[A] ' + msg);
const awarn = (msg: string) => console.warn('[A] ' + msg);

/**
 * Writes the access token into the `canari_ws_token` JS-readable cookie used by
 * WebSocket and sync API requests. Adds the `Secure` flag when served over HTTPS.
 */
function setWsSessionCookie(token: string): void {
  if (typeof document === 'undefined') return;
  // Tauri desktop runs under tauri:// which is not https: but traffic is local
  // → we still want the Secure flag for parity with the web production build.
  const proto = window.location.protocol;
  const secure = proto === 'https:' || proto === 'tauri:' ? '; Secure' : '';
  document.cookie = `canari_ws_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax${secure}`;
  alog('ws+');
}

/** Removes the `canari_ws_token` cookie by setting `Max-Age=0`. */
function clearWsSessionCookie(): void {
  if (typeof document === 'undefined') return;
  const proto = window.location.protocol;
  const secure = proto === 'https:' || proto === 'tauri:' ? '; Secure' : '';
  document.cookie = `canari_ws_token=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  alog('ws-');
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

/** Slug du flow Authentik MiConnect pour la connexion mot de passe (revue Google/Apple). */
export const PASSWORD_LOGIN_FLOW_SLUG = 'password-login';

export type OidcLoginOptions = {
  /** Slug du flow d'authentification Authentik (ex. password-login). */
  flowSlug?: string;
};

/**
 * Redirect the user to Authentik's authorize endpoint.
 * After login, Authentik will redirect back to `/auth/callback`.
 * When `flowSlug` is set, the user is sent through `/if/flow/{slug}/` first.
 */
export async function startOidcLogin(
  returnTo = '/chat',
  options?: OidcLoginOptions
): Promise<void> {
  const baseUrl = authentikUrl();
  const clientId = authentikClientId();
  if (!baseUrl || !clientId) {
    throw new Error(
      'Authentik OIDC is not configured (VITE_AUTHENTIK_URL / VITE_AUTHENTIK_CLIENT_ID)'
    );
  }

  // Generate random state for CSRF protection and persist it.
  // On desktop (Tauri) we use the native Store plugin since WebKitGTK clears
  // localStorage during full cross-origin navigation; on web localStorage is fine.
  const state = crypto.randomUUID();
  await setOidcEntry(OIDC_STATE_KEY, state);
  await setOidcEntry(OIDC_RETURN_KEY, returnTo);

  const redirectUri = oidcRedirectUri();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile promo name formation',
    state,
  });

  const authorizePath = `/application/o/authorize/?${params}`;
  const authUrl = options?.flowSlug
    ? `${baseUrl}/if/flow/${options.flowSlug}/?next=${encodeURIComponent(authorizePath)}`
    : `${baseUrl}${authorizePath}`;
  alog(`login returnTo=${returnTo} uri=${redirectUri} flow=${options?.flowSlug ?? 'default'}`);

  // On Android Tauri, open in the system browser (Chrome Custom Tabs) so the
  // main WebView is never navigated away and the Tauri IPC bridge stays intact.
  // The callback returns via the fr.emse.canari://callback deep link.
  if (typeof window !== 'undefined' && isTauri() && /android/i.test(navigator.userAgent)) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(authUrl);
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
  // CSRF state check - enforced on all platforms.
  // On desktop (Tauri) the state is read from the native Store plugin (survives
  // WebKitGTK navigation that clears localStorage). On web, localStorage is used.
  console.debug('[auth] handleOidcCallback isDesktop:', isTauriRuntime());
  const savedState = await getOidcEntry(OIDC_STATE_KEY);
  console.debug('[auth] savedState present:', !!savedState, 'matches:', savedState === state);
  if (!savedState || savedState !== state) {
    throw new Error('Invalid OIDC state - possible CSRF attack');
  }
  await removeOidcEntry(OIDC_STATE_KEY);

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
    const text = await res.text().catch(() => '');
    let message = text || `Authentication failed (${res.status})`;
    try {
      const parsed = JSON.parse(text) as {
        message?: string | { message?: string; code?: string };
        code?: string;
      };
      const msgField = parsed.message;
      const nested = typeof msgField === 'string' ? msgField : msgField?.message;
      const code = parsed.code ?? (typeof msgField === 'object' ? msgField?.code : undefined);
      if (code === 'MAINTENANCE') {
        message =
          nested || 'Canari est en maintenance. Seuls les administrateurs peuvent se connecter.';
      } else if (nested) {
        message = nested;
      }
    } catch {
      /* keep raw text */
    }
    throw new Error(message);
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
 * Get the intended return path after OIDC callback, then clear it.
 * Async because on Tauri desktop the value lives in the native Store
 * (WebKitGTK clears localStorage during cross-origin navigation to Authentik).
 */
export async function getOidcReturnTo(): Promise<string> {
  const returnTo = (await getOidcEntry(OIDC_RETURN_KEY)) || '/chat';
  await removeOidcEntry(OIDC_RETURN_KEY);
  return returnTo;
}

/**
 * Rotate the access token using the HttpOnly refresh cookie.
 * The browser sends the cookie automatically with `credentials: 'include'`.
 */
export async function refresh(): Promise<string> {
  if (_pendingRefresh) return _pendingRefresh;
  _pendingRefresh = _doRefresh().finally(() => {
    _pendingRefresh = null;
  });
  return _pendingRefresh;
}

async function _doRefresh(): Promise<string> {
  const endpoint = `${coreUrl()}/api/auth/refresh`;
  alog(`refresh→ ${endpoint}`);
  const t0 = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    credentials: 'include', // send HttpOnly cookie
  });

  if (!res.ok) {
    // Don't call clearAuth() - that would wipe userId from localStorage and revoke
    // the refresh cookie server-side, forcing a full OIDC re-auth even when the
    // failure was transient. Just drop the in-memory token.
    _accessToken = null;
    clearWsSessionCookie();
    awarn(`refresh✗${res.status} ${Date.now() - t0}ms`);
    // Only 401/403 prove the refresh cookie is dead. Any other status (e.g. 502/503
    // while the backend restarts during a deploy) is transient: throwing
    // SessionExpiredError there would force a logout + cookie revocation for a hiccup.
    if (res.status === 401 || res.status === 403) throw new SessionExpiredError();
    throw new Error(`Token refresh failed (HTTP ${res.status})`);
  }

  const data = (await res.json()) as { access_token: string };
  _accessToken = data.access_token;
  setWsSessionCookie(data.access_token);

  // Decode claims from the new JWT and keep reactive state in sync.
  let tokenExp: number | null = null;
  try {
    const payload = data.access_token.split('.')[1];
    if (payload) {
      const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
        sub?: string;
        admin?: boolean;
        exp?: number;
      };
      setGlobalAdmin(!!decoded.admin);
      tokenExp = decoded.exp ?? null;
      // Restore userId if localStorage was cleared (e.g., Android process kill).
      if (decoded.sub && !currentUserId()) {
        saveUserLocally({ id: decoded.sub, admin: !!decoded.admin });
      }
    }
  } catch {
    /* ignore malformed token */
  }

  const expIn = tokenExp ? tokenExp - Math.floor(Date.now() / 1000) : null;
  alog(`refresh✓ ${Date.now() - t0}ms${expIn !== null ? ` exp=${expIn}s` : ''}`);
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
    alog(`token exp=${remaining}s→refresh`);
    _accessToken = null;
  } else {
    alog('token→refresh');
  }
  return await refresh();
}

/** Override the in-memory token (used when a token is received externally). */
export function setToken(token: string): void {
  _accessToken = token;
  setWsSessionCookie(token);
}

/**
 * Logs the user out: clears the in-memory token and WebSocket cookie,
 * calls the backend logout endpoint to revoke the HttpOnly refresh cookie,
 * and erases all locally persisted user data.
 */
export async function clearAuth(): Promise<void> {
  alog('clear');
  _accessToken = null;
  clearWsSessionCookie();
  // Drop persisted message ACKs so a next user on this tab can't ACK the previous user's ids.
  clearPersistedPendingAcks();
  // Tell the backend to clear the HttpOnly cookie
  await fetch(`${coreUrl()}/api/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  }).catch((e) => awarn('logout✗ ' + e));
  clearUserLocally();
}

/**
 * Check if we have a session: try a silent refresh.
 * Returns true if the refresh cookie exists and is valid,
 * AND we have a saved user in localStorage (prevents loops after logout).
 */
export async function hasStoredSession(): Promise<boolean> {
  let uid = currentUserId();
  alog(`session uid=${uid ?? 'null'}`);
  if (!uid) {
    // On Tauri mobile, localStorage may be wiped after an OS process kill while
    // the HttpOnly refresh cookie survives in the WebView cookie store. Attempt a
    // silent refresh - _doRefresh will restore userId from the JWT sub claim.
    if (isTauri()) {
      try {
        await refresh();
        uid = currentUserId();
      } catch {
        /* cookie absent or expired */
      }
    }
    if (!uid) {
      alog('session→F');
      return false;
    }
    alog('session→T restored');
    return true;
  }
  try {
    await refresh();
    alog('session→T');
    return true;
  } catch {
    alog('session→F refresh✗');
    return false;
  }
}
