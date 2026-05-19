/**
 * Plain async helpers for conversation loading, de-duplication, and archive
 * persistence. These are pure functions that accept state by reference so they
 * work with Svelte 5's $state without requiring a specific composable wrapper.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { IStorage, ConversationMeta, StoredMessage } from '$lib/db';
import {
  mapStoredMessagesToChatMessages,
  replayConversationHistory,
  retroactivelyResolveHexIds,
} from './history';
import { migrateFromLocalStorage } from '../migration';
import type { IMlsService } from '$lib/mlsService';
import type { Conversation } from '$lib/types';
import { apiFetch } from '$lib/utils/apiFetch';
import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
import { compareMessageOrder } from './messageOrder';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is a single user/group UUID (not a canonical direct key). */
export function isUuidLike(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/** True when `value` is the persisted direct-conversation key (`userId::peerId`). */
export function isCanonicalDirectKey(value: string): boolean {
  return value.includes('::');
}

/** Number of messages loaded from local DB on first display. Older messages load on scroll-up. */
const INITIAL_MESSAGES_PAGE = 60;

// ---------- Archive persistence ----------

/** Returns the localStorage key used to store the set of archived conversation IDs for a user. */
export function archiveStorageKey(uid: string): string {
  return `canari_archived_conversations_${uid.toLowerCase()}`;
}

/**
 * Reads the persisted set of archived conversation IDs for a user from localStorage.
 * Returns an empty array if nothing is stored or the stored value is not a valid array.
 */
export function loadPersistedArchivedIds(uid: string): string[] {
  try {
    const raw = localStorage.getItem(archiveStorageKey(uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((id) => String(id).toLowerCase()).filter(Boolean))];
  } catch {
    return [];
  }
}

/** Saves the current set of archived conversation IDs for a user to localStorage. */
export function persistArchivedConversations(uid: string, ids: string[]) {
  localStorage.setItem(archiveStorageKey(uid), JSON.stringify([...new Set(ids)]));
}

// ---------- Direct-conversation identity ----------

/**
 * Infers whether a conversation is a 1-to-1 direct conversation or a group by
 * inspecting the conversation name and optional ID.
 *
 * Supported naming patterns:
 * - `"alice::bob"` — canonical direct conversation format.
 * - `"alice & bob"` — legacy two-participant format.
 * - `metaId` starts with `"dm_"` — explicit DM marker.
 *
 * Returns the conversation type, the contact name to display, and the peer's user ID
 * (`directPeerId`) for direct conversations.
 */
export function deriveConversationIdentity(
  metaName: string,
  userId: string,
  metaId?: string
): {
  conversationType: 'direct' | 'group';
  contactName: string;
  displayName: string;
  directPeerId?: string;
} {
  const normalizedName = metaName.trim();
  const currentUser = userId.toLowerCase();

  if (normalizedName.includes('::')) {
    const parts = normalizedName
      .split('::')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
    const unique = [...new Set(parts)];
    const peer = unique.find((p) => p !== currentUser);
    if (peer) {
      return {
        conversationType: 'direct',
        contactName: peer,
        displayName: peer,
        directPeerId: peer,
      };
    }
  }

  if (normalizedName.includes(' & ')) {
    const participants = normalizedName
      .split(' & ')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
    if (participants.length === 2 && participants.includes(currentUser)) {
      const peer = participants.find((p) => p !== currentUser) || participants[0];
      return {
        conversationType: 'direct',
        contactName: peer,
        displayName: peer,
        directPeerId: peer,
      };
    }
  }

  if (metaId?.startsWith('dm_')) {
    const peer = normalizedName.toLowerCase();
    if (peer && peer !== currentUser) {
      return {
        conversationType: 'direct',
        contactName: peer,
        displayName: peer,
        directPeerId: peer,
      };
    }
  }

  return { conversationType: 'group', contactName: normalizedName, displayName: normalizedName };
}

export interface ConversationListPresentation {
  conversationType: 'direct' | 'group';
  contactId: string;
  displayName: string;
}

/**
 * Resolves sidebar / mini-panel row data from a conversation record.
 * Prefer stored `conversationType` / `directPeerId` — re-parsing `conv.name` alone
 * breaks after MLS reload when `name` is only the peer UUID (no `::` key).
 */
export function resolveConversationListPresentation(
  input: {
    id: string;
    name: string;
    contactName: string;
    conversationType?: 'direct' | 'group' | 'channel';
    directPeerId?: string;
    /** Persisted IndexedDB name (often `userId::peerId` for DMs). */
    metaName?: string;
    /** Previously resolved label to keep across reloads. */
    fallbackDisplayName?: string;
  },
  userId: string
): ConversationListPresentation {
  const metaName = input.metaName?.trim();
  const identity = deriveConversationIdentity(metaName || input.name, userId, input.id);
  const conversationType = input.conversationType ?? identity.conversationType;

  if (conversationType === 'direct') {
    const peerId = (
      input.directPeerId ??
      identity.directPeerId ??
      (input.contactName && !isCanonicalDirectKey(input.contactName)
        ? input.contactName
        : undefined) ??
      identity.contactName
    ).toLowerCase();

    const rawName = input.name.trim();
    const needsResolve =
      isCanonicalDirectKey(rawName) ||
      !rawName ||
      rawName.toLowerCase() === peerId ||
      isUuidLike(rawName);

    const fallback =
      input.fallbackDisplayName &&
      !isCanonicalDirectKey(input.fallbackDisplayName) &&
      input.fallbackDisplayName.toLowerCase() !== peerId
        ? input.fallbackDisplayName
        : undefined;

    return {
      conversationType: 'direct',
      contactId: peerId,
      displayName: needsResolve ? getUserDisplayNameSync(peerId, fallback) : rawName,
    };
  }

  for (const candidate of [input.name, input.fallbackDisplayName, metaName]) {
    const trimmed = candidate?.trim();
    if (trimmed && !isUuidLike(trimmed) && !isCanonicalDirectKey(trimmed)) {
      return {
        conversationType: 'group',
        contactId: input.id,
        displayName: trimmed,
      };
    }
  }

  return {
    conversationType: 'group',
    contactId: input.id,
    displayName: input.name.trim() || input.id,
  };
}

// ---------- De-duplication ----------

/**
 * Detects duplicate direct conversations for the same peer (can happen when
 * two devices each start the conversation independently) and merges them into
 * a single canonical entry.
 *
 * The most-recently-updated conversation is kept; the other is deleted locally and
 * on the server. After merging, all direct conversation names are normalised to the
 * `"userId::peer"` canonical format for consistent future detection.
 *
 * Returns the deduplicated, normalised list of `ConversationMeta` objects.
 */
export async function mergeDirectConversationDuplicates(
  convMetas: ConversationMeta[],
  userId: string,
  pin: string,
  storage: IStorage,
  log: (msg: string) => void,
  mlsService?: IMlsService
): Promise<ConversationMeta[]> {
  const canonicalByPeer = new Map<string, ConversationMeta>();
  const duplicatesToMerge: Array<{ canonical: ConversationMeta; duplicate: ConversationMeta }> = [];

  for (const meta of convMetas) {
    const identity = deriveConversationIdentity(meta.name, userId, meta.id);
    if (identity.conversationType !== 'direct' || !identity.directPeerId) continue;

    const peer = identity.directPeerId.toLowerCase();
    const existing = canonicalByPeer.get(peer);
    if (!existing) {
      canonicalByPeer.set(peer, meta);
      continue;
    }

    const canonical = existing.updatedAt >= meta.updatedAt ? existing : meta;
    const duplicate = canonical.id === existing.id ? meta : existing;
    canonicalByPeer.set(peer, canonical);
    duplicatesToMerge.push({ canonical, duplicate });
  }

  if (duplicatesToMerge.length === 0) return convMetas;

  for (const { canonical, duplicate } of duplicatesToMerge) {
    if (canonical.id === duplicate.id) continue;
    try {
      const canonicalMessages = await storage.getMessages(canonical.id, pin);
      const duplicateMessages = await storage.getMessages(duplicate.id, pin);
      const byId = new Map<string, StoredMessage>();
      for (const m of canonicalMessages) byId.set(m.id, { ...m, conversationId: canonical.id });
      for (const m of duplicateMessages) {
        if (!byId.has(m.id)) byId.set(m.id, { ...m, conversationId: canonical.id });
      }
      const merged = Array.from(byId.values()).sort((a, b) => a.timestamp - b.timestamp);
      if (merged.length > 0) await storage.saveMessages(merged, pin);
      await storage.deleteConversation(duplicate.id);
      // Supprimer aussi le groupe orphelin côté serveur pour éviter qu'il
      // réapparaisse au prochain login via discoverMissingGroups.
      if (mlsService) {
        try {
          await mlsService.deleteGroupOnServer(duplicate.id);
        } catch {
          // Non-bloquant : nettoyé lors du prochain GC serveur
        }
      }
      log(`Fusion de discussions 1:1 en doublon: ${duplicate.name} -> ${canonical.name}`);
    } catch (error) {
      log(
        `Erreur fusion discussions directes: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const duplicateIds = new Set(duplicatesToMerge.map((item) => item.duplicate.id));
  const merged = convMetas.filter((meta) => !duplicateIds.has(meta.id));

  // Normalize direct-conversation names for future consistent detection.
  const normalizedMetas: ConversationMeta[] = [];
  for (const meta of merged) {
    const identity = deriveConversationIdentity(meta.name, userId, meta.id);
    if (identity.conversationType !== 'direct' || !identity.directPeerId) {
      normalizedMetas.push(meta);
      continue;
    }
    const normalizedDirectName = `${userId.toLowerCase()}::${identity.directPeerId.toLowerCase()}`;
    if (meta.name === normalizedDirectName) {
      normalizedMetas.push(meta);
      continue;
    }
    try {
      const updatedMeta = { ...meta, name: normalizedDirectName, updatedAt: Date.now() };
      await storage.saveConversation(updatedMeta);
      normalizedMetas.push(updatedMeta);
    } catch (e) {
      log(
        `[WARN] Echec normalisation conversation directe ${meta.id}: ${e instanceof Error ? e.message : String(e)}`
      );
      normalizedMetas.push(meta);
    }
  }

  return normalizedMetas;
}

// ---------- Full conversation load ----------

/** All dependencies required by `loadExistingConversations`. */
export interface LoadConversationsContext {
  userId: string;
  pin: string;
  storage: IStorage;
  mlsService: IMlsService;
  /** Reactive map populated by this function — cleared and rebuilt on each call. */
  conversations: SvelteMap<string, Conversation>;
  /** Shared reactions map, updated while loading messages. */
  messageReactions: SvelteMap<string, any>;
  archivedConversationIds: string[];
  historyBaseUrl: string;
  log: (msg: string) => void;
  /** Called when the archived-ID set is pruned to remove stale entries. */
  onArchivedIdsChange: (ids: string[]) => void;
}

/**
 * Full startup loader that bootstraps all conversations from local storage.
 *
 * Phase 1: For each conversation in the DB, a lightweight stub (no messages) is
 * immediately inserted into the reactive map so the sidebar is populated at once.
 *
 * Phase 2 (serialised): For each conversation, stored messages are decrypted and
 * loaded, then remote history is replayed via the MLS service. Serialised execution
 * is required because the WASM MLS client is not concurrency-safe.
 *
 * The function also runs a one-time localStorage migration, deduplicates direct
 * conversations, prunes stale archived IDs, and resolves ambiguous conversation types
 * via the members API.
 */
export async function loadExistingConversations(ctx: LoadConversationsContext) {
  await migrateFromLocalStorage(ctx.userId, ctx.pin, ctx.storage, ctx.log);

  const convMetas = await ctx.storage.getConversations();
  const mergedConvMetas = await mergeDirectConversationDuplicates(
    convMetas,
    ctx.userId,
    ctx.pin,
    ctx.storage,
    ctx.log,
    ctx.mlsService
  );

  const validConversationIds = new Set(mergedConvMetas.map((meta) => meta.id.toLowerCase()));
  const prunedArchivedIds = ctx.archivedConversationIds.filter((id) =>
    validConversationIds.has(id)
  );
  if (prunedArchivedIds.length !== ctx.archivedConversationIds.length) {
    ctx.onArchivedIdsChange(prunedArchivedIds);
    persistArchivedConversations(ctx.userId, prunedArchivedIds);
  }

  // Preserve in-memory UI fields (avatars, resolved names) across reload — they are
  // not stored in ConversationMeta and would otherwise flash away on every login.
  const snapshot = new SvelteMap<
    string,
    Pick<Conversation, 'name' | 'imageMediaId' | 'conversationType' | 'directPeerId'>
  >();
  for (const [key, conv] of ctx.conversations.entries()) {
    snapshot.set(key, {
      name: conv.name,
      imageMediaId: conv.imageMediaId,
      conversationType: conv.conversationType,
      directPeerId: conv.directPeerId,
    });
  }

  ctx.conversations.clear();
  ctx.messageReactions.clear();

  // Phase 1 — fast, immediately usable conversation stubs.
  for (const meta of mergedConvMetas) {
    const identity = deriveConversationIdentity(meta.name, ctx.userId, meta.id);
    const prev = snapshot.get(meta.id);
    const resolvedName =
      prev?.name &&
      prev.name.trim() &&
      prev.name !== identity.displayName &&
      identity.conversationType === 'group'
        ? prev.name
        : identity.conversationType === 'direct' && identity.directPeerId
          ? identity.directPeerId
          : identity.displayName;
    ctx.conversations.set(meta.id, {
      id: meta.id,
      contactName:
        identity.conversationType === 'direct' && identity.directPeerId
          ? identity.directPeerId
          : identity.contactName,
      name: resolvedName,
      messages: [],
      isReady: meta.isReady,
      mlsStateHex: null,
      unreadCount: 0,
      conversationType: prev?.conversationType ?? identity.conversationType,
      directPeerId: prev?.directPeerId ?? identity.directPeerId,
      imageMediaId: prev?.imageMediaId ?? null,
    });
  }

  // Phase 2 — decrypt stored messages + replay remote history.
  // Serialised (not parallel) because replayConversationHistory calls the shared
  // WASM MLS client which is not safe to invoke concurrently.
  for (const meta of mergedConvMetas) {
    if (meta.id.startsWith('channel_')) {
      await ctx.storage.deleteMessagesForConversation(meta.id).catch(() => {});
      continue;
    }
    try {
      const existingConvo = ctx.conversations.get(meta.id);
      if (
        existingConvo &&
        (existingConvo.conversationType ?? 'group') === 'group' &&
        !meta.id.startsWith('channel_')
      ) {
        try {
          // First check the explicit isGroup flag from the backend — this is
          // authoritative and prevents multi-user groups with only 2 members
          // from being misclassified as direct conversations.
          let isGroupFromApi: boolean | null = null;
          try {
            const gRes = await apiFetch(`${ctx.historyBaseUrl}/api/mls/groups/${meta.id}`);
            if (gRes.ok) {
              const gData = await gRes.json();
              if (typeof gData?.isGroup === 'boolean') {
                isGroupFromApi = gData.isGroup;
              }
            }
          } catch {
            // Non-blocking
          }

          // If the backend explicitly says this is a group, skip member-count heuristic.
          if (isGroupFromApi !== true) {
            const res = await apiFetch(`${ctx.historyBaseUrl}/api/mls/groups/${meta.id}/members`);
            if (res.ok) {
              const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
              if (contentType.includes('application/json')) {
                const rows = (await res.json()) as Array<{ userId?: string }>;
                const memberIds = [
                  ...new Set(rows.map((r) => String(r.userId ?? '').toLowerCase())),
                ].filter(Boolean);
                if (memberIds.length === 2 && memberIds.includes(ctx.userId.toLowerCase())) {
                  const peer = memberIds.find((m) => m !== ctx.userId.toLowerCase()) ?? '';
                  if (peer) {
                    ctx.conversations.set(meta.id, {
                      ...existingConvo,
                      conversationType: 'direct',
                      directPeerId: peer,
                      contactName: peer,
                      name: peer,
                    });

                    const normalizedName = `${ctx.userId.toLowerCase()}::${peer}`;
                    if (meta.name !== normalizedName) {
                      await ctx.storage.saveConversation({
                        ...meta,
                        name: normalizedName,
                        updatedAt: Date.now(),
                      });
                    }
                  }
                }
              }
            }
          }
        } catch {
          // Non-blocking: keep existing type when members endpoint is unavailable.
        }
      }

      const storedMessages = await ctx.storage.getMessagesPage(
        meta.id,
        ctx.pin,
        INITIAL_MESSAGES_PAGE
      );
      const msgs = await retroactivelyResolveHexIds(
        mapStoredMessagesToChatMessages(storedMessages, ctx.userId),
        ctx.storage,
        meta.id,
        ctx.pin
      );
      const preReplayMsgIds = new Set(msgs.map((m) => m.id));
      const existing = ctx.conversations.get(meta.id);
      if (existing && msgs.length > 0) {
        ctx.conversations.set(meta.id, { ...existing, messages: msgs });

        // Restore reactions into the shared messageReactions map
        for (const m of msgs) {
          if (m.reactions && m.reactions.length > 0) {
            ctx.messageReactions.set(m.id, m.reactions);
          }
        }
      }
      // Fetch from network → decrypt → save to DB (no direct UI update)
      await replayConversationHistory({
        mlsService: ctx.mlsService,
        id: meta.id,
        contactName: meta.id,
        userId: ctx.userId,
        pin: ctx.pin,
        storage: ctx.storage,
        getConversation: (name) => ctx.conversations.get(name),
        setConversation: (name, next) => ctx.conversations.set(name, next),
        messageReactions: ctx.messageReactions,
        log: ctx.log,
      });
      // Reload from DB after network sync so display reflects new messages
      const refreshed = await ctx.storage.getMessagesPage(meta.id, ctx.pin, INITIAL_MESSAGES_PAGE);
      const refreshedMsgs = await retroactivelyResolveHexIds(
        mapStoredMessagesToChatMessages(refreshed, ctx.userId),
        ctx.storage,
        meta.id,
        ctx.pin
      );
      const current = ctx.conversations.get(meta.id);
      if (current) {
        const newUnreadCount = refreshedMsgs.filter(
          (m) => !m.isOwn && m.senderId !== 'system' && !preReplayMsgIds.has(m.id)
        ).length;
        ctx.conversations.set(meta.id, {
          ...current,
          messages: [...refreshedMsgs].sort(compareMessageOrder),
          unreadCount: newUnreadCount,
        });
        for (const m of refreshedMsgs) {
          if (m.reactions && m.reactions.length > 0) {
            ctx.messageReactions.set(m.id, m.reactions);
          }
        }
      }
    } catch (e) {
      ctx.log(
        `[WARN] Echec chargement conversation ${meta.id}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
}
