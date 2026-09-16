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
  /**
   * The GROUP's display name, copied straight from the push - empty for a DM, by the server's own
   * contract (`PushMessageInput.groupName`: *"Resolved group name for group chats (empty for
   * DMs)"*). It is therefore both the label AND the discriminator, which is why it does not travel
   * beside an `isGroup` flag: the two would be one fact written twice.
   *
   * ABSENT, NOT EMPTY, ON A FILE WRITTEN BY AN OLDER NATIVE BUILD. The cache is a file on disk that
   * outlives an app update, so an entry queued before 2026-09-15 has no such key at all - see
   * {@link placeholderNameForPushEntry}, which is where that case is answered rather than here.
   */
  groupName?: string;
  content: string;
  timestamp: number;
  type: string;
  replyTo?: { id: string; senderId: string; preview: string } | null;
  mediaKind?: string | null;
}

/**
 * The label a placeholder conversation row is given, from ONE push entry.
 *
 * **A SENDER'S NAME IS EVIDENCE ABOUT THE SENDER, NOT ABOUT THE CONVERSATION**, and until
 * 2026-09-15 this row took it as both. For a DM the two coincide, which is why it looked right; for
 * a GROUP it produced a row titled with whoever happened to message first. Measured on a two-person
 * group: the sidebar then held two rows carrying the same person's name, one the DM and one the
 * group, with nothing on either to tell them apart.
 *
 * **AND NOTHING EVER CORRECTED IT.** The docblock beside the write promised the Welcome would
 * overwrite the label - true for a group this device is JOINING, and vacuous for one it is already
 * in, which is every group a push can arrive for. A group's name is refreshed from the server by
 * exactly one seam, `ensureConversationForServerGroup`, and that seam now repairs a row it finds
 * already present instead of returning `existed` and leaving the label alone.
 *
 * The group id is the last resort, and it is deliberately NOT a name: `isRawId` recognises it and
 * `resolveConversationListPresentation` renders "Groupe" rather than a uuid. Saying nothing is the
 * honest answer when the push carried nothing.
 */
export function placeholderNameForPushEntry(
  entry: Pick<FcmCacheEntry, 'groupId' | 'senderName' | 'groupName'>
): string {
  return entry.groupName?.trim() || entry.senderName.trim() || entry.groupId;
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
    appendLog(`[FCM_CACHE] Cache read failed: ${String(e)}`);
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
      // non-destructive placeholder (INSERT OR IGNORE); lifecycle 'pending' because the group is
      // not synced yet.
      //
      // THE LABEL IS NOT TRANSIENT, WHICH IS WHY IT IS NO LONGER A GUESS. This comment used to say
      // the sender's name served as a transient label that the Welcome would overwrite - and for a
      // group this device is already a member of no Welcome is ever coming, so the guess was the
      // name for good. {@link placeholderNameForPushEntry} carries what the push actually knew.
      const placeholder = {
        name: placeholderNameForPushEntry(entry),
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
      appendLog(`[FCM_CACHE] Injection failed id=${entry.messageId.slice(0, 8)}: ${String(e)}`);
    }
  }

  appendLog(`[FCM_CACHE] Injection done: ${injected.length}/${entries.length} message(s) injected`);
  return { messages: injected, placeholders };
}
