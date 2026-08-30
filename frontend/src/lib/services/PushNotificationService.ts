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
import { showToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';

/** Push gateway platform tag sent to the backend (mirrors the server's PushPlatform). */
type PushPlatform = 'android' | 'ios';

/**
 * Why a registration attempt did not end in a live token on the server.
 *
 * A TYPE rather than a boolean, because the two failures need different reactions and the caller can
 * only tell them apart if the callee states which one it was. `no-token` means the OS never handed
 * this app a push token, so there is nothing to send and no server involved; `rejected` means the
 * token existed and the backend refused it. Reported to the server as-is, and the server prints
 * whatever it is given rather than guessing.
 */
export type PushRegistrationOutcome = { ok: true } | { ok: false; reason: 'no-token' | 'rejected' };

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

const FCM_TOKEN_STORAGE_KEY = 'canari_fcm_token';
const BACKGROUND_RETRY_ATTEMPTS = 6;
const BACKGROUND_RETRY_DELAY_MS = 5000;

// Prevents repeated attempts when Google Play Services is unavailable.
let pushAttempted = false;

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
  console.info('[Push] registerPushToken start');
  // getFcmToken() returns immediately if already written, otherwise waits for
  // the canari:fcm-token native event emitted by MainActivity (max 30 s).
  const token = await getFcmToken();
  if (!token) {
    console.warn('[Push] No FCM token available');
    return { ok: false, reason: 'no-token' };
  }

  // Skip backend registration when the token has not changed.
  const stored = sessionStorage.getItem(FCM_TOKEN_STORAGE_KEY);
  if (stored === token) {
    console.info('[Push] Token unchanged, skip backend registration');
    return { ok: true };
  }

  try {
    await registerFn(token);
    sessionStorage.setItem(FCM_TOKEN_STORAGE_KEY, token);
    console.info('[Push] FCM token registered successfully');
    return { ok: true };
  } catch (err) {
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
  const deviceOs = detectRuntimeDeviceOs('desktop');
  const platform: PushPlatform | null =
    deviceOs === 'android' ? 'android' : deviceOs === 'ios' ? 'ios' : null;
  if (!platform) {
    console.info(`[Push] startPushService noop (${deviceOs} - no FCM)`);
    return;
  }

  const userId = currentUserId();
  if (!userId) {
    console.warn('[Push] startPushService aborted: missing currentUserId');
    return;
  }

  const registerOnce = async (): Promise<PushRegistrationOutcome> => {
    return await registerPushToken(async (pushToken) => {
      // PushKit VoIP token (iOS only, WP-XP-5): written by the native PKPushRegistry callback.
      // Included at registration so CallKit rings work from the very first login; later
      // rotations are pushed by the native refresh-token path.
      const voipToken =
        platform === 'ios' ? await invoke<string | null>('get_voip_token').catch(() => null) : null;
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
          ...(voipToken ? { voipToken } : {}),
        }),
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${errText ? `: ${errText}` : ''}`);
      }
      const data = await response.json().catch(() => null);
      const pushSecret: string | undefined = data?.pushSecret;
      if (pushSecret) {
        invoke('store_push_secret', { secret: pushSecret }).catch((err) =>
          console.warn('[Push] Failed to store push secret', err)
        );
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
  try {
    let permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      // Show context before the system dialog (avoids a "cold" permission request).
      // Short delay to let the user read the toast before the dialog opens.
      showToast(m.push_permission_rationale(), 'info', 6000);
      await new Promise((r) => setTimeout(r, 1200));
      const permission = await requestPermission();
      permissionGranted = permission === 'granted';
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
  reason: 'no-token' | 'rejected'
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

export async function stopPushService(
  apiBaseUrl: string,
  bearerToken: string,
  deviceId: string
): Promise<void> {
  if (!isTauriRuntime()) {
    console.info('[Push] stopPushService noop (non-Tauri environment)');
    return;
  }

  const cachedToken = sessionStorage.getItem(FCM_TOKEN_STORAGE_KEY);
  if (!cachedToken) {
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
