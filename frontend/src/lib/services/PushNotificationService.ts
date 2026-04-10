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

const FCM_TOKEN_STORAGE_KEY = 'canari_fcm_token';

type PushPlatform = 'android' | 'ios';

/** Détecte la plateforme mobile courante. Retourne null hors mobile/Tauri. */
function detectPlatform(): PushPlatform | null {
  if (typeof window === 'undefined') return null;
  const ua = window.navigator?.userAgent ?? '';
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  return null;
}

/**
 * Lit le token push depuis la couche Rust (Android/iOS uniquement).
 * – Android : token FCM depuis les SharedPreferences Kotlin
 * – iOS     : token FCM/APNs depuis les UserDefaults Swift
 * Retourne null hors mobile ou si le token n'est pas encore disponible.
 */
export async function getFcmToken(): Promise<string | null> {
  if (!isTauri()) return null;
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
): Promise<void> {
  const token = await getFcmToken();
  if (!token) return;

  // Évite de ré-enregistrer le même token inutilement
  const stored = sessionStorage.getItem(FCM_TOKEN_STORAGE_KEY);
  if (stored === token) return;

  try {
    await registerFn(token);
    sessionStorage.setItem(FCM_TOKEN_STORAGE_KEY, token);
    console.info('[Push] Token FCM enregistré avec succès');
  } catch (err) {
    console.error('[Push] Échec enregistrement du token FCM', err);
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
  authToken: string,
  deviceId: string
): Promise<void> {
  const platform = detectPlatform();
  if (!platform) return; // desktop ou web : pas de push

  await registerPushToken(async (pushToken) => {
    const response = await fetch(`${apiBaseUrl}/push/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': authToken,
      },
      body: JSON.stringify({ token: pushToken, deviceId, platform }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  });
}
