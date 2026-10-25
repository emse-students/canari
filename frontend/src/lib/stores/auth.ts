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
import type { AccountLiveness } from '$lib/utils/accountLocalWipe';
import { forgetDeletedAccountOnSignIn } from '$lib/utils/deletedAccountMarker';
import { setGlobalAdmin } from '$lib/stores/userState.svelte';
import { noteSessionAnswered } from '$lib/stores/sessionAnswer.svelte';
import {
  IdentitySplitError,
  checkTokenIdentity,
  clearIdentitySplit,
  getIdentitySplit,
} from '$lib/stores/tokenIdentity.svelte';
import { decodeTokenClaims } from '$lib/utils/jwtClaims';
import { createPkcePair } from '$lib/utils/pkce';
import { getAppVersionCheck } from '$lib/stores/appVersionCheck.svelte';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { coreUrl } from '$lib/utils/apiUrl';
import { showToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';
import {
  OIDC_MOBILE_POST_LOGOUT_URI,
  OIDC_MOBILE_REDIRECT_URI,
} from '$lib/mobile/appSiteAssociation';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { discardSharedOut } from '$lib/sharing/shareOutCleanup';
import { eraseAccountShortcuts } from '$lib/sharing/shareTargetsNative';
import { eraseIncomingShare } from '$lib/mobile/incomingShareSignOut';
import { endPushRegistration } from '$lib/services/PushNotificationService';
import { getClientAppVersion, isMobileTauriRuntime } from '$lib/utils/appVersion';
import { customTabsCommand } from '$lib/services/customTabsCommands';
import {
  clearRestoreKey,
  forgetRestoreKeyRegistrations,
  markRestoreAttempted,
} from '$lib/services/restoreKey';
import { clearPersistedPendingAcks } from '$lib/mls-client/ackRetry';
import { forgetPinSaltAhead } from '$lib/composables/session/pinSaltAhead';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { isTransportFailure, TransportFailureError } from '$lib/utils/transportFailure';
import { DEADLINE_MS, RequestDeadlineError } from '$lib/utils/requestDeadline';
import { trackedFetch } from '$lib/utils/trackedFetch';
import { flushAndroidCookies } from '$lib/utils/androidCookies';
import { onAppForegroundChange } from '$lib/utils/appForeground';
import { refusalOrigin } from '$lib/utils/apiJson';
import {
  REFRESH_HEADER,
  clearNativeRefreshToken,
  readNativeRefreshToken,
  usesBodyRefreshTransport,
  writeNativeRefreshToken,
} from '$lib/stores/nativeRefreshToken';

const OIDC_STATE_KEY = 'canari_oidc_state';
const OIDC_RETURN_KEY = 'canari_oidc_return';
/**
 * The PKCE verifier of the sign-in under way, redeemed with its code - see `$lib/utils/pkce`. On the
 * web it lives in `sessionStorage`, not `localStorage`: the redirect to MiConnect and back happens in
 * the SAME tab, which is all `sessionStorage` has to survive, and the secret then dies with the tab
 * instead of staying readable by every tab of the origin. A native app keeps it in the store file
 * with the state, for the reason {@link setOidcEntry} gives.
 */
const OIDC_VERIFIER_KEY = 'canari_oidc_verifier';
/**
 * Says that the sign-in under way sent a challenge, stored WITH the state (`localStorage` on the web,
 * the store file in an app) and holding no secret. It exists because the web keeps the state and the
 * verifier in two storages: a callback that lands in another browsing context - a link reopened in a
 * new tab, an installed PWA handing off to the browser - finds the state and not the verifier. Without
 * this marker that callback would post a challenged code with no verifier and get a bare refusal;
 * with it, the client knows before posting that the proof is gone (see {@link OidcSignInError}).
 */
const OIDC_CHALLENGED_KEY = 'canari_oidc_challenged';
/** MiConnect's id_token for the session this device signed in with - see {@link leaveSignedOut}. */
const OIDC_ID_TOKEN_KEY = 'canari_oidc_id_token';
const OIDC_STORE_FILE = 'oidc-state.json';

/**
 * Writes an OIDC state entry.
 * On Tauri desktop uses `tauri-plugin-store` (survives WebKitGTK navigation
 * which clears `localStorage`). On web, `webStorage` - `localStorage` unless the entry says otherwise.
 */
async function setOidcEntry(
  key: string,
  value: string,
  webStorage: Storage = localStorage
): Promise<void> {
  if (isTauriRuntime()) {
    const { load } = await import('@tauri-apps/plugin-store');
    const store = await load(OIDC_STORE_FILE, { autoSave: true, defaults: {} });
    await store.set(key, value);
  } else {
    webStorage.setItem(key, value);
  }
}

/** Reads an OIDC state entry (Tauri Store on desktop, `webStorage` on web). */
async function getOidcEntry(
  key: string,
  webStorage: Storage = localStorage
): Promise<string | null> {
  if (isTauriRuntime()) {
    const { load } = await import('@tauri-apps/plugin-store');
    const store = await load(OIDC_STORE_FILE, { autoSave: true, defaults: {} });
    return (await store.get<string>(key)) ?? null;
  }
  return webStorage.getItem(key);
}

/** Removes an OIDC state entry (Tauri Store on desktop, `webStorage` on web). */
async function removeOidcEntry(key: string, webStorage: Storage = localStorage): Promise<void> {
  if (isTauriRuntime()) {
    const { load } = await import('@tauri-apps/plugin-store');
    const store = await load(OIDC_STORE_FILE, { autoSave: true, defaults: {} });
    await store.delete(key);
  } else {
    webStorage.removeItem(key);
  }
}

let _accessToken: string | null = null;
// Shared in-flight refresh promise - prevents concurrent getToken() callers from
// each firing a separate /api/auth/refresh request.
let _pendingRefresh: Promise<string> | null = null;
/**
 * Counts the sign-outs this process has STARTED - see {@link clearAuth}. A refresh captures it before
 * it sends and compares it when the answer arrives: a different value means a sign-out began while it
 * was in flight, and the answer is about a session being revoked. It is DROPPED - no identity, no
 * token, no rotation stored, no verdict announced - because applying it re-saved the user the sign-out
 * had just cleared (`_doRefresh` restores the identity from the token after an Android process kill),
 * which is "a saved user, nobody logged in": the vault unlock, its 401, and a second sign-out.
 */
let _signOutGeneration = 0;

/**
 * The number of sign-outs this process has started (see `_signOutGeneration`), for work that spans
 * awaits and must not complete for an account that signed out meanwhile.
 *
 * A caller captures it when it starts and compares it after each await: a different value means a
 * sign-out began in between, whether or not it has finished. The login is the case that named it - a
 * sign-out during a ~12 s native decrypt found no live session to stop, and the login then set
 * `isLoggedIn` for a signed-out user (`loginImpl`).
 */
export function signOutGeneration(): number {
  return _signOutGeneration;
}
/**
 * How many {@link clearAuth} calls are running; while any is, a refresh asked for is not sent at all.
 * A count because sign-outs overlap - see `clearAuth`.
 */
let _signOutsUnderway = 0;
/**
 * The transport failure of the refresh SENT while the browser reported no network: the proof every
 * later caller of the same spell is answered from (see `refresh`). Null when no spell is proven.
 */
let _noNetworkSpellFailure: TransportFailureError | RequestDeadlineError | null = null;

/**
 * How long a refresh waits for its response head before it is a transport failure
 * ({@link RequestDeadlineError}), never an answer - so it can never log anyone out.
 *
 * THE ROTATION IS WHAT PICKS THE NUMBER. The server rotates the refresh token on RECEIPT, so a
 * deadline can abandon a refresh the server already executed and lose the new token. That loses the
 * RESPONSE, not the session: the replaced token stays valid for `ROTATION_GRACE_SECONDS` (60 s,
 * `apps/core-service/src/auth/auth-sessions.service.ts`), and presenting it again inside that window
 * is answered with the CURRENT token, rotating nothing - PROVIDED it is presented again inside
 * that window.
 *
 * NOTHING ELSE GUARANTEES A NEXT REFRESH, so the refresh re-sends itself, ONCE, at once, with the
 * SAME credential ({@link REFRESH_DEADLINE_RESENDS}) - the stored copy where the client carries it
 * (`X-Canari-Refresh`), the jar's current cookie otherwise. A cold start's `hasStoredSession` swallows the
 * failure and leaves the user on the login screen, the no-network gate holds refreshes until a
 * reconnect, and a backgrounded app makes no call at all - so "the next caller is the retry" could
 * leave a rotation lost until the grace ran out and the next refresh revoked the session as a replay.
 * The re-send is safe by the server's construction: a first request that never arrived means the
 * re-send rotates normally; one that did arrive means the re-send gets the grace answer. Never a
 * double rotation. The bound that must fit in the 60 s grace is the RE-SEND'S ARRIVAL, which the
 * server sees about one deadline (20 s) after the rotation the first request caused - not the 40 s
 * the two deadlines take in total.
 *
 * It is the read class's number and the call is labelled `read`, on purpose: what the deadline policy
 * needs is a call that may be re-sent once without a second effect, which is what a GET is and what
 * this POST is inside the grace. With NO deadline the same lost response is worse, not safer: an
 * engine that gives up after minutes has also spent the grace, and the next refresh is read as a
 * replay and revokes the session.
 */
export const REFRESH_DEADLINE_MS = DEADLINE_MS.read;

/** How many times a refresh whose head missed its deadline is re-sent - see {@link REFRESH_DEADLINE_MS}. */
const REFRESH_DEADLINE_RESENDS = 1;

/**
 * How long a sign-out waits for the server's revocation before the local sign-out goes on without
 * it. The write class's base: the revocation is a small POST, and the user is watching the button.
 */
export const LOGOUT_DEADLINE_MS = DEADLINE_MS.write;
/** A refresh was answered from that proof since the spell began - so the line is said once a spell. */
let _refreshHeldForNoNetwork = false;

/** Ends a no-network spell: the next refresh is sent and becomes the new proof. */
function endNoNetworkSpell(reason: string): void {
  if (!_noNetworkSpellFailure) return;
  _noNetworkSpellFailure = null;
  _refreshHeldForNoNetwork = false;
  alog(`refresh no-network spell ended (${reason}) - the next refresh is sent`);
}
// Two events end it: the reconnect (the browser's `online`, or any request answered after a
// transport failure) and the app coming back to the foreground, which is where a WebView that
// missed `online` while suspended is caught.
connectivity.onReconnect(() => endNoNetworkSpell('reconnect'));
onAppForegroundChange((foreground) => {
  if (foreground) endNoNetworkSpell('foreground');
});

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

/**
 * A refresh refused or dropped because the USER is signing out (see `_signOutGeneration`).
 *
 * NOT a {@link SessionExpiredError}, deliberately, and not a subtype of it: that type says "the
 * server proved the session dead", and its consumers answer with a logout and a redirect - a SECOND
 * sign-out, the very thing the refusal exists to prevent. Nobody proved anything here: the sign-out
 * already under way IS the outcome, so a consumer stops the work it was doing, quietly, and does
 * nothing else - no logout, no redirect, no retry, no error shown.
 */
export class SignOutInProgressError extends Error {
  constructor(stage: string) {
    super(`refresh ${stage} dropped - a sign-out is in progress`);
    this.name = 'SignOutInProgressError';
  }
}

/**
 * The refresh endpoint ANSWERED, and the answer was not a verdict on the session.
 *
 * THE MIRROR OF {@link SessionExpiredError}, and the pair is the whole point: `_doRefresh` is
 * careful that only 401/403 prove the cookie dead, because a 502 while the backend restarts during
 * a deploy is a hiccup and logging the user out for it costs a full OIDC round trip. That care was
 * spent at the throw and then lost one frame later - the other half arrived as a bare
 * `new Error('Token refresh failed (HTTP 502)')`, and every caller that wanted to know which of
 * the two it held had to read the sentence and find the digits in it.
 *
 * So the status travels as a FIELD. Reaching this variant at all means the server is there and
 * unhappy, which makes it transient by construction - a caller with a retry ladder should climb it.
 */
export class RefreshFailedError extends Error {
  constructor(
    /** The HTTP status the refresh endpoint answered with. Never 401 or 403 - those are the sibling. */
    readonly status: number
  ) {
    super(`Token refresh failed (HTTP ${status})`);
    this.name = 'RefreshFailedError';
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

/**
 * True once the SERVER has proven this client's refresh credential dead, and no new one has arrived.
 *
 * Exported so a caller can decline work the answer makes pointless BEFORE starting it, rather than
 * starting it and reading the refusal. The encryption-PIN prompt is the case that named this: it
 * was mounted, and accepted a correct PIN, on a client whose credential was already known dead -
 * the modal then closed a second later and the user landed on the login gate, having typed a secret
 * for nothing. NEVER LEARN BY FAILING WHAT A FACT COULD HAVE TOLD YOU.
 *
 * Read it only to SKIP something. It is not a logout trigger: the logout is announced from
 * {@link setSessionExpiredHandler} at the moment the latch is set, and a second reaction here would
 * be a second answer to a question already answered.
 */
export function isRefreshCredentialProvenDead(): boolean {
  return _refreshCredentialProvenDead;
}

/** The app's reaction to a sign-out, registered by the app shell; see {@link setSignOutHandler}. */
let _signOutHandler: (() => void) | null = null;

/**
 * Registers what the app must stop when the session is ended on purpose - the live chat session.
 *
 * EVERY SIGN-OUT IN THE APP IS `clearAuth()` THEN `/login` (the dashboard, the navbar, the PIN gate,
 * the platform gate, the identity-split notice, a dead session), and none of them could reach the
 * live session, which is owned by the app shell. So since 2026-04-09 a sign-out ended the session
 * on the SERVER and left it running on the device: `isLoggedIn` true, the socket's foreground resume
 * still armed. On the Mi 9T, 2026-10-14, the resume after the sign-in browser ran BEFORE the OIDC
 * callback had its token, read the dead credential, logged the half-ended session out, and the new
 * sign-in was never unlocked ("Connexion en cours..." for 4 minutes). Announced from here because
 * this is the one function every sign-out already calls, so no exit can forget it.
 *
 * Called FIRST in {@link clearAuth}, synchronously, while the access token still exists: the
 * teardown deregisters a live session's push token with it. The DEVICE's half of ending the push
 * registration is not the handler's - `clearAuth` runs it itself, so it holds with no handler.
 */
export function setSignOutHandler(fn: (() => void) | null): void {
  _signOutHandler = fn;
}

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
    return OIDC_MOBILE_REDIRECT_URI;
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

  // PKCE binds the code MiConnect hands back to the verifier kept here until the redemption, so a
  // code captured on its way back is refused without it. Sent only to a core-service that says it
  // forwards the verifier (`oidcPkce`, read by the login preamble's `refreshAppVersionCheck()`): an
  // older one drops it, and MiConnect refuses a challenged code redeemed without it. A CAPABILITY
  // read before the request, not a fallback - no failed attempt sits behind it.
  const pkce = getAppVersionCheck()?.oidcPkce === true ? await createPkcePair() : null;
  if (pkce) {
    await setOidcEntry(OIDC_VERIFIER_KEY, pkce.verifier, sessionStorage);
    await setOidcEntry(OIDC_CHALLENGED_KEY, 'S256');
  } else {
    // A verifier left by a sign-in that never came back must not ride this unchallenged code:
    // MiConnect refuses a verifier sent for a code issued without a challenge. Its marker goes too.
    await removeOidcEntry(OIDC_VERIFIER_KEY, sessionStorage);
    await removeOidcEntry(OIDC_CHALLENGED_KEY);
  }

  const redirectUri = oidcRedirectUri();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile promo name formation',
    state,
  });
  if (pkce) {
    params.set('code_challenge', pkce.challenge);
    params.set('code_challenge_method', 'S256');
  }

  const authorizePath = `/application/o/authorize/?${params}`;
  const authUrl = options?.flowSlug
    ? `${baseUrl}/if/flow/${options.flowSlug}/?next=${encodeURIComponent(authorizePath)}`
    : `${baseUrl}${authorizePath}`;
  alog(
    `login returnTo=${returnTo} uri=${redirectUri} flow=${options?.flowSlug ?? 'default'} pkce=${pkce ? 'S256' : 'none (server has no oidcPkce)'}`
  );

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
 * Why a MiConnect sign-in failed, when the reason is one the user can act on by starting again.
 * - `verifier-lost`: the code came back to a browsing context that does not hold the PKCE verifier
 *   of the request that produced it (a new tab, a PWA handing off), so it was never posted.
 * - `code-refused`: core-service answered `OIDC_PKCE_REFUSED` or `OIDC_CODE_REFUSED` - MiConnect
 *   would not redeem the code (spent, expired, or a verifier that does not match).
 * The message is already localized; the callback page renders it on `instanceof`, never on its text.
 */
export type OidcSignInFailure = 'verifier-lost' | 'code-refused';

/** A sign-in failure classified where it is known - see {@link OidcSignInFailure}. */
export class OidcSignInError extends Error {
  constructor(readonly failure: OidcSignInFailure) {
    super(failure === 'verifier-lost' ? m.auth_oidc_verifier_lost() : m.auth_oidc_code_refused());
    this.name = 'OidcSignInError';
  }
}

/**
 * Exchange the authorization code received from Authentik for internal tokens.
 * Called from the `/auth/callback` page. Throws {@link OidcSignInError} for a failure the user
 * resolves by signing in again from the start.
 */
export async function handleOidcCallback(
  code: string,
  state: string
): Promise<{ id: string; email: string; displayName: string }> {
  // Counted while it runs, so `accountLiveness` can say a sign-in is in flight (WP-DEL-LOCAL).
  const run = handleOidcCallbackUnderway(code, state);
  _signInsInFlight.add(run);
  try {
    return await run;
  } finally {
    _signInsInFlight.delete(run);
  }
}

/**
 * The OIDC callbacks under way. A sign-in names its account only when it lands, so until then
 * nothing may act on "who is signed in here" - the resumed wipe of a deleted account included.
 */
const _signInsInFlight = new Set<Promise<unknown>>();

/**
 * Whether an account is signed in here, and whether one is about to be - for the resume of an
 * account-deletion wipe (`resumePendingDeletedAccountWipes`), which must never delete what a live
 * session uses. Each answer is read at the moment it is asked.
 *
 * `isLive` IS PROVEN BY A TOKEN, NEVER BY THE SAVED IDENTITY. The saved user (`canari_saved_user`)
 * is a leftover, not a sign-in: a kill between the pending-wipe marker and `clearAuth()` leaves it
 * naming the deleted account, and an answer read from it made the next start drop the marker and keep
 * the data for ever (every offline cold start). Access tokens live in memory only, so one held here
 * landed IN THIS PROCESS - by an OIDC callback or a refresh - and every resume runs in a process
 * started after the deletion was confirmed; the server refuses a refresh for a deleted account, so a
 * token naming it can only come from that subject signing in AGAIN.
 *
 * A TOKEN IS ENOUGH ONLY BECAUSE THE TOKENLESS ENTRIES ARE CLOSED ELSEWHERE: a successful callback
 * drops the marker of a subject the server let back in (`forgetDeletedAccountOnSignIn`, below), so
 * another tab or a later offline start never resumes a wipe over the new account; and every login -
 * the offline unlock is the one with no token - refuses an account deleted here before it opens a
 * store (`isDeletedAccountHere` in `loginImpl`), so no session can re-create what the wipe removes.
 */
export const accountLiveness: AccountLiveness = {
  isLive: (userId) => _accessToken !== null && decodeTokenClaims(_accessToken)?.sub === userId,
  signInInFlight: () => _pendingRefresh !== null || _signInsInFlight.size > 0,
  whenSignInSettled: async () => {
    while (accountLiveness.signInInFlight()) {
      const pending: Promise<unknown>[] = [..._signInsInFlight];
      if (_pendingRefresh) pending.push(_pendingRefresh);
      alog(`deletion wipe waits for ${pending.length} sign-in(s) in flight`);
      await Promise.allSettled(pending);
    }
  },
};

/** The body of {@link handleOidcCallback}, run while it is counted in `_signInsInFlight`. */
async function handleOidcCallbackUnderway(
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
  // Read once and spent: a code can be redeemed once, and so can the proof that goes with it. None is
  // held when the sign-in sent no challenge (a server without `oidcPkce`, or a build before PKCE), and
  // then its code carries no challenge either.
  const challenged = (await getOidcEntry(OIDC_CHALLENGED_KEY)) !== null;
  const codeVerifier = await getOidcEntry(OIDC_VERIFIER_KEY, sessionStorage);
  await removeOidcEntry(OIDC_CHALLENGED_KEY);
  await removeOidcEntry(OIDC_VERIFIER_KEY, sessionStorage);
  alog(
    `callback pkce=${codeVerifier ? 'verifier' : 'none'} challenged=${challenged ? 'yes' : 'no'}`
  );
  if (challenged && !codeVerifier) {
    // The code was issued against a challenge and the verifier stayed in the browsing context that
    // started the sign-in. MiConnect would refuse it whatever core-service does, so it is not posted.
    console.warn('[auth] OIDC callback in a context without the PKCE verifier - not redeemed');
    throw new OidcSignInError('verifier-lost');
  }

  const redirectUri = oidcRedirectUri();
  console.debug('[auth] redirectUri:', redirectUri, 'coreUrl:', coreUrl());

  console.debug('[auth] POSTing to core-service /api/auth/oidc/callback…');
  const res = await fetch(`${coreUrl()}/api/auth/oidc/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // receive HttpOnly cookie
    body: JSON.stringify({
      code,
      redirect_uri: redirectUri,
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    }),
  });
  console.debug('[auth] core-service response status:', res.status);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text || `Authentication failed (${res.status})`;
    let refusal: OidcSignInError | null = null;
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
      } else if (code === 'ACCOUNT_ERASURE_PENDING') {
        // The account was deleted and its erasure is still running on the server: signing in now
        // would recreate it under the same identity (docs/wiki/account-erasure.md).
        console.warn('[auth] sign-in refused: account erasure pending');
        message = m.auth_account_erasure_pending();
      } else if (code === 'USER_ID_INVALID') {
        // The identity provider's subject is not a mintable user id (visible ASCII, no whitespace, no ':' -
        // core-service `users/user-id.ts`): nothing on this device can fix it, only a human can.
        console.error('[auth] sign-in refused: the subject is not a valid user id');
        message = m.auth_user_id_invalid();
      } else if (code === 'ACCOUNT_ERASURE_BLOCKED') {
        // A permanent failure the server could not fix by retrying: only a human finishes it.
        console.warn('[auth] sign-in refused: account erasure blocked');
        message = m.auth_account_erasure_blocked();
      } else if (code === 'OIDC_PKCE_REFUSED' || code === 'OIDC_CODE_REFUSED') {
        // MiConnect would not redeem this code: spent, expired, or its verifier did not match.
        console.warn(`[auth] sign-in refused by MiConnect: ${code}`);
        refusal = new OidcSignInError('code-refused');
      } else if (nested) {
        message = nested;
      }
    } catch {
      console.debug(`[auth] OIDC callback refusal is not JSON (${res.status}), raw text kept`);
    }
    if (refusal) throw refusal;
    throw new Error(message);
  }

  const data = (await res.json()) as SignedInSession;
  await adoptSignedInSession(data, 'miconnect');
  console.debug('[auth] handleOidcCallback complete');
  return data.user;
}

/** What a session-minting route answers: core-service's `issueSession` body. */
export interface SignedInSession {
  access_token: string;
  refresh_token?: string;
  /** MiConnect's id_token, kept for ONE use: the `id_token_hint` of the sign-out. */
  id_token?: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    firstYearOfSchool: number | null;
    avatarMediaId: string | null;
    bio: string | null;
    admin: boolean;
  };
}

/**
 * Adopts a session the server has just MINTED, whichever way the account was proven: a MiConnect
 * callback, or a restore key on a new Android phone (WP-RESTORE-1, docs/wiki/account-restore.md).
 * ONE implementation, so a restored session can never be missing a step a signed-in one takes.
 *
 * `via` decides the one difference: a restore has no MiConnect id_token, by construction (MiConnect
 * was not asked), so the stale one of a previous sign-in is removed WITHOUT the warning that says a
 * server forgot to send it.
 */
async function adoptSignedInSession(
  data: SignedInSession,
  via: 'miconnect' | 'restore'
): Promise<void> {
  console.debug(`[auth] got access_token (${via}), saving user:`, data.user?.id);
  // THE SERVER LET THIS SUBJECT IN, so any erasure of it has completed and this is a new account: a
  // wipe still owed on this device for the deleted one must never reach it (WP-DEL-LOCAL). First,
  // before this session's token or identity exists anywhere another tab's resume could miss.
  forgetDeletedAccountOnSignIn(data.user.id);
  // A NEW SIGN-IN NAMES ITS OWN USER (saved just below), so a split latched for the previous
  // identity is about somebody who is no longer here.
  clearIdentitySplit();
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
  // After the save, so the account it names is already the signed-in one when a reader compares.
  noteSessionAnswered(data.user.id);
  // A NEW SESSION HAS NO RESTORE KEY YET: the marker that says "registered" spoke of the previous
  // session's, so the next start registers one for this one. And this install is past its first
  // start, so it never attempts a restore again.
  forgetRestoreKeyRegistrations();
  markRestoreAttempted();
  if (via === 'miconnect') {
    await rememberMiconnectIdToken(data.id_token);
  } else {
    await removeOidcEntry(OIDC_ID_TOKEN_KEY);
    alog(
      'restored session: no MiConnect id_token, by construction - the sign-out will not end one'
    );
  }
}

/**
 * Adopts the session `POST /api/auth/restore/assertion` minted, counted as a sign-in in flight
 * while it lands (as {@link handleOidcCallback} is), so a resumed deletion wipe waits for it.
 */
export async function adoptRestoredSession(data: SignedInSession): Promise<void> {
  const run = adoptSignedInSession(data, 'restore');
  _signInsInFlight.add(run);
  try {
    await run;
  } finally {
    _signInsInFlight.delete(run);
  }
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
 * Keeps MiConnect's id_token for the sign-out that will end this session (or forgets the previous
 * one when the server sent none).
 *
 * WHY THE CLIENT HOLDS IT. Authentik's end-session REFUSES a `post_logout_redirect_uri` without an
 * `id_token_hint` (`end_session.py`, "id_token_hint required"), and without that redirect the user
 * is stranded on an Authentik page - inside the Custom Tab, on a phone. The sign-out happens days
 * after the sign-in, across reloads, so it is persisted in the same store as the OIDC state.
 *
 * WHY THAT IS NOT AN ACCESS TOKEN IN STORAGE. No Canari service accepts it (they verify their own
 * HS256 JWT) and Authentik reads it only as a logout HINT, expiry ignored. Its claims (sub, name,
 * promo) are what `saveUserLocally` already keeps. What it can do in other hands is sign this user
 * out of MiConnect, which any page can already do by navigating to end-session without a hint.
 */
async function rememberMiconnectIdToken(idToken: string | undefined): Promise<void> {
  if (idToken) {
    await setOidcEntry(OIDC_ID_TOKEN_KEY, idToken);
    return;
  }
  // A sign-in with no id_token is a server that predates it, and its sign-out cannot end MiConnect.
  await removeOidcEntry(OIDC_ID_TOKEN_KEY);
  awarn('login✓ but no id_token in the response - the sign-out will NOT end the MiConnect session');
}

/** What a sign-out the USER chose does with the MiConnect session - see {@link leaveSignedOut}. */
export type MiconnectSignOutPlan =
  /** Web and desktop: the document goes to end-session, which sends it back to `/login`. */
  | { kind: 'navigate-document'; url: string }
  /** Phone apps: end-session runs in the in-app browser the sign-in used, the app goes to `/login`. */
  | { kind: 'in-app-browser'; url: string }
  /** MiConnect is not asked. The Canari sign-out is complete; the MiConnect session is NOT ended. */
  | { kind: 'local-only'; reason: 'not-configured' | 'offline' | 'no-id-token' | 'foreign-issuer' };

/**
 * Decides how a sign-out reaches MiConnect's end-session, from facts already known - never by
 * trying and reading the failure.
 *
 * The endpoint is the id_token's issuer + `end-session/` (Authentik's discovery says the same:
 * `/application/o/<slug>/end-session/`), which names the right provider on every estate without a
 * build variable. An issuer on another origin than `VITE_AUTHENTIK_URL` is refused: the stored
 * token is the only input here that is not the build's own.
 *
 * @param input.webLoginUrl The absolute `/login` of this origin - the web `post_logout_redirect_uri`.
 */
export function planMiconnectSignOut(input: {
  idToken: string | null;
  authentikBase: string;
  mobile: boolean;
  offline: boolean;
  webLoginUrl: string;
}): MiconnectSignOutPlan {
  if (!input.authentikBase) return { kind: 'local-only', reason: 'not-configured' };
  if (input.offline) return { kind: 'local-only', reason: 'offline' };
  if (!input.idToken) return { kind: 'local-only', reason: 'no-id-token' };
  // Read without verifying it: Authentik verifies the hint itself.
  const issuer = decodeTokenClaims(input.idToken)?.iss ?? null;
  let sameOrigin = false;
  try {
    sameOrigin = !!issuer && new URL(issuer).origin === new URL(input.authentikBase).origin;
  } catch (e) {
    awarn(`MiConnect issuer or base URL unparsable: ${String(e)}`);
  }
  if (!issuer || !sameOrigin) return { kind: 'local-only', reason: 'foreign-issuer' };
  const params = new URLSearchParams({
    id_token_hint: input.idToken,
    post_logout_redirect_uri: input.mobile ? OIDC_MOBILE_POST_LOGOUT_URI : input.webLoginUrl,
  });
  const url = `${issuer.replace(/\/+$/, '')}/end-session/?${params}`;
  return input.mobile ? { kind: 'in-app-browser', url } : { kind: 'navigate-document', url };
}

/**
 * Where a sign-out the USER chose goes once `clearAuth()` has run: through MiConnect's end-session,
 * so the next sign-in asks who you are (user decision, 2026-10-14). Before it, signing out of Canari
 * left the MiConnect cookie alive and the next "Se connecter" came straight back as the account that
 * had just left - on the Mi 9T the user could not reach their own account at all.
 *
 * ONLY FOR A SIGN-OUT SOMEBODY ASKED FOR. A dead session (`handleSessionExpired`) and a revoked
 * device go to `/login` directly: nobody chose to leave MiConnect there, and its cookie is what
 * makes the next sign-in one tap.
 *
 * MiConnect is best-effort and NEVER holds the Canari sign-out hostage: `clearAuth` has already
 * revoked the session and dropped the credentials. When MiConnect is not asked (`local-only`), that
 * is said at warn, because the next sign-in on this device may then be answered by the old account.
 * The id_token is taken whatever happens: its lifetime is the Canari session's.
 */
export async function leaveSignedOut(): Promise<void> {
  const idToken = await getOidcEntry(OIDC_ID_TOKEN_KEY);
  await removeOidcEntry(OIDC_ID_TOKEN_KEY);
  const [{ goto }, { resolve }] = await Promise.all([
    import('$app/navigation'),
    import('$app/paths'),
  ]);
  const loginPath = resolve('/login');
  const plan = planMiconnectSignOut({
    idToken,
    authentikBase: authentikUrl(),
    mobile: isMobileTauriRuntime(),
    offline: connectivity.isOffline,
    webLoginUrl: new URL(loginPath, window.location.origin).href,
  });
  if (plan.kind === 'local-only') {
    awarn(
      `signout: MiConnect session NOT ended (${plan.reason}) - the next sign-in on this device may be answered by the account that left`
    );
  } else if (plan.kind === 'navigate-document') {
    alog('signout→MiConnect end-session (document)');
    window.location.href = plan.url;
    return;
  } else {
    try {
      await invoke(customTabsCommand('openCustomTab'), { url: plan.url });
      alog('signout→MiConnect end-session (in-app browser)');
    } catch (e) {
      awarn(
        `signout: MiConnect end-session could not open (${String(e)}) - its session is NOT ended`
      );
    }
  }
  await goto(loginPath, { replaceState: true });
}

/**
 * THE SIGN-OUT A USER CHOSE, from a control they tapped (the navbar, the dashboard row): revoke the
 * session, then leave through MiConnect. One function, so the two controls cannot drift apart.
 *
 * A failure is not swallowed by the `void` a click handler gives it: it is logged as an error and
 * the user is told the sign-out did not finish, so they can retry rather than believe they left.
 */
export async function signOutByChoice(): Promise<void> {
  alog('signout requested by the user');
  try {
    await clearAuth();
    await leaveSignedOut();
  } catch (e) {
    console.error('[auth] sign-out the user chose failed:', e);
    showToast(m.auth_signout_failed());
  }
}

/**
 * Rotate the access token using the HttpOnly refresh cookie.
 * The browser sends the cookie automatically with `credentials: 'include'`.
 *
 * `fetchImpl` is for ONE caller: the root layout's `load`, which hands over `event.fetch`. SvelteKit
 * warns on every navigation when a `load` reaches `window.fetch` (`Loading .../api/auth/refresh
 * using window.fetch`), and a line printed on every navigation is one its reader learns to skip.
 * Both of the warning's reasons are moot here (`ssr = false`), so this buys nothing but the silence -
 * which is the point. Every other caller uses the global `fetch`. A refresh already in flight is
 * joined whatever `fetch` the joiner brought, since the question and its answer are the same.
 */
export async function refresh(fetchImpl: typeof fetch = fetch): Promise<string> {
  // A SIGN-OUT IS REVOKING THIS CREDENTIAL RIGHT NOW: the answer is known, and a 200 racing the
  // revocation would rotate the very session being ended. Nothing is announced - the sign-out IS the
  // outcome - and the caller gets a type of its own, never a dead-session verdict it would act on.
  if (_signOutsUnderway > 0) {
    alog('refresh✗not sent - a sign-out is in progress');
    throw new SignOutInProgressError('request');
  }
  // The server already answered this question about this exact cookie. Repeating the request is a
  // round trip whose result is known, and 119 of them is what one iPhone sent in 45 minutes.
  if (_refreshCredentialProvenDead) {
    alog('refresh✗latched (cookie already proven dead - not asking again)');
    notifySessionExpired();
    throw new SessionExpiredError();
  }
  // A STANDING IDENTITY SPLIT ANSWERS THIS TOO: the credential is alive but belongs to somebody
  // else than the local state, and asking again would rotate it for the same verdict. Only a
  // sign-out changes the answer.
  const split = getIdentitySplit();
  if (split) {
    alog('refresh✗identity split (not asking again until sign-out)');
    throw new IdentitySplitError(split);
  }
  // ONE REFRESH PER NO-NETWORK SPELL, NEVER ZERO. Each caller of `getToken` used to send its own
  // refresh into a dead link: an offline cold start on the Mi 9T (`v1.2.9-alpha.1`, 2026-10-15)
  // logged 23 `refresh✗transport` lines in six seconds, one per request that wanted a token.
  //
  // `navigator.onLine === false` is NOT a proof either way, so it never decides alone: a stale false
  // (WebKitGTK behind a full-tunnel VPN, a WebView that missed the `online` event while suspended)
  // would lock a signed-in user out if it did - no token means no request, and nothing would ever
  // answer to end it. So the FIRST refresh of a spell is sent, and its outcome is the proof: an
  // answer sets reachability and ends the spell; a transport failure, while the browser still says
  // no network, is the fact every later caller is answered from, without a request. The spell ends
  // on the reconnect (the `online` event, or any request answered) and on the app's return to the
  // foreground - events, never a clock.
  if (_noNetworkSpellFailure && connectivity.browserReportsNoNetwork()) {
    if (!_refreshHeldForNoNetwork) {
      _refreshHeldForNoNetwork = true;
      alog(
        'refresh not sent: the browser reports no network and this spell refresh got no answer - held until the reconnect or the foreground'
      );
    }
    throw _noNetworkSpellFailure;
  }
  if (_pendingRefresh) return _pendingRefresh;
  _pendingRefresh = _doRefresh(fetchImpl).finally(() => {
    _pendingRefresh = null;
  });
  return _pendingRefresh;
}

async function _doRefresh(fetchImpl: typeof fetch): Promise<string> {
  // The build doing the asking, carried the way `users/me/announcement` already carries it: as a
  // query parameter, because nothing in a request states a client's version. It is here for the
  // server's REPORT, not for any decision. A refused refresh has causes that only the version tells
  // apart - a client too old to carry its own credential, which is expected and needs nothing, and a
  // client that should have carried one and did not, which is a defect in the store write. A query
  // parameter rather than a second custom header: the header would need its own CORS allowance on
  // four services, and this needs none.
  const endpoint =
    `${coreUrl()}/api/auth/refresh` + `?clientVersion=${encodeURIComponent(getClientAppVersion())}`;
  alog(`refresh→ ${endpoint}`);
  const t0 = Date.now();
  // WHO WAS SIGNED IN WHEN THIS ASKED: a sign-in completing while the request is in flight changes
  // the local identity under it, and the answer is then about the PREVIOUS credential, not a split.
  const localAtStart = currentUserId();
  // WHICH SIGN-OUT THIS ASKED AFTER - see `_signOutGeneration`.
  const signOutsAtStart = _signOutGeneration;
  /** Drops an answer (or a send) that a sign-out started since has made moot. */
  const supersededBySignOut = (stage: string): SignOutInProgressError | null => {
    if (_signOutGeneration === signOutsAtStart) return null;
    alog(`refresh✗${stage} dropped - a sign-out started while it was in flight`);
    return new SignOutInProgressError(stage);
  };

  // On a platform whose WebView can refuse the cookie, the credential is ours to carry. An EMPTY
  // store is not proof of no session though: `tauri://` is also the desktop origin, where the
  // HttpOnly cookie may work perfectly and is invisible to this code by design. So the request is
  // still made - the header is added only when we actually hold a copy, and it is authoritative
  // when present.
  const bodyTransport = usesBodyRefreshTransport();
  const carried = bodyTransport ? await readNativeRefreshToken() : null;
  if (bodyTransport)
    alog(`refresh carries=${carried ? 'stored credential' : 'nothing (cookie only)'}`);
  // The stored credential is read across an await, during which a sign-out may have begun.
  const droppedBeforeSend = supersededBySignOut('request');
  if (droppedBeforeSend) throw droppedBeforeSend;

  // The refresh is the first call of every cold start, so it is also the app's primary
  // connectivity probe. A transport failure here means "no network"; an HTTP status - any status -
  // means the server answered and the session question is decided below. Keeping the two apart is
  // what lets an offline launch unlock instead of being reported as an expired session.
  //
  // UNDER A DEADLINE, like every first-party request: `trackedFetch` bounds the wait for the head
  // (see `REFRESH_DEADLINE_MS` for why that is safe with a rotating token) and tells the
  // connectivity store what happened - an answer is reachability, a transport failure is not, and a
  // deadline expiry counts as a stall. Without it a stalled or captive link held every request of a
  // cold open behind this one for as long as the engine tolerates, minutes.
  //
  // A head that missed its deadline is re-sent ONCE, at once, with the SAME credential - the stored
  // copy where we carry it (`carried` is read once above), the jar's current cookie otherwise (an
  // aborted request delivered no `Set-Cookie`) - inside this shared promise so
  // the single flight holds - see `REFRESH_DEADLINE_MS` for why that can never rotate twice.
  const send = (): Promise<Response> =>
    trackedFetch(
      fetchImpl,
      endpoint,
      {
        method: 'POST',
        // `credentials` still says `include` on every platform: where the cookie works it IS the
        // credential, and where it does not the header carries it and the flag costs nothing.
        credentials: 'include',
        headers: carried ? { [REFRESH_HEADER]: carried } : undefined,
      },
      { requestClass: 'read', deadlineMs: REFRESH_DEADLINE_MS }
    );
  let res: Response;
  try {
    let resends = 0;
    for (;;) {
      try {
        res = await send();
        break;
      } catch (e) {
        if (!(e instanceof RequestDeadlineError) || resends >= REFRESH_DEADLINE_RESENDS) throw e;
        resends++;
        awarn(
          `refresh✗deadline ${Date.now() - t0}ms - re-sent once with the same credential, so a rotation the server made is answered from its grace`
        );
      }
    }
  } catch (e) {
    _accessToken = null;
    clearWsSessionCookie();
    awarn(`refresh✗transport ${Date.now() - t0}ms: ${String(e)}`);
    if (!isTransportFailure(e)) throw e;
    // TYPED AT THE THROW, by `trackedFetch`: a `TransportFailureError` when nothing answered, a
    // `RequestDeadlineError` when the head did not come back in time. Both say "no answer" by their
    // NAME, so no caller of `getToken` reads a raw `TypeError` or a sentence.
    const failure =
      e instanceof TransportFailureError || e instanceof RequestDeadlineError
        ? e
        : new TransportFailureError(e);
    // The proof the spell gate in `refresh` answers later callers from - see there.
    if (connectivity.browserReportsNoNetwork()) _noNetworkSpellFailure = failure;
    throw failure;
  }

  // BEFORE ANY STATUS IS READ: a 200 would re-save the identity and store a rotation, a 401 would
  // latch and announce - each a reaction to a session the user is already ending.
  const droppedAnswer = supersededBySignOut('answer');
  if (droppedAnswer) throw droppedAnswer;

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
    // ...and only when core-service SAID it: an edge's HTML 403 (a WAF ban page, a portal) is a
    // verdict on the network path, never on the credential, so it is transient like a 5xx. Read
    // from Nest's error envelope, not the header alone: an edge can answer in JSON too.
    if ((res.status === 401 || res.status === 403) && (await refusalOrigin(res)) === 'gateway') {
      // The proof, latched: only a new credential can change this answer.
      _refreshCredentialProvenDead = true;
      noteSessionAnswered(null);
      notifySessionExpired();
      throw new SessionExpiredError();
    }
    throw new RefreshFailedError(res.status);
  }

  const data = (await res.json()) as { access_token: string; refresh_token?: string };
  // The body is read across an await too.
  const droppedBody = supersededBySignOut('answer');
  if (droppedBody) throw droppedBody;
  // SUPERSEDED BY A SIGN-IN: the local identity changed while this was in flight (handleOidcCallback
  // saved a different user). The response belongs to the old credential - comparing it to the NEW
  // identity would latch a false split and lock out the person who just signed in, and persisting its
  // rotation would overwrite the new session's credential. It is dropped, and the new token stands.
  if (localAtStart && currentUserId() !== localAtStart && _accessToken) {
    alog('refresh✗superseded by a sign-in as another account - stale answer dropped');
    return _accessToken;
  }
  // WHOSE TOKEN IS THIS? Compared with the local/MLS identity BEFORE it is published anywhere: a
  // token for another account must never reach the socket cookie, or the gateway registers this
  // device's id under it (measured 2026-10-10, see `tokenIdentity.svelte.ts`).
  const identityOk = checkTokenIdentity(data.access_token, currentUserId());
  if (identityOk) {
    _accessToken = data.access_token;
    setWsSessionCookie(data.access_token);
  } else {
    _accessToken = null;
    clearWsSessionCookie();
  }
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
  // AND ACROSS THE TWO WRITES ABOVE: a sign-out begun during them has already dropped the token set
  // above, and what follows (the credential declared alive, the identity restored) must not undo it.
  const droppedAfterWrites = supersededBySignOut('answer');
  if (droppedAfterWrites) throw droppedAfterWrites;
  // The session answered AND rotated, so both the verdict and the latch are void.
  noteRefreshCredentialAlive();

  // The rotation above is persisted whatever the verdict, so the sign-out that follows a split can
  // still revoke the session. Nothing else of a foreign token is applied.
  const split = getIdentitySplit();
  if (!identityOk && split) throw new IdentitySplitError(split);

  // Decode claims from the new JWT and keep reactive state in sync.
  let tokenExp: number | null = null;
  const decoded = decodeTokenClaims(data.access_token);
  if (decoded) {
    setGlobalAdmin(!!decoded.admin);
    tokenExp = decoded.exp ?? null;
    // Restore userId if localStorage was cleared (e.g., Android process kill).
    if (decoded.sub && !currentUserId()) {
      saveUserLocally({ id: decoded.sub, admin: !!decoded.admin });
    }
    // The token is this account's (`identityOk`, or the split above would have thrown): what may
    // start on a token alone - the community listing - may start now.
    if (decoded.sub && identityOk) noteSessionAnswered(decoded.sub);
  }

  const expIn = tokenExp ? tokenExp - Math.floor(Date.now() / 1000) : null;
  alog(`refresh✓ ${Date.now() - t0}ms${expIn !== null ? ` exp=${expIn}s` : ''}`);
  return data.access_token;
}

/** Decode the `exp` claim from a JWT without verifying the signature. */
function jwtExpiresAt(token: string): number | null {
  const exp = decodeTokenClaims(token)?.exp;
  return typeof exp === 'number' ? exp : null;
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
  noteSessionAnswered(decodeTokenClaims(token)?.sub ?? null);
}

/**
 * Logs the user out: clears the in-memory token and WebSocket cookie,
 * calls the backend logout endpoint to revoke the HttpOnly refresh cookie,
 * and erases all locally persisted user data.
 */
export async function clearAuth(): Promise<void> {
  alog('clear');
  // FIRST OF ALL, before the handler: every refresh from here to the end of the revocation is moot -
  // one asked for is not sent, one already in flight drops its answer (`_signOutGeneration`).
  //
  // A COUNT, NOT A FLAG. Two sign-outs can overlap (a double tap, a session expiry during the PIN
  // gate's or the navbar's sign-out), and either may finish first: a flag the first finisher lowered
  // let a refresh be sent while the other was still revoking - and that refresh captured the CURRENT
  // generation, so nothing dropped its answer and it re-saved the user. The refusal holds until the
  // LAST sign-out under way has finished.
  await clearAuthCounted({ revokeServerSession: true });
}

/**
 * Ends THIS TAB's session and forgets its identity, and touches NOTHING shared: no
 * `POST /api/auth/logout`, no cookie flush, no native refresh credential.
 *
 * For a tab told by ANOTHER tab that its account was deleted (`deletedAccountGuards.ts`). The refresh
 * cookie and the native credential are one per origin, not one per tab: the deleting tab already
 * revoked its own session, and by the time the notice arrives that cookie may belong to an account
 * signed in since - a second logout here would end THAT account's session for nothing.
 */
export async function clearAuthLocally(): Promise<void> {
  alog('clear (local only - another tab ended this account)');
  await clearAuthCounted({ revokeServerSession: false });
}

/** Counts one sign-out under way around {@link clearAuthUnderway} - see {@link clearAuth}. */
async function clearAuthCounted(options: { revokeServerSession: boolean }): Promise<void> {
  _signOutGeneration++;
  _signOutsUnderway++;
  try {
    await clearAuthUnderway(options);
  } finally {
    _signOutsUnderway--;
  }
}

/** The body of {@link clearAuth}, run while it is counted in `_signOutsUnderway`. */
async function clearAuthUnderway(options: { revokeServerSession: boolean }): Promise<void> {
  // THE LIVE SESSION ENDS BEFORE ANYTHING IT USES IS GONE - see `setSignOutHandler`. A throw here is
  // a session left running for a signed-out user, so it is accused by name, and the sign-out goes on.
  if (_signOutHandler) {
    try {
      _signOutHandler();
    } catch (e) {
      console.error(`[A] sign-out handler failed - the live session may still be running: ${e}`);
    }
  } else {
    alog('clear with no sign-out handler registered - no live session to end');
  }
  // THE DEVICE STOPS BEING A PUSH DESTINATION FOR THE ACCOUNT THAT LEFT, at EVERY sign-out: with a
  // live session or none, a dead credential, no network, or no registration marker in this tab. Not
  // awaited - it never rejects and logs its own failures, and a deletion it cannot finish stays owed
  // on disk until it does. AFTER the handler, which reads the registration marker synchronously for
  // the server-side deregistration of a live session.
  void endPushRegistration();
  // THE LOCAL IDENTITY GOES NOW, BEFORE THE FIRST AWAIT - never after the revocation below. The
  // handler has just set `isLoggedIn` false, and every unlock trigger in the app shell (the user-id
  // effect, `afterNavigate`) starts the unlock on "a saved user, nobody logged in". Left until the
  // end, that state held for the whole logout round trip: on the Mi 9T (`1.2.9-alpha.7`, 2026-10-17)
  // the "Rester connecte" vault logged the user straight back in, its refresh met the logout and came
  // back 401, and the session-expired path signed out a SECOND time (two `POST /api/auth/logout`,
  // landing on `/login?returnTo=/dashboard`). With no saved user, no unlock starts and a 401 met
  // during the sign-out announces nothing (`notifySessionExpired` is gated on a saved user). The one
  // path that could put the identity BACK - `_doRefresh` restoring it from a token's `sub` - is shut
  // by `_signOutGeneration` above: no refresh is sent now, and none in flight applies its answer.
  clearUserLocally();
  _accessToken = null;
  noteSessionAnswered(null);
  clearWsSessionCookie();
  clearIdentitySplit();
  // Drop persisted message ACKs so a next user on this tab can't ACK the previous user's ids.
  clearPersistedPendingAcks();
  // And a PIN salt asked for a keypad this session will never submit.
  forgetPinSaltAhead('signed out', alog);
  // And the decrypted file the last share out of Canari left in the cache (phone apps).
  void discardSharedOut('signed out');
  // And a share INTO Canari still waiting: it must never land in the account signed in next.
  void eraseIncomingShare('signed out');
  // And the shortcuts Android holds for THIS account - the share sheet's suggestions and the
  // notifications' conversation shortcuts, names and faces the next account must never see.
  void eraseAccountShortcuts('signed out');
  if (!options.revokeServerSession) {
    alog('clear✓ local only - the shared cookie and credential are left to the tab that owns them');
    return;
  }
  // THE RESTORE KEY GOES WITH THE SESSION (WP-RESTORE-1). The server's copy dies with the session
  // row the logout below revokes; this is the platform's copy, so no later backup carries it. And
  // the install is past its first start: a key that a sign-out could not reach the server about
  // must never sign this user straight back in from `/login`. Not in the local-only branch above:
  // the key, like the cookie, is one per app, and that branch touches nothing shared.
  forgetRestoreKeyRegistrations();
  markRestoreAttempted();
  void clearRestoreKey('signed out');
  // Tell the backend to REVOKE the session row - the cookie is the least of it. The credential has
  // to travel the same way it does on a refresh, or the server cannot name the row to delete and a
  // logout on iOS would clear the local copy while leaving the session alive for seven more days.
  //
  // AWAITED, BUT UNDER A DEADLINE. Awaited because a web sign-out navigates the document to
  // MiConnect's end-session next (`leaveSignedOut`), which would abort a request still in flight;
  // bounded because on a stalled link it used to hold the sign-out, with no feedback, for as long as
  // the engine tolerates. Past the deadline the local sign-out goes on - that is what signing out
  // IS - and the line says the server did not revoke, because the session row then lives on.
  const carried = usesBodyRefreshTransport() ? await readNativeRefreshToken() : null;
  const t0 = Date.now();
  try {
    const res = await trackedFetch(
      fetch,
      `${coreUrl()}/api/auth/logout`,
      {
        method: 'POST',
        credentials: 'include',
        headers: carried ? { [REFRESH_HEADER]: carried } : undefined,
      },
      { requestClass: 'write', deadlineMs: LOGOUT_DEADLINE_MS }
    );
    // A status is an answer, but only a 2xx says the row was revoked: a 5xx is the server saying it
    // could not, and the session then lives on exactly as after a deadline.
    if (res.ok) alog(`logout✓${res.status} ${Date.now() - t0}ms`);
    else
      awarn(
        `logout✗${res.status} ${Date.now() - t0}ms - signed out locally, the server did NOT revoke the session`
      );
  } catch (e) {
    awarn(
      `logout✗ ${Date.now() - t0}ms: ${String(e)} - signed out locally, the server did NOT revoke the session`
    );
  }
  // Same reasoning as the rotation: the cookie DELETION must reach disk too, or a process death
  // resurrects a revoked cookie at the next launch.
  await flushAndroidCookies('logout');
  // And the copy we carry ourselves, which no `Set-Cookie` can clear.
  if (usesBodyRefreshTransport()) await clearNativeRefreshToken();
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
