<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import { showToast } from '$lib/stores/toast.svelte';
  import { sendReadReceipt } from '$lib/utils/chat/messaging';
  import { forceSyncReset } from '$lib/utils/chat/actions';
  import {
    isChannelConversationId,
    sendChannelPoll,
    type ChannelPollDraft,
  } from '$lib/utils/chat/channelCrypto';
  import { channelService } from '$lib/services/ChannelService';
  import { applyLocalVote, setPollMeta } from '$lib/stores/pollStore.svelte';
  import { aggregateSharedContent, type SharedContent } from '$lib/utils/chat/sharedContent';
  import { getPreviewText, parseEnvelope } from '$lib/envelope';
  import { isMessagePinned, applyPin, setPinnedSet } from '$lib/stores/pinStore.svelte';
  import { useSyncSession } from '$lib/composables/useSyncSession.svelte';
  import {
    globalSession as session,
    globalConvs as convs,
    globalMessaging as messaging,
    globalChannels as channels,
    globalNotifs as notifs,
    appendLog,
  } from '$lib/stores/globalChatSingleton.svelte';
  import { openConversationFromId } from '$lib/utils/chat/openConversationFromId';
  import { notifNav } from '$lib/stores/notifNav.svelte';
  import Sidebar from './sidebar/Sidebar.svelte';
  import ChannelMembersSidebar from './chat/ChannelMembersSidebar.svelte';
  import ChannelSettingsModal from './chat/ChannelSettingsModal.svelte';
  import SyncSessionModal from './chat/SyncSessionModal.svelte';
  import ChatArea from './chat/ChatArea.svelte';
  import MessagingSyncOverlay from './chat/MessagingSyncOverlay.svelte';
  import ForwardMessageModal from './chat/ForwardMessageModal.svelte';
  import type { ChatMessage, Conversation } from '$lib/types';
  import type { BulkIngestPhase } from '$lib/mls-client';
  import { WifiOff } from '@lucide/svelte';

  interface Props {
    /** Controls whether the sidebar shows private chat conversations or community channels. */
    routeMode?: 'chat' | 'communities';
  }

  let { routeMode = 'chat' }: Props = $props();

  /** True when the currently selected conversation is a channel (not an MLS DM or group). */
  const isSelectedChannel = $derived(isChannelConversationId(convs.selectedContact ?? ''));

  /** True while MLS unlock / queue catch-up is running. */
  const isSyncing = $derived(
    session.isMessagingInitializing || messaging.isMessageCatchupActive
  );

  /** True once at least one conversation is restored from local cache. */
  const hasCachedConversations = $derived(convs.conversations.size > 0);

  /**
   * Block the whole UI only on a cold start (nothing cached yet). Once cached
   * conversations are available we show them immediately and sync in the
   * background - the per-group scheduler serializes sends safely meanwhile.
   */
  const isMessagingBlocked = $derived(
    !session.isLoggedIn || (isSyncing && !hasCachedConversations)
  );

  /** Non-blocking "still syncing" indicator shown over already-displayed cached data. */
  const isBackgroundSyncing = $derived(
    session.isLoggedIn && isSyncing && hasCachedConversations
  );

  const messagingOverlayMessage = $derived(
    !session.isLoggedIn ? 'Connexion en cours…' : 'Synchronisation des messages…'
  );

  /** Explicit derived binding so ChatArea re-renders when the open conversation mutates. */
  const activeConversation = $derived(convs.currentConvo);

  /**
   * Debounced WS-disconnect banner: only shown after the socket has been down for a
   * few seconds, to avoid flicker on brief reconnects / startup.
   */
  let showWsBanner = $state(false);
  $effect(() => {
    // Suppress during the initial messaging bring-up: the WS is legitimately not connected yet
    // while MLS/session initialise, so showing "en attente de connexion" then is a false positive.
    // Only arm the delayed banner once init is done and we are genuinely disconnected.
    if (session.isWsConnected || session.isMessagingInitializing) {
      showWsBanner = false;
      return;
    }
    const t = setTimeout(() => (showWsBanner = true), 3000);
    return () => clearTimeout(t);
  });

  // Notification tap → open conversation (also handled globally in ChatBackgroundService).
  $effect(() => {
    const id = notifNav.pending;
    if (!id) return;
    if (openConversationFromId(convs, convCtx(), id)) {
      notifNav.clear();
    }
  });

  // ─── Sync session (local - scoped to /chat, not the global background service) ──
  const sync = useSyncSession();

  let messageText = $state('');

  /** Message en cours de transfert (ouvre ForwardMessageModal quand non-null). */
  let forwardingMessage = $state<ChatMessage | null>(null);
  let isWindowFocused = $state(true);
  let isTabVisible = $state(true);

  /** Appends a debug message to the global log buffer and scrolls the log panel. */
  function log(msg: string) {
    appendLog(msg);
    tick().then(() => {
      const el = document.getElementById('logContainer');
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  /** Builds the context object passed to channel workspace composable operations. */
  function channelsCtx() {
    return {
      conversations: convs.conversations,
      saveConversation: (name: string) => convs.saveConversation(name, convCtx()),
      deleteConversation: (name: string) =>
        session.storage?.deleteConversation(name) ?? Promise.resolve(),
      selectConversation: convs.selectConversation,
      ensureMls: async () => session.ensureMls(),
      startDirectConversation: (targetUserId: string) =>
        convs.startNewConversation(targetUserId, convCtx()),
      getSelectedConversationId: () => convs.selectedContact,
      reloadChannelHistory: (channelConversationId: string) =>
        convs.loadHistoryForConversation(channelConversationId, channelConversationId, convCtx()),
      invalidateChannelHistoryCache: (channelConversationId: string) =>
        convs.invalidateChannelHistoryCache(channelConversationId),
      log,
    };
  }

  /** Builds the context object passed to QR sync session operations. */
  function syncCtx() {
    return {
      historyBaseUrl: session.historyBaseUrl,
      userId: session.userId,
      myDeviceId: session.myDeviceId,
      pin: session.pin,
      storage: session.storage,
      log,
      loadExistingConversations: () => convs.loadAndRestoreConversations(convCtx()),
      processDeviceInvitationsLocally: () => session.processDeviceInvitationsLocally(sessionCb()),
    };
  }

  /** Builds the context object passed to conversation composable operations. */
  function convCtx() {
    return {
      storage: session.storage,
      ensureMls: session.ensureMls,
      userId: session.userId,
      pin: session.pin,
      historyBaseUrl: session.historyBaseUrl,
      messageReactions: messaging.messageReactions,
      log,
      addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
        messaging.addMessageToChat(sid, content, contactName, msgCtx(), options),
      batchAddMessages: (
        msgs: Parameters<typeof messaging.batchAddMessages>[0],
        contactName: string
      ) => messaging.batchAddMessages(msgs, contactName, msgCtx()),
    };
  }

  /** Builds the context object passed to messaging composable operations. */
  function msgCtx() {
    return {
      ensureMls: session.ensureMls,
      conversations: convs.conversations,
      userId: session.userId,
      pin: session.pin,
      authToken: session.authToken,
      setAuthToken: (v: string) => {
        session.authToken = v;
      },
      selectedContact: convs.selectedContact,
      getSendError: () => convs.sendError,
      setSendError: (v: string) => {
        convs.sendError = v;
      },
      getChatContainer: () => convs.chatContainer,
      storage: session.storage,
      log,
      saveConversation: (name: string) => convs.saveConversation(name, convCtx()),
      verifyCurrentUserMembership: (name: string) =>
        convs.verifyCurrentUserMembership(name, convCtx()),
      playNotificationTone: notifs.playNotificationTone,
      playSendTone: notifs.playSendTone,
      playReceiveTone: notifs.playReceiveTone,
      playReadTone: notifs.playReadTone,
      sendSystemNotification: notifs.sendSystemNotification,
    };
  }

  /** Builds the callbacks object passed to session composable operations (WebSocket event handlers). */
  function sessionCb() {
    return {
      conversations: convs.conversations,
      loadAndRestoreConversations: () => convs.loadAndRestoreConversations(convCtx()),
      addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
        messaging.addMessageToChat(sid, content, contactName, msgCtx(), options),
      beginBulkMessageIngest: (phase: BulkIngestPhase) => messaging.beginBulkMessageIngest(phase),
      endBulkMessageIngest: (phase: BulkIngestPhase) =>
        messaging.endBulkMessageIngest(msgCtx(), phase),
      batchAddMessages: (
        msgs: Parameters<typeof messaging.batchAddMessages>[0],
        contactName: string
      ) => messaging.batchAddMessages(msgs, contactName, msgCtx()),
      saveConversation: (name: string) => convs.saveConversation(name, convCtx()),
      selectConversation: convs.selectConversation,
      onSendError: (msg: string) => {
        convs.sendError = msg;
      },
      onReadReceiptReceived: (e: { conversationKey: string; senderId: string; messageIds: string[] }) => {
        // Son uniquement quand quelqu'un d'autre lit MON message, dans la conversation
        // ouverte à l'écran et l'onglet visible (pas mes propres lectures cross-device).
        if (e.senderId === session.userId) return;
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        if (e.conversationKey !== convs.selectedContact) return;
        notifs.playReadTone();
      },
      log,
      messageReactions: messaging.messageReactions,
      getSelectedContact: () => convs.selectedContact,
      setSelectedContact: (v: string | null) => {
        convs.selectedContact = v;
      },
      onLoadHistoryForConversation: (contactName: string, groupId: string) =>
        convs.loadHistoryForConversation(contactName, groupId, convCtx()),
    };
  }

  /**
   * Returns the set of props shared by both the desktop sidebar and the mobile drawer sidebar.
   * Extracted here to avoid duplicating 20+ prop bindings in the template.
   */
  function makeSidebarCommonProps() {
    return {
      viewMode: (routeMode === 'communities' ? 'communities' : 'chat') as 'chat' | 'communities',
      conversations: convs.conversations,
      selectedContact: convs.selectedContact,
      newContactInput: convs.newContactInput,
      newGroupInput: convs.newGroupInput,
      newChannelInput: convs.newChannelInput,
      channelWorkspaces: channels.channelWorkspaces,
      selectedChannelId: channels.selectedChannelConversationId,
      currentUserId: session.userId,
      onContactInputChange: (v: string) => {
        convs.newContactInput = v;
      },
      onGroupInputChange: (v: string) => {
        convs.newGroupInput = v;
      },
      onChannelInputChange: (v: string) => {
        convs.newChannelInput = v;
      },
      onAddContact: (value?: string) => {
        const c = (value ?? convs.newContactInput).trim();
        if (c) {
          void convs.startNewConversation(c, convCtx());
          convs.newContactInput = '';
        }
      },
      onCreateGroup: (value?: string) => {
        const g = (value ?? convs.newGroupInput).trim();
        if (g) {
          void convs.createNewGroup(g, convCtx());
          convs.newGroupInput = '';
        }
      },
      onCreateChannel: (workspaceId: string, value?: string) => {
        const ch = (value ?? convs.newChannelInput).trim();
        if (!ch) return;
        const ws = channels.channelWorkspaces.find((w) => w.id === workspaceId);
        if (ws?.workspaceDbId) channels.createNewChannel(ws.workspaceDbId, ch, channelsCtx());
        convs.newChannelInput = '';
      },
      onCreateWorkspace: (value?: string) => {
        const wn = (value ?? '').trim();
        if (wn) channels.createNewCommunity(wn, channelsCtx());
      },
      onInviteChannelMember: (
        channelId: string,
        memberId: string,
        roleName: 'member' | 'moderator' | 'admin'
      ) => channels.inviteMemberToChannel(channelId, memberId, roleName, channelsCtx()),
      onUpdateChannelMemberRole: (
        channelId: string,
        memberId: string,
        roleName: 'member' | 'moderator' | 'admin'
      ) => channels.updateChannelMemberRole(channelId, memberId, roleName, channelsCtx()),
      onUpdateWorkspaceImage: (workspaceDbId: string, mediaId: string) =>
        void channels.updateCurrentWorkspaceImage(workspaceDbId, mediaId, channelsCtx()),
      onLeaveWorkspace: (workspaceDbId: string) => {
        void channels.leaveCurrentWorkspace(workspaceDbId, channelsCtx());
        if (isSelectedChannel) {
          const ws = channels.channelWorkspaces.find((w) => w.workspaceDbId === workspaceDbId);
          if (ws?.channels.some((c) => c.id === convs.selectedContact))
            convs.selectedContact = null;
        }
      },
      onSelectConversation: handleSelectConversation,
      onSelectChannelConversation: (channelId: string) => {
        channels.selectedChannelConversationId = channelId;
        convs.selectConversation(channelId);
        void convs.loadHistoryForConversation(channelId, channelId, convCtx());
      },
      onRefresh: async () => {
        // If disconnected, give the auto-reconnect mechanism a moment to kick in.
        // The actual reconnect is triggered by the visibility-change watchdog in
        // ChatBackgroundService; this just provides the UX feedback.
        if (!session.isWsConnected) {
          await new Promise<void>((r) => setTimeout(r, 600));
        }
      },
    };
  }

  // ─── Load group members when selected conversation changes ────────────────
  $effect(() => {
    const contact = convs.selectedContact;
    if (!contact || !session.isLoggedIn) return;
    const convo = convs.conversations.get(contact);
    if (!convo?.id) return;
    void convs.loadGroupMembers(convo.id, convCtx());
  });

  // ─── Read receipts (debounced 2 s) ────────────────────────────────────────
  let pendingReadReceipts: string[] = [];
  let readReceiptTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    if (!convs.selectedContact || !session.isLoggedIn) return;
    if (!isWindowFocused || !isTabVisible) return;
    const convo = convs.conversations.get(convs.selectedContact);
    if (!convo || convo.lifecycle !== 'active') return;

    const meNorm = session.userId.toLowerCase();
    const unread = convo.messages.filter(
      (m) => !m.isOwn && !m.isSystem && !(m.readBy || []).includes(meNorm)
    );
    if (unread.length === 0) return;

    const ids = unread.map((m) => m.id);
    const currentContact = convs.selectedContact;

    // Optimistically mark as read in-memory without waiting for the network ACK.
    untrack(() => {
      setTimeout(() => {
        const fresh = convs.conversations.get(currentContact);
        if (!fresh) return;
        convs.conversations.set(currentContact, {
          ...fresh,
          messages: fresh.messages.map((m) =>
            ids.includes(m.id) ? { ...m, readBy: [...(m.readBy || []), meNorm] } : m
          ),
        });
      }, 0);
    });

    ids.forEach((id) => {
      if (!pendingReadReceipts.includes(id)) pendingReadReceipts.push(id);
    });

    if (!readReceiptTimer) {
      readReceiptTimer = setTimeout(() => {
        untrack(() => {
          const toSend = [...pendingReadReceipts];
          pendingReadReceipts = [];
          readReceiptTimer = null;
          if (toSend.length === 0) return;
          try {
            const mlsService = session.ensureMls();
            const fresh = convs.conversations.get(currentContact);
            if (!fresh) return;
            sendReadReceipt(toSend, {
              mlsService,
              userId: session.userId,
              pin: session.pin,
              conversation: fresh,
            }).catch(() => {});
          } catch {
            /* MLS not ready */
          }
        });
      }, 2000);
    }

    // Only cancel the timer when the user navigates to a different conversation.
    // Same-conversation re-runs (e.g. from the optimistic readBy update below) must
    // not cancel the pending timer - that was the root cause of receipts never firing.
    return () => {
      if (convs.selectedContact !== currentContact) {
        if (readReceiptTimer) {
          clearTimeout(readReceiptTimer);
          readReceiptTimer = null;
        }
        pendingReadReceipts = [];
      }
    };
  });

  // ─── Mount: event listeners (window focus, visibility, debug shortcut) ────
  onMount(() => {
    isWindowFocused = document.hasFocus();
    isTabVisible = document.visibilityState === 'visible';

    const handleVisibilityChange = () => {
      isTabVisible = document.visibilityState === 'visible';
    };
    const handleWindowFocus = () => {
      isWindowFocused = true;
    };
    const handleWindowBlur = () => {
      isWindowFocused = false;
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Shift+S: force sync reset (clears device cache and reloads)
      if (e.ctrlKey && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        if (session.isLoggedIn && session.userId) {
          forceSyncReset(session.userId, log);
          log('[INFO] Rechargement de la page dans 1s...');
          setTimeout(() => window.location.reload(), 1000);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('keydown', handleKeyDown);
    };
  });

  // ─── Apply pending conversation selection (from cross-page navigation) ────
  $effect(() => {
    if (!session.isLoggedIn) return;
    untrack(() => {
      const pending = sessionStorage.getItem('canari_pending_contact');
      if (pending) {
        sessionStorage.removeItem('canari_pending_contact');
        setTimeout(() => {
          convs.selectConversation(pending);
        }, 600);
      }
    });
  });

  // ─── Reset selection when switching between /chat and /communities ─────────
  // Only on routeMode change (not on mount/remount) so returning to /chat keeps the open thread.
  let lastRouteModeForReset = $state<string | null>(null);
  $effect.pre(() => {
    const mode = routeMode;
    if (lastRouteModeForReset === null) {
      lastRouteModeForReset = mode;
      return;
    }
    if (lastRouteModeForReset === mode) return;
    lastRouteModeForReset = mode;
    untrack(() => {
      if (readReceiptTimer) {
        clearTimeout(readReceiptTimer);
        readReceiptTimer = null;
      }
      pendingReadReceipts = [];
      convs.selectedContact = null;
      convs.isChannelSettingsModalOpen = false;
      convs.isChannelMembersDrawerOpen = false;
      convs.sendError = '';
      messageText = '';
    });
  });

  /** Opens a discussion and loads/decrypts its history (same as channel selection). */
  function handleSelectConversation(name: string) {
    convs.selectConversation(name);
    const convo = convs.conversations.get(name);
    if (convo?.id) {
      void convs.loadHistoryForConversation(name, convo.id, convCtx());
    }
  }

  // ─── Thin forwarding helpers (keep template free of logic) ────────────────

  /** Sends the current messageText via MLS then clears the input. */
  function handleSendChat() {
    void messaging.handleSendChat(msgCtx(), messageText);
    messageText = '';
  }

  /** Forwards selected files to the messaging composable for upload. */
  function handleFilesSelected(files: File[]) {
    void messaging.handleFilesSelected(files, msgCtx());
  }

  /** Opens the forward picker for a given message. */
  function handleForward(message: ChatMessage) {
    forwardingMessage = message;
  }

  /** Transfère le message en cours vers la conversation choisie dans la modal. */
  async function doForward(targetKey: string, target: Conversation) {
    const message = forwardingMessage;
    forwardingMessage = null;
    if (!message) return;
    const result = await messaging.forwardMessage(message.content, targetKey, msgCtx());
    if (result.success) {
      showToast(`Message transféré à ${target.name}`, 'info');
    } else {
      showToast(result.error ?? 'Échec du transfert', 'error');
    }
  }

  /**
   * Routes a throttled typing signal to the right transport for the active
   * conversation: gateway WS for DMs/groups (keyed by the MLS groupId), social
   * HTTP for community channels. Best-effort - failures are ignored.
   */
  function handleTyping(isTyping: boolean) {
    const key = convs.selectedContact;
    if (!key) return;
    if (isSelectedChannel) {
      void channelService.sendTyping(key, isTyping);
      return;
    }
    const convo = convs.conversations.get(key);
    if (!convo?.id) return;
    Promise.resolve(session.ensureMls())
      .then((m) => m?.sendTyping?.(convo.id, isTyping))
      .catch(() => {});
  }

  /**
   * Loads the conversation's shared media/links/files from the FULL local history
   * (IndexedDB/SQLite), for the "Médias, liens & fichiers" panel.
   */
  async function loadSharedContent(conversationId: string): Promise<SharedContent> {
    // Community channels don't persist messages locally (skipDbSave), so aggregate from
    // the in-memory loaded messages. DMs/groups use the full local history from storage.
    if (isChannelConversationId(conversationId)) {
      const convo = convs.conversations.get(conversationId);
      const msgs = (convo?.messages ?? []).map((m) => ({
        id: m.id,
        senderId: m.senderId,
        timestamp: m.timestamp.getTime(),
        content: m.content,
        isDeleted: m.isDeleted,
      }));
      return aggregateSharedContent(msgs);
    }
    if (!session.storage) return { media: [], files: [], links: [] };
    const msgs = await session.storage.getMessages(conversationId, session.pin);
    return aggregateSharedContent(msgs);
  }

  /**
   * Full-conversation search over the local store (DMs/groups), returning matching message IDs
   * oldest-first. Returns null for channels (not persisted locally) so the UI searches the
   * in-memory loaded messages instead.
   */
  async function searchConversation(
    conversationId: string,
    query: string
  ): Promise<string[] | null> {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    if (isChannelConversationId(conversationId) || !session.storage) return null;
    const msgs = await session.storage.getMessages(conversationId, session.pin);
    return msgs
      .filter((m) => !m.isDeleted && messageSearchText(m.content).toLowerCase().includes(q))
      .map((m) => m.id);
  }

  function messageSearchText(content: string): string {
    try {
      return getPreviewText(parseEnvelope(content));
    } catch {
      return content;
    }
  }

  /**
   * Toggles a message's pinned state, routing to the right transport: server pin for
   * community channels (with optimistic local apply + revert on failure), MLS `pin`/`unpin`
   * system message for DMs/groups.
   */
  function handleTogglePinMessage(messageId: string) {
    const key = convs.selectedContact;
    if (!key) return;
    const convo = convs.conversations.get(key);
    if (!convo) return;
    if (isSelectedChannel) {
      const next = !isMessagePinned(convo.id, messageId);
      applyPin(convo.id, messageId, next);
      void channelService.setMessagePinned(convo.id, messageId, next).catch(() => {
        applyPin(convo.id, messageId, !next); // revert if the server rejects
      });
    } else {
      void messaging.handleTogglePin(messageId, msgCtx());
    }
  }

  // Load the channel's pinned-message set from the server when a channel is opened.
  $effect(() => {
    const key = convs.selectedContact;
    if (!key || !isSelectedChannel) return;
    void channelService
      .listPinnedMessageIds(key)
      .then((ids) => setPinnedSet(key, ids))
      .catch(() => {});
  });

  /** Sends a picked GIF as a message (its direct URL is rendered inline as a GIF). */
  function handleSendGif(url: string) {
    void messaging.handleSendChat(msgCtx(), url);
  }

  /** Encrypts and sends a community poll in the currently selected channel. */
  async function handleCreatePoll(draft: ChannelPollDraft) {
    const channelId = convs.selectedContact;
    if (!channelId) return;
    await sendChannelPoll(channelId, draft);
  }

  /** Casts (or retracts) the user's vote on a channel poll, optimistically then authoritatively. */
  async function handleVotePoll(messageId: string, optionIds: string[]) {
    const channelId = convs.selectedContact;
    if (!channelId) return;
    applyLocalVote(messageId, session.userId, optionIds);
    try {
      const meta = await channelService.votePoll(channelId, messageId, optionIds);
      setPollMeta(messageId, meta);
    } catch (e) {
      showToast(`Vote impossible : ${e instanceof Error ? e.message : 'erreur'}`, 'warning');
    }
  }

  /** Starts a voice or video call when the conversation is a group or DM (not a channel). */
  function startCallForCurrentConversation(video: boolean) {
    if (!session.callService || !convs.selectedContact) return;
    const convo = convs.conversations.get(convs.selectedContact);
    if (!convo) return;
    const type = convo.conversationType ?? 'group';
    if (type === 'channel') return;
    if (convo.lifecycle !== 'active') {
      showToast("La session sécurisée n'est pas encore prête. Réessayez dans un instant.", 'warning');
      return;
    }
    session.callService.startCall(convo.id, video).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Groupe introuvable') || msg.includes('Group not found')) {
        showToast('Ce groupe est désynchronisé. Supprimez cette conversation et recréez-en une nouvelle.');
      } else {
        showToast(`Erreur appel : ${msg}`);
      }
    });
  }

</script>

<div class="app-layout" in:fade>
    {#if session.isLoggedIn}
    {#if showWsBanner}
      <div class="flex items-center justify-center gap-1.5 py-1.5 px-4 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs font-medium border-b border-amber-500/20">
        <WifiOff size={11} strokeWidth={2.5} class="shrink-0" />
        En attente de connexion…
      </div>
    {:else if isBackgroundSyncing}
      <div class="flex items-center justify-center gap-2 py-1.5 px-4 bg-cn-yellow/10 text-text-muted text-xs font-medium border-b border-cn-border/60">
        <span class="h-3 w-3 animate-spin rounded-full border-2 border-cn-yellow border-t-transparent shrink-0"></span>
        Synchronisation des messages…
      </div>
    {/if}

    <main class="main-content">
      <!-- Desktop sidebar (always mounted, hidden on mobile when chat is open) -->
      <Sidebar {...makeSidebarCommonProps()} isHidden={convs.mobileView === 'chat'} />

      <svelte:boundary onerror={(e) => appendLog(`[UI] Erreur ChatArea récupérée: ${e}`)}>
        {#snippet failed(_error, reset)}
          <div
            class="flex flex-1 min-h-0 flex-col items-center justify-center gap-4 p-8 text-center"
          >
            <p class="text-sm text-text-muted">Impossible d'afficher cette discussion.</p>
            <button
              type="button"
              onclick={reset}
              class="px-4 py-2 rounded-xl bg-amber-500 text-white text-sm font-semibold"
            >
              Réessayer
            </button>
          </div>
        {/snippet}
        <ChatArea
          currentUserId={session.userId}
          conversation={activeConversation}
          {messageText}
          isChannel={isSelectedChannel ?? false}
          imageMediaId={activeConversation?.imageMediaId ?? null}
          onMessageChange={(value) => (messageText = value)}
          onSend={handleSendChat}
          onTyping={handleTyping}
          onSendGif={handleSendGif}
          onCreatePoll={isSelectedChannel ? handleCreatePoll : undefined}
          onVotePoll={isSelectedChannel ? handleVotePoll : undefined}
          onLoadSharedContent={loadSharedContent}
          onSearchAll={searchConversation}
          onInviteMembers={(ids) => void convs.inviteMembersToCurrentGroup(ids, convCtx())}
          onBack={() => {
            channels.selectedChannelConversationId = '';
            convs.goBackToMenu();
          }}
          onOpenConversations={convs.openConversationDrawer}
          onOpenSettings={isSelectedChannel
            ? () => (convs.isChannelSettingsModalOpen = true)
            : undefined}
          isHidden={convs.mobileView === 'list'}
          isLoadingHistory={convs.isLoadingHistory}
          isCatchingUpMessages={messaging.isMessageCatchupActive}
          groupMembers={convs.groupMembers}
          sendError={convs.sendError}
          onGroupRename={(name) => void convs.handleRenameGroup(name, convCtx())}
          onGroupDelete={() => void convs.handleDeleteGroup(convCtx())}
          onGroupDeleteLocally={() => void convs.handleDeleteGroupLocally(convCtx())}
          onGroupLeave={() => void convs.handleLeaveGroup(convCtx())}
          onGroupRemoveMember={(memberId) => void convs.handleRemoveMember(memberId, convCtx())}
          messageReactions={messaging.messageReactions}
          replyingTo={messaging.replyingTo}
          onReply={messaging.handleReply}
          onForward={isSelectedChannel ? undefined : handleForward}
          onReact={isSelectedChannel
            ? undefined
            : (msgId, emoji) => void messaging.handleAddReaction(msgId, emoji, msgCtx())}
          onDelete={isSelectedChannel
            ? undefined
            : (msgId) => void messaging.handleDeleteMessage(msgId, msgCtx())}
          onEdit={isSelectedChannel
            ? undefined
            : (msgId, text) => void messaging.handleEditMessage(msgId, text, msgCtx())}
          onTogglePin={handleTogglePinMessage}
          onCancelReply={messaging.cancelReply}
          authToken={session.authToken}
          onFilesSelected={handleFilesSelected}
          pendingFiles={messaging.pendingMediaFiles}
          onRemovePendingFile={messaging.removePendingMediaFile}
          isUploading={messaging.isUploadingMedia}
          onStartAudioCall={() => {
            void startCallForCurrentConversation(false);
          }}
          onStartVideoCall={() => {
            void startCallForCurrentConversation(true);
          }}
          onOpenMembers={routeMode === 'communities' && isSelectedChannel
            ? convs.openChannelMembersDrawer
            : undefined}
          onLoadOlderMessages={() => convs.loadOlderMessages(convs.selectedContact!, convCtx())}
          onMessagesScrollEl={(el) => {
            convs.chatContainer = el ?? undefined;
          }}
        />
      </svelte:boundary>

      {#if routeMode === 'communities'}
        {#if channels.selectedChannelConversationId}
          <ChannelMembersSidebar
            currentUserId={session.userId}
            selectedChannelId={channels.selectedChannelConversationId}
          />
        {/if}

        {#if convs.isChannelMembersDrawerOpen}
          <button
            type="button"
            class="fixed inset-0 z-40 bg-black/30 xl:hidden"
            aria-label="Fermer le panneau membres"
            onclick={convs.closeChannelMembersDrawer}
          ></button>
          <div
            class="fixed right-0 top-0 bottom-0 z-50 w-[90vw] max-w-sm border-l border-cn-border bg-[color-mix(in_srgb,var(--cn-surface)_90%,white)] shadow-2xl xl:hidden"
          >
            <ChannelMembersSidebar
              mode="mobile"
              currentUserId={session.userId}
              onClose={convs.closeChannelMembersDrawer}
              selectedChannelId={channels.selectedChannelConversationId}
            />
          </div>
        {/if}
      {/if}

      <!-- Mobile drawer sidebar (mounted only when the drawer is open) -->
      {#if convs.isConversationDrawerOpen}
        <Sidebar
          {...makeSidebarCommonProps()}
          isHidden={false}
          drawerMode={true}
          onCloseDrawer={convs.closeConversationDrawer}
        />
      {/if}

      <ChannelSettingsModal
        open={convs.isChannelSettingsModalOpen}
        onClose={() => (convs.isChannelSettingsModalOpen = false)}
        selectedChannelId={channels.selectedChannelConversationId}
        channelWorkspaces={channels.channelWorkspaces}
        imageMediaId={convs.currentConvo?.imageMediaId ?? null}
        onInviteMember={(channelId, memberId, roleName) =>
          channels.inviteMemberToChannel(channelId, memberId, roleName, channelsCtx())}
        onUpdateMemberRole={(channelId, memberId, roleName) =>
          channels.updateChannelMemberRole(channelId, memberId, roleName, channelsCtx())}
        onRenameChannel={(channelId, newName) =>
          channels.renameCurrentChannel(channelId, newName, channelsCtx())}
        onUpdateChannelImage={(channelId, mediaId) =>
          void channels.updateCurrentChannelImage(channelId, mediaId, channelsCtx())}
        onDeleteChannel={(channelId) => {
          void channels.deleteCurrentChannel(channelId, channelsCtx());
          if (convs.selectedContact === channelId) convs.selectedContact = null;
        }}
        onLeaveChannel={(channelId) => {
          void channels.leaveCurrentChannel(channelId, channelsCtx());
          if (convs.selectedContact === channelId) convs.selectedContact = null;
        }}
      />

      <SyncSessionModal
        isOpen={sync.isSyncSessionOpen}
        mode={sync.syncMode}
        qrPayload={sync.syncQrPayloadText}
        qrDataUrl={sync.syncQrDataUrl}
        joinPayload={sync.syncJoinPayload}
        statusText={sync.syncStatusText}
        isBusy={sync.isSyncSessionBusy}
        onJoinPayloadChange={(value) => (sync.syncJoinPayload = value)}
        onConfirmJoin={() => sync.handleConfirmJoinSync(syncCtx())}
        onCopyPayload={sync.copySyncPayload}
        onClose={sync.closeModal}
      />

      <ForwardMessageModal
        open={!!forwardingMessage}
        conversations={[...convs.conversations.entries()]}
        excludeKey={convs.selectedContact}
        currentUserId={session.userId}
        channelWorkspaces={channels.channelWorkspaces}
        onClose={() => (forwardingMessage = null)}
        onSelect={doForward}
      />
    </main>
    {:else}
      <main class="main-content" aria-hidden="true"></main>
    {/if}

    {#if isMessagingBlocked}
      <MessagingSyncOverlay message={messagingOverlayMessage} />
    {/if}
  </div>

<style>
  .app-layout {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
    width: 100%;
  }

  .main-content {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    position: relative;
  }
</style>
