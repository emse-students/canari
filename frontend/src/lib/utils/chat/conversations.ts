/**
 * Plain async helpers for conversation loading, de-duplication, and archive
 * persistence. These are pure functions that accept state by reference so they
 * work with Svelte 5's $state without requiring a specific composable wrapper.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { IStorage, ConversationMeta, StoredMessage } from '$lib/db';
import {
  mapStoredMessagesToChatMessages,
  readHistoryStreamCursor,
  replayConversationHistory,
  retroactivelyResolveHexIds,
  type MlsReplayCommit,
} from './history';
import { withMlsBulkIngest } from '$lib/mls-client/mlsBulkIngest';
import { buildUserGroupSyncIndex } from './groupSyncEligibility';
import { migrateFromLocalStorage } from '../migration';
import type { IMlsService } from '$lib/mlsService';
import type { Conversation } from '$lib/types';
import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
import { compareMessageOrder } from './messageOrder';
import { isChannelConversationId } from './channelCrypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is a single user/group UUID (not a canonical direct key). */
export function isUuidLike(value: string): boolean {
  return UUID_RE.test(value.trim());
}

const HEX_ID_RE = /^[0-9a-f]{40,}$/i;

/**
 * True when `value` looks like a raw technical ID that must never be shown in the UI -
 * either a UUID or an MLS group ID (64-char lowercase hex hash).
 */
export function isRawId(value: string): boolean {
  return isUuidLike(value) || HEX_ID_RE.test(value.trim());
}

/** True when `value` is the persisted direct-conversation key (`userId::peerId`). */
export function isCanonicalDirectKey(value: string): boolean {
  return value.includes('::');
}

/**
 * Extracts the peer's user ID from a DM group name formatted as `"userA::userB"`.
 * Returns `null` when the name does not match the pattern (i.e. for named group chats).
 */
export function parseDirectPeerFromName(rawName: string, userId: string): string | null {
  const parts = rawName
    .split('::')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const current = userId.toLowerCase();
  const unique = [...new Set(parts)];
  return unique.find((p) => p !== current) ?? null;
}

/** Canonical direct-conversation group name for a peer: `self::peer` (both lowercased). */
export function canonicalDirectName(userId: string, peerId: string): string {
  return `${userId.toLowerCase()}::${peerId.toLowerCase()}`;
}

/**
 * Resolves the peer userId of a direct conversation authoritatively.
 *
 * The group `name` is only a hint: legacy groups can carry a malformed name
 * (self-only, `self::self`, or empty) which makes {@link parseDirectPeerFromName} return
 * `null` and previously produced a "conversation with yourself". When the name is unusable
 * we fall back to the server-side user membership (`getGroupUserMembers`) and pick the sole
 * member that is not the current user - the actual MLS roster is the source of truth.
 *
 * Returns `null` only when the peer genuinely cannot be determined (transport failure, or a
 * roster that transiently contains just this user, e.g. mid re-add). Callers must treat a
 * null result as "unknown yet" and retry later rather than inventing a self peer.
 */
export async function resolveDirectPeerId(
  mlsService: Pick<IMlsService, 'getGroupUserMembers'>,
  groupId: string,
  rawName: string,
  userId: string,
  log?: (msg: string) => void
): Promise<string | null> {
  const self = userId.toLowerCase();
  const fromName = parseDirectPeerFromName(rawName, userId);
  if (fromName && fromName !== self) return fromName;

  try {
    const members = await mlsService.getGroupUserMembers(groupId);
    const peer = members.map((m) => m.userId.toLowerCase()).find((u) => u !== self) ?? null;
    if (peer) {
      log?.(
        `[DM_PEER] ${groupId.slice(0, 8)}... peer resolved from roster: ${peer.slice(0, 8)}... (name was malformed)`
      );
    } else {
      log?.(`[DM_PEER] ${groupId.slice(0, 8)}... roster has no peer yet - deferring`);
    }
    return peer;
  } catch (e) {
    log?.(
      `[DM_PEER] ${groupId.slice(0, 8)}... roster lookup failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}

/** Number of messages loaded from local DB on first display. Older messages load on scroll-up. */
export const INITIAL_MESSAGES_PAGE = 60;

/**
 * Resolves the conversations-map key for a MLS `groupId`.
 * Most entries use `groupId` as the key; legacy direct rows may use `userId::peerId`.
 */
export function findConversationKeyByGroupId(
  conversations: Map<string, Conversation>,
  groupId: string
): string | undefined {
  if (conversations.has(groupId)) return groupId;
  for (const [key, convo] of conversations) {
    if (convo.id === groupId) return key;
  }
  return undefined;
}

/**
 * Marks a conversation as remotely deleted (`deletedRemotely=true`) so the UI shows
 * the local-delete banner instead of silently keeping a live conversation shell.
 */
export function markConversationDeletedRemotely(
  conversations: Map<string, Conversation>,
  groupId: string,
  saveConversation?: (key: string) => Promise<void>
): boolean {
  const key = findConversationKeyByGroupId(conversations, groupId);
  if (!key) return false;
  const convo = conversations.get(key);
  if (!convo || convo.lifecycle === 'removed') return false;
  conversations.set(key, { ...convo, lifecycle: 'removed' });
  saveConversation?.(key).catch(() => {});
  return true;
}

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
 * - `"alice::bob"` - canonical direct conversation format.
 * - `"alice & bob"` - legacy two-participant format.
 * - `metaId` starts with `"dm_"` - explicit DM marker.
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
 * Prefer stored `conversationType` / `directPeerId` - re-parsing `conv.name` alone
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
    const peerRaw =
      input.directPeerId ??
      identity.directPeerId ??
      (input.contactName && !isCanonicalDirectKey(input.contactName)
        ? input.contactName
        : undefined) ??
      identity.contactName;
    if (!peerRaw?.trim()) {
      // Stale/partial row during route switch or MLS reload - avoid throwing on .toLowerCase().
      return {
        conversationType: 'group',
        contactId: input.id,
        displayName: input.fallbackDisplayName?.trim() || input.name.trim() || 'Discussion',
      };
    }
    const peerId = peerRaw.toLowerCase();

    const rawName = input.name.trim();
    const needsResolve =
      isCanonicalDirectKey(rawName) ||
      !rawName ||
      rawName.toLowerCase() === peerId ||
      isRawId(rawName);

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
    if (trimmed && !isRawId(trimmed) && !isCanonicalDirectKey(trimmed)) {
      return {
        conversationType: 'group',
        contactId: input.id,
        displayName: trimmed,
      };
    }
  }

  const fb = input.name.trim();
  return {
    conversationType: 'group',
    contactId: input.id,
    displayName: fb && !isRawId(fb) ? fb : 'Groupe',
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
  const directByPeer = new Map<string, ConversationMeta[]>();
  for (const meta of convMetas) {
    const identity = deriveConversationIdentity(meta.name, userId, meta.id);
    if (identity.conversationType !== 'direct' || !identity.directPeerId) continue;
    const peer = identity.directPeerId.toLowerCase();
    const list = directByPeer.get(peer) ?? [];
    list.push(meta);
    directByPeer.set(peer, list);
  }

  const canonicalByPeer = new Map<string, ConversationMeta>();
  const duplicatesToMerge: Array<{
    canonical: ConversationMeta;
    duplicate: ConversationMeta;
  }> = [];

  for (const [peer, metas] of directByPeer) {
    if (metas.length === 1) {
      canonicalByPeer.set(peer, metas[0]);
      continue;
    }

    // No successor chains anymore: each conversation is its own terminal.
    const resolved = metas.map((m) => ({ meta: m, terminalId: m.id }));

    const uniqueTerminals = new Set(resolved.map((r) => r.terminalId));
    let terminalId: string;
    let canonical: ConversationMeta;

    if (uniqueTerminals.size === 1) {
      terminalId = resolved[0].terminalId;
      canonical =
        metas.find((m) => m.id === terminalId) ??
        metas.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
      if (canonical.id !== terminalId) {
        canonical = { ...canonical, id: terminalId };
      }
    } else {
      // Vrais doublons indépendants (pas une chaîne de successeurs) : garder le plus récent.
      canonical = metas.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
      terminalId = canonical.id;
    }

    canonicalByPeer.set(peer, canonical);

    for (const meta of metas) {
      if (meta.id === canonical.id) continue;
      // Independent duplicates (same DM peer, concurrently created groups) are merged into the
      // canonical (most recent).
      duplicatesToMerge.push({ canonical, duplicate: meta });
    }
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
      // Supprimer le groupe orphelin côté serveur pour éviter qu'il réapparaisse
      // au prochain login via discoverMissingGroups.
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

  // Réinjecter le canonique re-keyé vers le terminal s'il n'était pas déjà dans la liste.
  for (const canonical of canonicalByPeer.values()) {
    if (merged.some((m) => m.id === canonical.id)) continue;
    try {
      await storage.saveConversation(canonical);
    } catch (e) {
      log(
        `[WARN] Echec persistance canonique ${canonical.id}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    merged.push(canonical);
  }

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
  /** Reactive map populated by this function - cleared and rebuilt on each call. */
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
 * conversations, prunes stale archived IDs, and reclassifies DMs via `getUserGroups`.
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

  // Preserve in-memory UI fields (avatars, resolved names) across reload - they are
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

  // Phase 1 - fast, immediately usable conversation stubs.
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
      lifecycle: meta.lifecycle,
      mlsStateHex: null,
      unreadCount: 0,
      conversationType: prev?.conversationType ?? identity.conversationType,
      directPeerId: prev?.directPeerId ?? identity.directPeerId,
      imageMediaId: prev?.imageMediaId ?? null,
      // Seed from DB so the sidebar can sort before messages are loaded.
      lastMessageAt: meta.updatedAt,
    });
  }

  // Phase 2 - decrypt stored messages + replay remote history.
  // Serialised (not parallel) because replayConversationHistory calls the shared
  // WASM MLS client which is not safe to invoke concurrently.
  //
  // The whole phase runs in one bulk-ingest window: replays defer their disk writes and a
  // single encrypted checkpoint is flushed at the end; only then are the per-conversation
  // progress markers (stream cursor / seen hashes) committed, so they never run ahead of
  // the persisted ratchet state.
  const pendingCommits: MlsReplayCommit[] = [];
  await withMlsBulkIngest(ctx.mlsService, async () => {
    let serverGroupIndex = null;
    try {
      const groups = await ctx.mlsService.getUserGroups(ctx.userId);
      serverGroupIndex = buildUserGroupSyncIndex(groups);
    } catch {
      ctx.log('[WARN] getUserGroups indisponible — classification DM/groupe depuis le cache local');
    }

    const replayMetas = mergedConvMetas.filter((m) => !isChannelConversationId(m.id));
    let batchFirstPages: Map<string, import('$lib/mls-client/historyTypes').HistoryStreamRow[]> =
      new Map();
    if (replayMetas.length > 0 && ctx.mlsService.fetchHistoryBatch) {
      try {
        batchFirstPages = await ctx.mlsService.fetchHistoryBatch(
          replayMetas.map((meta) => ({
            groupId: meta.id,
            afterStreamId: readHistoryStreamCursor(ctx.userId, meta.id),
          }))
        );
        ctx.log(`[CATCHUP] batch history: ${batchFirstPages.size} groupe(s) en 1 requête`);
      } catch (e) {
        ctx.log(
          `[WARN] batch history échoué: ${e instanceof Error ? e.message : String(e)} — fallback séquentiel`
        );
      }
    }

    for (const meta of mergedConvMetas) {
      if (isChannelConversationId(meta.id)) {
        await ctx.storage.deleteMessagesForConversation(meta.id).catch(() => {});
        continue;
      }
      try {
        const existingConvo = ctx.conversations.get(meta.id);
        if (existingConvo && !isChannelConversationId(meta.id) && serverGroupIndex) {
          const row = serverGroupIndex.byGroupId.get(meta.id);
          if (row?.isGroup === false) {
            // Repair a DM whose peer identity is corrupted: either misclassified as a group,
            // or stored as direct but with a missing/self peer (legacy self-only group name).
            // resolveDirectPeerId falls back to the authoritative roster when the name is unusable.
            const self = ctx.userId.toLowerCase();
            const currentPeer = (existingConvo.directPeerId ?? '').toLowerCase();
            const needsRepair =
              (existingConvo.conversationType ?? 'group') !== 'direct' ||
              !currentPeer ||
              currentPeer === self;
            if (needsRepair) {
              const peer = await resolveDirectPeerId(
                ctx.mlsService,
                meta.id,
                row.name ?? meta.name,
                ctx.userId,
                ctx.log
              );
              if (peer && peer !== self) {
                ctx.conversations.set(meta.id, {
                  ...existingConvo,
                  conversationType: 'direct',
                  directPeerId: peer,
                  contactName: peer,
                  name: peer,
                });
                const normalizedName = canonicalDirectName(ctx.userId, peer);
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
        const commit = await replayConversationHistory({
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
          primedFirstPage: batchFirstPages.get(meta.id),
        });
        if (commit) pendingCommits.push(commit);
        // Reload from DB after network sync so display reflects new messages
        const refreshed = await ctx.storage.getMessagesPage(
          meta.id,
          ctx.pin,
          INITIAL_MESSAGES_PAGE
        );
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
  });

  // Encrypted checkpoint has flushed: durable progress markers are now safe to record.
  for (const commit of pendingCommits) commit();
}
