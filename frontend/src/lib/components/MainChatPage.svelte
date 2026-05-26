<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import { sendReadReceipt } from '$lib/utils/chat/messaging';
  import { forceSyncReset } from '$lib/utils/chat/actions';
  import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
  import { useSyncSession } from '$lib/composables/useSyncSession.svelte';
  import {
    globalSession as session,
    globalConvs as convs,
    globalMessaging as messaging,
    globalChannels as channels,
    globalNotifs as notifs,
    appendLog,
  } from '$lib/stores/globalChatSingleton.svelte';
  import { notifNav } from '$lib/stores/notifNav.svelte';
  import Sidebar from './sidebar/Sidebar.svelte';
  import ChannelMembersSidebar from './chat/ChannelMembersSidebar.svelte';
  import ChannelSettingsModal from './chat/ChannelSettingsModal.svelte';
  import SyncSessionModal from './chat/SyncSessionModal.svelte';
  import SyncGuideModal from './chat/SyncGuideModal.svelte';
  import ChatArea from './chat/ChatArea.svelte';

  interface Props {
    /** Controls whether the sidebar shows private chat conversations or community channels. */
    routeMode?: 'chat' | 'communities';
  }

  let { routeMode = 'chat' }: Props = $props();

  /** True when the currently selected conversation is a channel (not an MLS DM or group). */
  const isSelectedChannel = $derived(isChannelConversationId(convs.selectedContact ?? ''));

  // ─── Notification click navigation ────────────────────────────────────────
  // When a system notification is clicked, notifNav.pending is set to the
  // target conversation ID. This effect consumes it and opens the conversation.
  $effect(() => {
    const id = notifNav.pending;
    if (!id) return;
    // Direct key match (web notifications use the conversation map key)
    if (convs.conversations.has(id)) {
      notifNav.clear();
      convs.selectConversation(id);
      void convs.loadHistoryForConversation(id, id, convCtx());
      return;
    }
    // Search by convo.id (Android deep link uses the MLS groupId)
    for (const [key, convo] of convs.conversations) {
      if (convo.id === id) {
        notifNav.clear();
        convs.selectConversation(key);
        void convs.loadHistoryForConversation(key, convo.id, convCtx());
        return;
      }
    }
    // Conversations not yet loaded — effect re-runs when map changes
  });

  // ─── Sync session (local — scoped to /chat, not the global background service) ──
  const sync = useSyncSession();

  let messageText = $state('');
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
      setAuthToken: (v: string) => { session.authToken = v; },
      selectedContact: convs.selectedContact,
      getSendError: () => convs.sendError,
      setSendError: (v: string) => { convs.sendError = v; },
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
      beginBulkMessageIngest: (bulk?: boolean, overlay?: boolean) =>
        messaging.beginBulkMessageIngest(bulk, overlay),
      endBulkMessageIngest: (bulk?: boolean, overlay?: boolean) =>
        messaging.endBulkMessageIngest(msgCtx(), bulk, overlay),
      batchAddMessages: (msgs: Parameters<typeof messaging.batchAddMessages>[0], contactName: string) =>
        messaging.batchAddMessages(msgs, contactName, msgCtx()),
      saveConversation: (name: string) => convs.saveConversation(name, convCtx()),
      selectConversation: convs.selectConversation,
      onSendError: (msg: string) => { convs.sendError = msg; },
      onShowSyncGuidePrompt: () => { convs.showSyncGuidePrompt = true; },
      onReadReceiptReceived: () => { notifs.playReadTone(); },
      log,
      messageReactions: messaging.messageReactions,
      getSelectedContact: () => convs.selectedContact,
      setSelectedContact: (v: string | null) => { convs.selectedContact = v; },
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
      onContactInputChange: (v: string) => { convs.newContactInput = v; },
      onGroupInputChange: (v: string) => { convs.newGroupInput = v; },
      onChannelInputChange: (v: string) => { convs.newChannelInput = v; },
      onAddContact: (value?: string) => {
        const c = (value ?? convs.newContactInput).trim();
        if (c) { void convs.startNewConversation(c, convCtx()); convs.newContactInput = ''; }
      },
      onCreateGroup: (value?: string) => {
        const g = (value ?? convs.newGroupInput).trim();
        if (g) { void convs.createNewGroup(g, convCtx()); convs.newGroupInput = ''; }
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
      onInviteChannelMember: (channelId: string, memberId: string, roleName: 'member' | 'moderator' | 'admin') =>
        channels.inviteMemberToChannel(channelId, memberId, roleName, channelsCtx()),
      onUpdateChannelMemberRole: (channelId: string, memberId: string, roleName: 'member' | 'moderator' | 'admin') =>
        channels.updateChannelMemberRole(channelId, memberId, roleName, channelsCtx()),
      onUpdateWorkspaceImage: (workspaceDbId: string, mediaId: string) =>
        void channels.updateCurrentWorkspaceImage(workspaceDbId, mediaId, channelsCtx()),
      onLeaveWorkspace: (workspaceDbId: string) => {
        void channels.leaveCurrentWorkspace(workspaceDbId, channelsCtx());
        if (isSelectedChannel) {
          const ws = channels.channelWorkspaces.find((w) => w.workspaceDbId === workspaceDbId);
          if (ws?.channels.some((c) => c.id === convs.selectedContact)) convs.selectedContact = null;
        }
      },
      onSelectConversation: convs.selectConversation,
      onSelectChannelConversation: (channelId: string) => {
        channels.selectedChannelConversationId = channelId;
        convs.selectConversation(channelId);
        void convs.loadHistoryForConversation(channelId, channelId, convCtx());
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
    if (!convo || !convo.isReady) return;

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
    // not cancel the pending timer — that was the root cause of receipts never firing.
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

    const handleVisibilityChange = () => { isTabVisible = document.visibilityState === 'visible'; };
    const handleWindowFocus = () => { isWindowFocused = true; };
    const handleWindowBlur = () => { isWindowFocused = false; };
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
        setTimeout(() => { convs.selectConversation(pending); }, 600);
      }
    });
  });

  // ─── Reset selection when switching between /chat and /communities ─────────
  // $effect.pre runs before DOM updates so ChatArea never reads a torn-down conversation.
  $effect.pre(() => {
    const _ = routeMode;
    untrack(() => {
      if (readReceiptTimer) {
        clearTimeout(readReceiptTimer);
        readReceiptTimer = null;
      }
      pendingReadReceipts = [];
      convs.selectedContact = null;
      convs.sendError = '';
      messageText = '';
    });
  });

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

  /** Starts a voice or video call when the conversation is a group or DM (not a channel). */
  function startCallForCurrentConversation(video: boolean) {
    if (!session.callService || !convs.selectedContact) return;
    const convo = convs.conversations.get(convs.selectedContact);
    if (!convo) return;
    const type = convo.conversationType ?? 'group';
    if (type === 'channel') return;
    if (!convo.isReady) {
      alert('La session securisee n est pas encore prete. Reessayez dans un instant.');
      return;
    }
    session.callService.startCall(convo.id, video).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Groupe introuvable') || msg.includes('Group not found')) {
        alert(
          'Ce groupe est desynchronise. Veuillez supprimer cette conversation et en recreer une nouvelle.'
        );
      } else {
        alert(`Erreur appel: ${msg}`);
      }
    });
  }

  /** Closes the sync guide prompt and opens the QR join modal. */
  function openQrGuideSync() {
    convs.showSyncGuidePrompt = false;
    sync.openJoinSyncModal();
  }
</script>

{#if !session.isLoggedIn}
  <div class="min-h-screen flex items-center justify-center text-sm text-text-muted">
    Connexion en cours...
  </div>
{:else}
  <div class="app-layout" in:fade>
    <main class="main-content">
      <!-- Desktop sidebar (always mounted, hidden on mobile when chat is open) -->
      <Sidebar
        {...makeSidebarCommonProps()}
        isHidden={convs.mobileView === 'chat'}
      />

      {#key `${routeMode}-${convs.selectedContact ?? ''}`}
      <ChatArea
        currentUserId={session.userId}
        conversation={convs.currentConvo}
        {messageText}
        isChannel={isSelectedChannel ?? false}
        imageMediaId={convs.currentConvo?.imageMediaId ?? null}
        onMessageChange={(value) => (messageText = value)}
        onSend={handleSendChat}
        onInviteMembers={(ids) => void convs.inviteMembersToCurrentGroup(ids, convCtx())}
        onBack={convs.goBackToMenu}
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
        onGroupLeave={() => void convs.handleLeaveGroup(convCtx())}
        onGroupRemoveMember={(memberId) => void convs.handleRemoveMember(memberId, convCtx())}
        messageReactions={messaging.messageReactions}
        replyingTo={messaging.replyingTo}
        onReply={messaging.handleReply}
        onReact={isSelectedChannel
          ? undefined
          : (msgId, emoji) => void messaging.handleAddReaction(msgId, emoji, msgCtx())}
        onDelete={isSelectedChannel
          ? undefined
          : (msgId) => void messaging.handleDeleteMessage(msgId, msgCtx())}
        onEdit={isSelectedChannel
          ? undefined
          : (msgId, text) => void messaging.handleEditMessage(msgId, text, msgCtx())}
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
        onMessagesScrollEl={(el) => {
          convs.chatContainer = el ?? undefined;
        }}
      />
      {/key}

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

      <SyncGuideModal
        open={convs.showSyncGuidePrompt}
        onClose={() => (convs.showSyncGuidePrompt = false)}
        onOpenQrSync={openQrGuideSync}
      />
    </main>
  </div>
{/if}

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
