/**
 * FCM Message Cache - pré-injection des messages dans le stockage local.
 *
 * Quand l'app est fermée et qu'une notification FCM arrive, CanariFirebaseMessagingService
 * déchiffre le message MLS (pour afficher le texte dans la notification) et écrit une entrée
 * dans fcm_message_cache.ndjson. Au boot de l'app, consumeFcmCache() lit ce fichier et injecte
 * les messages dans le stockage local AVANT la sync MLS complète (~10s) → affichage immédiat.
 *
 * Les messages complets provenant du pipeline MLS remplacent les previews FCM via
 * shouldUpgradeMessage() dans useMessaging (merge à l'arrivée de l'enveloppe JSON).
 */

import type { IStorage, StoredMessage } from '$lib/db';
import { appendLog } from '$lib/stores/globalChatSingleton.svelte';
import { isTauriRuntime } from '$lib/utils/openExternal';

/** Structure d'une entrée dans fcm_message_cache.ndjson (écrite par Kotlin/Rust). */
interface FcmCacheEntry {
  groupId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: number;
  type: string;
  replyTo?: { id: string; senderId: string; preview: string } | null;
  mediaKind?: string | null;
}

/**
 * Lit le cache FCM natif (Tauri uniquement) et injecte les messages dans le stockage local.
 * Retourne les messages effectivement écrits en base pour que l'appelant puisse mettre à
 * jour l'état en mémoire sans attendre le prochain rechargement de l'historique.
 * No-op sur web/desktop (pas de cache natif disponible) → retourne [].
 */
export async function consumeFcmCache(pin: string, storage: IStorage): Promise<StoredMessage[]> {
  if (!isTauriRuntime()) return [];

  // Declared without initializer: catch always returns, so entries is definitely
  // assigned before use - TypeScript flow analysis confirms this.
  let entries: FcmCacheEntry[];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    entries = await invoke<FcmCacheEntry[]>('read_and_clear_fcm_cache');
  } catch (e) {
    appendLog(`[FCM_CACHE] Lecture cache échouée: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }

  if (!entries.length) return [];

  appendLog(`[FCM_CACHE] ${entries.length} message(s) à pré-injecter depuis le cache FCM`);

  const injected: StoredMessage[] = [];
  for (const entry of entries) {
    if (!entry.messageId || !entry.groupId || !entry.senderId) {
      appendLog(
        `[FCM_CACHE] Entrée ignorée (champs manquants): ${JSON.stringify(entry).slice(0, 80)}`
      );
      continue;
    }
    const msg: StoredMessage = {
      id: entry.messageId,
      conversationId: entry.groupId,
      senderId: entry.senderId.toLowerCase(),
      content: entry.content,
      timestamp: entry.timestamp,
      isFcmPreview: true,
    };
    try {
      // .saveMessage() utilise .put() - le pipeline MLS peut écraser avec les données complètes
      await storage.saveMessage(msg, pin);
      injected.push(msg);
      appendLog(
        `[FCM_CACHE] ✓ id=${entry.messageId.slice(0, 8)} groupe=${entry.groupId.slice(0, 8)} type=${entry.type}`
      );
    } catch (e) {
      appendLog(
        `[FCM_CACHE] Échec injection id=${entry.messageId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  appendLog(
    `[FCM_CACHE] Injection terminée: ${injected.length}/${entries.length} message(s) injectés`
  );
  return injected;
}
