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
import { invoke, isTauri } from '@tauri-apps/api/core';
import { coreUrl } from '$lib/utils/apiUrl';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { isMobileTauriRuntime } from '$lib/utils/appVersion';
import { customTabsCommand } from '$lib/services/customTabsCommands';
import { clearPersistedPendingAcks } from '$lib/mls-client/ackRetry';
import { connectivity, isTransportFailure } from '$lib/stores/connectivity.svelte';
import { flushAndroidCookies } from '$lib/utils/androidCookies';
import {
  REFRESH_HEADER,
  clearNativeRefreshToken,
  readNativeRefreshToken,
  usesBodyRefreshTransport,
  writeNativeRefreshToken,
} from '$lib/stores/nativeRefreshToken';

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

/** Fires once when the refresh cookie is proven dead. Set by the app shell. */
type SessionExpiredHandler = () => void;
let _sessionExpiredHandler: SessionExpiredHandler | null = null;
let _sessionExpiredNotified = false;

/**
 * Latched the moment the SERVER proves the refresh credential is dead (401/403 on `/api/auth/refresh`).
 *
 * This is a different question from {@link _sessionExpiredNotified}, which only records whether the
 * app has already ANNOUNCED the verdict - and using one for the other is what let the request itself
 * repeat. `_pendingRefresh` collapses callers that overlap in TIME; it does nothing for the caller
 * that arrives one millisecond after the previous request settled, so a screen's worth of API calls
 * each discovered the same dead cookie separately. Measured on prod 2026-08-27: 120 `POST
 * /api/auth/refresh` from one iPhone in 45 minutes, in bursts of eleven inside a single second,
 * every one of them a 401 for the same absent cookie.
 *
 * A 401 here is a PROOF ABOUT A CREDENTIAL, not a transient failure: asking again with the same
 * cookie cannot produce a different answer, so the second request is guaranteed-useless work. The
 * latch is in memory only and is cleared wherever a NEW refresh credential can have arrived - a
 * successful rotation, the OIDC callback, or {@link setToken} - because those are the only events
 * that change the answer. A cold start begins with it clear, which keeps the first refresh of every
 * launch the connectivity probe the rest of this module relies on.
 */
let _refreshCredentialProvenDead = false;

/** Records that a live refresh credential exists again, voiding both verdicts above. */
function noteRefreshCredentialAlive(): void {
  _refreshCredentialProvenDead = false;
  _sessionExpiredNotified = false;
}

/**
 * Registers the app-level reaction to a definitively dead session (log out, go to `/login`).
 *
 * Every caller of `refresh()`/`getToken()` used to own that decision itself, and each one that
 * forgot produced a signed-in-looking app with nothing in it: `apiFetch` swallowed the error and
 * retried anonymously, and the Android reconnect path returned before `getToken()` was ever
 * called, so nothing raised the error that redirects (WP-ANDROID-SESS-1). The verdict is reached
 * in exactly one place - here - so it is announced from here too.
 */
export function setSessionExpiredHandler(fn: SessionExpiredHandler | null): void {
  _sessionExpiredHandler = fn;
  // The verdict can be reached before anything is listening: on a cold start the first refresh
  // runs before the app shell mounts, so the fallback below is what reacts - and a bare redirect
  // is NOT the same reaction. It leaves the PIN modal open over `/login`, covering the sign-in
  // button, and never clears the stale auth state. Measured on Android 2026-08-06. So a handler
  // that arrives late is told immediately; running it twice is the handler's own problem to guard.
  if (fn && _sessionExpiredNotified) {
    awarn('session-expired handler registered after the verdict - replaying it');
    fn();
  }
}

/**
 * Announces a dead session, at most once per session.
 *
 * Gated on a locally saved user: with no saved user there is nothing to log out OF, and a 401 is
 * the ordinary answer during the login flow itself, where a forced redirect would be a loop.
 */
function notifySessionExpired(): void {
  if (_sessionExpiredNotified || !currentUserId()) return;
  _sessionExpiredNotified = true;
  awarn('session dead → logout');
  if (_sessionExpiredHandler) {
    _sessionExpiredHandler();
    return;
  }
  // No handler wired is exactly the silent failure this exists to prevent - say so, and redirect
  // anyway rather than leave the user on a shell that can no longer load anything.
  awarn('no session-expired handler registered - redirecting directly');
  void import('$app/navigation').then(({ goto }) => goto('/login', { replaceState: true }));
}

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
  // On Tauri mobile (Android + iOS) use a custom-scheme deep link so Authentik
  // redirects back to the app via the OS URL handler (Android intent-filter /
  // iOS CFBundleURLTypes) rather than navigating the main WebView away.
  if (isMobileTauriRuntime()) {
    return 'fr.emse.canari://callback';
  }
  return `${window.location.origin}/auth/callback`;
}

/** Slug of the MiConnect Authentik flow for password login (Google/Apple review). */
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

  // On Tauri mobile (Android + iOS), open in a dedicated in-app browser session so the main
  // WebView is never navigated away and the Tauri IPC bridge stays intact. The callback returns
  // via the fr.emse.canari://callback deep link handled by plugin-deep-link - shared by both
  // platforms and unaffected by which browser surface presented the login page.
  //
  // tauri-plugin-customtabs backs this with a Chrome Custom Tab on Android and an
  // ASWebAuthenticationSession on iOS (WP-OIDC-TAB-1). Both are closed automatically once the
  // flow completes - the OS does it for the Custom Tab when this app resumes to the foreground
  // on that deep link, the plugin does it for the session by re-dispatching its callback
  // through the same deep link. A plain system-browser launch (openUrl), used before this
  // plugin existed, left the tab/window open afterward with nothing able to dismiss it from
  // either side, which read as "the login failed".
  if (isMobileTauriRuntime()) {
    await invoke(customTabsCommand('openCustomTab'), { url: authUrl });
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
    refresh_token?: string;
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
  // The first credential of this session. On a cookie platform it arrived as a `Set-Cookie` and
  // there is nothing to do; where the cookie cannot live, this response body is the ONLY copy that
  // will ever exist, so losing it here costs the user a fresh login at the next launch.
  if (usesBodyRefreshTransport()) {
    if (data.refresh_token) {
      await writeNativeRefreshToken(data.refresh_token);
      console.debug('[auth] stored native refresh credential');
    } else {
      awarn('login✓ but no refresh_token in the response - this session cannot survive a restart');
    }
  }
  // A brand-new `canari_refresh` just arrived, so any latched verdict from the previous session is
  // about a credential that no longer exists.
  noteRefreshCredentialAlive();
  setWsSessionCookie(data.access_token);
  // The response carried the first `canari_refresh` of this session; on Android it is only in
  // WebView memory until something flushes it.
  await flushAndroidCookies('login');

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
  // The server already answered this question about this exact cookie. Repeating the request is a
  // round trip whose result is known, and 119 of them is what one iPhone sent in 45 minutes.
  if (_refreshCredentialProvenDead) {
    alog('refresh✗latched (cookie already proven dead - not asking again)');
    notifySessionExpired();
    throw new SessionExpiredError();
  }
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

  // On a platform whose WebView can refuse the cookie, the credential is ours to carry. An EMPTY
  // store is not proof of no session though: `tauri://` is also the desktop origin, where the
  // HttpOnly cookie may work perfectly and is invisible to this code by design. So the request is
  // still made - the header is added only when we actually hold a copy, and it is authoritative
  // when present.
  const bodyTransport = usesBodyRefreshTransport();
  const carried = bodyTransport ? await readNativeRefreshToken() : null;
  if (bodyTransport)
    alog(`refresh carries=${carried ? 'stored credential' : 'nothing (cookie only)'}`);

  // The refresh is the first call of every cold start, so it is also the app's primary
  // connectivity probe. A transport failure here means "no network"; an HTTP status - any status -
  // means the server answered and the session question is decided below. Keeping the two apart is
  // what lets an offline launch unlock instead of being reported as an expired session.
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      // `credentials` still says `include` on every platform: where the cookie works it IS the
      // credential, and where it does not the header carries it and the flag costs nothing.
      credentials: 'include',
      headers: carried ? { [REFRESH_HEADER]: carried } : undefined,
    });
    connectivity.notifyServerReachable();
  } catch (e) {
    if (isTransportFailure(e)) connectivity.notifyServerUnreachable();
    _accessToken = null;
    clearWsSessionCookie();
    awarn(`refresh✗transport ${Date.now() - t0}ms: ${String(e)}`);
    throw e;
  }

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
    if (res.status === 401 || res.status === 403) {
      // The proof, latched: only a new credential can change this answer.
      _refreshCredentialProvenDead = true;
      notifySessionExpired();
      throw new SessionExpiredError();
    }
    throw new Error(`Token refresh failed (HTTP ${res.status})`);
  }

  const data = (await res.json()) as { access_token: string; refresh_token?: string };
  _accessToken = data.access_token;
  setWsSessionCookie(data.access_token);
  // The credential ROTATED. Where we carry it ourselves, the new value must be on disk before this
  // function returns: the server will refuse the old one from now on, and 60 s later will read it as
  // a REPLAY and delete the session row. A server that answered 200 without one would leave this
  // device holding a token it has just invalidated, so say so rather than storing nothing.
  if (bodyTransport) {
    if (data.refresh_token) {
      await writeNativeRefreshToken(data.refresh_token);
      alog('refresh✓stored');
    } else {
      // The rotation happened regardless, so the session is fine for this run - but nothing durable
      // came with it, and the next cold start will have only the cookie to go on. That is either a
      // server that predates this transport or one that stopped sending the field, and both are
      // worth naming rather than silently degrading to "logs in every launch".
      awarn(
        'refresh✓ but no refresh_token in the response - nothing to persist for the next launch'
      );
    }
  }
  // The refresh token ROTATED: the cookie the server just set is the only one it will accept from
  // now on, and the previous one becomes a replay 60 s later. On Android that cookie is in WebView
  // memory only, so a process death before Chromium's own commit timer would hand the next cold
  // start the superseded value and get the session revoked (WP-ANDROID-SESS-1).
  await flushAndroidCookies('refresh');
  // The session answered AND rotated, so both the verdict and the latch are void.
  noteRefreshCredentialAlive();

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
  // Whoever supplied this token supplied a live session with it.
  noteRefreshCredentialAlive();
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
  // Tell the backend to REVOKE the session row - the cookie is the least of it. The credential has
  // to travel the same way it does on a refresh, or the server cannot name the row to delete and a
  // logout on iOS would clear the local copy while leaving the session alive for seven more days.
  const carried = usesBodyRefreshTransport() ? await readNativeRefreshToken() : null;
  await fetch(`${coreUrl()}/api/auth/logout`, {
    method: 'POST',
    credentials: 'include',
    headers: carried ? { [REFRESH_HEADER]: carried } : undefined,
  }).catch((e) => awarn('logout✗ ' + e));
  // Same reasoning as the rotation: the cookie DELETION must reach disk too, or a process death
  // resurrects a revoked cookie at the next launch.
  await flushAndroidCookies('logout');
  // And the copy we carry ourselves, which no `Set-Cookie` can clear.
  if (usesBodyRefreshTransport()) await clearNativeRefreshToken();
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
