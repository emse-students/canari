/**
 * FCM Message Cache — pré-injection des messages dans le stockage local.
 *
 * Quand l'app est fermée et qu'une notification FCM arrive, CanariFirebaseMessagingService
 * déchiffre le message MLS (pour afficher le texte dans la notification) et écrit une entrée
 * dans fcm_message_cache.ndjson. Au boot de l'app, consumeFcmCache() lit ce fichier et injecte
 * les messages dans le stockage local AVANT la sync MLS complète (~10s) → affichage immédiat.
 *
 * Les messages complets provenant du pipeline MLS normal écraseront ensuite les entrées de
 * cache via .put() — garantissant des données complètes (replyTo, media key, etc.) à terme.
 */

import type { IStorage, StoredMessage } from '$lib/db';
import { appendLog } from '$lib/stores/globalChatSingleton.svelte';

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
 * À appeler juste après login, avant loadAndRestoreConversations(), pour affichage immédiat.
 * No-op sur web/desktop (pas de cache natif disponible).
 */
export async function consumeFcmCache(pin: string, storage: IStorage): Promise<void> {
  if (!(window as any).__TAURI_INTERNALS__) return;

  // Declared without initializer: catch always returns, so entries is definitely
  // assigned before use — TypeScript flow analysis confirms this.
  let entries: FcmCacheEntry[];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    entries = await invoke<FcmCacheEntry[]>('read_and_clear_fcm_cache');
  } catch (e) {
    appendLog(`[FCM_CACHE] Lecture cache échouée: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  if (!entries.length) return;

  appendLog(`[FCM_CACHE] ${entries.length} message(s) à pré-injecter depuis le cache FCM`);

  let injected = 0;
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
    };
    try {
      // .saveMessage() utilise .put() — le pipeline MLS peut écraser avec les données complètes
      await storage.saveMessage(msg, pin);
      injected++;
      appendLog(
        `[FCM_CACHE] ✓ id=${entry.messageId.slice(0, 8)} groupe=${entry.groupId.slice(0, 8)} type=${entry.type}`
      );
    } catch (e) {
      appendLog(
        `[FCM_CACHE] Échec injection id=${entry.messageId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  appendLog(`[FCM_CACHE] Injection terminée: ${injected}/${entries.length} message(s) injectés`);
}
