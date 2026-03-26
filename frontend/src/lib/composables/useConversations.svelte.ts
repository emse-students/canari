/**
 * Reactive composable owning all conversation state and operations:
 * - The conversations SvelteMap
 * - Selection, archive/restore
 * - Group members + membership verification
 * - Group-level operations (create, rename, delete, invite, kick)
 * - Storage helpers (save, load history, reload)
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { IStorage } from '$lib/db';
import type { IMlsService } from '$lib/mlsService';
import type { MessageReaction, Conversation } from '$lib/types';
import {
  fetchUniqueGroupMembers,
  removeMemberAndBroadcast,
  renameGroupAndBroadcast,
} from '$lib/utils/chat/groupActions';
import {
  createNewGroup as createGroup,
  inviteMembersToGroup,
  startNewConversation as startConversation,
  repairDirectConversation,
} from '$lib/utils/chat/groupCreation';
import {
  loadExistingConversations,
  loadPersistedArchivedIds,
  persistArchivedConversations,
} from '$lib/utils/chat/conversations';

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
    replyTo?: { id: string; senderId: string; content: string },
    isSystem?: boolean,
    messageId?: string,
    timestamp?: Date
  ) => Promise<void>;
}

export function useConversations() {
  const conversations = new SvelteMap<string, Conversation>();

  // ── UI state ──────────────────────────────────────────────────────────────
  let selectedContact = $state<string | null>(null);
  let mobileView = $state<'list' | 'chat'>('list');
  let isConversationDrawerOpen = $state(false);
  let isChannelMembersDrawerOpen = $state(false);
  let isChannelSettingsModalOpen = $state(false);
  let archivedConversationIds = $state<string[]>([]);
  let showArchivedConversations = $state(false);
  let showSyncGuidePrompt = $state(false);
  let groupMembers = $state<string[]>([]);
  let sendError = $state('');

  // ── Input state ───────────────────────────────────────────────────────────
  let newContactInput = $state('');
  let newGroupInput = $state('');
  let newChannelInput = $state('');
  let chatContainer = $state<HTMLElement | undefined>(undefined);

  // ── Derived ───────────────────────────────────────────────────────────────
  const currentConvo = $derived(
    selectedContact ? (conversations.get(selectedContact) ?? null) : null
  );

  // ── Storage helpers ───────────────────────────────────────────────────────

  async function saveConversation(contactName: string, ctx: ConversationContext) {
    if (!ctx.storage) return;
    const normalized = contactName.toLowerCase();
    const convo = conversations.get(normalized);
    if (!convo) return;
    const persistedName =
      (convo.conversationType ?? 'group') === 'direct'
        ? `${ctx.userId.toLowerCase()}::${(convo.directPeerId ?? convo.contactName).toLowerCase()}`
        : convo.name;
    await ctx.storage.saveConversation({
      id: normalized,
      groupId: convo.groupId,
      name: persistedName,
      isReady: convo.isReady,
      updatedAt: Date.now(),
    });
  }

  async function loadHistoryForConversation(
    contactName: string,
    groupId: string,
    ctx: ConversationContext
  ) {
    const { replayConversationHistory } = await import('$lib/utils/chat/history');
    await replayConversationHistory({
      mlsService: ctx.ensureMls(),
      groupId,
      contactName,
      userId: ctx.userId,
      pin: ctx.pin,
      addMessageToChat: ctx.addMessageToChat,
      getConversation: (name) => conversations.get(name),
      setConversation: (name, next) => conversations.set(name, next),
      messageReactions: ctx.messageReactions,
      log: ctx.log,
    });
  }

  async function loadAndRestoreConversations(ctx: ConversationContext) {
    if (!ctx.storage) return;
    archivedConversationIds = loadPersistedArchivedIds(ctx.userId);
    await loadExistingConversations({
      userId: ctx.userId,
      pin: ctx.pin,
      storage: ctx.storage,
      mlsService: ctx.ensureMls(),
      conversations,
      messageReactions: ctx.messageReactions,
      archivedConversationIds,
      historyBaseUrl: ctx.historyBaseUrl,
      log: ctx.log,
      onArchivedIdsChange: (ids) => {
        archivedConversationIds = ids;
      },
      addMessageToChat: ctx.addMessageToChat,
    });
  }

  // ── Selection + navigation ────────────────────────────────────────────────

  function selectConversation(name: string) {
    selectedContact = name;
    mobileView = 'chat';
    isConversationDrawerOpen = false;
    sendError = '';
    const convo = conversations.get(name);
    if (convo) conversations.set(name, { ...convo, unreadCount: 0 });
    if (convo?.groupId) {
      void loadGroupMembers(convo.groupId, null as any); // ctx injected by parent
    }
  }

  /** Call this version when you have the ctx available (inside handlers). */
  function selectConversationWithCtx(name: string, ctx: ConversationContext) {
    selectedContact = name;
    mobileView = 'chat';
    isConversationDrawerOpen = false;
    sendError = '';
    const convo = conversations.get(name);
    if (convo) conversations.set(name, { ...convo, unreadCount: 0 });
    if (convo?.groupId) {
      void loadGroupMembers(convo.groupId, ctx);
      void verifyCurrentUserMembership(name, ctx);
    }
  }

  function goBackToMenu() {
    mobileView = 'list';
    isConversationDrawerOpen = false;
  }

  // ── Archive ───────────────────────────────────────────────────────────────

  function archiveConversation(conversationId: string, userId: string) {
    const normalized = conversationId.toLowerCase();
    if (archivedConversationIds.includes(normalized)) return;
    archivedConversationIds = [...archivedConversationIds, normalized];
    persistArchivedConversations(userId, archivedConversationIds);
    if (selectedContact === normalized) {
      selectedContact = null;
      mobileView = 'list';
      isConversationDrawerOpen = false;
      sendError = '';
      groupMembers = [];
    }
  }

  function restoreConversation(conversationId: string, userId: string) {
    const normalized = conversationId.toLowerCase();
    if (!archivedConversationIds.includes(normalized)) return;
    archivedConversationIds = archivedConversationIds.filter((id) => id !== normalized);
    persistArchivedConversations(userId, archivedConversationIds);
  }

  // ── Group members ─────────────────────────────────────────────────────────

  async function loadGroupMembers(groupId: string, ctx: ConversationContext) {
    try {
      groupMembers = await fetchUniqueGroupMembers(ctx.ensureMls(), groupId);
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
    if (convo.groupId.startsWith('channel_')) return true;
    try {
      const members = await fetchUniqueGroupMembers(ctx.ensureMls(), convo.groupId);
      if (members.length === 0) return true;
      const stillMember = members.some((m) => m.toLowerCase() === ctx.userId.toLowerCase());
      if (stillMember) return true;
      if (convo.conversationType === 'direct') {
        const repaired = await repairDirectConversation(contactName, {
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
        if (repaired) return true;
      }
      const notice =
        'Vous avez ete retire de ce groupe. Vous ne pouvez plus envoyer ni recevoir de nouveaux messages.';
      if (!convo.messages.some((m) => m.isSystem && m.content === notice)) {
        await ctx.addMessageToChat('system', notice, contactName, undefined, true);
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
    await loadGroupMembers(convo.groupId, ctx);
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
    try {
      await renameGroupAndBroadcast({
        mlsService: ctx.ensureMls(),
        groupId: convo.groupId,
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
        undefined,
        true
      );
      ctx.log(`Groupe renomme en "${name}"`);
    } catch (e) {
      ctx.log(`Erreur renommage: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function handleDeleteGroup(userId: string) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    archiveConversation(selectedContact, userId);
  }

  async function handleRemoveMember(memberId: string, ctx: ConversationContext) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    try {
      await removeMemberAndBroadcast({
        mlsService: ctx.ensureMls(),
        groupId: convo.groupId,
        memberId,
        userId: ctx.userId,
        pin: ctx.pin,
      });
      groupMembers = groupMembers.filter((m) => m !== memberId);
      await ctx.addMessageToChat(
        'system',
        `${ctx.userId} a retire ${memberId} du groupe`,
        selectedContact,
        undefined,
        true
      );
      await loadGroupMembers(convo.groupId, ctx);
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
      return mobileView;
    },
    set mobileView(v: 'list' | 'chat') {
      mobileView = v;
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
    get archivedConversationIds() {
      return archivedConversationIds;
    },
    set archivedConversationIds(v: string[]) {
      archivedConversationIds = v;
    },
    get showArchivedConversations() {
      return showArchivedConversations;
    },
    set showArchivedConversations(v: boolean) {
      showArchivedConversations = v;
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
    selectConversation,
    selectConversationWithCtx,
    goBackToMenu,
    archiveConversation,
    restoreConversation,
    loadGroupMembers,
    verifyCurrentUserMembership,
    createNewGroup,
    inviteMembersToCurrentGroup,
    startNewConversation,
    handleRenameGroup,
    handleDeleteGroup,
    handleRemoveMember,
  };
}
