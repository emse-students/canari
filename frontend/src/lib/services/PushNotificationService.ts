/**
 * PushNotificationService.ts
 *
 * Android + iOS push notification management via FCM and Tauri. FCM is the single
 * transport for both platforms: Android receives FCM data messages natively, and
 * FCM relays iOS pushes to APNs (the .p8 APNs key lives in the Firebase console).
 *
 * Flow:
 *  1. `startPushService` is called at startup (after login).
 *  2. `getFcmToken` polls the `get_fcm_token` Rust command (reads fcm_token.txt
 *     written by MainActivity.onCreate or CanariFirebaseMessagingService.onNewToken)
 *     every 500 ms for up to 30 s.
 *  3. The token is sent to the backend, which returns a `pushSecret` stored
 *     in the Android Keystore via `store_push_secret`.
 *
 * On desktop/web, all methods are silent no-ops.
 */

import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { detectRuntimeDeviceOs } from '$lib/mls-client/mlsPlatform';
import { currentUserId } from '$lib/stores/user';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { showConfirm } from '$lib/stores/confirm.svelte';
import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/i18n';
import { CALLS_NATIVE_RING_COMPILED, PUSH_WAKE_DECLARED } from '$lib/features';
import { voipRegistrationField } from '$lib/mobile/voipRegistration';
import { GROUP_CALL_VERSION } from '$lib/utils/callRoomToken';
import { readApiJson } from '$lib/utils/apiJson';
import { isTransportFailure, RefreshFailedError } from '$lib/utils/transportFailure';
import { sendRenewingOn401 } from '$lib/utils/renewOn401';

/** Push gateway platform tag sent to the backend (mirrors the server's PushPlatform). */
type PushPlatform = 'android' | 'ios';

/**
 * Why a registration attempt did not end in a live token on the server.
 *
 * A TYPE rather than a boolean, because the two failures need different reactions and the caller can
 * only tell them apart if the callee states which one it was. `no-token` means the OS never handed
 * this app a push token, so there is nothing to send and no server involved; `rejected` means the
 * token existed and the backend refused it; `secret-not-stored` means the backend answered and the
 * push secret it returned could not be stored here. Reported to the server as-is, and the server prints
 * whatever it is given rather than guessing.
 */
export type PushRegistrationFailure =
  | 'no-token'
  | 'rejected'
  | 'secret-not-stored'
  | 'refused'
  | 'unauthorized';

/**
 * The failures another attempt cannot change, so the retry ladder stops on them at once. `refused`
 * is the server's 4xx ANSWER about the request (a 403, a 400, a 429 - never a 401); `unauthorized`
 * is a 401 the one renewal did not lift, or a session with no token left to renew. A status is an
 * answer: sending the same request again would only repeat it. `rejected` (a 5xx, a transport
 * failure, a renewal nobody answered) and the two device-side failures stay retried.
 */
const FINAL_FAILURES: ReadonlySet<PushRegistrationFailure> = new Set(['refused', 'unauthorized']);

/**
 * Where the registration reads its bearer: the session's CURRENT token for every attempt, and its
 * renewal on a 401. Injected, never imported from the auth store, which imports this module. The
 * one construction that ships is `sessionPushAuth`.
 */
export interface PushAuth {
  /** The token in memory now, renewed first when missing or about to expire (`getToken`). */
  tokenNow: () => Promise<string>;
  /** Renews the access token through the session's single-flight refresh (`refresh`). */
  renew: () => Promise<string>;
}

/**
 * The server ANSWERED the registration with a 4xx other than 401. Typed at the throw so the ladder
 * reads the status as a type and never retries it: the same request would get the same answer.
 */
export class PushRegistrationRefusedError extends Error {
  constructor(readonly status: number) {
    super(`the push registration was refused: HTTP ${status}`);
    this.name = 'PushRegistrationRefusedError';
  }
}

/**
 * The registration has no token the server accepts: a 401 on a token renewed for it, or no session
 * left to renew (a dead credential, a sign-out under way, another account). Not retried, and no
 * gave-up report is sent with it - that report would be refused with the same token.
 */
export class PushRegistrationUnauthorizedError extends Error {
  constructor(why: string, cause?: unknown) {
    super(`the push registration has no accepted token: ${why}`, { cause });
    this.name = 'PushRegistrationUnauthorizedError';
  }
}

/**
 * The session that started this registration ended (a sign-out bumped `pushSessionGeneration`):
 * whatever it would send or store belongs to the account that left. Not a failure of this session -
 * said at info, and recorded nowhere (the record is gated on the same generation).
 */
export class PushRegistrationSupersededError extends Error {
  constructor(where: string) {
    super(`the session that started this push registration ended - ${where}`);
    this.name = 'PushRegistrationSupersededError';
  }
}

/**
 * What a failure to obtain a token becomes. An ALLOWLIST of the failures that say only "no new
 * token now" - a refresh that answered with no token (`RefreshFailedError`) or one nobody answered -
 * which pass as they came and are retried; every other failure is a verdict on the session.
 */
function classifyTokenFailure(error: unknown): unknown {
  if (error instanceof RefreshFailedError || isTransportFailure(error)) return error;
  const name = error instanceof Error ? error.name : typeof error;
  return new PushRegistrationUnauthorizedError(`no session token (${name})`, error);
}

/** The answer of one registration attempt; see {@link PushRegistrationFailure}. */
export type PushRegistrationOutcome = { ok: true } | { ok: false; reason: PushRegistrationFailure };

/**
 * The server answered the registration and its push secret could not be stored on the device.
 * Thrown by the registration itself so the caller classifies by TYPE: the registration does not
 * count (no skip key), and the next attempt re-registers and stores a fresh secret.
 */
export class PushSecretNotStoredError extends Error {
  constructor(cause: unknown) {
    super('the push secret the server returned was not stored', { cause });
    this.name = 'PushSecretNotStoredError';
  }
}

/**
 * What this install's push registration last came to, kept across processes and stated to the
 * delivery service with every `register-device` (`pushOutcomeForReport`), which prints it when it
 * holds no push registration for the device (`[PUSH_MISSING]`).
 *
 * - `registered`: the server answered a registration, or the skip key said one already stood;
 * - a {@link PushRegistrationFailure}: the last attempt's failure;
 * - `deferred`: a sign-out's token deletion is still owed, so nothing may register;
 * - `no-user`: the service started with no signed-in user.
 *
 * Each of these is FINAL for the attempt it ends, and none is ever overwritten by a marker: a phone
 * whose OS gives no token states `no-token` on every `register-device`, including the first one of a
 * process whose ladder is still asking again - the login starts the ladder before the socket opens,
 * and the ladder lasts four minutes, so a marker written over it would have left an unknown state on
 * the server for a known one (review of #3649).
 *
 * With no final outcome since the sign-out, `pushOutcomeForReport` states `in-progress` while THIS
 * process's ladder or a registration runs, `started` when a ladder began in an earlier process and
 * nothing came of it (kept apart, `PUSH_STARTED_STORAGE_KEY`), else `none`.
 *
 * WHY IT IS DURABLE: the branches that end a registration without a request - an `unauthorized`
 * ladder, an owed deletion, a process killed inside the four-minute ladder - leave no trace on the
 * server, and a device in that state looked exactly like one that was never opened (production,
 * 2026-11-15: 25 of 65 `1.6.12` devices held no row and had said nothing). The next authenticated
 * call this device makes anyway carries the evidence; no new request is spent on it.
 */
export type PushOutcomeRecord = 'registered' | PushRegistrationFailure | 'deferred' | 'no-user';

/** localStorage key of {@link PushOutcomeRecord}; cleared at sign-out with the registration. */
export const PUSH_OUTCOME_STORAGE_KEY = 'canari_push_outcome';

/**
 * localStorage key of the `started` marker: a ladder began and no final outcome has been recorded
 * since. Apart from the final outcome so it never erases one; cleared by the next final outcome and
 * at sign-out.
 */
export const PUSH_STARTED_STORAGE_KEY = 'canari_push_started';

/**
 * Bumped by every sign-out (`endPushRegistration`). A ladder captures it when it starts, and one
 * whose generation is gone belongs to an account that left: it records nothing and sends nothing -
 * it was still sleeping between attempts when the next account signed in, and would have written its
 * outcome into that account's state and sent its user id with that account's bearer.
 */
let pushSessionGeneration = 0;

/** The generation whose first ladder is running in this process, or null - see `in-progress`. */
let ladderGeneration: number | null = null;

/**
 * Records this install's latest {@link PushOutcomeRecord} for the session of `generation`; a ladder
 * of a session that ended records nothing. A store that refuses is logged.
 */
function recordPushOutcome(outcome: PushOutcomeRecord, generation: number): void {
  if (generation !== pushSessionGeneration) {
    console.info(`[Push] outcome ${outcome} of a signed-out session not recorded`);
    return;
  }
  try {
    localStorage.setItem(PUSH_OUTCOME_STORAGE_KEY, outcome);
    localStorage.removeItem(PUSH_STARTED_STORAGE_KEY);
  } catch (err) {
    console.warn(`[Push] could not record the registration outcome (${outcome})`, err);
  }
}

/** Marks that a ladder began for the session of `generation`, beside its last final outcome. */
function markLadderStarted(generation: number): void {
  if (generation !== pushSessionGeneration) return;
  try {
    localStorage.setItem(PUSH_STARTED_STORAGE_KEY, '1');
  } catch (err) {
    console.warn('[Push] could not mark the registration as started', err);
  }
}

/** Whether THIS process is registering for the current session (the ladder or one attempt). */
function registeringNow(): boolean {
  return (
    ladderGeneration === pushSessionGeneration ||
    registrationInFlight?.generation === pushSessionGeneration
  );
}

/**
 * The outcome `register-device` states: the last FINAL one since the sign-out whenever there is one,
 * else `in-progress` while this process registers, `started` when an earlier process began a ladder
 * and ended inside it, `none` when nothing started. A store that cannot be read says `unreadable`,
 * never a guess.
 */
export function pushOutcomeForReport(): string {
  try {
    const final = localStorage.getItem(PUSH_OUTCOME_STORAGE_KEY);
    if (final) return final;
    if (registeringNow()) return 'in-progress';
    return localStorage.getItem(PUSH_STARTED_STORAGE_KEY) ? 'started' : 'none';
  } catch (err) {
    console.warn('[Push] could not read the registration outcome', err);
    return 'unreadable';
  }
}

/** The last outcomes registering again cannot change - see {@link reconcilePushRegistration}. */
const NOT_REDRIVEN: ReadonlySet<string> = new Set(['refused', 'no-token']);

/**
 * Where `startPushService` was last started, so the delivery service's answer can drive a
 * registration it owes ({@link reconcilePushRegistration}) without a second copy of these arguments.
 */
let startedWith: { apiBaseUrl: string; auth: PushAuth; deviceId: string } | null = null;

/**
 * Acts on the delivery service's answer to `register-device`: whether it HOLDS a push registration
 * for this device (`push_token`, keyed by the account and the device).
 *
 * THE SERVER'S ROW IS THE FACT, THE SKIP KEY ONLY A LOCAL COPY OF IT. The skip key
 * (`FCM_TOKEN_STORAGE_KEY`) says "this token was registered once in this WebView", and a row can go
 * after that (a terminal send error, a session end, a purge) or never have come (a ladder that ended
 * without a request): the device then skipped, or never retried, for as long as the WebView lived.
 * `register-device` runs at every unlock and every key-package renewal, so this answer re-drives the
 * registration deterministically from the durable state, never from a timer.
 *
 * NOT RE-DRIVEN: a registration already running (`in-progress`), and the two outcomes another
 * attempt cannot change - `refused` (the server's 4xx answer) and `no-token` (the OS gave no token;
 * each process start still asks it again). The server names both in `[PUSH_MISSING]`.
 *
 * `null` - a delivery service that does not say (an older one, or a lookup that failed) - changes
 * nothing.
 */
export function reconcilePushRegistration(serverHolds: boolean | null): void {
  if (serverHolds === null) {
    console.info('[Push] register-device did not say whether a push registration is held');
    return;
  }
  if (serverHolds) return;
  if (!pushPlatform()) return;
  if (registeringNow()) {
    console.info('[Push] no push registration held yet - this process is registering');
    return;
  }
  const last = pushOutcomeForReport();
  if (NOT_REDRIVEN.has(last)) {
    console.info(
      `[Push] no push registration held, last outcome ${last} - an answer, not re-driven`
    );
    return;
  }
  // A FIRST REGISTRATION IS THE ORDINARY CASE, said at info; any other state lost a registration.
  const say = last === 'none' ? console.info : console.warn;
  say(
    `[Push] the delivery service holds no push registration for this device (last outcome: ${last}) - registering again`
  );
  try {
    sessionStorage.removeItem(FCM_TOKEN_STORAGE_KEY);
  } catch (err) {
    console.error(
      '[Push] could not drop the registration skip key - the registration may skip',
      err
    );
  }
  // Not started yet: the start this login owes registers, the skip key being gone.
  if (!startedWith) return;
  const { apiBaseUrl, auth, deviceId } = startedWith;
  void startPushService(apiBaseUrl, auth, deviceId).catch((err) =>
    console.error('[Push] the registration the delivery service owed failed to start', err)
  );
}

/**
 * Asks the native layer WHY there is no token, and falls back to the symptom when it has no answer.
 *
 * `no-token` is the honest limit of what this layer can see, and it is not enough: on iOS it covers
 * APNs never answering at all and APNs answering while FCM refuses, two causes whose fixes are
 * opposite. The native side branches on exactly that distinction already and writes the branch it
 * took, so the report can name the cause instead of making the next reader learn it by shipping a
 * build. Android and desktop have nothing finer to say and keep saying `no-token`.
 */
async function noTokenReason(): Promise<string> {
  if (!isTauriRuntime()) return 'no-token';
  try {
    const diagnostic = await invoke<string | null>('get_push_diagnostic');
    return diagnostic?.trim() || 'no-token';
  } catch (err) {
    console.warn('[Push] get_push_diagnostic unavailable', err);
    return 'no-token';
  }
}

/**
 * What was last REGISTERED, as `<fcm token>|<locale>` - not the token alone.
 *
 * The value is a skip key, never a token to read: it answers "is a fresh registration owed", and
 * the answer stopped depending on the token alone when the language joined what registration
 * carries.
 */
const FCM_TOKEN_STORAGE_KEY = 'canari_fcm_token';
const BACKGROUND_RETRY_ATTEMPTS = 6;
const BACKGROUND_RETRY_DELAY_MS = 5000;

// Prevents repeated attempts when Google Play Services is unavailable.
let pushAttempted = false;

// The registration currently talking to the server, if any, and the session it belongs to - see
// `registerPushToken`.
let registrationInFlight: {
  generation: number;
  promise: Promise<PushRegistrationOutcome>;
} | null = null;

// Whether this process has already told the server that this device has no usable token. Guards the
// report, NOT the attempts: a device keeps trying on every resume, it just stops repeating itself.
let pushUnavailableReported = false;

/**
 * Reads the FCM token via the Rust `get_fcm_token` command (reads fcm_token.txt).
 * Polls every 500 ms for up to 30 s to let MainActivity.onCreate complete
 * the asynchronous Firebase call.
 */
export async function getFcmToken(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const token = await invoke<string | null>('get_fcm_token');
      if (token) return token;
    } catch {
      return null; // Rust command unavailable
    }
    await new Promise<void>((r) => setTimeout(r, 500));
  }
  return null;
}

/**
 * Fetches the FCM token and registers it with the backend.
 *
 * @param registerFn  Callback that sends the token to the backend.
 *                    Signature: (token: string) => Promise<void>
 *                    Example: (t) => apiClient.post('/push/register', { token: t })
 */
export async function registerPushToken(
  registerFn: (token: string) => Promise<void>
): Promise<PushRegistrationOutcome> {
  // ONE REGISTRATION AT A TIME, because each one mints a secret and invalidates the previous one.
  // Login starts this service twice - `sessionAuth` and the root layout's effect, 500 ms apart -
  // and both passed the skip check below before either had recorded its result, so production
  // logged two `[PUSH_REGISTER]` a second apart for one device (2026-10-12). The server then keeps
  // whichever upsert committed last and the device whichever answer it stored last, and nothing
  // ties those two orders together. A second caller joins the attempt in flight instead.
  //
  // ONLY ONE OF THE SAME SESSION IS JOINED: one started before a sign-out belongs to the account
  // that left, ends on its own generation check, and would hand THIS session its failure.
  const generation = pushSessionGeneration;
  if (registrationInFlight?.generation === generation) {
    console.info('[Push] registration already in flight, joining it');
    return registrationInFlight.promise;
  }
  if (registrationInFlight) {
    console.info('[Push] a registration of a signed-out session is in flight - not joined');
  }
  const entry = {
    generation,
    promise: registerPushTokenOnce(registerFn).finally(() => {
      if (registrationInFlight === entry) registrationInFlight = null;
    }),
  };
  registrationInFlight = entry;
  return entry.promise;
}

/** The registration `registerPushToken` serialises. */
async function registerPushTokenOnce(
  registerFn: (token: string) => Promise<void>
): Promise<PushRegistrationOutcome> {
  console.info('[Push] registerPushToken start');
  // getFcmToken() returns immediately if already written, otherwise waits for
  // the canari:fcm-token native event emitted by MainActivity (max 30 s).
  const token = await getFcmToken();
  if (!token) {
    console.warn('[Push] No FCM token available');
    return { ok: false, reason: 'no-token' };
  }

  // SKIP ONLY WHEN NOTHING THE REGISTRATION CARRIES HAS CHANGED, which stopped being the token
  // alone the day the locale joined it. `changeLocale` reloads the document, and sessionStorage
  // survives a reload, so a predicate testing the token would have skipped the one registration
  // that exists to record a language change - leaving the server writing the fallback body in the
  // language the user had just left, for as long as the FCM token lived.
  const identity = `${token}|${getLocale()}`;
  const stored = sessionStorage.getItem(FCM_TOKEN_STORAGE_KEY);
  if (stored === identity) {
    console.info('[Push] Token and locale unchanged, skip backend registration');
    return { ok: true };
  }

  try {
    await registerFn(token);
    sessionStorage.setItem(FCM_TOKEN_STORAGE_KEY, identity);
    console.info('[Push] FCM token registered successfully');
    return { ok: true };
  } catch (err) {
    if (err instanceof PushSecretNotStoredError) {
      console.error('[Push] registration answered but its push secret was not stored', err.cause);
      return { ok: false, reason: 'secret-not-stored' };
    }
    if (err instanceof PushRegistrationRefusedError) {
      console.warn(`[Push] registration refused by the server (HTTP ${err.status}) - not retried`);
      return { ok: false, reason: 'refused' };
    }
    if (err instanceof PushRegistrationSupersededError) {
      console.info(`[Push] ${err.message}`);
      return { ok: false, reason: 'unauthorized' };
    }
    if (err instanceof PushRegistrationUnauthorizedError) {
      console.warn(`[Push] ${err.message} - not retried`, err.cause);
      return { ok: false, reason: 'unauthorized' };
    }
    console.error('[Push] FCM token registration failed', err);
    return { ok: false, reason: 'rejected' };
  }
}

/**
 * Starts the push notification service.
 * Call at application startup (in ChatBackgroundService or hooks.client.ts).
 *
 * @param apiBaseUrl   Backend API base URL (e.g. "https://api.canari.app")
 * @param auth         Where each attempt reads its CURRENT token, and renews it on a 401 - never a
 *                     token captured once: the retry ladder outlives an access token
 * @param deviceId     Unique device identifier
 */
export async function startPushService(
  apiBaseUrl: string,
  auth: PushAuth,
  deviceId: string
): Promise<void> {
  if (!isTauriRuntime()) {
    console.info('[Push] startPushService noop (non-Tauri environment)');
    return; // web: no push
  }

  // FCM covers Android (native FCM) and iOS (FCM relays to APNs). The Rust
  // get_fcm_token command exists on all targets but returns null on desktop, so we
  // early-return there to avoid getFcmToken polling for 30 s on every desktop start.
  //
  // THE OS IS ASKED, NEVER THE USER AGENT. Inside a Tauri build `detectRuntimeDeviceOs` answers
  // with the COMPILE-TIME target; the user-agent test that used to be here read `/iphone|ipad|ipod/`
  // against an iPad WKWebView that calls itself "Macintosh", so an iPad fell through to `null` and
  // this whole service returned as "desktop" - no token, and no report either, because the return is
  // above the reporting path. That is the same defect the login took, at a site its fix did not reach.
  const platform = pushPlatform();
  if (!platform) {
    console.info(`[Push] startPushService noop (${detectRuntimeDeviceOs('desktop')} - no FCM)`);
    return;
  }

  startedWith = { apiBaseUrl, auth, deviceId };
  const generation = pushSessionGeneration;
  const superseded = (): boolean => generation !== pushSessionGeneration;

  const userId = currentUserId();
  if (!userId) {
    console.error('[Push] startPushService aborted: missing currentUserId - nothing registers');
    recordPushOutcome('no-user', generation);
    return;
  }

  // THE TOKEN A SIGN-OUT STILL OWES THE DELETION OF IS NEVER REGISTERED FOR THE NEXT SESSION: the
  // deletion completes first, or nothing registers (see `endPushRegistration`).
  if (!(await completeOwedPushTokenDeletion())) {
    recordPushOutcome('deferred', generation);
    return;
  }

  const registerOnce = async (): Promise<PushRegistrationOutcome> => {
    const outcome = await registerAttempt();
    recordPushOutcome(outcome.ok ? 'registered' : outcome.reason, generation);
    return outcome;
  };

  const registerAttempt = async (): Promise<PushRegistrationOutcome> => {
    return await registerPushToken(async (pushToken) => {
      // PushKit VoIP token (iOS only, WP-C6): written by the native PKPushRegistry callback, which
      // exists only in a binary with the native ring. Sent at registration so CallKit rings from the
      // very first login (later rotations go over the native refresh-token path), and an explicit
      // null from a binary WITHOUT the ring clears a stale one - see `voipRegistrationField`.
      const voipToken =
        platform === 'ios' && CALLS_NATIVE_RING_COMPILED
          ? await invoke<string | null>('get_voip_token').catch((err) => {
              console.warn('[Push] get_voip_token failed - registering without a VoIP token', err);
              return null;
            })
          : null;
      const body = JSON.stringify({
        token: pushToken,
        deviceId,
        platform,
        // The one thing the server cannot know and must not guess: `APNS_FALLBACK_BODY` is the
        // single sentence it still composes, shown when the iOS extension cannot run.
        locale: getLocale(),
        ...voipRegistrationField(platform, CALLS_NATIVE_RING_COMPILED, voipToken),
        // Whether this binary takes a content-free wake-up push ON THIS PLATFORM (iOS declares
        // false until its P1 is closed - see `PUSH_WAKE_DECLARED`); the server writes
        // `push_token.wakeCapable` from it on every registration (false if absent).
        wake: PUSH_WAKE_DECLARED[platform],
        // The group-call protocol this build carries (WP-GC2): the server rings a device for a
        // group call only when it declared one, so a build before group calls is never rung for one.
        groupCallVersion: GROUP_CALL_VERSION,
      });
      const send = async (token: string): Promise<Response> => {
        // NEVER ACCOUNT A's USER ID WITH ACCOUNT B's BEARER: `userId` is the one this ladder started
        // with, the token the session's current one.
        if (superseded()) throw new PushRegistrationSupersededError('nothing sent');
        return await fetch(`${apiBaseUrl}/api/mls/push/register`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'x-user-logged-in': 'true',
            'x-user-id': userId,
          },
          body,
        });
      };
      // THE TOKEN IS READ FOR THIS ATTEMPT, never captured when the service started: the ladder
      // below lasts minutes, and a token captured at its start could expire under it and then be
      // refused on every attempt, the gave-up report included.
      let token: string;
      try {
        token = await auth.tokenNow();
      } catch (err) {
        throw classifyTokenFailure(err);
      }
      // A 401 IS AN ANSWER about the bearer: renewed ONCE and sent again (`renewOn401.ts`, the one
      // copy of that rule); a 401 on the renewed token ends the registration.
      const response = await sendRenewingOn401(send, token, {
        tokenNow: auth.tokenNow,
        renew: auth.renew,
        where: 'POST /api/mls/push/register',
        refusedRenewed: () =>
          new PushRegistrationUnauthorizedError('the token renewed for it was refused too'),
        renewalFailed: (err) => classifyTokenFailure(err),
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        // Any other 4xx is an answer too, and the same request would get it again.
        if (response.status >= 400 && response.status < 500) {
          console.warn(
            `[Push] register answered HTTP ${response.status}${errText ? `: ${errText}` : ''}`
          );
          throw new PushRegistrationRefusedError(response.status);
        }
        throw new Error(`HTTP ${response.status}${errText ? `: ${errText}` : ''}`);
      }
      // A 2xx that is not the API's JSON (a captive portal's page) registered NOTHING: it throws
      // `NotFromApiError`, so this registration fails and is not counted - read as `null`, the
      // token was taken for registered and never sent again until it rotated.
      const data = (await readApiJson(response, 'POST /api/mls/push/register')) as {
        pushSecret?: string;
      } | null;
      const pushSecret: string | undefined = data?.pushSecret;
      // AWAITED, so the secret is stored before this registration counts as finished and the next
      // one may start: two stores in flight could land in either order. A store that failed makes
      // the registration fail too, so it is not counted and the next attempt registers again: the
      // device stays signed out of pushes until a secret is stored (`write_push_secret`).
      // NOT STORED FOR AN ACCOUNT THAT LEFT: an answer to a request sent before the sign-out would
      // otherwise store its secret after the next account's, and the native secret would then not
      // be the one the server holds for that account's row - the two stores in either order above.
      if (superseded()) throw new PushRegistrationSupersededError('its answer is dropped');
      if (pushSecret) {
        try {
          await invoke('store_push_secret', { secret: pushSecret });
        } catch (err) {
          throw new PushSecretNotStoredError(err);
        }
      }
    });
  };

  // Subsequent calls (e.g. returning to foreground): do NOT blindly skip.
  // The FCM token may have rotated while the app was in the background;
  // onNewToken only writes the new token locally without pushing it to the server.
  // Re-check the token here (fast path, no 30 s re-poll, no re-permission prompt);
  // registerPushToken only sends to the backend if the token has actually changed.
  //
  // A FAILURE HERE IS REPORTED, and it used to be thrown away. This path ran on every return to the
  // foreground and DISCARDED the outcome, so once the first call had set `pushAttempted` a device
  // could go on failing for ever without a word - the ladder below is the only thing that ever
  // reported, and it runs once per process. A `no-token` on this path is not a premature verdict:
  // `registerOnce` answers `ok` when the token is merely unchanged, so reaching `no-token` means the
  // OS still had nothing to give after the poll.
  if (pushAttempted) {
    console.info('[Push] startPushService re-check (possible token rotation)');
    const recheck = await registerOnce();
    if (!recheck.ok && superseded()) {
      console.info('[Push] the session that started this re-check ended - nothing reported');
    } else if (!recheck.ok) {
      await reportGaveUp(apiBaseUrl, auth, deviceId, platform, recheck.reason);
    }
    return;
  }

  pushAttempted = true;
  // A marker BESIDE the last final outcome, never over it; cleared by the first attempt's outcome. Read
  // as `started` only when no final outcome exists and this process is not the one registering.
  markLadderStarted(generation);
  ladderGeneration = generation;
  try {
    await runFirstLadder(platform);
  } finally {
    if (ladderGeneration === generation) ladderGeneration = null;
  }

  /** The first registration of this process: the permission, then the attempts, then the report. */
  async function runFirstLadder(platform: PushPlatform): Promise<void> {
    console.info(
      `[Push] startPushService device=${deviceId} (platform will be confirmed by FCM token)`
    );

    // --- ANDROID 13+ NOTIFICATION PERMISSION ---
    //
    // THE RATIONALE IS ACKNOWLEDGED, NEVER TIMED, AND THAT IS THE WHOLE FIX. It used to be a toast
    // shown for 6 s with a 1200 ms sleep after it, and the OS dialog opened on the way through: for
    // the remaining 4,8 s both were on screen at once, and a native permission dialog takes EVERY
    // touch until it is answered. Measured on A1 on 2026-09-14, on the first launch after an install
    // - and it presented in a way worth knowing about, because the WebView stopped repainting while
    // still answering CDP, so the DOM said one thing and the screen showed another. Only a screenshot
    // separated them.
    //
    // A sleep cannot be right here, whatever its length: it is a guess about how fast someone reads,
    // and the thing it is racing is a dialog this code opens itself. So the two are SEQUENCED by the
    // one event that proves the first is finished - the user dismissing it. Declining is a real
    // answer and it is honoured: Android gives an app very few chances to ask, and spending one on a
    // user who just said "later" wastes it for good.
    try {
      let permissionGranted = await isPermissionGranted();
      if (!permissionGranted) {
        const askNow = await showConfirm(m.push_permission_rationale(), {
          confirmLabel: m.push_permission_enable_button(),
          cancelLabel: m.push_permission_later_button(),
        });
        if (askNow) {
          const permission = await requestPermission();
          permissionGranted = permission === 'granted';
        } else {
          console.info('[Push] rationale declined - the OS permission dialog was not opened');
        }
      }

      if (!permissionGranted) {
        console.warn(
          '[Push] Notification permission denied. Pop-up display will be blocked by Android.'
        );
        // Continue anyway: FCM can still receive silent data messages (background sync).
      }
    } catch (err) {
      console.warn('[Push] Cannot check/request notification permission', err);
    }
    // --------------------------------------

    let outcome = await registerOnce();
    if (outcome.ok) return;

    // Fallback: token generation can be delayed on some Android devices.
    for (let i = 0; i < BACKGROUND_RETRY_ATTEMPTS; i++) {
      if (FINAL_FAILURES.has(outcome.reason)) {
        console.warn(`[Push] registration ${outcome.reason} - an answer, so no retry`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, BACKGROUND_RETRY_DELAY_MS));
      if (superseded()) {
        console.info('[Push] the session that started this registration ended - ladder stopped');
        return;
      }
      outcome = await registerOnce();
      if (outcome.ok) return;
    }

    console.warn(`[Push] startPushService ended without a registration (${outcome.reason})`);
    // THE FAILURE IS REPORTED HERE AND NOWHERE EARLIER ON THIS PATH. Every attempt above can fail for
    // a reason the next one fixes - that is what the retries are for - so reporting one of those would
    // file a defect against a device that goes on to work. Reaching this line means the device has
    // given up and every notification for it is now silently lost, which is exactly the state that had
    // gone unnoticed on iOS for the platform's whole life.
    //
    // WHAT THIS COSTS, STATED SO IT IS NOT REDISCOVERED AS A MYSTERY: the ladder spends up to
    // 30 s + BACKGROUND_RETRY_ATTEMPTS * (BACKGROUND_RETRY_DELAY_MS + 30 s) - four minutes with the
    // current constants - before the report is even attempted, because each `registerOnce` polls
    // `getFcmToken` for 30 s. An app closed or backgrounded inside that window reports nothing, and
    // that is a real reason for a silent device. The retries are not a clock this design leans on, so
    // they are not shortened here on a hunch: the window is written down, and shortening it needs a
    // measurement of how long a token really takes to appear on a slow Android.
    if (superseded()) {
      console.info('[Push] the session that started this registration ended - nothing reported');
      return;
    }
    await reportGaveUp(apiBaseUrl, auth, deviceId, platform, outcome.reason);
  }
}

/**
 * Files the "this device has no usable push token" report, at most once per process.
 *
 * Best-effort by construction: a device that cannot reach the network cannot report that it cannot
 * reach the network, and failing to file the report must never be louder than the thing being
 * reported. The once-per-process guard is what keeps a foreground re-check from filing the same
 * verdict on every resume; it is deliberately NOT durable, because the question the report answers
 * ("is this device silent right now") is answered afresh by each process.
 */
async function reportGaveUp(
  apiBaseUrl: string,
  auth: PushAuth,
  deviceId: string,
  platform: PushPlatform,
  reason: PushRegistrationFailure
): Promise<void> {
  // NOT SENT WITHOUT A TOKEN THE SERVER TAKES: the registration just learned that this session has
  // none, and the report would be refused with the same bearer - a request whose answer is known.
  // NOT SILENT EITHER: the outcome is recorded (`recordPushOutcome`), and the next `register-device`
  // states it, where the server prints `[PUSH_MISSING] ... last=unauthorized` and answers that it
  // holds no registration - which drives the next attempt (`reconcilePushRegistration`).
  if (reason === 'unauthorized') {
    console.error(
      '[Push] gave up with no accepted token - no registration; the next register-device reports it'
    );
    return;
  }
  if (pushUnavailableReported) {
    console.info('[Push] still unavailable, already reported once this process');
    return;
  }
  let bearerToken: string;
  try {
    bearerToken = await auth.tokenNow();
  } catch (err) {
    console.warn(`[Push] cannot report unavailable (${reason}): no session token`, err);
    return;
  }
  pushUnavailableReported = true;
  const named = reason === 'no-token' ? await noTokenReason() : reason;
  await reportPushUnavailable(apiBaseUrl, bearerToken, deviceId, platform, named);
}

/**
 * Tells the backend that this device has no usable push token.
 *
 * Sends no token and stores nothing: the server logs it. See the endpoint's own comment in
 * `apps/chat-delivery-service/src/controllers/push.controller.ts` for why the absence of a row could
 * not answer this question by itself.
 */
async function reportPushUnavailable(
  apiBaseUrl: string,
  bearerToken: string,
  deviceId: string,
  platform: PushPlatform,
  reason: string
): Promise<void> {
  const userId = currentUserId();
  if (!userId) {
    // Every swallowed branch logs: this one used to return in silence, which made a dropped report
    // indistinguishable from a report that was never owed - the exact confusion this endpoint exists
    // to end.
    console.warn(`[Push] cannot report unavailable (${reason}): no currentUserId`);
    return;
  }
  try {
    const response = await fetch(`${apiBaseUrl}/api/mls/push/unavailable`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearerToken}`,
        'x-user-logged-in': 'true',
        'x-user-id': userId,
      },
      body: JSON.stringify({ deviceId, platform, reason }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.info(`[Push] reported unavailable (${reason})`);
  } catch (err) {
    console.warn('[Push] could not report the missing push token', err);
  }
}

/**
 * Ends THIS DEVICE's push registration at a sign-out - every sign-out, whatever the server said.
 *
 * The server half (`/api/auth/logout` and every revocation end the device's `push_token` row) and
 * this half each stand alone, so neither depends on the other being reached: here the OS push token
 * is deleted natively, the push secret erased, and the native push context reduced to the device's
 * identity, so a push still in flight is dropped rather than shown as the account that left
 * (`src-tauri/src/commands/push_registration.rs`). Runs with the session already dead, with the
 * network refusing, and with no registration marker in this tab - none of those is a reason to stay
 * a destination.
 *
 * A deletion that cannot complete now (offline) stays OWED in a durable mark on disk, and is
 * completed before anything registers again ({@link startPushService}). That is logged as an error,
 * since until then FCM may still hold this install's token.
 *
 * Never rejects: a sign-out does not wait on it to go on, and every failure is logged here.
 */
export async function endPushRegistration(): Promise<void> {
  // The skip key describes the registration that just ended; left, the next sign-in in this tab
  // would compare a fresh token against it instead of registering.
  try {
    sessionStorage.removeItem(FCM_TOKEN_STORAGE_KEY);
  } catch (err) {
    console.error('[Push] could not forget the registration skip key at sign-out', err);
  }
  // The outcome is the session's: the next account starts at `none`, and a registration this
  // sign-out ends is never stated as `registered` for a device the server no longer holds.
  try {
    localStorage.removeItem(PUSH_OUTCOME_STORAGE_KEY);
    localStorage.removeItem(PUSH_STARTED_STORAGE_KEY);
  } catch (err) {
    console.error('[Push] could not forget the registration outcome at sign-out', err);
  }
  startedWith = null;
  // Every ladder of the session that ended stops recording and sending (`pushSessionGeneration`),
  // and the next account starts its own ladder - permission, attempts, report - not a re-check.
  pushSessionGeneration++;
  ladderGeneration = null;
  pushAttempted = false;
  const platform = pushPlatform();
  if (!platform) {
    console.info('[Push] endPushRegistration noop (no push registration on this platform)');
    return;
  }
  try {
    const deleted = await invoke<boolean>('end_push_registration');
    if (deleted) {
      console.info(`[Push] sign-out ended this device's push registration (${platform})`);
    } else {
      console.error(
        `[Push] sign-out could not delete the ${platform} push token now - the deletion is OWED and completes before the next registration`
      );
    }
  } catch (err) {
    console.error(
      '[Push] sign-out did not end every part of the push registration - see the native log',
      err
    );
  }
}

/**
 * Completes a token deletion a previous sign-out left owed, and answers whether registering is
 * allowed now. `false` means the deletion is still owed (logged natively and here): registering
 * would publish the token of the account that left for the next one.
 */
async function completeOwedPushTokenDeletion(): Promise<boolean> {
  try {
    const done = await invoke<boolean>('complete_owed_push_token_deletion');
    if (!done) {
      console.error(
        '[Push] registration deferred - the token deletion a sign-out owes did not complete'
      );
    }
    return done;
  } catch (err) {
    console.error('[Push] registration deferred - the owed token deletion could not run', err);
    return false;
  }
}

/** The push platform this runtime registers on, or null where there is no push registration. */
function pushPlatform(): PushPlatform | null {
  if (!isTauriRuntime()) return null;
  const deviceOs = detectRuntimeDeviceOs('desktop');
  return deviceOs === 'android' ? 'android' : deviceOs === 'ios' ? 'ios' : null;
}

/**
 * How long a sign-out waits for the server's push deregistration. SHORT ON PURPOSE: it runs BEFORE
 * the revocation and blocks it, so on a stalled link it adds to the revocation's own deadline - the
 * server ends the device's token with the session anyway, so this call is not worth a long wait.
 */
export const PUSH_DEREGISTRATION_DEADLINE_MS = 6_000;

/**
 * Deregisters this device's push token on the SERVER while the session's credential is still valid.
 * A sign-out AWAITS this before it revokes the session (`clearAuth`): fired concurrently, the
 * revocation could land first and the call came back `HTTP 401` (Mi 9T, `1.6.7-alpha.3`). Never
 * rejects; every failure is logged here and none blocks the sign-out.
 */
export async function stopPushService(
  apiBaseUrl: string,
  bearerToken: string,
  deviceId: string
): Promise<void> {
  if (!isTauriRuntime()) {
    console.info('[Push] stopPushService noop (non-Tauri environment)');
    return;
  }

  // Presence only - the value is a token AND a locale since the language joined the registration,
  // and this path never reads the token itself (the unregister route takes the deviceId).
  const registered = sessionStorage.getItem(FCM_TOKEN_STORAGE_KEY);
  if (!registered) {
    console.info('[Push] stopPushService noop (no registered token)');
    return;
  }

  console.info(`[Push] stopPushService device=${deviceId}`);

  let response: Response;
  try {
    // A PLAIN `fetch` UNDER ITS OWN SIGNAL, not `trackedFetch`: that one reports a deadline expiry to the
    // connectivity store, and two consecutive expiries mark the server unreachable - a sign-out's
    // deregistration timing out is not evidence about the link (`trackedFetch` has no opt-out).
    response = await fetch(
      `${apiBaseUrl}/api/mls/push/unregister/${encodeURIComponent(deviceId)}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          'x-user-logged-in': 'true',
          // READ SYNCHRONOUSLY, AND IT RELIES ON CALL ORDER: at a sign-out this runs from the handler
          // `clearAuth` calls FIRST, and nothing above awaits, so the identity is still saved here.
          // `clearAuth` drops it on its next line - an `await` added above this read would send ''.
          'x-user-id': currentUserId() ?? '',
        },
        signal: AbortSignal.timeout(PUSH_DEREGISTRATION_DEADLINE_MS),
      }
    );
  } catch (err) {
    // A TRANSPORT FAILURE OR THE DEADLINE, never a status (a status is an answer, handled below). It
    // does not block the sign-out; it is said by what it leaves behind.
    console.warn(
      `[Push] FCM token deregistration got no answer - the server still lists device ${deviceId} as a push destination until the session's revocation ends it`,
      err
    );
    return;
  }
  if (!response.ok) {
    console.error(
      `[Push] FCM token deregistration refused: HTTP ${response.status} - the server still lists device ${deviceId} as a push destination`
    );
    return;
  }
  sessionStorage.removeItem(FCM_TOKEN_STORAGE_KEY);
}
