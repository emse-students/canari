/**
 * PushNotificationService.ts
 *
 * Gestion des notifications push (FCM) sur Android via Tauri.
 *
 * Flux :
 *  1. Au démarrage, lit le token FCM via la commande Rust `get_fcm_token`
 *  2. Envoie le token au backend Canari pour qu'il puisse envoyer des push
 *  3. Expose une function utilitaire pour re-demander le token si nécessaire
 *
 * Sur desktop/web, les méthodes sont des no-op silencieux.
 */

import { isTauri } from '@tauri-apps/api/core';
import { invoke } from '@tauri-apps/api/core';

const FCM_TOKEN_STORAGE_KEY = 'canari_fcm_token';

/**
 * Lit le token FCM depuis la couche Rust (Android uniquement).
 * Retourne null hors Android ou si le token n'est pas encore disponible.
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
 */
export async function startPushService(apiBaseUrl: string, authToken: string): Promise<void> {
  await registerPushToken(async (fcmToken) => {
    const response = await fetch(`${apiBaseUrl}/push/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ token: fcmToken, platform: 'android' }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  });
}
