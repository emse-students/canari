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
 *
 * **AND THE REPLACEMENT ONLY EVER GOES ONE WAY, WHICH UNTIL 2026-09-17 IT DID NOT.** The native
 * side writes a cache entry for EVERY frame it decrypts, with no foreground check - only the
 * notification itself is suppressed while the app is open. So a message received by a RUNNING app,
 * rendered from its real envelope and acknowledged to the server, still left an entry on disk; the
 * next boot drained it and `saveMessage` (a `put` on the primary key) wrote the notification's
 * caption straight over the envelope. Nothing could repair it afterwards, because an acknowledged
 * message is deleted from the server queue and is never delivered again - a photo became the words
 * "Photo", for good. The injection therefore asks what it would be replacing.
 */

import type { IStorage, StoredMessage } from '$lib/db';
import type { ConversationIdentity } from '$lib/utils/chat/conversations';
import { appendLog } from '$lib/stores/globalChatSingleton.svelte';
import { isEnvelopeContent } from '$lib/utils/chat/messageMerge';
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
 * The IDENTITY a placeholder row is given, from ONE push entry - not just its label.
 *
 * **THE LABEL WAS NEVER THE WHOLE ANSWER, AND THE MISSING HALF WAS VISIBLE.** A row built from a
 * push carried a name and no type, and `buildConversationRow` writes `group` when a site does not
 * say - deliberately, because most sites that cannot say really are looking at a group. So the
 * first message from a NEW correspondent, the one case this whole file exists for, produced a
 * conversation typed `group`: drawn with `GroupAvatar` (a rounded square, and no user whose photo
 * to fetch) instead of the peer's round avatar, until a restart let the server sweep rewrite the
 * row. Reported by the user on 2026-09-18 as two separate defects - "no profile photo before
 * reloading the app" and "it is square instead of round for people" - which are this one.
 *
 * **THE DISCRIMINATOR WAS ALREADY ON THE WIRE, AND THIS FILE ALREADY DOCUMENTED IT.**
 * {@link FcmCacheEntry.groupName} is empty for a DM by the server's own contract, which is why it
 * does not travel beside an `isGroup` flag. Three states, not two:
 *
 * - **absent** - an entry written by a native build older than 2026-09-15. The push said nothing
 *   about the group, so neither does this: no type, and the builder's default stands. Learning
 *   nothing is the honest answer, and it is NOT the same as learning `group`.
 * - **present and non-empty** - a named group. The name is the label and the type is `group`.
 * - **present and empty** - a DM, and the peer is the sender, because a DM has exactly one other
 *   member and the push came from them.
 *
 * For that last case the row is named with the canonical `self::peer` key rather than with the
 * sender's display name. That is what every other DM row on disk carries, and it is the only form
 * `deriveConversationIdentity` can read back: `ConversationMeta` has no type column, so a persisted
 * DM named "Firstname LASTNAME" comes back from storage as a group on the NEXT boot too. The label
 * a human sees is resolved from the peer id by `resolveConversationListPresentation`, as for every
 * other DM.
 *
 * **WHAT THIS CANNOT SEPARATE, said rather than hidden:** the server writes `''` for a DM *and* for
 * a group whose own name is empty (`messaging.service.ts`: `group?.isGroup ? name : ''`). Such a
 * group would be drawn here as a DM with its first sender as the peer. It is already labelled with
 * that sender's name today, so only the avatar changes, and the next server sync replaces the row
 * outright - but it is a real edge and the fix for it belongs on the server's side of that ternary.
 */
export function placeholderIdentityForPushEntry(
  entry: Pick<FcmCacheEntry, 'groupId' | 'senderId' | 'senderName' | 'groupName'>,
  userId: string
): PushPlaceholderIdentity {
  const named = entry.groupName?.trim();
  if (named) {
    return { conversationType: 'group', name: named, contactName: named };
  }

  const self = userId.trim().toLowerCase();
  const peer = entry.senderId.trim().toLowerCase();
  if (entry.groupName !== undefined && self && peer && peer !== self) {
    return {
      conversationType: 'direct',
      name: `${self}::${peer}`,
      contactName: peer,
      directPeerId: peer,
    };
  }

  // The legacy entry, and the only case left with nothing to go on. No type: see the docblock.
  return {
    name: placeholderNameForPushEntry(entry),
    contactName: placeholderNameForPushEntry(entry),
  };
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
  placeholders: Map<string, PushPlaceholder>;
}

/**
 * What a push entry says about WHO a conversation is with.
 *
 * `displayName` is absent on purpose: {@link ConversationIdentity} carries both a `contactName` and
 * a `displayName`, and for a placeholder they are the same string - the row's `name`. Keeping one
 * field here is what stops the two stores drifting.
 */
export type PushPlaceholderIdentity = Omit<ConversationIdentity, 'displayName'> & { name: string };

/** One placeholder row, as both stores must see it. */
export type PushPlaceholder = PushPlaceholderIdentity & { updatedAt: number };

/** Nothing read, nothing written - the shape every early return owes. */
const NOTHING: FcmCacheInjection = { messages: [], placeholders: new Map() };

/**
 * Reads the native FCM cache (Tauri only) and injects the messages into local storage.
 * Returns what was written - see {@link FcmCacheInjection} for why the placeholders travel too.
 * No-op on web/desktop (no native cache available).
 */
export async function consumeFcmCache(
  deviceKeyB64: string,
  storage: IStorage,
  userId: string
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
  const placeholders = new Map<string, PushPlaceholder>();
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
      // A PUSH PREVIEW MAY CREATE A ROW AND MAY REPLACE ANOTHER PREVIEW - NEVER AN ENVELOPE.
      // `isEnvelopeContent` is the same predicate `shouldUpgradeMessage` uses to decide an upgrade
      // is worth making; asked here it decides the write is not. The row is left exactly as it is,
      // and it is NOT reported as injected: the in-memory merge that follows would otherwise be
      // handed a caption to draw over a message already on screen.
      const existing = await storage.getMessage(entry.messageId, deviceKeyB64);
      if (existing && isEnvelopeContent(existing.content)) {
        appendLog(
          `[FCM_CACHE] = id=${entry.messageId.slice(0, 8)} already a full envelope, preview dropped`
        );
        continue;
      }
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
      const placeholder: PushPlaceholder = {
        ...placeholderIdentityForPushEntry(entry, userId),
        updatedAt: entry.timestamp,
      };
      // ONLY `name` REACHES STORAGE, AND THAT IS NOT A LOSS - `ConversationMeta` has no type and no
      // peer column, so the name IS the persisted identity and `deriveConversationIdentity` reads it
      // back. The rest of the identity travels in memory, to the caller, for the row it builds now.
      await storage.mergeConversation({
        id: entry.groupId,
        lifecycle: 'pending',
        name: placeholder.name,
        updatedAt: placeholder.updatedAt,
      });
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
