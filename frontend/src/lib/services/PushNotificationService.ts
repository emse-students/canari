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
import { currentUserId } from '$lib/stores/user';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { showToast } from '$lib/stores/toast.svelte';

/** Push gateway platform tag sent to the backend (mirrors the server's PushPlatform). */
type PushPlatform = 'android' | 'ios';

const FCM_TOKEN_STORAGE_KEY = 'canari_fcm_token';
const BACKGROUND_RETRY_ATTEMPTS = 6;
const BACKGROUND_RETRY_DELAY_MS = 5000;

// Prevents repeated attempts when Google Play Services is unavailable.
let pushAttempted = false;

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
): Promise<boolean> {
  console.info('[Push] registerPushToken start');
  // getFcmToken() returns immediately if already written, otherwise waits for
  // the canari:fcm-token native event emitted by MainActivity (max 30 s).
  const token = await getFcmToken();
  if (!token) {
    console.warn('[Push] No FCM token available');
    return false;
  }

  // Skip backend registration when the token has not changed.
  const stored = sessionStorage.getItem(FCM_TOKEN_STORAGE_KEY);
  if (stored === token) {
    console.info('[Push] Token unchanged, skip backend registration');
    return true;
  }

  try {
    await registerFn(token);
    sessionStorage.setItem(FCM_TOKEN_STORAGE_KEY, token);
    console.info('[Push] FCM token registered successfully');
    return true;
  } catch (err) {
    console.error('[Push] FCM token registration failed', err);
    return false;
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
    return; // web : pas de push
  }

  // FCM covers Android (native FCM) and iOS (FCM relays to APNs). The Rust
  // get_fcm_token command exists on all targets but returns null on desktop, so we
  // early-return there to avoid getFcmToken polling for 30 s on every desktop start.
  const ua = navigator.userAgent;
  const platform: PushPlatform | null = /android/i.test(ua)
    ? 'android'
    : /iphone|ipad|ipod/i.test(ua)
      ? 'ios'
      : null;
  if (!platform) {
    console.info('[Push] startPushService noop (desktop - no FCM)');
    return;
  }

  const userId = currentUserId();
  if (!userId) {
    console.warn('[Push] startPushService aborted: missing currentUserId');
    return;
  }

  const registerOnce = async (): Promise<boolean> => {
    return await registerPushToken(async (pushToken) => {
      const response = await fetch(`${apiBaseUrl}/api/mls/push/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearerToken}`,
          'x-user-logged-in': 'true',
          'x-user-id': userId,
        },
        body: JSON.stringify({ token: pushToken, deviceId, platform }),
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
  if (pushAttempted) {
    console.info('[Push] startPushService re-check (possible token rotation)');
    await registerOnce();
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
      showToast(
        'Enable notifications to be notified of new messages, even when the app is closed.',
        'info',
        6000
      );
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

  const immediateOk = await registerOnce();
  if (immediateOk) return;

  // Fallback: token generation can be delayed on some Android devices.
  for (let i = 0; i < BACKGROUND_RETRY_ATTEMPTS; i++) {
    await new Promise((resolve) => setTimeout(resolve, BACKGROUND_RETRY_DELAY_MS));
    const ok = await registerOnce();
    if (ok) return;
  }

  console.warn('[Push] startPushService exhausted retries without successful registration');
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
