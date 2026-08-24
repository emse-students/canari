/**
 * Reactive composable owning all conversation state and operations:
 * - The conversations SvelteMap
 * - Selection, archive/restore
 * - Group members + membership verification
 * - Group-level operations (create, rename, delete, invite, kick)
 * - Storage helpers (save, load history, reload)
 */
import { SvelteDate, SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { IStorage } from '$lib/db';
import type { IMlsService } from '$lib/mlsService';
import type {
  AddMessageToChatOptions,
  MessageReaction,
  Conversation,
  ChatMessage,
} from '$lib/types';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import { chat_system_removed_from_group } from '$lib/paraglide/messages';
import { withMlsBulkIngest } from '$lib/mls-client/mlsBulkIngest';
import { notifNav } from '$lib/stores/notifNav.svelte';
import { resolveConversationKey } from '$lib/utils/chat/openConversationFromId';
import { setPollMeta } from '$lib/stores/pollStore.svelte';
import { applyChannelReactionFrame } from '$lib/stores/reactionStore.svelte';
import {
  fetchUniqueGroupMembers,
  removeMemberAndBroadcast,
  renameGroupAndBroadcast,
  setGroupImageAndBroadcast,
  deleteGroupAndBroadcast,
  leaveGroupAndBroadcast,
  isGroupActiveOnServer,
  purgeOrphanGroup,
  historyRangeStartFor,
  sendHistoryRangeRequest,
} from '$lib/utils/chat/groupActions';
import { membershipIsDurablyLost, readLocalMembership } from '$lib/utils/chat/eviction';
import { NotAGroupMemberError } from '$lib/mls-client/mlsDeliveryApi';
import { digestIdentity } from '$lib/utils/chat/historyDigestRendezvous';
import {
  createNewGroup as createGroup,
  inviteMembersToGroup,
  startNewConversation as startConversation,
} from '$lib/utils/chat/groupCreation';
import { requestReAdd } from '$lib/utils/chat/recovery';
import {
  findConversationKeyByGroupId,
  loadExistingConversations,
  purgeConversation,
  retireConversation,
  toConversationMeta,
  INITIAL_MESSAGES_PAGE,
} from '$lib/utils/chat/conversations';
import { compareMessageOrder } from '$lib/utils/chat/messageOrder';
import { mergeMessagePage } from '$lib/utils/chat/messageMerge';
import {
  mapStoredMessagesToChatMessages,
  readHistoryStreamCursor,
  replayConversationHistory,
  retroactivelyResolveHexIds,
} from '$lib/utils/chat/history';
import {
  pushHistoryOverlay,
  closeHistoryOverlayFromUi,
  abandonHistoryOverlay,
  isMobileOverlayLayout,
} from '$lib/utils/historyOverlayStack';

/** Messages loaded per scroll-up DB page request. */
const OLDER_MESSAGES_PAGE = 50;

/**
 * How many messages one scrollback ask may bring back.
 *
 * A page, not a store: the reader asks again by scrolling further, so this bounds the answer without
 * bounding what they can eventually reach. Matched to {@link OLDER_MESSAGES_PAGE} so a page fetched
 * from a peer fills the list exactly as a page read from disk does.
 */
const SCROLLBACK_PAGE = OLDER_MESSAGES_PAGE;
/** Skip channel REST history refetch when the in-memory copy was loaded recently. */
const CHANNEL_HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;

/** Runtime dependencies injected into all conversation and group operations. */
export interface ConversationContext {
  /** The live storage instance (null until logged in). */
  storage: IStorage | null;
  /** Returns (or lazily creates) the active MLS service. */
  ensureMls: () => IMlsService;
  userId: string;
  deviceKeyB64: string;
  historyBaseUrl: string;
  messageReactions: SvelteMap<string, MessageReaction[]>;
  log: (msg: string) => void;
  addMessageToChat: (
    senderId: string,
    content: string,
    contactName: string,
    options?: AddMessageToChatOptions
  ) => Promise<void>;
  batchAddMessages?: (
    messages: Array<{ senderId: string; content: string } & AddMessageToChatOptions>,
    contactName: string
  ) => Promise<void>;
}

/** Creates and returns the reactive conversation store with all selection, history, group, and storage operations. */
export function useConversations() {
  const conversations = new SvelteMap<string, Conversation>();

  // ── UI state ──────────────────────────────────────────────────────────────
  let selectedContact = $state<string | null>(null);
  let isConversationDrawerOpen = $state(false);
  // Desktop (xl+) shows the members panel inline by default; mobile uses this same flag to
  // gate a full-screen overlay drawer, which must start closed.
  let isChannelMembersDrawerOpen = $state(!isMobileOverlayLayout());
  let isChannelSettingsModalOpen = $state(false);
  let groupMembers = $state<string[]>([]);
  // Optimistic invite feedback: user IDs with an add-member operation in flight,
  // keyed by group so a mid-invite conversation switch never leaks pending rows.
  let pendingInvites = $state<{ groupId: string; ids: string[] } | null>(null);
  let isLoadingHistory = $state(false);
  // True once the initial IndexedDB restore has populated the map, so consumers (e.g. the
  // /posts mini-panel) can treat the live map as authoritative and reflect deletions
  // instead of resurrecting stale rows from their own snapshot.
  let conversationsRestored = $state(false);
  let sendError = $state('');

  // ── Input state ───────────────────────────────────────────────────────────
  let newContactInput = $state('');
  let newGroupInput = $state('');
  let newChannelInput = $state('');
  let chatContainer = $state<HTMLElement | undefined>(undefined);

  // Short-lived cache so rapid successive sends don't re-check membership via HTTP
  const membershipCache = new SvelteMap<string, { isMember: boolean; expiresAt: number }>();
  /** When a channel history was last fetched from the API (per user + channel). */
  const channelHistoryLoadedAt = new SvelteMap<string, { loadedAt: number; userId: string }>();

  function invalidateChannelHistoryCache(channelConversationId?: string) {
    if (channelConversationId) channelHistoryLoadedAt.delete(channelConversationId);
    else channelHistoryLoadedAt.clear();
  }

  let mobileConvoHistoryClose: (() => void) | null = null;
  let drawerHistoryClose: (() => void) | null = null;
  let channelMembersDrawerHistoryClose: (() => void) | null = null;

  function ensureMobileConvoHistory() {
    if (!isMobileOverlayLayout() || !selectedContact || mobileConvoHistoryClose) return;
    mobileConvoHistoryClose = () => {
      mobileConvoHistoryClose = null;
      selectedContact = null;
      isConversationDrawerOpen = false;
    };
    pushHistoryOverlay(mobileConvoHistoryClose);
  }

  function ensureDrawerHistory() {
    if (!isMobileOverlayLayout() || !isConversationDrawerOpen || drawerHistoryClose) return;
    drawerHistoryClose = () => {
      drawerHistoryClose = null;
      isConversationDrawerOpen = false;
    };
    pushHistoryOverlay(drawerHistoryClose);
  }

  function ensureChannelMembersDrawerHistory() {
    if (
      !isMobileOverlayLayout() ||
      !isChannelMembersDrawerOpen ||
      channelMembersDrawerHistoryClose
    ) {
      return;
    }
    channelMembersDrawerHistoryClose = () => {
      channelMembersDrawerHistoryClose = null;
      isChannelMembersDrawerOpen = false;
    };
    pushHistoryOverlay(channelMembersDrawerHistoryClose);
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  /**
   * Resolves the open conversation synchronously.
   * Iterates the map so Svelte 5 tracks set/delete; shallow-clones the entry so prop
   * consumers (ChatArea on Android WebView) always see a fresh reference when messages
   * or flags change.
   */
  const currentConvo = $derived.by(() => {
    const key = selectedContact;
    if (!key) return null;
    for (const [k, v] of conversations) {
      if (k !== key) continue;
      void v.messages.length;
      void v.lastMessageAt;
      void v.lifecycle;
      void v.unreadCount;
      return { ...v, messages: v.messages };
    }
    return null;
  });

  /**
   * Clears selection when the map no longer has the key (reload, migration, channel kick).
   * `$effect.root` - this composable is instantiated at module load in `globalChatSingleton`.
   *
   * A key absent from the map does NOT always mean the conversation is gone: the map is emptied
   * and rebuilt wholesale by the IndexedDB restore, and pruned on every community refetch, so a
   * deep-link target is routinely missing for as long as a network round trip. Clearing then is
   * what left every deep link in the right tab with nothing open. While the target is still being
   * landed the selection is kept, and the landing itself decides when to give up.
   */
  $effect.root(() => {
    $effect(() => {
      const key = selectedContact;
      if (!key) return;
      if (!conversations.has(key)) {
        if (notifNav.pending === key) return;
        selectedContact = null;
        sendError = '';
      }
    });
  });

  // ── Storage helpers ───────────────────────────────────────────────────────

  /** Persists a conversation's metadata row (see `toConversationMeta` for what it carries). */
  async function saveConversation(id: string, ctx: ConversationContext) {
    if (!ctx.storage) return;
    const convo = conversations.get(id);
    if (!convo) return;
    await ctx.storage.saveConversation(toConversationMeta(id, convo, ctx.userId));
  }

  /** Fetches and decrypts conversation history from the network, then reloads the latest page from IndexedDB. For channel conversations delegates to loadChannelHistory instead of MLS replay. */
  async function loadHistoryForConversation(
    contactName: string,
    id: string,
    ctx: ConversationContext,
    options?: { force?: boolean }
  ) {
    // Channel conversations: load via REST API instead of MLS replay
    if (isChannelConversationId(contactName)) {
      await loadChannelHistory(contactName, ctx, options?.force);
      return;
    }

    const isSelected = selectedContact === contactName;
    if (isSelected) isLoadingHistory = true;
    try {
      // Fast-path: when user clicks a conversation, probe the server cursor with `limit=1`.
      // If there is nothing new, skip the heavy decrypt/replay and just render the latest
      // IndexedDB page we already have.
      if (!options?.force && ctx.storage) {
        const cursor = readHistoryStreamCursor(ctx.userId, id);
        if (cursor) {
          const existingPage = await ctx.storage.getMessagesPage(
            id,
            ctx.deviceKeyB64,
            INITIAL_MESSAGES_PAGE
          );
          // If local DB is empty, let `replayConversationHistory` handle cursor reset safely.
          if (existingPage.length > 0) {
            try {
              const probe = await ctx.ensureMls().fetchHistory(id, cursor, 1);
              if (probe.rows.length === 0) {
                const msgs = await retroactivelyResolveHexIds(
                  mapStoredMessagesToChatMessages(existingPage, ctx.userId),
                  ctx.storage,
                  id,
                  ctx.deviceKeyB64
                );
                const current = conversations.get(contactName);
                if (current) {
                  conversations.set(contactName, {
                    ...current,
                    messages: mergeMessagePage(current.messages, msgs),
                  });
                  for (const m of msgs) {
                    if (m.reactions && m.reactions.length > 0) {
                      ctx.messageReactions.set(m.id, m.reactions);
                    }
                  }
                }
                return;
              }
            } catch {
              /* non-blocking: fallback to full replay */
            }
          }
        }
      }

      // Fetch from network → decrypt → save to DB (no direct UI update).
      // The replay runs in a bulk-ingest window so an encrypted checkpoint flushes on close;
      // its progress markers are committed only afterwards (never ahead of persisted state).
      try {
        const commit = await withMlsBulkIngest(ctx.ensureMls(), () =>
          replayConversationHistory({
            mlsService: ctx.ensureMls(),
            id,
            contactName,
            userId: ctx.userId,
            deviceKeyB64: ctx.deviceKeyB64,
            storage: ctx.storage,
            getConversation: (name) => conversations.get(name),
            setConversation: (name, next) => conversations.set(name, next),
            saveConversation: (name) => saveConversation(name, ctx),
            messageReactions: ctx.messageReactions,
            log: ctx.log,
          })
        );
        commit?.();
        // Reload from DB so display reflects the latest saved state
        if (ctx.storage) {
          const refreshed = await ctx.storage.getMessagesPage(
            id,
            ctx.deviceKeyB64,
            INITIAL_MESSAGES_PAGE
          );
          const msgs = await retroactivelyResolveHexIds(
            mapStoredMessagesToChatMessages(refreshed, ctx.userId),
            ctx.storage,
            id,
            ctx.deviceKeyB64
          );
          const current = conversations.get(contactName);
          if (current) {
            conversations.set(contactName, {
              ...current,
              messages: mergeMessagePage(current.messages, msgs),
            });
            for (const m of msgs) {
              if (m.reactions && m.reactions.length > 0) {
                ctx.messageReactions.set(m.id, m.reactions);
              }
            }
          }
        }
      } catch (e) {
        // Previously unhandled: this call is fired with `void` by every caller, so a throw here
        // (network hiccup, decrypt error, IndexedDB contention - all realistic during a
        // cold-started app's many concurrent init steps) left `conversation.messages` never
        // updated, with NOTHING logged anywhere - the empty conversation this leaves behind had
        // no trace of why. `isLoadingHistory` still clears via `finally` below, so the skeleton
        // stops showing regardless, which is exactly what made this indistinguishable from a
        // conversation that genuinely has no history.
        ctx.log(
          `[HISTORY] Échec chargement historique (${id.slice(0, 8)}…): ${e instanceof Error ? e.message : e}`
        );
      }
    } finally {
      if (isSelected) isLoadingHistory = false;
    }
  }

  /** Loads channel history from the server (source of truth) into memory only - never IndexedDB. */
  async function loadChannelHistory(
    channelConversationId: string,
    ctx: ConversationContext,
    force = false
  ) {
    const { channelService } = await import('$lib/services/ChannelService');
    const { decodeChannelMessageRow } = await import('$lib/utils/chat/channelCrypto');

    const rawId = channelConversationId.replace(/^channel_/, '');
    const convo = conversations.get(channelConversationId);
    if (!convo) return;

    const cached = channelHistoryLoadedAt.get(channelConversationId);
    if (
      !force &&
      cached &&
      cached.userId === ctx.userId &&
      Date.now() - cached.loadedAt < CHANNEL_HISTORY_CACHE_TTL_MS
    ) {
      return;
    }

    const isSelected = selectedContact === channelConversationId;
    if (isSelected) isLoadingHistory = true;

    try {
      if (ctx.storage) {
        await ctx.storage.deleteMessagesForConversation(channelConversationId).catch(() => {});
      }
      // Nothing to hydrate: a Graine seed is already in the local store or it is not, and the
      // server holds none to fetch. A row this device has no seed for is REPORTED unreadable by
      // `decodeChannelMessageRow` rather than silently skipped, and repaired by WP-33.
      const rows = await channelService.listMessages(rawId, 200);
      const loaded: ChatMessage[] = [];
      const meLower = ctx.userId.toLowerCase();

      if (Array.isArray(rows)) {
        for (const msg of rows) {
          const decoded = await decodeChannelMessageRow(rawId, msg, meLower);
          if (!decoded) continue;
          // A reaction is a row of its own now (WP-40): it changes a bubble instead of being one.
          // Merged by the same last-write-wins rule everywhere, so the order the page is read in
          // cannot change the result - including a reaction read before the message it lands on.
          if (decoded.kind === 'reaction') {
            const r = decoded.reaction;
            applyChannelReactionFrame(r.targetMessageId, r.senderId, r.emoji, r.at, r.removed);
            continue;
          }

          // Seed the live poll tally from the server row, keyed by the server id.
          if (msg.poll) setPollMeta(String(msg.id), msg.poll);

          loaded.push({
            id: decoded.message.id,
            senderId: decoded.message.senderId,
            content: decoded.message.content,
            timestamp: decoded.message.timestamp,
            isOwn: decoded.message.isOwn,
            isSystem: decoded.message.isSystem,
          });
        }
      }

      loaded.sort(compareMessageOrder);

      const current = conversations.get(channelConversationId);
      if (current) {
        // Same race as the DM path, and worse: decrypting 200 channel rows takes seconds, and every
        // live message posted meanwhile used to be discarded when this resolved.
        conversations.set(channelConversationId, {
          ...current,
          messages: mergeMessagePage(current.messages, loaded),
        });
        channelHistoryLoadedAt.set(channelConversationId, {
          loadedAt: Date.now(),
          userId: ctx.userId,
        });
      }
    } catch (e) {
      ctx.log(`[CHANNEL] Échec chargement historique: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (isSelected) isLoadingHistory = false;
    }
  }

  /**
   * Full-text search over a channel's ENTIRE history (channels keep only the most recent page in
   * memory and are never persisted locally). Pages the whole channel from the server, decrypts each
   * message, and matches the human-readable preview text. As a side effect it merges the fetched
   * history into the conversation so every hit is rendered and the UI can scroll to it. Returns the
   * matching message IDs oldest-first (the order ChatArea expects), capped at ~2000 messages.
   */
  async function searchChannelHistory(
    channelConversationId: string,
    query: string,
    ctx: ConversationContext
  ): Promise<string[]> {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];

    const { channelService } = await import('$lib/services/ChannelService');
    const { decodeChannelMessageRow } = await import('$lib/utils/chat/channelCrypto');
    const { getPreviewText, parseEnvelope } = await import('$lib/envelope');

    const rawId = channelConversationId.replace(/^channel_/, '');
    const meLower = ctx.userId.toLowerCase();

    const { rows, capped } = await channelService.fetchAllChannelMessages(channelConversationId, {
      cap: 2000,
    });

    const decodedAll: ChatMessage[] = [];
    const matches: { id: string; ts: number }[] = [];
    for (const row of rows) {
      const decoded = await decodeChannelMessageRow(rawId, row, meLower);
      if (!decoded) continue;
      if (decoded.kind === 'reaction') {
        // Searching the whole history is also the widest sweep of reaction frames there is, so it
        // merges them rather than dropping them - a search must not cost a message its hearts.
        const r = decoded.reaction;
        applyChannelReactionFrame(r.targetMessageId, r.senderId, r.emoji, r.at, r.removed);
        continue;
      }
      const message = decoded.message;
      if (row.poll) setPollMeta(String(row.id), row.poll);
      decodedAll.push({
        id: message.id,
        senderId: message.senderId,
        content: message.content,
        timestamp: message.timestamp,
        isOwn: message.isOwn,
        isSystem: message.isSystem,
      });
      let text = message.content;
      try {
        text = getPreviewText(parseEnvelope(message.content));
      } catch {
        /* fall back to the raw content */
      }
      if (text.toLowerCase().includes(q)) {
        matches.push({ id: message.id, ts: message.timestamp.getTime() });
      }
    }

    // Merge the full fetched history into the conversation (union by id, keeping optimistic/pending
    // local messages) so a hit older than the loaded page is present and scrollable.
    //
    // WRITTEN ONLY WHEN THE MERGE ACTUALLY ADDS SOMETHING. This used to `set` unconditionally, and a
    // `set` mints a new conversation object whether or not its contents changed - which made this
    // function retrigger whatever was watching the conversation, including the effect that had just
    // called it. Measured by the campaign's SEARCH-4 on 2026-08-22: one search in a 1052-message
    // channel issued 4956 requests to `/messages` and was still going ten minutes later, never
    // settling on a result, because every pass rewrote the object that caused the next pass.
    const current = conversations.get(channelConversationId);
    if (current) {
      const existingIds = new SvelteSet(current.messages.map((m) => m.id));
      const added = decodedAll.filter((m) => !existingIds.has(m.id));
      if (added.length) {
        const merged = [...current.messages, ...added].sort(compareMessageOrder);
        conversations.set(channelConversationId, { ...current, messages: merged });
      }
    }

    if (capped) {
      ctx.log(`[CHANNEL] Search covered the ${rows.length} most recent messages (history capped)`);
    }

    return matches.sort((a, b) => a.ts - b.ts).map((m) => m.id);
  }

  /** Reads all saved conversations from IndexedDB, verifies MLS state consistency, and populates the conversations map. */
  async function loadAndRestoreConversations(ctx: ConversationContext) {
    if (!ctx.storage) return;
    try {
      await loadExistingConversations({
        userId: ctx.userId,
        deviceKeyB64: ctx.deviceKeyB64,
        storage: ctx.storage,
        mlsService: ctx.ensureMls(),
        conversations,
        messageReactions: ctx.messageReactions,
        archivedConversationIds: [],
        historyBaseUrl: ctx.historyBaseUrl,
        log: ctx.log,
        onArchivedIdsChange: () => {},
      });
    } finally {
      conversationsRestored = true;
      // A frame that reached the handler while this map was still empty was left in the server
      // queue rather than dropped. The restore finishing is what makes it readable, so it is the
      // trigger to ask again - there is no timer waiting to notice.
      ctx.ensureMls().notifyConversationsRestored();
    }
  }

  /**
   * Load a page of older messages from local DB and prepend them to the conversation.
   * Returns true if there may be more, false if the DB is exhausted.
   */
  async function loadOlderMessages(
    contactName: string,
    ctx: ConversationContext
  ): Promise<boolean> {
    if (isChannelConversationId(contactName)) return false;
    if (!ctx.storage) return false;
    const convo = conversations.get(contactName);
    if (!convo) return false;

    const timestamps = convo.messages.map((m) =>
      m.timestamp instanceof Date
        ? m.timestamp.getTime()
        : new SvelteDate(m.timestamp as any).getTime()
    );
    const beforeTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : undefined;

    const older = await ctx.storage.getMessagesPage(
      convo.id,
      ctx.deviceKeyB64,
      OLDER_MESSAGES_PAGE,
      beforeTimestamp
    );
    if (older.length === 0) return false;

    const mapped = await retroactivelyResolveHexIds(
      mapStoredMessagesToChatMessages(older, ctx.userId),
      ctx.storage ?? null,
      convo.id,
      ctx.deviceKeyB64
    );

    const current = conversations.get(contactName);
    if (!current) return false;

    const existingIds = new SvelteSet(current.messages.map((m) => m.id));
    const merged = [...mapped.filter((m) => !existingIds.has(m.id)), ...current.messages].sort(
      compareMessageOrder
    );

    conversations.set(contactName, { ...current, messages: merged });
    return older.length === OLDER_MESSAGES_PAGE;
  }

  /**
   * Asks a peer for the page BELOW what this device holds, once the local store is exhausted.
   *
   * The scrollback. It exists because the device window is finite - ninety days on the web - so a
   * browser that never received the older past has no way to obtain it except from a member that
   * did. Same election and same rendezvous as the reconciliation, different boundary: this one is
   * driven by a reader scrolling, not by a connection.
   *
   * Bounded by construction: it asks for the page immediately before the oldest message it holds,
   * and the reader asks again by scrolling further. A conversation of any size is paged the same way.
   *
   * @returns `asked` when a peer was elected and the ask went out - the messages arrive later, as an
   *          ordinary bundle; `no-peer` when nobody was online to answer, which is the one outcome
   *          worth telling the reader about; `unavailable` when this device cannot ask at all.
   */
  async function requestOlderFromPeers(
    contactName: string,
    ctx: ConversationContext
  ): Promise<'asked' | 'no-peer' | 'unavailable'> {
    if (isChannelConversationId(contactName)) return 'unavailable';
    const convo = conversations.get(contactName);
    if (!convo || !ctx.storage) return 'unavailable';

    const timestamps = convo.messages
      .map((m) =>
        m.timestamp instanceof Date
          ? m.timestamp.getTime()
          : new SvelteDate(m.timestamp as any).getTime()
      )
      .filter((t) => Number.isFinite(t));
    // Nothing held means nothing to ask BEFORE. That case is the reconciliation's, not this one's:
    // an empty conversation is repaired by the state key comparison on connect.
    if (timestamps.length === 0) return 'unavailable';
    const before = Math.min(...timestamps);

    const since = await historyRangeStartFor(convo.id, ctx.storage);
    if (before <= since) {
      // We already hold everything down to the floor of our own window. There is nothing below it
      // that anybody is entitled to send us.
      ctx.log(`[HISTORY_RANGE] ${convo.id.slice(0, 8)}… already reaches its floor - not asking`);
      return 'unavailable';
    }

    const mls = ctx.ensureMls();
    let outcome;
    try {
      outcome = await mls.sendHistoryRequest(convo.id);
    } catch (e) {
      ctx.log(`[HISTORY_RANGE] could not reach the service: ${String(e).slice(0, 120)}`);
      return 'no-peer';
    }
    if (outcome?.noPeerOnline) return 'no-peer';

    const sent = await sendHistoryRangeRequest(
      convo.id,
      {
        from: digestIdentity(ctx.userId, mls.getDeviceId()),
        before,
        limit: SCROLLBACK_PAGE,
        since,
      },
      { mlsService: mls, log: ctx.log }
    );
    return sent ? 'asked' : 'unavailable';
  }

  // ── Selection + navigation ────────────────────────────────────────────────

  function dismissChannelMembersDrawerIfAny() {
    if (!channelMembersDrawerHistoryClose) {
      isChannelMembersDrawerOpen = false;
      return;
    }
    const ref = channelMembersDrawerHistoryClose;
    channelMembersDrawerHistoryClose = null;
    isChannelMembersDrawerOpen = false;
    abandonHistoryOverlay(ref);
  }

  /** Selects a conversation (sets selectedContact, clears unread badge and send error). Use this version when no ctx is available (e.g. from channel event handlers). */
  function dismissDrawerHistoryIfAny() {
    if (!drawerHistoryClose) return;
    const ref = drawerHistoryClose;
    drawerHistoryClose = null;
    isConversationDrawerOpen = false;
    abandonHistoryOverlay(ref);
  }

  /**
   * Ends a deep-link landing as soon as the user opens something else, so its target stops being
   * protected from the selection watchdog. The landing itself selects its own target, so a call
   * naming that target is the landing at work and must not cancel it.
   *
   * "Naming that target" is a comparison of a MAP KEY against a pending GROUP ID, and those differ
   * for every DM - so the raw string check ended the landing on the landing's own call. The target
   * then lost its protection immediately and the IndexedDB restore dropped the selection moments
   * later: the tap arrived on the right tab, on no conversation. Resolve before comparing.
   */
  function endLandingUnlessTarget(name: string | null) {
    const pending = notifNav.pending;
    if (!pending || pending === name) return;
    if (resolveConversationKey(conversations, pending) === name) return;
    notifNav.clear();
  }

  function selectConversation(name: string) {
    endLandingUnlessTarget(name);
    dismissDrawerHistoryIfAny();
    dismissChannelMembersDrawerIfAny();
    selectedContact = name;
    sendError = '';
    const convo = conversations.get(name);
    if (convo) conversations.set(name, { ...convo, unreadCount: 0 });
    if (convo?.id) {
      void loadGroupMembers(convo.id, null);
    }
    ensureMobileConvoHistory();
  }

  /** Call this version when you have the ctx available (inside handlers). */
  function selectConversationWithCtx(name: string, ctx: ConversationContext) {
    endLandingUnlessTarget(name);
    dismissDrawerHistoryIfAny();
    dismissChannelMembersDrawerIfAny();
    selectedContact = name;
    sendError = '';
    const convo = conversations.get(name);
    if (convo) conversations.set(name, { ...convo, unreadCount: 0 });
    if (convo?.id) {
      void loadGroupMembers(convo.id, ctx);
      void verifyCurrentUserMembership(name, ctx);
    }
    ensureMobileConvoHistory();
  }

  /** Deselects the active conversation and closes the drawer (mobile back-button action). */
  function goBackToMenu() {
    // Backing out of the thread ends any landing, or the target would be re-selected instantly.
    endLandingUnlessTarget(null);
    isChannelSettingsModalOpen = false;
    dismissChannelMembersDrawerIfAny();
    if (mobileConvoHistoryClose) {
      // Clear state synchronously so any rapid click on a new conversation after
      // pressing back pushes a fresh history overlay rather than reusing the stale one.
      // abandonHistoryOverlay removes the entry from the stack and calls history.back()
      // with ignoreNextPop=true, preventing the old close callback from firing and
      // accidentally clearing a newly-selected conversation.
      selectedContact = null;
      isConversationDrawerOpen = false;
      const ref = mobileConvoHistoryClose;
      mobileConvoHistoryClose = null;
      abandonHistoryOverlay(ref);
      return;
    }
    selectedContact = null;
    isConversationDrawerOpen = false;
  }

  function openConversationDrawer() {
    isConversationDrawerOpen = true;
    ensureDrawerHistory();
  }

  function closeConversationDrawer() {
    if (drawerHistoryClose) {
      closeHistoryOverlayFromUi(drawerHistoryClose);
      return;
    }
    isConversationDrawerOpen = false;
  }

  function openChannelMembersDrawer() {
    isChannelMembersDrawerOpen = true;
    ensureChannelMembersDrawerHistory();
  }

  function closeChannelMembersDrawer() {
    if (channelMembersDrawerHistoryClose) {
      closeHistoryOverlayFromUi(channelMembersDrawerHistoryClose);
      return;
    }
    isChannelMembersDrawerOpen = false;
  }

  /** Toggles the members panel: opens/closes the mobile drawer, or shows/hides the desktop panel. */
  function toggleChannelMembersDrawer() {
    if (isChannelMembersDrawerOpen) {
      closeChannelMembersDrawer();
    } else {
      openChannelMembersDrawer();
    }
  }

  // ── Group members ─────────────────────────────────────────────────────────

  /**
   * Fetches the deduplicated list of member userIds for an MLS group and stores them in
   * groupMembers. No-op for channel conversations, and for one this device is no longer in.
   *
   * THE ROSTER OF A RETIRED CONVERSATION IS NOT OURS TO ASK FOR. `GET /api/mls/groups/:id/members`
   * is members-only by design, so on a device holding a Remove commit the request has exactly one
   * possible outcome, and it is a 403 in the console of every removed device. Both selection paths
   * fire this one line above `verifyCurrentUserMembership`, which was taught the same fact on
   * 2026-08-23 - this call site was not, which is why GRP-3 still recorded the 403 the next day.
   * The discriminator is durable, local and already in the row (see `membershipIsDurablyLost`).
   *
   * An empty roster is the ANSWER here rather than a fallback: there is no membership to show.
   */
  async function loadGroupMembers(id: string, ctx: ConversationContext | null) {
    if (!ctx) return;
    if (isChannelConversationId(id)) {
      groupMembers = [];
      return;
    }
    const key = findConversationKeyByGroupId(conversations, id);
    if (membershipIsDurablyLost(key ? conversations.get(key) : undefined)) {
      groupMembers = [];
      ctx.log(`[VERIFY] Roster of ${id.slice(0, 8)}… not requested - conversation retired`);
      return;
    }
    try {
      groupMembers = await fetchUniqueGroupMembers(ctx.ensureMls(), id);
    } catch (e) {
      console.warn('[GroupMembers]', e);
      groupMembers = [];
    }
  }

  /** Remembers a membership verdict for 30 s, so a re-selected conversation does not re-ask. */
  function cacheMembership(groupId: string, isMember: boolean) {
    membershipCache.set(groupId, { isMember, expiresAt: Date.now() + 30_000 });
  }

  /**
   * Surfaces the removal notice for a conversation this device is no longer a member of, and
   * answers `false`.
   *
   * Extracted so the LOCAL verdict and the SERVER verdict share one presentation: they are the same
   * conclusion reached from two places, and a second copy of the notice logic is a second chance for
   * them to disagree about what the user sees.
   */
  async function surfaceRemoval(
    contactName: string,
    convo: Conversation,
    ctx: ConversationContext
  ): Promise<false> {
    const notice = chat_system_removed_from_group();
    console.warn(`[VERIFY] User no longer member of ${convo.id} - showing removal notice`);
    if (!convo.messages.some((m) => m.isSystem && m.content === notice)) {
      await ctx.addMessageToChat('system', notice, contactName, { isSystem: true });
    }
    if (selectedContact === contactName) sendError = notice;
    return false;
  }

  /**
   * Checks whether the current user is still a member of the given conversation. Caches the result
   * for 30 s. Attempts server re-registration and direct-conversation repair before surfacing a
   * removal notice.
   *
   * THE LOCAL MLS STATE IS ASKED FIRST, AND ON `false` IT IS THE WHOLE ANSWER. A Remove commit is a
   * signed, ordered statement by a member entitled to make it, already applied and already durable
   * (see `eviction.ts`) - so a device that has one has nothing left to ask anybody. Asking anyway
   * sent `GET /api/mls/groups/:id/members` to an endpoint that is members-only BY DESIGN, which is
   * to say: on the one question worth asking, the request could only ever be refused. That is a
   * 403 in the console of every removed device, and it is learning by failing what a fact already
   * told us. GRP-3 caught it on 2026-08-23.
   *
   * The two paths overlapped rather than disagreed, which is why nothing failed: the eviction was
   * ALSO learnt from the commit, and `convo.lifecycle` carried it. This deletes the overlap instead
   * of reconciling it - the local fact decides, and the server is asked only about what the local
   * state cannot see, which is server-side drift while we ARE still a member.
   */
  async function verifyCurrentUserMembership(
    contactName: string,
    ctx: ConversationContext
  ): Promise<boolean> {
    const convo = conversations.get(contactName);
    if (!convo) return false;
    if (isChannelConversationId(convo.id)) return true;

    const cached = membershipCache.get(convo.id);
    if (cached && cached.expiresAt > Date.now()) return cached.isMember;

    const mlsService = ctx.ensureMls();
    const localMembership = await readLocalMembership({
      mlsService,
      groupId: convo.id,
      context: 'before verifying against the server',
      log: ctx.log,
    });
    // Only `false` short-circuits. `null` means the local state could not say - a conversation whose
    // MLS group this device does not hold - and that is exactly the case the server can still answer.
    if (localMembership === false) {
      cacheMembership(convo.id, false);
      return await surfaceRemoval(contactName, convo, ctx);
    }

    try {
      const members = await fetchUniqueGroupMembers(mlsService, convo.id);
      if (members.length === 0) {
        cacheMembership(convo.id, true);
        return true;
      }
      const stillMember = members.some((m) => m.toLowerCase() === ctx.userId.toLowerCase());
      if (stillMember) {
        cacheMembership(convo.id, true);
        return true;
      }

      // Self-heal transient server drift first: re-register this device in the
      // gateway membership set, then re-check before attempting any heavy repair.
      try {
        await mlsService.registerMember(convo.id, ctx.userId);
        const repairedMembers = await fetchUniqueGroupMembers(mlsService, convo.id);
        const backInGroup = repairedMembers.some(
          (m) => m.toLowerCase() === ctx.userId.toLowerCase()
        );
        if (backInGroup) {
          ctx.log(`[SYNC] Server re-registration succeeded for ${convo.id}.`);
          cacheMembership(convo.id, true);
          return true;
        }
      } catch (e) {
        // Non-blocking - the repair below is what answers. But a swallowed branch logs: this is
        // where a re-registration that never works would sit silently for ever.
        ctx.log(`[SYNC] Server re-registration of ${convo.id.slice(0, 8)}… failed: ${String(e)}`);
      }

      if (convo.conversationType === 'direct') {
        const localGroups = new SvelteSet(mlsService.getLocalGroups());
        if (localGroups.has(convo.id)) {
          // We still have valid local MLS state: avoid destructive auto-repair
          // (new group creation) and keep operating while sync converges.
          ctx.log(
            `[WARN] Appartenance serveur absente pour ${convo.id}, réparation lourde ignorée (état MLS local présent).`
          );
          console.warn(
            `[VERIFY] Server membership missing for ${convo.id} but local MLS state present - skipping repair`
          );
          return true;
        }

        try {
          await requestReAdd(contactName, {
            mlsService,
            storage: ctx.storage,
            userId: ctx.userId,
            deviceKeyB64: ctx.deviceKeyB64,
            conversations,
            getSelectedContact: () => selectedContact,
            setSelectedContact: (id: string | null) => {
              if (id) selectConversationWithCtx(id, ctx);
            },
            saveConversation: (name: string) => saveConversation(name, ctx),
            log: ctx.log,
          });
          console.log(`[VERIFY] Direct conversation ${convo.id} recovery triggered`);
          return true;
        } catch {
          // Recovery failed - fall through to show removal notice
        }
      }
      return await surfaceRemoval(contactName, convo, ctx);
    } catch (e) {
      // A STATUS CODE IS AN ANSWER, A TRANSPORT FAILURE IS NOT - and this `catch` used to make no
      // such distinction: it answered `true` to everything, so the server saying "you are not a
      // member" in the clearest way it has was read as "still a member". It failed in the unsafe
      // direction, on the exact input it was most likely to see.
      if (e instanceof NotAGroupMemberError) {
        cacheMembership(convo.id, false);
        return await surfaceRemoval(contactName, convo, ctx);
      }
      // Anything else - unreachable, 5xx, a refused token - says NOTHING about membership, so it
      // must not retire a conversation. `true` keeps the client working; the log is what stops the
      // branch from being silent, since this is where a real outage would hide.
      ctx.log(`[VERIFY] Membership of ${convo.id.slice(0, 8)}… could not be checked: ${String(e)}`);
      return true;
    }
  }

  // ── Group operations ──────────────────────────────────────────────────────

  /**
   * Shared cleanup for delete and leave: records the departure locally, calls an optional server
   * action, then purges the local MLS + UI state regardless of whether the server call succeeds.
   *
   * THE DEPARTURE IS RECORDED BEFORE IT IS ACTED ON, AND THAT ORDERING IS THE POINT. The row used
   * to be purged at the very END, so for the whole span of the server action, the WASM forget and
   * the state persist that follow it - hundreds of milliseconds to seconds - a conversation this
   * device had irrevocably given up still looked exactly like a live one. `loadGroupMembers` is
   * fired by a `$effect` over the conversations map, so ANY write inside that span - the
   * `memberLeft` system message this very path adds - re-ran it against a group whose server-side
   * membership had just been revoked, and asked a members-only endpoint the one question it is
   * certain to refuse. That is a `GET /api/mls/groups/:id/members -> 403` in the leaver's console,
   * intermittent by nature, and GRP-6 recorded it on 2026-08-24.
   *
   * A guard on the asker would have been the THIRD door patched on this one endpoint (audit S5,
   * `membershipIsDurablyLost`), so this closes the seam instead: `lifecycle: 'removed'` is the
   * durable local statement "this device is out", every reader of it already behaves correctly on
   * that answer - no roster, no send, no recovery - and the purge below then removes the row. The
   * only overlap there ever was is the window where the row disagreed with the decision, and it is
   * gone rather than reconciled.
   *
   * A crash inside the window is IMPROVED by this, not risked: it now leaves a row the UI can
   * explain and the user can clear in one click, where before it left a live-looking conversation
   * with no MLS state behind it - unusable, and refused by the server on every selection.
   *
   * The UI reset moves up for the same reason and one more: the "removed" banner offers a
   * delete-locally button, and it must not appear under a conversation the user is already leaving.
   */
  async function exitGroupAndCleanup(
    contactKey: string,
    convo: Conversation,
    serverAction: (mlsService: IMlsService) => Promise<void>,
    label: string,
    ctx: ConversationContext
  ) {
    const mlsService = ctx.ensureMls();
    await retireConversation({
      conversations,
      key: contactKey,
      groupId: convo.id,
      saveConversation: (key) => saveConversation(key, ctx),
    });
    membershipCache.delete(convo.id);
    selectedContact = null;
    isConversationDrawerOpen = false;
    sendError = '';
    groupMembers = [];
    ctx.log(`[${label}] ${convo.id.slice(0, 8)}… retired locally before the server action`);
    try {
      const onServer = await isGroupActiveOnServer(mlsService, ctx.userId, convo.id);
      if (onServer !== false) {
        await serverAction(mlsService);
      } else {
        ctx.log(`[${label}] Groupe ${convo.id} absent du serveur - purge MLS/UI locale`);
      }
    } catch (e) {
      ctx.log(
        `[${label}] Erreur serveur (${e instanceof Error ? e.message : String(e)}) - purge MLS/UI locale`
      );
    }
    // MANUAL delete/leave: record the per-user dismiss so the conversation also disappears from
    // the user's OTHER devices (rules 3 & 5) - their discovery purges it instead of showing the
    // "deleted" banner (reserved for peer deletions / exclusions). Best-effort: the local purge
    // below happens either way.
    await mlsService.dismissGroup(convo.id).catch(() => {});
    await purgeOrphanGroup({
      conversations,
      mlsService,
      userId: ctx.userId,
      deviceKeyB64: ctx.deviceKeyB64,
      contactKey,
      groupId: convo.id,
      deleteConversation: ctx.storage ? (key) => ctx.storage!.deleteConversation(key) : undefined,
      log: ctx.log,
    });
  }

  /** Creates a new named MLS group, persists it, and selects it in the UI. */
  async function createNewGroup(nameRaw: string, ctx: ConversationContext) {
    await createGroup(nameRaw, {
      mlsService: ctx.ensureMls(),
      storage: ctx.storage,
      userId: ctx.userId,
      deviceKeyB64: ctx.deviceKeyB64,
      historyBaseUrl: ctx.historyBaseUrl,
      conversations,
      selectConversation: (name) => selectConversationWithCtx(name, ctx),
      saveConversation: (name) => saveConversation(name, ctx),
      log: ctx.log,
    });
  }

  /** Invites one or more users (by ID) to the currently selected group, then refreshes the member list. No-op for DMs or channels. */
  async function inviteMembersToCurrentGroup(memberIds: string[], ctx: ConversationContext) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    if ((convo.conversationType ?? 'group') !== 'group') return; // DMs and channels cannot be invaded
    const normalized = [
      ...new SvelteSet(memberIds.map((id) => id.trim().toLowerCase()).filter(Boolean)),
    ];
    if (normalized.length === 0) return;
    // Optimistic UI: expose the invitees as pending immediately; the invite flow
    // (device fetch + bulk commit + welcomes) takes several seconds.
    pendingInvites = { groupId: convo.id, ids: normalized };
    try {
      await inviteMembersToGroup(normalized, convo, {
        mlsService: ctx.ensureMls(),
        storage: ctx.storage,
        userId: ctx.userId,
        deviceKeyB64: ctx.deviceKeyB64,
        historyBaseUrl: ctx.historyBaseUrl,
        conversations,
        selectConversation: (name) => selectConversationWithCtx(name, ctx),
        saveConversation: (name) => saveConversation(name, ctx),
        log: ctx.log,
      });
      await loadGroupMembers(convo.id, ctx);
    } finally {
      pendingInvites = null;
    }
  }

  /** Opens or creates a direct 1-to-1 conversation with the given user. */
  async function startNewConversation(
    contactNameRaw: string,
    ctx: ConversationContext,
    opts?: { silent?: boolean }
  ) {
    await startConversation(contactNameRaw, {
      mlsService: ctx.ensureMls(),
      storage: ctx.storage,
      userId: ctx.userId,
      deviceKeyB64: ctx.deviceKeyB64,
      historyBaseUrl: ctx.historyBaseUrl,
      conversations,
      selectConversation: (name) => selectConversationWithCtx(name, ctx),
      saveConversation: (name) => saveConversation(name, ctx),
      log: ctx.log,
      silent: opts?.silent,
    });
  }

  /** Renames the currently selected group on the server, broadcasts the change via MLS, and appends a system message. No-op for DMs and channels. */
  async function handleRenameGroup(name: string, ctx: ConversationContext) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    if ((convo.conversationType ?? 'group') !== 'group') return; // only named groups can be renamed
    try {
      await renameGroupAndBroadcast({
        mlsService: ctx.ensureMls(),
        groupId: convo.id,
        newName: name,
        userId: ctx.userId,
        deviceKeyB64: ctx.deviceKeyB64,
      });
      conversations.set(selectedContact, { ...convo, name });
      await saveConversation(selectedContact, ctx);
      ctx.log(`Groupe renomme en "${name}"`);
    } catch (e) {
      ctx.log(`Erreur renommage: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Sets the currently selected group's avatar on the server, broadcasts the change via MLS, and updates the UI. No-op for DMs and channels. */
  async function handleSetGroupImage(mediaId: string, ctx: ConversationContext) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    if ((convo.conversationType ?? 'group') !== 'group') return; // only named groups carry an avatar
    try {
      await setGroupImageAndBroadcast({
        mlsService: ctx.ensureMls(),
        groupId: convo.id,
        mediaId,
        userId: ctx.userId,
        deviceKeyB64: ctx.deviceKeyB64,
      });
      conversations.set(selectedContact, { ...convo, imageMediaId: mediaId });
      await saveConversation(selectedContact, ctx);
      ctx.log(`Photo de groupe mise a jour (media=${mediaId})`);
    } catch (e) {
      ctx.log(`Erreur changement photo: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Broadcasts a "groupDeleted" message, deletes the group on the server, wipes local MLS state, removes the conversation from IndexedDB, and resets the UI. */
  async function handleDeleteGroup(ctx: ConversationContext) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    await exitGroupAndCleanup(
      selectedContact,
      convo,
      (mls) =>
        deleteGroupAndBroadcast({
          mlsService: mls,
          groupId: convo.id,
          userId: ctx.userId,
          deviceKeyB64: ctx.deviceKeyB64,
        }),
      'DELETE',
      ctx
    );
  }

  /**
   * Deletes the conversation locally only (IndexedDB + reactive map), with no server call and
   * no MLS broadcast.
   *
   * Used when the conversation is flagged `deletedRemotely=true`: the group has already been
   * deleted server-side by another participant; we just remove the local entry at the user's
   * request.
   */
  async function handleDeleteGroupLocally(ctx: ConversationContext) {
    if (!selectedContact) return;
    const contactKey = selectedContact;
    // Through `purgeConversation` rather than a bare `conversations.delete`, so this exit forgets
    // the group-keyed leftovers exactly like retiring does - it did not, and left orphaned
    // awaiting-history markers behind for every conversation cleared this way.
    await purgeConversation({
      conversations,
      key: contactKey,
      deleteStored: ctx.storage ? (key) => ctx.storage!.deleteConversation(key) : undefined,
    });
    selectedContact = null;
    ctx.log(`[DELETE_LOCAL] Local conversation deleted: ${contactKey.slice(0, 8)}…`);
  }

  /** Sends a "memberLeft" broadcast, de-registers from the server, forgets local MLS state, deletes the DB entry, and clears the selection. */
  async function handleLeaveGroup(ctx: ConversationContext) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    await exitGroupAndCleanup(
      selectedContact,
      convo,
      (mls) =>
        leaveGroupAndBroadcast({
          mlsService: mls,
          groupId: convo.id,
          userId: ctx.userId,
          deviceKeyB64: ctx.deviceKeyB64,
        }),
      'LEAVE',
      ctx
    );
  }

  /** Removes a member from the currently selected group via an MLS commit, broadcasts the removal, and refreshes the member list. */
  async function handleRemoveMember(memberId: string, ctx: ConversationContext) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    try {
      await removeMemberAndBroadcast({
        mlsService: ctx.ensureMls(),
        groupId: convo.id,
        memberId,
        userId: ctx.userId,
        deviceKeyB64: ctx.deviceKeyB64,
      });
      membershipCache.delete(convo.id);
      groupMembers = groupMembers.filter((m) => m !== memberId);
      await loadGroupMembers(convo.id, ctx);
      ctx.log(`${memberId} retire du groupe.`);
    } catch (e) {
      ctx.log(`Erreur retrait membre: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Exposed API ───────────────────────────────────────────────────────────

  return {
    /** Reactive SvelteMap of all conversations keyed by conversation name. */
    conversations,
    /** True once the initial IndexedDB restore finished; the map is then authoritative. */
    get conversationsRestored() {
      return conversationsRestored;
    },

    // UI state
    /** Currently selected conversation name (null when no conversation is open). */
    get selectedContact() {
      return selectedContact;
    },
    set selectedContact(v: string | null) {
      selectedContact = v;
    },
    /** Returns 'chat' when a conversation is selected, 'list' otherwise (mobile layout helper). */
    get mobileView() {
      return selectedContact ? 'chat' : 'list';
    },
    /** Whether the conversation list drawer is open (mobile). */
    get isConversationDrawerOpen() {
      return isConversationDrawerOpen;
    },
    set isConversationDrawerOpen(v: boolean) {
      isConversationDrawerOpen = v;
    },
    /** Whether the channel members side drawer is open. */
    get isChannelMembersDrawerOpen() {
      return isChannelMembersDrawerOpen;
    },
    set isChannelMembersDrawerOpen(v: boolean) {
      isChannelMembersDrawerOpen = v;
    },
    /** Whether the channel settings modal is open. */
    get isChannelSettingsModalOpen() {
      return isChannelSettingsModalOpen;
    },
    set isChannelSettingsModalOpen(v: boolean) {
      isChannelSettingsModalOpen = v;
    },
    /** Deduplicated list of userIds currently in the selected group. */
    get groupMembers() {
      return groupMembers;
    },
    set groupMembers(v: string[]) {
      groupMembers = v;
    },
    /** User IDs with an invite in flight for the currently selected group (optimistic UI). */
    get pendingGroupInvites(): string[] {
      if (!pendingInvites || !selectedContact) return [];
      const convo = conversations.get(selectedContact);
      return convo && convo.id === pendingInvites.groupId ? pendingInvites.ids : [];
    },
    /** True while history is being fetched and decrypted for the selected conversation. */
    get isLoadingHistory() {
      return isLoadingHistory;
    },
    /** Last send or membership error message to display to the user. */
    get sendError() {
      return sendError;
    },
    set sendError(v: string) {
      sendError = v;
    },
    /** Controlled value of the "new direct conversation" input field. */
    get newContactInput() {
      return newContactInput;
    },
    set newContactInput(v: string) {
      newContactInput = v;
    },
    /** Controlled value of the "new group" input field. */
    get newGroupInput() {
      return newGroupInput;
    },
    set newGroupInput(v: string) {
      newGroupInput = v;
    },
    /** Controlled value of the "new channel" input field. */
    get newChannelInput() {
      return newChannelInput;
    },
    set newChannelInput(v: string) {
      newChannelInput = v;
    },
    /** Reference to the chat scroll container used for auto-scroll. */
    get chatContainer() {
      return chatContainer;
    },
    set chatContainer(v: HTMLElement | undefined) {
      chatContainer = v;
    },
    /** Derived conversation object for the currently selected contact (null if none). */
    get currentConvo() {
      return currentConvo;
    },

    // actions
    /** Persists the given conversation's metadata to IndexedDB. */
    saveConversation,
    /** Fetches and decrypts network history for a conversation, then reloads from DB. */
    loadHistoryForConversation,
    /** Full-text search over a channel's entire server history (decrypts + merges hits into view). */
    searchChannelHistory,
    /** Clears the in-memory channel history TTL cache (one channel or all). */
    invalidateChannelHistoryCache,
    /** Reads saved conversations from IndexedDB and populates the reactive map. */
    loadAndRestoreConversations,
    /** Prepends an older page of messages from IndexedDB to the conversation. */
    loadOlderMessages,
    /** Asks a peer for the page below what this device holds, once the local store is exhausted. */
    requestOlderFromPeers,
    /** Selects a conversation without a ctx (clears unread badge). */
    selectConversation,
    /** Selects a conversation with a ctx (also verifies membership). */
    selectConversationWithCtx,
    /** Deselects the active conversation and closes the drawer. */
    goBackToMenu,
    openConversationDrawer,
    closeConversationDrawer,
    openChannelMembersDrawer,
    closeChannelMembersDrawer,
    toggleChannelMembersDrawer,
    /** Fetches and stores the deduplicated member list for an MLS group. */
    loadGroupMembers,
    /** Checks and caches whether the current user is still in the given conversation. */
    verifyCurrentUserMembership,
    /** Creates a new named MLS group and selects it. */
    createNewGroup,
    /** Invites one or more users to the currently selected group. */
    inviteMembersToCurrentGroup,
    /** Opens or creates a direct 1-to-1 conversation with the given user. */
    startNewConversation,
    /** Renames the currently selected group and broadcasts the change. */
    handleRenameGroup,
    /** Sets the currently selected group's avatar and broadcasts the change. */
    handleSetGroupImage,
    /** Deletes the currently selected group and clears the UI. */
    handleDeleteGroup,
    /** Removes only the local conversation entry (no server call). Used when the group was deleted remotely. */
    handleDeleteGroupLocally,
    /** Leaves the currently selected group and clears the UI. */
    handleLeaveGroup,
    /** Removes a member from the currently selected group. */
    handleRemoveMember,
  };
}
