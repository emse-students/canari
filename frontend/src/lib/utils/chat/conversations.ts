/**
 * Plain async helpers for conversation loading, de-duplication, and archive
 * persistence. These are pure functions that accept state by reference so they
 * work with Svelte 5's $state without requiring a specific composable wrapper.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { IStorage, ConversationMeta, StoredMessage } from '$lib/db';
import { mapStoredMessagesToChatMessages, replayConversationHistory } from './history';
import { migrateFromLocalStorage } from '../migration';
import type { IMlsService } from '$lib/mlsService';
import type { Conversation } from '$lib/types';

// ---------- Archive persistence ----------

export function archiveStorageKey(uid: string): string {
  return `canari_archived_conversations_${uid.toLowerCase()}`;
}

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

export function persistArchivedConversations(uid: string, ids: string[]) {
  localStorage.setItem(archiveStorageKey(uid), JSON.stringify([...new Set(ids)]));
}

// ---------- Direct-conversation identity ----------

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

  if (normalizedName.includes('::')) {
    const [a, b] = normalizedName.split('::').map((v) => v.trim().toLowerCase());
    const peer = a === userId.toLowerCase() ? b : a;
    return { conversationType: 'direct', contactName: peer, displayName: peer, directPeerId: peer };
  }

  if (normalizedName.includes(' & ')) {
    const participants = normalizedName
      .split(' & ')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
    if (participants.length === 2 && participants.includes(userId.toLowerCase())) {
      const peer = participants.find((p) => p !== userId.toLowerCase()) || participants[0];
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
    if (peer && peer !== userId.toLowerCase()) {
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

// ---------- De-duplication ----------

export async function mergeDirectConversationDuplicates(
  convMetas: ConversationMeta[],
  userId: string,
  pin: string,
  storage: IStorage,
  log: (msg: string) => void
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
    } catch {
      normalizedMetas.push(meta);
    }
  }

  return normalizedMetas;
}

// ---------- Full conversation load ----------

export interface LoadConversationsContext {
  userId: string;
  pin: string;
  storage: IStorage;
  mlsService: IMlsService;
  conversations: SvelteMap<string, Conversation>;
  messageReactions: SvelteMap<string, any>;
  archivedConversationIds: string[];
  historyBaseUrl: string;
  log: (msg: string) => void;
  onArchivedIdsChange: (ids: string[]) => void;
  addMessageToChat: (
    senderId: string,
    content: string,
    contactName: string,
    replyTo?: { id: string; senderId: string; content: string },
    isSystem?: boolean,
    messageId?: string,
    timestamp?: Date
  ) => Promise<void>;
}

export async function loadExistingConversations(ctx: LoadConversationsContext) {
  await migrateFromLocalStorage(ctx.userId, ctx.pin, ctx.storage, ctx.log);

  const convMetas = await ctx.storage.getConversations();
  const mergedConvMetas = await mergeDirectConversationDuplicates(
    convMetas,
    ctx.userId,
    ctx.pin,
    ctx.storage,
    ctx.log
  );

  const validConversationIds = new Set(mergedConvMetas.map((meta) => meta.id.toLowerCase()));
  const prunedArchivedIds = ctx.archivedConversationIds.filter((id) =>
    validConversationIds.has(id)
  );
  if (prunedArchivedIds.length !== ctx.archivedConversationIds.length) {
    ctx.onArchivedIdsChange(prunedArchivedIds);
    persistArchivedConversations(ctx.userId, prunedArchivedIds);
  }

  ctx.conversations.clear();
  ctx.messageReactions.clear();

  // Phase 1 — fast, immediately usable conversation stubs.
  for (const meta of mergedConvMetas) {
    const identity = deriveConversationIdentity(meta.name, ctx.userId, meta.id);
    ctx.conversations.set(meta.id, {
      contactName: identity.contactName,
      name: identity.displayName,
      groupId: meta.groupId,
      messages: [],
      isReady: meta.isReady,
      mlsStateHex: null,
      unreadCount: 0,
      conversationType: identity.conversationType,
      directPeerId: identity.directPeerId,
    });
  }

  // Phase 2 — decrypt stored messages + replay remote history in parallel.
  for (const meta of mergedConvMetas) {
    (async () => {
      try {
        const storedMessages = await ctx.storage.getMessages(meta.id, ctx.pin);
        const msgs = mapStoredMessagesToChatMessages(storedMessages, ctx.userId);
        const existing = ctx.conversations.get(meta.id);
        if (existing && msgs.length > 0) {
          ctx.conversations.set(meta.id, { ...existing, messages: msgs });
        }
        await replayConversationHistory({
          mlsService: ctx.mlsService,
          groupId: meta.groupId,
          contactName: meta.id,
          userId: ctx.userId,
          pin: ctx.pin,
          addMessageToChat: ctx.addMessageToChat,
          getConversation: (name) => ctx.conversations.get(name),
          setConversation: (name, next) => ctx.conversations.set(name, next),
          messageReactions: ctx.messageReactions,
          log: ctx.log,
        });
      } catch {
        // Resilient: keep loading other conversations.
      }
    })();
  }
}
