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
import { apiFetch } from '$lib/utils/apiFetch';

/** Number of messages loaded from local DB on first display. Older messages load on scroll-up. */
const INITIAL_MESSAGES_PAGE = 60;

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

// ---------- De-duplication ----------

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
}

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

  ctx.conversations.clear();
  ctx.messageReactions.clear();

  // Phase 1 — fast, immediately usable conversation stubs.
  for (const meta of mergedConvMetas) {
    const identity = deriveConversationIdentity(meta.name, ctx.userId, meta.id);
    ctx.conversations.set(meta.id, {
      id: meta.id,
      contactName: identity.contactName,
      name: identity.displayName,
      messages: [],
      isReady: meta.isReady,
      mlsStateHex: null,
      unreadCount: 0,
      conversationType: identity.conversationType,
      directPeerId: identity.directPeerId,
    });
  }

  // Phase 2 — decrypt stored messages + replay remote history in parallel.
  const phase2Promises: Promise<void>[] = [];
  for (const meta of mergedConvMetas) {
    phase2Promises.push(
      (async () => {
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
                const gRes = await apiFetch(`${ctx.historyBaseUrl}/api/mls-api/groups/${meta.id}`);
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
                const res = await apiFetch(
                  `${ctx.historyBaseUrl}/api/mls-api/groups/${meta.id}/members`
                );
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
          const msgs = mapStoredMessagesToChatMessages(storedMessages, ctx.userId);
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
          const refreshed = await ctx.storage.getMessagesPage(
            meta.id,
            ctx.pin,
            INITIAL_MESSAGES_PAGE
          );
          const refreshedMsgs = mapStoredMessagesToChatMessages(refreshed, ctx.userId);
          const current = ctx.conversations.get(meta.id);
          if (current) {
            ctx.conversations.set(meta.id, { ...current, messages: refreshedMsgs });
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
      })()
    );
  }
  await Promise.allSettled(phase2Promises);
}
