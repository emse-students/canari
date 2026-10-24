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
import { CALLS_NATIVE_RING_COMPILED } from '$lib/features';
import { voipRegistrationField } from '$lib/mobile/voipRegistration';

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
export type PushRegistrationFailure = 'no-token' | 'rejected' | 'secret-not-stored';

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

// The registration currently talking to the server, if any - see `registerPushToken`.
let registrationInFlight: Promise<PushRegistrationOutcome> | null = null;

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
  if (registrationInFlight) {
    console.info('[Push] registration already in flight, joining it');
    return registrationInFlight;
  }
  registrationInFlight = registerPushTokenOnce(registerFn).finally(() => {
    registrationInFlight = null;
  });
  return registrationInFlight;
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
    console.error('[Push] FCM token registration failed', err);
    return { ok: false, reason: 'rejected' };
  }
}

/**
 * Starts the push notification service.
 * Call at application startup (in ChatBackgroundService or hooks.client.ts).
 *
 * @param apiBaseUrl   Backend API base URL (e.g. "https://api.canari.app")
 * @param authToken    Authentication token for the API
 * @param deviceId     Unique device identifier
 */
export async function startPushService(
  apiBaseUrl: string,
  bearerToken: string,
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

  const userId = currentUserId();
  if (!userId) {
    console.warn('[Push] startPushService aborted: missing currentUserId');
    return;
  }

  // THE TOKEN A SIGN-OUT STILL OWES THE DELETION OF IS NEVER REGISTERED FOR THE NEXT SESSION: the
  // deletion completes first, or nothing registers (see `endPushRegistration`).
  if (!(await completeOwedPushTokenDeletion())) return;

  const registerOnce = async (): Promise<PushRegistrationOutcome> => {
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
      const response = await fetch(`${apiBaseUrl}/api/mls/push/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearerToken}`,
          'x-user-logged-in': 'true',
          'x-user-id': userId,
        },
        body: JSON.stringify({
          token: pushToken,
          deviceId,
          platform,
          // The one thing the server cannot know and must not guess: `APNS_FALLBACK_BODY` is the
          // single sentence it still composes, shown when the iOS extension cannot run.
          locale: getLocale(),
          ...voipRegistrationField(platform, CALLS_NATIVE_RING_COMPILED, voipToken),
        }),
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${errText ? `: ${errText}` : ''}`);
      }
      const data = await response.json().catch(() => null);
      const pushSecret: string | undefined = data?.pushSecret;
      // AWAITED, so the secret is stored before this registration counts as finished and the next
      // one may start: two stores in flight could land in either order. A store that failed makes
      // the registration fail too, so it is not counted and the next attempt registers again: the
      // device stays signed out of pushes until a secret is stored (`write_push_secret`).
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
    if (!recheck.ok) {
      await reportGaveUp(apiBaseUrl, bearerToken, deviceId, platform, recheck.reason);
    }
    return;
  }

  pushAttempted = true;

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
    await new Promise((resolve) => setTimeout(resolve, BACKGROUND_RETRY_DELAY_MS));
    outcome = await registerOnce();
    if (outcome.ok) return;
  }

  console.warn('[Push] startPushService exhausted retries without successful registration');
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
  await reportGaveUp(apiBaseUrl, bearerToken, deviceId, platform, outcome.reason);
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
  bearerToken: string,
  deviceId: string,
  platform: PushPlatform,
  reason: PushRegistrationFailure
): Promise<void> {
  if (pushUnavailableReported) {
    console.info('[Push] still unavailable, already reported once this process');
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

  try {
    const response = await fetch(
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
      }
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    sessionStorage.removeItem(FCM_TOKEN_STORAGE_KEY);
  } catch (err) {
    console.error('[Push] FCM token deregistration failed', err);
  }
}
