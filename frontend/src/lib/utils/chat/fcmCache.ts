/**
 * FCM Message Cache - pre-injects messages into local storage.
 *
 * When the app is closed and an FCM notification arrives, CanariFirebaseMessagingService
 * decrypts the MLS message (to show the text in the notification) and writes an entry to
 * fcm_message_cache.ndjson. On app boot, consumeFcmCache() reads that file and injects the
 * messages into local storage BEFORE the full MLS sync (~10s) -> immediate display.
 *
 * Full messages coming from the MLS pipeline replace the FCM previews via
 * shouldUpgradeMessage() in useMessaging (merged when the JSON envelope arrives).
 */

import type { IStorage, StoredMessage } from '$lib/db';
import { appendLog } from '$lib/stores/globalChatSingleton.svelte';
import { isTauriRuntime } from '$lib/utils/openExternal';

/** Shape of one entry in fcm_message_cache.ndjson (written by Kotlin/Rust). */
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
 * Reads the native FCM cache (Tauri only) and injects the messages into local storage.
 * Returns the messages actually written to the DB so the caller can update in-memory state
 * without waiting for the next history reload.
 * No-op on web/desktop (no native cache available) -> returns [].
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
    appendLog(`[FCM_CACHE] Cache read failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }

  if (!entries.length) return [];

  appendLog(`[FCM_CACHE] ${entries.length} message(s) to pre-inject from the FCM cache`);

  const injected: StoredMessage[] = [];
  for (const entry of entries) {
    if (!entry.messageId || !entry.groupId || !entry.senderId) {
      appendLog(
        `[FCM_CACHE] Entry skipped (missing fields): ${JSON.stringify(entry).slice(0, 80)}`
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
      // The message has an FK to conversations(id). If the group was just joined in the
      // background, its conversation row does not exist yet -> saveMessage fails
      // (SQLITE_CONSTRAINT_FOREIGNKEY, code 787) and the preview is lost. So first insert a
      // non-destructive placeholder (INSERT OR IGNORE): the real sync (Welcome) then overwrites
      // name/lifecycle via saveConversation (INSERT OR REPLACE). The sender name serves as a
      // transient label; lifecycle 'pending' because the group is not synced yet.
      await storage.mergeConversation({
        id: entry.groupId,
        name: entry.senderName || entry.groupId,
        lifecycle: 'pending',
        updatedAt: entry.timestamp,
      });
      // .saveMessage() uses .put() - the MLS pipeline can overwrite with the full data
      await storage.saveMessage(msg, pin);
      injected.push(msg);
      appendLog(
        `[FCM_CACHE] ✓ id=${entry.messageId.slice(0, 8)} group=${entry.groupId.slice(0, 8)} type=${entry.type}`
      );
    } catch (e) {
      appendLog(
        `[FCM_CACHE] Injection failed id=${entry.messageId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  appendLog(`[FCM_CACHE] Injection done: ${injected.length}/${entries.length} message(s) injected`);
  return injected;
}
