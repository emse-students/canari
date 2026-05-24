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
import {
  fetchUniqueGroupMembers,
  removeMemberAndBroadcast,
  renameGroupAndBroadcast,
  deleteGroupAndBroadcast,
  leaveGroupAndBroadcast,
} from '$lib/utils/chat/groupActions';
import {
  createNewGroup as createGroup,
  inviteMembersToGroup,
  startNewConversation as startConversation,
  repairDirectConversation,
} from '$lib/utils/chat/groupCreation';
import { loadExistingConversations } from '$lib/utils/chat/conversations';
import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
import { compareMessageOrder } from '$lib/utils/chat/messageOrder';
import {
  pushHistoryOverlay,
  closeHistoryOverlayFromUi,
  abandonHistoryOverlay,
  isMobileOverlayLayout,
} from '$lib/utils/historyOverlayStack';

/** Messages loaded from DB on initial display or after network sync. */
const INITIAL_MESSAGES_PAGE = 60;
/** Messages loaded per scroll-up DB page request. */
const OLDER_MESSAGES_PAGE = 50;
/** Skip channel REST history refetch when the in-memory copy was loaded recently. */
const CHANNEL_HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;

/** Runtime dependencies injected into all conversation and group operations. */
export interface ConversationContext {
  /** The live storage instance (null until logged in). */
  storage: IStorage | null;
  /** Returns (or lazily creates) the active MLS service. */
  ensureMls: () => IMlsService;
  userId: string;
  pin: string;
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
  let isChannelMembersDrawerOpen = $state(false);
  let isChannelSettingsModalOpen = $state(false);
  let showSyncGuidePrompt = $state(false);
  let groupMembers = $state<string[]>([]);
  let isLoadingHistory = $state(false);
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
  const currentConvo = $derived(
    selectedContact ? (conversations.get(selectedContact) ?? null) : null
  );

  // ── Storage helpers ───────────────────────────────────────────────────────

  /** Persists a conversation's metadata (name, isReady, updatedAt) to IndexedDB. For direct conversations the name is stored as "userId::peerId". */
  async function saveConversation(id: string, ctx: ConversationContext) {
    if (!ctx.storage) return;
    const convo = conversations.get(id);
    if (!convo) return;
    const persistedName =
      (convo.conversationType ?? 'group') === 'direct'
        ? `${ctx.userId.toLowerCase()}::${(convo.directPeerId ?? convo.contactName).toLowerCase()}`
        : convo.name;
    await ctx.storage.saveConversation({
      id: id,
      name: persistedName,
      isReady: convo.isReady,
      updatedAt: Date.now(),
    });
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

    const {
      replayConversationHistory,
      mapStoredMessagesToChatMessages,
      retroactivelyResolveHexIds,
    } = await import('$lib/utils/chat/history');
    const isSelected = selectedContact === contactName;
    if (isSelected) isLoadingHistory = true;
    try {
      // Fetch from network → decrypt → save to DB (no direct UI update)
      await replayConversationHistory({
        mlsService: ctx.ensureMls(),
        id,
        contactName,
        userId: ctx.userId,
        pin: ctx.pin,
        storage: ctx.storage,
        getConversation: (name) => conversations.get(name),
        setConversation: (name, next) => conversations.set(name, next),
        messageReactions: ctx.messageReactions,
        log: ctx.log,
      });
      // Reload from DB so display reflects the latest saved state
      if (ctx.storage) {
        const refreshed = await ctx.storage.getMessagesPage(id, ctx.pin, INITIAL_MESSAGES_PAGE);
        const msgs = await retroactivelyResolveHexIds(
          mapStoredMessagesToChatMessages(refreshed, ctx.userId),
          ctx.storage,
          id,
          ctx.pin
        );
        const current = conversations.get(contactName);
        if (current) {
          conversations.set(contactName, {
            ...current,
            messages: [...msgs].sort(compareMessageOrder),
          });
          for (const m of msgs) {
            if (m.reactions && m.reactions.length > 0) {
              ctx.messageReactions.set(m.id, m.reactions);
            }
          }
        }
      }
    } finally {
      if (isSelected) isLoadingHistory = false;
    }
  }

  /** Loads channel history from the server (source of truth) into memory only — never IndexedDB. */
  async function loadChannelHistory(
    channelConversationId: string,
    ctx: ConversationContext,
    force = false
  ) {
    const { channelService } = await import('$lib/services/ChannelService');
    const { channelKeyManager } = await import('$lib/crypto/ChannelKeyVault');
    const { decodeAppMessage } = await import('$lib/proto/codec');
    const { appMsgToEnvelope } = await import('$lib/utils/chat/messageUtils');
    const { parseServerTimestampMs } = await import('$lib/mls-client/incomingDelivery');

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
      // Fresh devices may miss historical channel epochs in memory.
      // Hydrate all known epochs before decrypting history.
      try {
        const historyKeys = await channelService.getChannelHistoryKeys(rawId);
        const vault = channelKeyManager.getVault(rawId);
        for (const keyEntry of historyKeys.epochKeys || []) {
          if (!Number.isFinite(keyEntry.keyVersion) || keyEntry.keyVersion <= 0) continue;
          if (!keyEntry.encryptedChannelKey) continue;
          const rawKeyMat = Uint8Array.from(atob(keyEntry.encryptedChannelKey), (c) =>
            c.charCodeAt(0)
          );
          await vault.rotateKey(keyEntry.keyVersion, rawKeyMat);
        }
      } catch (e) {
        ctx.log(
          `[CHANNEL] Hydratation clés historiques impossible pour ${rawId}: ${e instanceof Error ? e.message : e}`
        );
      }

      const rows: any[] = await channelService.listMessages(rawId, 200);
      const loaded: ChatMessage[] = [];

      if (Array.isArray(rows)) {
        for (const msg of rows) {
          let content: string | undefined;
          let messageTimestamp: Date | undefined;
          const channelServerMs = parseServerTimestampMs(msg.createdAt);
          try {
            let bytes: Uint8Array | undefined;
            if (msg.ciphertext && msg.nonce && msg.keyVersion !== undefined) {
              bytes = await channelKeyManager.decryptMessage(
                rawId,
                msg.ciphertext,
                msg.nonce,
                msg.keyVersion
              );
            } else if (msg.ciphertext) {
              const binStr = atob(msg.ciphertext);
              bytes = new Uint8Array(binStr.length);
              for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
            }
            if (bytes) {
              const decoded = decodeAppMessage(bytes);
              if (decoded) {
                const envelope = appMsgToEnvelope(decoded, channelServerMs);
                if (envelope) {
                  content = envelope.content;
                  messageTimestamp = envelope.options.timestamp;
                }
              }
            }
          } catch (e) {
            ctx.log(`[CHANNEL] Message non lisible (clé indisponible) ${msg.id}: ${e}`);
          }
          if (content === undefined) continue;

          const senderId = String(msg.senderId || 'unknown').toLowerCase();
          loaded.push({
            id: msg.id,
            senderId,
            content,
            timestamp:
              messageTimestamp ??
              (channelServerMs !== undefined ? new SvelteDate(channelServerMs) : new SvelteDate()),
            isOwn: senderId === ctx.userId.toLowerCase(),
          });
        }
      }

      loaded.sort(compareMessageOrder);

      const current = conversations.get(channelConversationId);
      if (current) {
        conversations.set(channelConversationId, { ...current, messages: loaded });
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

  /** Reads all saved conversations from IndexedDB, verifies MLS state consistency, and populates the conversations map. */
  async function loadAndRestoreConversations(ctx: ConversationContext) {
    if (!ctx.storage) return;
    await loadExistingConversations({
      userId: ctx.userId,
      pin: ctx.pin,
      storage: ctx.storage,
      mlsService: ctx.ensureMls(),
      conversations,
      messageReactions: ctx.messageReactions,
      archivedConversationIds: [],
      historyBaseUrl: ctx.historyBaseUrl,
      log: ctx.log,
      onArchivedIdsChange: () => {},
    });
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
      ctx.pin,
      OLDER_MESSAGES_PAGE,
      beforeTimestamp
    );
    if (older.length === 0) return false;

    const { mapStoredMessagesToChatMessages, retroactivelyResolveHexIds } =
      await import('$lib/utils/chat/history');
    const mapped = await retroactivelyResolveHexIds(
      mapStoredMessagesToChatMessages(older, ctx.userId),
      ctx.storage ?? null,
      convo.id,
      ctx.pin
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

  // ── Selection + navigation ────────────────────────────────────────────────

  /** Selects a conversation (sets selectedContact, clears unread badge and send error). Use this version when no ctx is available (e.g. from channel event handlers). */
  function dismissDrawerHistoryIfAny() {
    if (!drawerHistoryClose) return;
    const ref = drawerHistoryClose;
    drawerHistoryClose = null;
    isConversationDrawerOpen = false;
    abandonHistoryOverlay(ref);
  }

  function selectConversation(name: string) {
    dismissDrawerHistoryIfAny();
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
    dismissDrawerHistoryIfAny();
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
    if (mobileConvoHistoryClose) {
      closeHistoryOverlayFromUi(mobileConvoHistoryClose);
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

  // ── Group members ─────────────────────────────────────────────────────────

  /** Fetches the deduplicated list of member userIds for an MLS group and stores them in groupMembers. No-op for channel conversations. */
  async function loadGroupMembers(id: string, ctx: ConversationContext | null) {
    if (!ctx) return;
    if (isChannelConversationId(id)) {
      groupMembers = [];
      return;
    }
    try {
      groupMembers = await fetchUniqueGroupMembers(ctx.ensureMls(), id);
    } catch (e) {
      console.warn('[GroupMembers]', e);
      groupMembers = [];
    }
  }

  /** Checks whether the current user is still a member of the given conversation. Caches the result for 30 s. Attempts server re-registration and direct-conversation repair before surfacing a removal notice. */
  async function verifyCurrentUserMembership(
    contactName: string,
    ctx: ConversationContext
  ): Promise<boolean> {
    const convo = conversations.get(contactName);
    if (!convo) return false;
    if (isChannelConversationId(convo.id)) return true;

    const cached = membershipCache.get(convo.id);
    if (cached && cached.expiresAt > Date.now()) return cached.isMember;

    try {
      const mlsService = ctx.ensureMls();
      const members = await fetchUniqueGroupMembers(mlsService, convo.id);
      if (members.length === 0) {
        membershipCache.set(convo.id, { isMember: true, expiresAt: Date.now() + 30_000 });
        return true;
      }
      const stillMember = members.some((m) => m.toLowerCase() === ctx.userId.toLowerCase());
      if (stillMember) {
        membershipCache.set(convo.id, { isMember: true, expiresAt: Date.now() + 30_000 });
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
          ctx.log(`[SYNC] Réinscription serveur réussie pour ${convo.id}.`);
          membershipCache.set(convo.id, { isMember: true, expiresAt: Date.now() + 30_000 });
          return true;
        }
      } catch {
        // Non-blocking: fallback behavior below
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
            `[VERIFY] Server membership missing for ${convo.id} but local MLS state present — skipping repair`
          );
          return true;
        }

        const repaired = await repairDirectConversation(contactName, {
          mlsService,
          storage: ctx.storage,
          userId: ctx.userId,
          pin: ctx.pin,
          historyBaseUrl: ctx.historyBaseUrl,
          conversations,
          selectConversation: (name) => selectConversationWithCtx(name, ctx),
          saveConversation: (name) => saveConversation(name, ctx),
          log: ctx.log,
        });
        if (repaired) {
          console.log(`[VERIFY] Direct conversation ${convo.id} repaired successfully`);
          return true;
        }
      }
      const notice =
        'Vous avez ete retire de ce groupe. Vous ne pouvez plus envoyer ni recevoir de nouveaux messages.';
      console.warn(`[VERIFY] User no longer member of ${convo.id} — showing removal notice`);
      if (!convo.messages.some((m) => m.isSystem && m.content === notice)) {
        await ctx.addMessageToChat('system', notice, contactName, { isSystem: true });
      }
      if (selectedContact === contactName) sendError = notice;
      return false;
    } catch {
      return true;
    }
  }

  // ── Group operations ──────────────────────────────────────────────────────

  /** Creates a new named MLS group, persists it, and selects it in the UI. */
  async function createNewGroup(nameRaw: string, ctx: ConversationContext) {
    await createGroup(nameRaw, {
      mlsService: ctx.ensureMls(),
      storage: ctx.storage,
      userId: ctx.userId,
      pin: ctx.pin,
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
    await inviteMembersToGroup(normalized, convo, {
      mlsService: ctx.ensureMls(),
      storage: ctx.storage,
      userId: ctx.userId,
      pin: ctx.pin,
      historyBaseUrl: ctx.historyBaseUrl,
      conversations,
      selectConversation: (name) => selectConversationWithCtx(name, ctx),
      saveConversation: (name) => saveConversation(name, ctx),
      log: ctx.log,
    });
    await loadGroupMembers(convo.id, ctx);
  }

  /** Opens or creates a direct 1-to-1 conversation with the given user. */
  async function startNewConversation(contactNameRaw: string, ctx: ConversationContext) {
    await startConversation(contactNameRaw, {
      mlsService: ctx.ensureMls(),
      storage: ctx.storage,
      userId: ctx.userId,
      pin: ctx.pin,
      historyBaseUrl: ctx.historyBaseUrl,
      conversations,
      selectConversation: (name) => selectConversationWithCtx(name, ctx),
      saveConversation: (name) => saveConversation(name, ctx),
      log: ctx.log,
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
        pin: ctx.pin,
      });
      conversations.set(selectedContact, { ...convo, name });
      await saveConversation(selectedContact, ctx);
      await ctx.addMessageToChat(
        'system',
        `${getUserDisplayNameSync(ctx.userId)} a renomme le groupe en "${name}"`,
        selectedContact,
        { isSystem: true }
      );
      ctx.log(`Groupe renomme en "${name}"`);
    } catch (e) {
      ctx.log(`Erreur renommage: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Broadcasts a "groupDeleted" message, deletes the group on the server, wipes local MLS state, removes the conversation from IndexedDB, and resets the UI. */
  async function handleDeleteGroup(ctx: ConversationContext) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    const contactKey = selectedContact;
    const mlsService = ctx.ensureMls();

    // 1. Notifier les pairs + supprimer côté serveur
    await deleteGroupAndBroadcast({
      mlsService,
      groupId: convo.id,
      userId: ctx.userId,
      pin: ctx.pin,
    });

    // 2. Oublier l'état MLS local
    try {
      mlsService.forgetGroup(convo.id, 0);
    } catch {
      /* non-blocking */
    }

    // 3. Supprimer de la base locale
    if (ctx.storage) {
      try {
        await ctx.storage.deleteConversation(contactKey);
      } catch {
        /* non-blocking */
      }
    }

    // 4. Retirer de la map et reset UI
    membershipCache.delete(convo.id);
    conversations.delete(contactKey);
    selectedContact = null;
    isConversationDrawerOpen = false;
    sendError = '';
    groupMembers = [];
  }

  /** Sends a "memberLeft" broadcast, de-registers from the server, forgets local MLS state, deletes the DB entry, and clears the selection. */
  async function handleLeaveGroup(ctx: ConversationContext) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    const contactKey = selectedContact;
    const mlsService = ctx.ensureMls();

    await leaveGroupAndBroadcast({
      mlsService,
      groupId: convo.id,
      userId: ctx.userId,
      pin: ctx.pin,
    });

    try {
      mlsService.forgetGroup(convo.id, 0);
    } catch {
      /* non-blocking */
    }

    if (ctx.storage) {
      try {
        await ctx.storage.deleteConversation(contactKey);
      } catch {
        /* non-blocking */
      }
    }

    membershipCache.delete(convo.id);
    conversations.delete(contactKey);
    selectedContact = null;
    isConversationDrawerOpen = false;
    sendError = '';
    groupMembers = [];
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
        pin: ctx.pin,
      });
      membershipCache.delete(convo.id);
      groupMembers = groupMembers.filter((m) => m !== memberId);
      await ctx.addMessageToChat(
        'system',
        `${ctx.userId} a retire ${memberId} du groupe`,
        selectedContact,
        { isSystem: true }
      );
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
    /** Whether to show the multi-device sync guide prompt. */
    get showSyncGuidePrompt() {
      return showSyncGuidePrompt;
    },
    set showSyncGuidePrompt(v: boolean) {
      showSyncGuidePrompt = v;
    },
    /** Deduplicated list of userIds currently in the selected group. */
    get groupMembers() {
      return groupMembers;
    },
    set groupMembers(v: string[]) {
      groupMembers = v;
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
    /** Clears the in-memory channel history TTL cache (one channel or all). */
    invalidateChannelHistoryCache,
    /** Reads saved conversations from IndexedDB and populates the reactive map. */
    loadAndRestoreConversations,
    /** Prepends an older page of messages from IndexedDB to the conversation. */
    loadOlderMessages,
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
    /** Deletes the currently selected group and clears the UI. */
    handleDeleteGroup,
    /** Leaves the currently selected group and clears the UI. */
    handleLeaveGroup,
    /** Removes a member from the currently selected group. */
    handleRemoveMember,
  };
}
