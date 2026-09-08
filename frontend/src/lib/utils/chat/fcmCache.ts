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

/**
 * Shape of one entry in fcm_message_cache.ndjson (written by Android Kotlin and the
 * iOS Notification Service Extension). Both writers must produce the same fields so
 * the TypeScript consumer does not need to distinguish platforms.
 *
 * replyTo is written as the platform's native object (JSONObject on Android,
 * [String: Any] on iOS), so the JSON must match the TS-side reply-to contract.
 */
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
 * What {@link consumeFcmCache} wrote, for BOTH stores it has to leave consistent.
 *
 * The messages alone were not enough, and the gap was a user-visible P1: a first message from
 * someone you have no conversation with is decrypted by the FCM service, and this function writes
 * the message AND a placeholder conversation row for it - but the caller then merged only the
 * MESSAGES into the in-memory list, found no conversation to merge them into, and dropped them.
 * The app showed nothing until a restart re-read the placeholder from storage, which is exactly
 * what the user reported on 2026-09-08. **The placeholder is known HERE and nowhere else**, so it
 * is returned rather than re-derived: a `StoredMessage` carries no sender NAME, so a caller trying
 * to build the same row would have to invent one and the two stores would disagree on the label.
 */
export interface FcmCacheInjection {
  /** Messages written to the DB, so a caller can update in-memory state without a history reload. */
  messages: StoredMessage[];
  /** The placeholder conversation written for each group seen, keyed by group id. */
  placeholders: Map<string, { name: string; updatedAt: number }>;
}

/** Nothing read, nothing written - the shape every early return owes. */
const NOTHING: FcmCacheInjection = { messages: [], placeholders: new Map() };

/**
 * Reads the native FCM cache (Tauri only) and injects the messages into local storage.
 * Returns what was written - see {@link FcmCacheInjection} for why the placeholders travel too.
 * No-op on web/desktop (no native cache available).
 */
export async function consumeFcmCache(
  deviceKeyB64: string,
  storage: IStorage
): Promise<FcmCacheInjection> {
  if (!isTauriRuntime()) return NOTHING;

  // Declared without initializer: catch always returns, so entries is definitely
  // assigned before use - TypeScript flow analysis confirms this.
  let entries: FcmCacheEntry[];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    entries = await invoke<FcmCacheEntry[]>('read_and_clear_fcm_cache');
  } catch (e) {
    appendLog(`[FCM_CACHE] Cache read failed: ${e instanceof Error ? e.message : String(e)}`);
    return NOTHING;
  }

  if (!entries.length) return NOTHING;

  appendLog(`[FCM_CACHE] ${entries.length} message(s) to pre-inject from the FCM cache`);

  const injected: StoredMessage[] = [];
  const placeholders = new Map<string, { name: string; updatedAt: number }>();
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
      const placeholder = {
        name: entry.senderName || entry.groupId,
        updatedAt: entry.timestamp,
      };
      await storage.mergeConversation({ id: entry.groupId, lifecycle: 'pending', ...placeholder });
      // RECORDED ONLY ON THE PATH THAT WROTE IT, so the caller cannot be handed a label for a row
      // that does not exist: a throw below leaves neither store carrying this group.
      placeholders.set(entry.groupId, placeholder);
      // .saveMessage() uses .put() - the MLS pipeline can overwrite with the full data
      await storage.saveMessage(msg, deviceKeyB64);
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
  return { messages: injected, placeholders };
}
