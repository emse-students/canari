/**
 * PushNotificationService.ts
 *
 * Gestion des notifications push FCM sur Android via Tauri.
 *
 * Flux :
 *  1. `startPushService` est appelé au démarrage (après login).
 *  2. `getFcmToken` interroge la commande Rust `get_fcm_token` (lit fcm_token.txt
 *     écrit par MainActivity.onCreate ou CanariFirebaseMessagingService.onNewToken)
 *     avec des tentatives toutes les 500 ms pendant 30 s max.
 *  3. Le token est envoyé au backend qui retourne un `pushSecret` stocké
 *     dans le Keystore Android via `store_push_secret`.
 *
 * Sur desktop/web, toutes les méthodes sont des no-op silencieux.
 */

import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { currentUserId } from '$lib/stores/user';
import { isTauriRuntime } from '$lib/utils/openExternal';

const FCM_TOKEN_STORAGE_KEY = 'canari_fcm_token';
const BACKGROUND_RETRY_ATTEMPTS = 6;
const BACKGROUND_RETRY_DELAY_MS = 5000;

// Évite le spam de tentatives si Google Play Services est indisponible.
let pushAttempted = false;

/**
 * Lit le token FCM via la commande Rust `get_fcm_token` (lit fcm_token.txt).
 * Interroge toutes les 500 ms pendant 30 s pour laisser le temps à
 * MainActivity.onCreate de terminer l'appel Firebase asynchrone.
 */
export async function getFcmToken(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const token = await invoke<string | null>('get_fcm_token');
      if (token) return token;
    } catch {
      return null; // commande Rust indisponible
    }
    await new Promise<void>((r) => setTimeout(r, 500));
  }
  return null;
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
  // getFcmToken() returns immediately if already written, otherwise waits for
  // the canari:fcm-token native event emitted by MainActivity (max 30 s).
  const token = await getFcmToken();
  if (!token) {
    console.warn('[Push] No FCM token available');
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

  // FCM is Android-only; the Rust command exists on all targets but returns null on desktop.
  // Without this guard, getFcmToken polls for 30 s on every desktop start.
  if (!/android/i.test(navigator.userAgent)) {
    console.info('[Push] startPushService noop (not Android)');
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
        body: JSON.stringify({ token: pushToken, deviceId, platform: 'android' }),
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

  // Appels ultérieurs (ex. retour au premier plan) : NE PAS re-skip aveuglément.
  // Le token FCM peut avoir tourné pendant que l'app vivait en arrière-plan ;
  // onNewToken n'écrit le nouveau token qu'en local sans le pousser au serveur.
  // On re-vérifie donc le token (chemin rapide, sans re-poll 30 s ni re-demander la
  // permission) ; registerPushToken n'envoie au backend que s'il a réellement changé.
  if (pushAttempted) {
    console.info('[Push] startPushService re-check (rotation token éventuelle)');
    await registerOnce();
    return;
  }
  pushAttempted = true;

  console.info(
    `[Push] startPushService device=${deviceId} (platform will be confirmed by FCM token)`
  );

  // --- GESTION PERMISSION ANDROID 13+ ---
  try {
    let permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const permission = await requestPermission();
      permissionGranted = permission === 'granted';
    }

    if (!permissionGranted) {
      console.warn(
        "[Push] Permission de notification refusée. L'affichage des pop-ups sera bloqué par Android."
      );
      // On continue quand même : FCM peut recevoir des données silencieuses (background sync)
    }
  } catch (err) {
    console.warn('[Push] Impossible de vérifier/demander la permission de notification', err);
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
    console.error('[Push] Échec désenregistrement du token FCM', err);
  }
}
