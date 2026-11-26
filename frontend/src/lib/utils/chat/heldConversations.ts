/**
 * THE DIRECT AND GROUP CONVERSATIONS THIS DEVICE HOLDS, as rows a list outside the chat page draws:
 * the posts page's mini panel and the universal search's Discussions section read the SAME rows, so
 * a conversation is never named one way in one and another way in the other.
 *
 * Two sources, merged by one rule: the stored conversation rows (`IStorage.getConversations`, read
 * before the session is live, so a cold page is not empty) and the live conversation map. Once the
 * live map is authoritative (`conversationsRestored`) it is the sole source of membership, so a
 * deletion disappears at once instead of being resurrected from the stored snapshot. Salons are not
 * here: they are not stored on the device (`community-open-budget.md`).
 */
import { getStorage, type ConversationMeta } from '$lib/db';
import type { Conversation } from '$lib/types';
import { isDeletedAccountHere } from '$lib/utils/deletedAccountMarker';
import {
  conversationRecency,
  deriveConversationIdentity,
  resolveConversationListPresentation,
} from '$lib/utils/chat/conversations';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import { isHiddenFromList, loadHiddenUnopenable } from '$lib/utils/chat/noHolder.svelte';
import { previewContentOf } from '$lib/utils/chat/listPreview';

/** One conversation as a list outside the chat page draws it. */
export interface HeldConversation {
  meta: ConversationMeta;
  contactId: string;
  displayName: string;
  /** See `ConversationListPresentation.displayNameResolved` - false means it is a placeholder. */
  displayNameResolved: boolean;
  conversationType: 'direct' | 'group' | 'self';
  isReady: boolean;
  unreadCount: number;
  imageMediaId: string | null;
  lastMessageContent?: string;
  /** Newest message time (ms), for the tile's relative time. */
  lastActivityAt?: number;
}

/** A stored conversation row, named as the conversation list names it. */
export function heldConversationFromMeta(meta: ConversationMeta, uid: string): HeldConversation {
  const identity = deriveConversationIdentity(meta.name, uid, meta.id);
  const pres = resolveConversationListPresentation(
    {
      id: meta.id,
      name: meta.name,
      contactName: identity.contactName,
      conversationType: identity.conversationType,
      directPeerId: identity.directPeerId,
      metaName: meta.name,
    },
    uid
  );
  return {
    meta,
    contactId: pres.contactId,
    displayName: pres.displayName,
    displayNameResolved: pres.displayNameResolved,
    conversationType: pres.conversationType,
    isReady: meta.lifecycle === 'active',
    unreadCount: 0,
    imageMediaId: null,
  };
}

/** A live conversation, its stored row (`baseline`) filling what the live one does not carry yet. */
export function heldConversationFromLive(
  key: string,
  conv: Conversation,
  uid: string,
  baseline?: HeldConversation
): HeldConversation {
  const pres = resolveConversationListPresentation(
    {
      id: conv.id,
      name: conv.name,
      contactName: conv.contactName,
      conversationType: conv.conversationType,
      directPeerId: conv.directPeerId,
      metaName: baseline?.meta.name,
      // ONLY A 1:1's PREVIOUS LABEL IS A FALLBACK. A group's baseline label may be a COMPUTED one
      // (the generic word, drawn before its tree was read): fed back in as a name it would win
      // over the members' first names for the whole session. `metaName` already carries the
      // stored name of a named group.
      fallbackDisplayName:
        baseline?.conversationType === 'direct' ? baseline.displayName : undefined,
    },
    uid
  );
  return {
    meta: {
      id: key,
      name: conv.name,
      lifecycle: conv.lifecycle,
      updatedAt: conversationRecency(conv) || (baseline?.meta.updatedAt ?? 0),
      awaitingAdmission: conv.awaitingAdmission === true,
    },
    contactId: pres.contactId,
    displayName: pres.displayName,
    displayNameResolved: pres.displayNameResolved,
    conversationType: pres.conversationType,
    isReady: conv.lifecycle === 'active',
    unreadCount: conv.unreadCount ?? baseline?.unreadCount ?? 0,
    imageMediaId: conv.imageMediaId ?? baseline?.imageMediaId ?? null,
    // Only device lines loaded: the baseline's preview, never an empty row.
    lastMessageContent:
      (conv.messages?.length > 0 ? previewContentOf(conv.messages) : undefined) ??
      baseline?.lastMessageContent,
    lastActivityAt:
      conv.messages?.length > 0 ? conversationRecency(conv) : baseline?.lastActivityAt,
  };
}

/**
 * The stored rows and the live map merged, most recent first. `live` is null when no session is
 * live; `liveAuthoritative` is the live map's `conversationsRestored`.
 */
export function mergeHeldConversations(input: {
  stored: readonly HeldConversation[];
  live: Iterable<[string, Conversation]> | null;
  uid: string;
  liveAuthoritative: boolean;
}): HeldConversation[] {
  const byId = new Map<string, HeldConversation>();
  if (!input.liveAuthoritative) {
    for (const item of input.stored) byId.set(item.meta.id, item);
  }
  if (input.live) {
    for (const [key, conv] of input.live) {
      if (isChannelConversationId(key) || isChannelConversationId(conv.id)) continue;
      byId.set(key, heldConversationFromLive(key, conv, input.uid, byId.get(key)));
    }
  }
  return [...byId.values()].sort((a, b) => b.meta.updatedAt - a.meta.updatedAt);
}

/**
 * The direct and group conversations the store of `uid` holds, most recent first, named for a list.
 * Empty, with a warning, for an account this device deleted (opening its store would re-create it).
 *
 * IT DOES NOT CLOSE THE STORE, DELIBERATELY: `SqliteStorage.close()` closes the plugin's POOL for
 * that path, and the pool is shared with the chat session running behind the page - a reader would
 * be tearing down the writer's handle. The lifetime belongs to whoever opened the session.
 */
export async function readStoredConversations(uid: string): Promise<HeldConversation[]> {
  // A KILL BEFORE `clearAuth()` LEAVES THE SAVED USER AT A DELETED ACCOUNT, and a page can run with
  // no login: opening its store would re-create `CanariDB_<id>` behind the owed wipe.
  if (isDeletedAccountHere(uid)) {
    console.warn(
      `[CONV] ${uid.slice(0, 8)} was deleted from this device - its stored conversations are not opened`
    );
    return [];
  }
  // ASK THE RUNTIME WHICH STORE THIS DEVICE HAS: on a phone the message store is SQLite, and
  // building an IndexedDB store directly read an unrelated database and CREATED it (Pixel 6a,
  // 2026-08-28: 5.9 MB of `CanariDB_<userId>` that nothing on that platform deletes).
  const storage = await getStorage(uid);
  // No `.sort()`: `getConversations` answers most-recently-updated first, on both backends
  // (`db/conversationOrder.test.ts`).
  const convos = await storage.getConversations();
  loadHiddenUnopenable(uid);
  return convos
    .filter((meta) => !isChannelConversationId(meta.id))
    .filter((meta) => !isHiddenFromList(meta.id, meta.lifecycle))
    .map((meta) => heldConversationFromMeta(meta, uid));
}
