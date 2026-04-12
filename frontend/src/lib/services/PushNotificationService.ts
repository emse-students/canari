/**
 * PushNotificationService.ts
 *
 * Gestion des notifications push (FCM/APNs) sur Android et iOS via Tauri.
 *
 * Flux :
 *  1. Au démarrage, détecte la plateforme (Android / iOS / desktop)
 *  2. Lit le token push via la commande Rust `get_fcm_token`
 *     – Android : token FCM lu depuis les SharedPreferences Kotlin
 *     – iOS     : token APNs/FCM lu depuis UserDefaults Swift (à implémenter)
 *  3. Envoie le token au backend Canari avec la plateforme correcte
 *
 * Sur desktop/web, les méthodes sont des no-op silencieux.
 */

import { isTauri } from '@tauri-apps/api/core';
import { invoke } from '@tauri-apps/api/core';
import { currentUserId } from '$lib/stores/user';

const FCM_TOKEN_STORAGE_KEY = 'canari_fcm_token';
const TOKEN_POLL_RETRIES = 20;
const TOKEN_POLL_DELAY_MS = 1000;
const BACKGROUND_RETRY_ATTEMPTS = 6;
const BACKGROUND_RETRY_DELAY_MS = 5000;

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return isTauri() || !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

/**
 * Lit le token push depuis la couche Rust (Android/iOS uniquement).
 * – Android : token FCM depuis les SharedPreferences Kotlin
 * – iOS     : token FCM/APNs depuis les UserDefaults Swift
 * Retourne null hors mobile ou si le token n'est pas encore disponible.
 */
export async function getFcmToken(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  try {
    const token = await invoke<string | null>('get_fcm_token');
    return token ?? null;
  } catch {
    return null;
  }
}

/**
 * Récupère le token FCM et l'enregistre auprès du backend.
 *
 * @param registerFn  Callback qui envoie le token au backend.
 *                    Signature : (token: string) => Promise<void>
 *                    Exemple : (t) => apiClient.post('/push/register', { token: t })
 */
export async function registerPushToken(
  registerFn: (token: string) => Promise<void>
): Promise<boolean> {
  console.info('[Push] registerPushToken start');
  // On Android, the FCM service may provide the token a bit after startup.
  let token: string | null = null;
  for (let i = 0; i < TOKEN_POLL_RETRIES; i++) {
    token = await getFcmToken();
    console.info(
      `[Push] token poll attempt ${i + 1}/${TOKEN_POLL_RETRIES}: ${token ? 'received' : 'empty'}`
    );
    if (token) break;
    if (i < TOKEN_POLL_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, TOKEN_POLL_DELAY_MS));
    }
  }
  if (!token) {
    console.warn('[Push] No FCM token available after polling');
    return false;
  }

  // Évite de ré-enregistrer le même token inutilement
  const stored = sessionStorage.getItem(FCM_TOKEN_STORAGE_KEY);
  if (stored === token) {
    console.info('[Push] Token unchanged, skip backend registration');
    return true;
  }

  try {
    await registerFn(token);
    sessionStorage.setItem(FCM_TOKEN_STORAGE_KEY, token);
    console.info('[Push] Token FCM enregistré avec succès');
    return true;
  } catch (err) {
    console.error('[Push] Échec enregistrement du token FCM', err);
    return false;
  }
}

/**
 * Démarre le service push.
 * À appeler au démarrage de l'application (dans ChatBackgroundService ou hooks.client.ts).
 *
 * @param apiBaseUrl   URL de base de l'API backend (ex: "https://api.canari.app")
 * @param authToken    Token d'authentification pour l'API
 * @param deviceId     Identifiant unique de l'appareil
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

  console.info(
    `[Push] startPushService device=${deviceId} (platform will be confirmed by FCM token)`
  );

  const userId = currentUserId();
  if (!userId) {
    console.warn('[Push] startPushService aborted: missing currentUserId');
    return;
  }

  const registerOnce = async (): Promise<boolean> => {
    return await registerPushToken(async (pushToken) => {
      const response = await fetch(`${apiBaseUrl}/api/mls-api/push/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearerToken}`,
          'x-user-logged-in': 'true',
          'x-user-id': userId,
        },
        body: JSON.stringify({ token: pushToken, deviceId, platform: 'android' }),
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${errText ? `: ${errText}` : ''}`);
      }
    });
  };

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
      `${apiBaseUrl}/api/mls-api/push/unregister/${encodeURIComponent(deviceId)}`,
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
    console.error('[Push] Échec désenregistrement du token FCM', err);
  }
}
