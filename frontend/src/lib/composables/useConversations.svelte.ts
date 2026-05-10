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
import type { MessageReaction, Conversation } from '$lib/types';
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

/** Messages loaded from DB on initial display or after network sync. */
const INITIAL_MESSAGES_PAGE = 60;
/** Messages loaded per scroll-up DB page request. */
const OLDER_MESSAGES_PAGE = 50;

export interface ConversationContext {
  /** The live storage instance (null until logged in) */
  storage: IStorage | null;
  /** The live MLS service */
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
    options?: {
      replyTo?: { id: string; senderId: string; content: string };
      isSystem?: boolean;
      messageId?: string;
      timestamp?: Date;
      status?: 'sending' | 'sent' | 'error';
    }
  ) => Promise<void>;
  batchAddMessages?: (
    messages: Array<{
      senderId: string;
      content: string;
      replyTo?: { id: string; senderId: string; content: string };
      isSystem?: boolean;
      messageId?: string;
      timestamp?: Date;
    }>,
    contactName: string
  ) => Promise<void>;
}

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

  // ── Derived ───────────────────────────────────────────────────────────────
  const currentConvo = $derived(
    selectedContact ? (conversations.get(selectedContact) ?? null) : null
  );

  // ── Storage helpers ───────────────────────────────────────────────────────

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

  async function loadHistoryForConversation(
    contactName: string,
    id: string,
    ctx: ConversationContext
  ) {
    // Channel conversations: load via REST API instead of MLS replay
    if (contactName.startsWith('channel_')) {
      await loadChannelHistory(contactName, ctx);
      return;
    }

    const { replayConversationHistory, mapStoredMessagesToChatMessages } =
      await import('$lib/utils/chat/history');
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
        const msgs = mapStoredMessagesToChatMessages(refreshed, ctx.userId);
        const current = conversations.get(contactName);
        if (current) {
          conversations.set(contactName, { ...current, messages: msgs });
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

  async function loadChannelHistory(channelConversationId: string, ctx: ConversationContext) {
    const { channelService } = await import('$lib/services/ChannelService');
    const { channelKeyManager } = await import('$lib/crypto/ChannelKeyVault');
    const { decodeAppMessage } = await import('$lib/proto/codec');
    const { serializeEnvelope, mkTextEnvelope } = await import('$lib/envelope');

    const rawId = channelConversationId.replace(/^channel_/, '');
    const convo = conversations.get(channelConversationId);
    if (!convo) return;

    try {
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

      const messages: any[] = await channelService.listMessages(rawId, 200);
      if (!Array.isArray(messages) || messages.length === 0) return;

      // Avoid duplicates: collect existing message IDs
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local lookup set, not reactive state
      const existingIds = new Set(convo.messages.map((m) => m.id).filter(Boolean));

      for (const msg of messages) {
        if (msg.id && existingIds.has(msg.id)) continue;

        let content = '[Message chiffré]';
        let shouldAppendMessage = false;
        try {
          if (msg.ciphertext && msg.nonce && msg.keyVersion !== undefined) {
            const bytes = await channelKeyManager.decryptMessage(
              rawId,
              msg.ciphertext,
              msg.nonce,
              msg.keyVersion
            );
            const decoded = decodeAppMessage(bytes);
            if (decoded?.text) {
              content = serializeEnvelope(mkTextEnvelope(decoded.text.content ?? ''));
              shouldAppendMessage = true;
            } else if (decoded?.reply) {
              const replyTo = decoded.reply.replyTo
                ? {
                    id: decoded.reply.replyTo.id || '',
                    senderId: decoded.reply.replyTo.senderId || '',
                    content: decoded.reply.replyTo.preview || '',
                  }
                : undefined;
              content = serializeEnvelope(mkTextEnvelope(decoded.reply.content ?? '', replyTo));
              shouldAppendMessage = true;
            }
          } else if (msg.ciphertext) {
            // Legacy base64 fallback
            const binStr = atob(msg.ciphertext);
            const bytes = new Uint8Array(binStr.length);
            for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
            const decoded = decodeAppMessage(bytes);
            if (decoded?.text) {
              content = serializeEnvelope(mkTextEnvelope(decoded.text.content ?? ''));
              shouldAppendMessage = true;
            }
          }
        } catch (e) {
          ctx.log(`[CHANNEL] Message non lisible (clé indisponible) ${msg.id}: ${e}`);
          shouldAppendMessage = false;
        }

        // Keep history clean for newly invited users: skip messages that
        // cannot be decrypted with the locally available channel keys.
        if (!shouldAppendMessage) continue;

        await ctx.addMessageToChat(msg.senderId || 'unknown', content, channelConversationId, {
          messageId: msg.id,
          // eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain timestamp conversion
          timestamp: msg.createdAt ? new Date(msg.createdAt) : undefined,
        });
      }
    } catch (e) {
      ctx.log(`[CHANNEL] Échec chargement historique: ${e instanceof Error ? e.message : e}`);
    }
  }

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

    const { mapStoredMessagesToChatMessages } = await import('$lib/utils/chat/history');
    const mapped = mapStoredMessagesToChatMessages(older, ctx.userId);

    const current = conversations.get(contactName);
    if (!current) return false;

    const existingIds = new SvelteSet(current.messages.map((m) => m.id));
    const merged = [...mapped.filter((m) => !existingIds.has(m.id)), ...current.messages].sort(
      (a, b) => {
        const ta =
          a.timestamp instanceof Date
            ? a.timestamp.getTime()
            : new SvelteDate(a.timestamp as any).getTime();
        const tb =
          b.timestamp instanceof Date
            ? b.timestamp.getTime()
            : new SvelteDate(b.timestamp as any).getTime();
        return ta !== tb ? ta - tb : a.id.localeCompare(b.id);
      }
    );

    conversations.set(contactName, { ...current, messages: merged });
    return older.length === OLDER_MESSAGES_PAGE;
  }

  // ── Selection + navigation ────────────────────────────────────────────────

  function selectConversation(name: string) {
    selectedContact = name;
    isConversationDrawerOpen = false;
    sendError = '';
    const convo = conversations.get(name);
    if (convo) conversations.set(name, { ...convo, unreadCount: 0 });
    if (convo?.id) {
      void loadGroupMembers(convo.id, null);
    }
  }

  /** Call this version when you have the ctx available (inside handlers). */
  function selectConversationWithCtx(name: string, ctx: ConversationContext) {
    selectedContact = name;
    isConversationDrawerOpen = false;
    sendError = '';
    const convo = conversations.get(name);
    if (convo) conversations.set(name, { ...convo, unreadCount: 0 });
    if (convo?.id) {
      void loadGroupMembers(convo.id, ctx);
      void verifyCurrentUserMembership(name, ctx);
    }
  }

  function goBackToMenu() {
    selectedContact = null;
    isConversationDrawerOpen = false;
  }

  // ── Group members ─────────────────────────────────────────────────────────

  async function loadGroupMembers(id: string, ctx: ConversationContext | null) {
    if (!ctx) return;
    if (id.startsWith('channel_')) {
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

  async function verifyCurrentUserMembership(
    contactName: string,
    ctx: ConversationContext
  ): Promise<boolean> {
    const convo = conversations.get(contactName);
    if (!convo) return false;
    if (convo.id.startsWith('channel_')) return true;

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
        `${ctx.userId} a renomme le groupe en "${name}"`,
        selectedContact,
        { isSystem: true }
      );
      ctx.log(`Groupe renomme en "${name}"`);
    } catch (e) {
      ctx.log(`Erreur renommage: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

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
    // The reactive map — passed by reference so all consumers share the same instance
    conversations,

    // UI state
    get selectedContact() {
      return selectedContact;
    },
    set selectedContact(v: string | null) {
      selectedContact = v;
    },
    get mobileView() {
      return selectedContact ? 'chat' : 'list';
    },
    get isConversationDrawerOpen() {
      return isConversationDrawerOpen;
    },
    set isConversationDrawerOpen(v: boolean) {
      isConversationDrawerOpen = v;
    },
    get isChannelMembersDrawerOpen() {
      return isChannelMembersDrawerOpen;
    },
    set isChannelMembersDrawerOpen(v: boolean) {
      isChannelMembersDrawerOpen = v;
    },
    get isChannelSettingsModalOpen() {
      return isChannelSettingsModalOpen;
    },
    set isChannelSettingsModalOpen(v: boolean) {
      isChannelSettingsModalOpen = v;
    },
    get showSyncGuidePrompt() {
      return showSyncGuidePrompt;
    },
    set showSyncGuidePrompt(v: boolean) {
      showSyncGuidePrompt = v;
    },
    get groupMembers() {
      return groupMembers;
    },
    set groupMembers(v: string[]) {
      groupMembers = v;
    },
    get isLoadingHistory() {
      return isLoadingHistory;
    },
    get sendError() {
      return sendError;
    },
    set sendError(v: string) {
      sendError = v;
    },
    get newContactInput() {
      return newContactInput;
    },
    set newContactInput(v: string) {
      newContactInput = v;
    },
    get newGroupInput() {
      return newGroupInput;
    },
    set newGroupInput(v: string) {
      newGroupInput = v;
    },
    get newChannelInput() {
      return newChannelInput;
    },
    set newChannelInput(v: string) {
      newChannelInput = v;
    },
    get chatContainer() {
      return chatContainer;
    },
    set chatContainer(v: HTMLElement | undefined) {
      chatContainer = v;
    },
    get currentConvo() {
      return currentConvo;
    },

    // actions
    saveConversation,
    loadHistoryForConversation,
    loadAndRestoreConversations,
    loadOlderMessages,
    selectConversation,
    selectConversationWithCtx,
    goBackToMenu,
    loadGroupMembers,
    verifyCurrentUserMembership,
    createNewGroup,
    inviteMembersToCurrentGroup,
    startNewConversation,
    handleRenameGroup,
    handleDeleteGroup,
    handleLeaveGroup,
    handleRemoveMember,
  };
}
