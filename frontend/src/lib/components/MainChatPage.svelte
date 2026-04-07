<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import { Users } from 'lucide-svelte';
  import { sendReadReceipt } from '$lib/utils/chat/messaging';
  import { forceSyncReset } from '$lib/utils/chat/actions';
  import { channelKeyManager } from '$lib/crypto/ChannelKeyVault';
  import { ChannelService } from '$lib/services/ChannelService';
  import { useSyncSession } from '$lib/composables/useSyncSession.svelte';
  import {
    globalSession as session,
    globalConvs as convs,
    globalMessaging as messaging,
    globalChannels as channels,
    globalNotifs as notifs,
    appendLog,
    getStatusLog,
  } from '$lib/stores/globalChatSingleton.svelte';
  import Modal from './shared/Modal.svelte';
  import Navbar from './navigation/Navbar.svelte';
  import Sidebar from './sidebar/Sidebar.svelte';
  import ChannelMembersSidebar from './chat/ChannelMembersSidebar.svelte';
  import ChannelSettingsModal from './chat/ChannelSettingsModal.svelte';
  import SyncSessionModal from './chat/SyncSessionModal.svelte';
  import DeviceManagementPanel from './chat/DeviceManagementPanel.svelte';
  import ChatArea from './chat/ChatArea.svelte';
  import LogsPanel from './dev/LogsPanel.svelte';

  interface Props {
    routeMode?: 'chat' | 'communities';
  }

  let { routeMode = 'chat' }: Props = $props();

  // ─── Sync session (local — ne concerne que la page /chat) ─────────────────
  const sync = useSyncSession();

  // ─── Dev / log state ──────────────────────────────────────────────────────
  let showLogs = $state(false);
  let messageText = $state('');
  let isWindowFocused = $state(true);
  let isTabVisible = $state(true);
  let showDevicePanel = $state(false);
  let pendingInvitationCount = $state(0);

  // Log local (écrit aussi dans le buffer global pour le LogsPanel)
  function log(msg: string) {
    appendLog(msg);
    tick().then(() => {
      const el = document.getElementById('logContainer');
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  // Lecture réactive des logs globaux pour le LogsPanel
  const statusLog = $derived(getStatusLog());

  /** Context object for channel workspace operations. */
  function channelsCtx() {
    return {
      conversations: convs.conversations,
      saveConversation: (name: string) => convs.saveConversation(name, convCtx()),
      selectConversation: convs.selectConversation,
      log,
    };
  }

  /** Context object for sync session operations. */
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

  /** Context for conversation composable operations. */
  function convCtx() {
    return {
      storage: session.storage,
      ensureMls: session.ensureMls,
      userId: session.userId,
      pin: session.pin,
      historyBaseUrl: session.historyBaseUrl,
      messageReactions: messaging.messageReactions,
      log,
      addMessageToChat: (
        sid: string,
        content: string,
        contactName: string,
        replyTo?: any,
        isSystem?: boolean,
        msgId?: string,
        ts?: Date
      ) =>
        messaging.addMessageToChat(
          sid,
          content,
          contactName,
          msgCtx(),
          replyTo,
          isSystem,
          msgId,
          ts
        ),
    };
  }

  /** Context for messaging composable operations. */
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

  async function bootstrapChannelKey(rawChannelId: string) {
    const vault = channelKeyManager.getVault(rawChannelId);
    try {
      vault.getCurrentKey();
      return;
    } catch {
      // no key yet
    }
    try {
      const svc = new ChannelService();
      const { epochKey, keyVersion } = await svc.getChannelKey(rawChannelId);
      const rawKeyMat = Uint8Array.from(atob(epochKey), (c) => c.charCodeAt(0));
      await vault.rotateKey(keyVersion, rawKeyMat);
    } catch {
      const encoded = new TextEncoder().encode(`canari-channel-key:${rawChannelId}`);
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
      await vault.rotateKey(0, hash);
    }
  }

  /** Callbacks object for session composable operations. */
  function sessionCb() {
    return {
      conversations: convs.conversations,
      loadAndRestoreConversations: () => convs.loadAndRestoreConversations(convCtx()),
      addMessageToChat: (
        sid: string,
        content: string,
        contactName: string,
        replyTo?: any,
        isSystem?: boolean,
        msgId?: string,
        ts?: Date
      ) =>
        messaging.addMessageToChat(
          sid,
          content,
          contactName,
          msgCtx(),
          replyTo,
          isSystem,
          msgId,
          ts
        ),
      addSystemMessage: (content: string, contactName: string) =>
        messaging.addSystemMessage(content, contactName, msgCtx()),
      saveConversation: (name: string) => convs.saveConversation(name, convCtx()),
      selectConversation: convs.selectConversation,
      onChannelMemberJoined: (event: any) => {
        if (!event.channelId) return;
        const channelConversationId = `channel_${event.channelId}`;
        void bootstrapChannelKey(event.channelId);
        const workspace = channels.ensureWorkspaceForChannelEvent(event);
        const isPrivate = event.visibility === 'private';
        channels.addChannelToWorkspace(workspace.id, {
          id: channelConversationId,
          name: (event.channelName || 'canal').toLowerCase(),
          isPrivate,
        });
        if (!convs.conversations.has(channelConversationId)) {
          convs.conversations.set(channelConversationId, {
            id: channelConversationId,
            contactName: channelConversationId,
            name: (event.channelName || 'canal').toLowerCase(),
            messages: [],
            isReady: true,
            mlsStateHex: null,
          });
        }
        notifs.showChannelMembershipNotice(
          isPrivate
            ? `Vous avez ete ajoute au canal prive #${event.channelName || event.channelId}`
            : `Vous avez ete ajoute au canal #${event.channelName || event.channelId}`,
          isPrivate ? channelConversationId : undefined
        );
        void notifs.sendSystemNotification(
          'Canal rejoint',
          `Vous avez ete ajoute au canal #${event.channelName || event.channelId}`
        );
        log(`Ajout au canal #${event.channelName || event.channelId}`);
      },
      onChannelMemberKicked: (event: any) => {
        if (!event.channelId) return;
        const channelConversationId = `channel_${event.channelId}`;
        convs.conversations.delete(channelConversationId);
        channels.removeChannelFromWorkspaces(channelConversationId);
        if (convs.selectedContact === channelConversationId) {
          convs.selectedContact = null;
          convs.mobileView = 'list';
          convs.sendError = '';
        }
        if (channels.selectedChannelConversationId === channelConversationId) {
          channels.selectedChannelConversationId = '';
        }
        notifs.clearActionChannel(channelConversationId);
        notifs.showChannelMembershipNotice(
          `Vous avez ete retire du canal #${event.channelName || event.channelId}`
        );
        void notifs.sendSystemNotification(
          'Canal quitte',
          `Vous avez ete retire du canal #${event.channelName || event.channelId}`
        );
        log(`Retire du canal #${event.channelName || event.channelId}`);
      },
      onSendError: (msg: string) => {
        convs.sendError = msg;
      },
      onShowSyncGuidePrompt: () => {
        convs.showSyncGuidePrompt = true;
      },
      onReadReceiptReceived: () => {
        notifs.playReadTone();
      },
      log,
      messageReactions: messaging.messageReactions,
      getSelectedContact: () => convs.selectedContact,
      setSelectedContact: (v: string | null) => {
        convs.selectedContact = v;
      },
      setMobileView: (v: 'list' | 'chat') => {
        convs.mobileView = v;
      },
      onLoadHistoryForConversation: (contactName: string, groupId: string) =>
        convs.loadHistoryForConversation(contactName, groupId, convCtx()),
    };
  }

  // ─── Read receipts (debounced 2 s) ────────────────────────────────────────
  let pendingReadReceipts: string[] = [];
  let readReceiptTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    if (!convs.selectedContact || !session.isLoggedIn) return;
    if (!isWindowFocused || !isTabVisible) return;
    if (convs.mobileView !== 'chat') return;
    const convo = convs.conversations.get(convs.selectedContact);
    if (!convo || !convo.isReady) return;

    const meNorm = session.userId.toLowerCase();
    const unread = convo.messages.filter(
      (m) => !m.isOwn && !m.isSystem && !(m.readBy || []).includes(meNorm)
    );
    if (unread.length === 0) return;

    const ids = unread.map((m) => m.id);
    const currentContact = convs.selectedContact;

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
            })
              .then((sent) => {
                if (sent) notifs.playReadTone();
              })
              .catch(() => {});
          } catch {
            /* MLS not ready */
          }
        });
      }, 2000);
    }
  });

  // ─── Mount ────────────────────────────────────────────────────────────────
  // La session est déjà gérée par ChatBackgroundService (monté dans le layout).
  // Ici, on gère uniquement les événements propres à la vue /chat.

  // ─── Pending invitations polling ──────────────────────────────────────────
  $effect(() => {
    if (!session.isLoggedIn || !session.myDeviceId) return;
    const userId = session.userId;
    const deviceId = session.myDeviceId;
    let cancelled = false;

    async function pollPendingInvitations() {
      try {
        const mls = session.ensureMls();
        const memberships = await mls.getDeviceMemberships(userId, deviceId);
        if (!cancelled) {
          const pending = memberships.filter((m) => m.status === 'pending');
          pendingInvitationCount = pending.length;
          if (pending.length > 0) {
            console.log(`[DevicePanel] ${pending.length} pending invitation(s) detected`);
          }
        }
      } catch {
        // MLS not ready yet
      }
    }

    void pollPendingInvitations();
    const interval = setInterval(pollPendingInvitations, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  });

  onMount(() => {
    isWindowFocused = document.hasFocus();
    isTabVisible = document.visibilityState === 'visible';

    const handleVisibilityChange = () => {
      isTabVisible = document.visibilityState === 'visible';
      // La reconnexion est gérée de façon globale par ChatBackgroundService.
    };
    const handleWindowFocus = () => {
      isWindowFocused = true;
    };
    const handleWindowBlur = () => {
      isWindowFocused = false;
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Shift+S: Force sync reset (clear device cache and reload)
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

  // ─── Post-login : sélection de conversation en attente ───────────────────
  $effect(() => {
    if (!session.isLoggedIn) return;
    untrack(() => {
      // Apply any pending conversation selection (from ConversationsMiniPanel cross-navigation)
      const pending = sessionStorage.getItem('canari_pending_contact');
      if (pending) {
        sessionStorage.removeItem('canari_pending_contact');
        // Delay to let conversations load first
        setTimeout(() => {
          convs.selectConversation(pending);
        }, 600);
      }
    });
  });

  // ─── Forwarding helpers (thin wrappers so the template stays clean) ───────

  function handleSendChat() {
    // Expose messageText to msgCtx via a closure trick:
    void messaging.handleSendChat({ ...msgCtx(), _messageText: messageText } as any);
    messageText = '';
  }

  function handleFilesSelected(files: File[]) {
    void messaging.handleFilesSelected(files, msgCtx());
  }

  function openQrGuideSync() {
    convs.showSyncGuidePrompt = false;
    sync.openJoinSyncModal();
  }
  // ─── END ──────────────────────────────────────────────────────────────────
</script>

<!-- ==================== UI ==================== -->

{#if !session.isLoggedIn}
  <div class="min-h-screen flex items-center justify-center text-sm text-text-muted">
    Connexion en cours...
  </div>
{:else}
  <div class="app-layout" in:fade>
    <Navbar
      isWsConnected={session.isWsConnected}
      onToggleLogs={() => (showLogs = !showLogs)}
      onLogout={() => session.logout(sessionCb())}
    />

    {#if notifs.channelMembershipNotice}
      <!-- La notice est aussi affichée dans ChatBackgroundService ; ce bloc est
           conservé pour la compatibilité visuelle quand on est déjà sur /chat. -->
    {/if}

    <main class="main-content">
      <Sidebar
        viewMode={routeMode === 'communities' ? 'communities' : 'chat'}
        conversations={convs.conversations}
        selectedContact={convs.selectedContact}
        newContactInput={convs.newContactInput}
        newGroupInput={convs.newGroupInput}
        newChannelInput={convs.newChannelInput}
        channelWorkspaces={channels.channelWorkspaces}
        selectedChannelId={channels.selectedChannelConversationId}
        isExporting={session.isExporting}
        isImporting={session.isImporting}
        isSyncing={sync.isSyncSessionBusy}
        onContactInputChange={(v) => (convs.newContactInput = v)}
        onGroupInputChange={(v) => (convs.newGroupInput = v)}
        onChannelInputChange={(v) => (convs.newChannelInput = v)}
        onAddContact={(value?: string) => {
          const c = (value ?? convs.newContactInput).trim();
          if (c) {
            void convs.startNewConversation(c, convCtx());
            convs.newContactInput = '';
          }
        }}
        onCreateGroup={(value?: string) => {
          const g = (value ?? convs.newGroupInput).trim();
          if (g) {
            void convs.createNewGroup(g, convCtx());
            convs.newGroupInput = '';
          }
        }}
        onCreateChannel={(workspaceId: string, value?: string) => {
          const ch = (value ?? convs.newChannelInput).trim();
          if (!ch) return;
          const ws = channels.channelWorkspaces.find((w) => w.id === workspaceId);
          if (ws?.workspaceDbId) {
            channels.createNewChannel(ws.workspaceDbId, ch, channelsCtx());
          }
          convs.newChannelInput = '';
        }}
        onCreateWorkspace={(value?: string) => {
          const wn = (value ?? '').trim();
          if (wn) channels.createNewCommunity(wn, channelsCtx());
        }}
        onInviteChannelMember={(channelId, memberId, roleName) =>
          channels.inviteMemberToChannel(channelId, memberId, roleName, channelsCtx())}
        onUpdateChannelMemberRole={(channelId, memberId, roleName) =>
          channels.updateChannelMemberRole(channelId, memberId, roleName, channelsCtx())}
        onSelectConversation={convs.selectConversation}
        onSelectChannelConversation={(channelId) => {
          channels.selectedChannelConversationId = channelId;
          convs.selectConversation(channelId);
        }}
        onExport={() => session.handleExport(log)}
        onImport={(file) =>
          session.handleImport(
            file,
            log,
            () => convs.conversations.clear(),
            () => convs.loadAndRestoreConversations(convCtx())
          )}
        onStartSync={() => sync.handleStartSyncSession(syncCtx())}
        onJoinSync={() => sync.openJoinSyncModal()}
        onOpenDevicePanel={() => (showDevicePanel = true)}
        {pendingInvitationCount}
        isHidden={convs.mobileView === 'chat'}
      />

      <ChatArea
        conversation={convs.currentConvo}
        {messageText}
        isChannel={convs.selectedContact?.startsWith('channel_') ?? false}
        onMessageChange={(value) => (messageText = value)}
        onSend={handleSendChat}
        onInviteMembers={(ids) => void convs.inviteMembersToCurrentGroup(ids, convCtx())}
        onBack={convs.goBackToMenu}
        onOpenConversations={() => {
          convs.isConversationDrawerOpen = true;
        }}
        onOpenSettings={convs.selectedContact?.startsWith('channel_')
          ? () => (convs.isChannelSettingsModalOpen = true)
          : undefined}
        isHidden={convs.mobileView === 'list'}
        groupMembers={convs.groupMembers}
        sendError={convs.sendError}
        onGroupRename={(name) => void convs.handleRenameGroup(name, convCtx())}
        onGroupDelete={() => void convs.handleDeleteGroup(convCtx())}
        onGroupRemoveMember={(memberId) => void convs.handleRemoveMember(memberId, convCtx())}
        messageReactions={messaging.messageReactions}
        replyingTo={messaging.replyingTo}
        onReply={messaging.handleReply}
        onReact={convs.selectedContact?.startsWith('channel_')
          ? undefined
          : (msgId, emoji) => void messaging.handleAddReaction(msgId, emoji, msgCtx())}
        onDelete={convs.selectedContact?.startsWith('channel_')
          ? undefined
          : (msgId) => void messaging.handleDeleteMessage(msgId, msgCtx())}
        onEdit={convs.selectedContact?.startsWith('channel_')
          ? undefined
          : (msgId, text) => void messaging.handleEditMessage(msgId, text, msgCtx())}
        onCancelReply={messaging.cancelReply}
        authToken={session.authToken}
        onFilesSelected={handleFilesSelected}
        pendingFiles={messaging.pendingMediaFiles}
        onRemovePendingFile={messaging.removePendingMediaFile}
        isUploading={messaging.isUploadingMedia}
        onStartCall={() => {
          if (session.callService && convs.selectedContact) {
            const convo = convs.conversations.get(convs.selectedContact);
            if (convo) {
              session.callService.startCall(convo.id).catch((e: unknown) => {
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
          }
        }}
      />

      {#if routeMode === 'communities'}
        {#if channels.selectedChannelConversationId}
          <ChannelMembersSidebar
            currentUserId={session.userId}
            selectedChannelId={channels.selectedChannelConversationId}
          />
          <button
            type="button"
            onclick={() => {
              convs.isChannelMembersDrawerOpen = true;
            }}
            class="fixed bottom-24 right-4 z-30 inline-flex items-center gap-2 rounded-full border border-cn-border bg-white/90 px-3 py-2 text-sm font-semibold text-text-main shadow-md xl:hidden"
            aria-label="Ouvrir les membres du canal"
          >
            <Users size={14} />
            Membres
          </button>
        {/if}

        {#if convs.isChannelMembersDrawerOpen}
          <button
            type="button"
            class="fixed inset-0 z-40 bg-black/30 xl:hidden"
            aria-label="Fermer le panneau membres"
            onclick={() => {
              convs.isChannelMembersDrawerOpen = false;
            }}
          ></button>
          <div
            class="fixed right-0 top-0 bottom-0 z-50 w-[90vw] max-w-sm border-l border-cn-border bg-[color-mix(in_srgb,var(--cn-surface)_90%,white)] shadow-2xl xl:hidden"
          >
            <ChannelMembersSidebar
              mode="mobile"
              currentUserId={session.userId}
              onClose={() => {
                convs.isChannelMembersDrawerOpen = false;
              }}
              selectedChannelId={channels.selectedChannelConversationId}
            />
          </div>
        {/if}
      {/if}

      {#if convs.isConversationDrawerOpen}
        <Sidebar
          viewMode={routeMode === 'communities' ? 'communities' : 'chat'}
          conversations={convs.conversations}
          selectedContact={convs.selectedContact}
          newContactInput={convs.newContactInput}
          newGroupInput={convs.newGroupInput}
          newChannelInput={convs.newChannelInput}
          channelWorkspaces={channels.channelWorkspaces}
          selectedChannelId={channels.selectedChannelConversationId}
          isExporting={session.isExporting}
          isImporting={session.isImporting}
          isSyncing={sync.isSyncSessionBusy}
          onContactInputChange={(v) => (convs.newContactInput = v)}
          onGroupInputChange={(v) => (convs.newGroupInput = v)}
          onChannelInputChange={(v) => (convs.newChannelInput = v)}
          onAddContact={(value?: string) => {
            const c = (value ?? convs.newContactInput).trim();
            if (c) {
              void convs.startNewConversation(c, convCtx());
              convs.newContactInput = '';
            }
          }}
          onCreateGroup={(value?: string) => {
            const g = (value ?? convs.newGroupInput).trim();
            if (g) {
              void convs.createNewGroup(g, convCtx());
              convs.newGroupInput = '';
            }
          }}
          onCreateChannel={(workspaceId: string, value?: string) => {
            const ch = (value ?? convs.newChannelInput).trim();
            if (!ch) return;
            const ws = channels.channelWorkspaces.find((w) => w.id === workspaceId);
            if (ws?.workspaceDbId) {
              channels.createNewChannel(ws.workspaceDbId, ch, channelsCtx());
            }
            convs.newChannelInput = '';
          }}
          onCreateWorkspace={(value?: string) => {
            const wn = (value ?? '').trim();
            if (wn) channels.createNewCommunity(wn, channelsCtx());
          }}
          onInviteChannelMember={(channelId, memberId, roleName) =>
            channels.inviteMemberToChannel(channelId, memberId, roleName, channelsCtx())}
          onUpdateChannelMemberRole={(channelId, memberId, roleName) =>
            channels.updateChannelMemberRole(channelId, memberId, roleName, channelsCtx())}
          onSelectConversation={convs.selectConversation}
          onSelectChannelConversation={(channelId) => {
            channels.selectedChannelConversationId = channelId;
            convs.selectConversation(channelId);
          }}
          onExport={() => session.handleExport(log)}
          onImport={(file) =>
            session.handleImport(
              file,
              log,
              () => convs.conversations.clear(),
              () => convs.loadAndRestoreConversations(convCtx())
            )}
          onStartSync={() => sync.handleStartSyncSession(syncCtx())}
          onJoinSync={() => sync.openJoinSyncModal()}
          onOpenDevicePanel={() => (showDevicePanel = true)}
          {pendingInvitationCount}
          isHidden={false}
          drawerMode={true}
          onCloseDrawer={() => {
            convs.isConversationDrawerOpen = false;
          }}
        />
      {/if}

      <ChannelSettingsModal
        open={convs.isChannelSettingsModalOpen}
        onClose={() => (convs.isChannelSettingsModalOpen = false)}
        selectedChannelId={channels.selectedChannelConversationId}
        channelWorkspaces={channels.channelWorkspaces}
        onInviteMember={(channelId, memberId, roleName) =>
          channels.inviteMemberToChannel(channelId, memberId, roleName, channelsCtx())}
        onUpdateMemberRole={(channelId, memberId, roleName) =>
          channels.updateChannelMemberRole(channelId, memberId, roleName, channelsCtx())}
      />

      <SyncSessionModal
        isOpen={sync.isSyncSessionOpen}
        mode={sync.syncMode}
        qrPayload={sync.syncQrPayloadText}
        qrDataUrl={sync.syncQrDataUrl}
        joinPayload={sync.syncJoinPayload}
        statusText={sync.syncStatusText}
        isBusy={sync.isSyncSessionBusy}
        onJoinPayloadChange={(value: string) => (sync.syncJoinPayload = value)}
        onConfirmJoin={() => sync.handleConfirmJoinSync(syncCtx())}
        onCopyPayload={sync.copySyncPayload}
        onClose={sync.closeModal}
      />

      {#if session.isLoggedIn}
        <DeviceManagementPanel
          open={showDevicePanel}
          userId={session.userId}
          myDeviceId={session.myDeviceId}
          mlsService={session.ensureMls()}
          onClose={() => (showDevicePanel = false)}
        />
      {/if}

      <Modal
        open={convs.showSyncGuidePrompt}
        onClose={() => (convs.showSyncGuidePrompt = false)}
        title="Nouveau appareil detecte"
      >
        <div class="space-y-3 text-sm text-text-main">
          <p>
            Pour recuperer vos conversations, lancez une synchronisation QR avec un appareil deja
            connecte.
          </p>
          <ol class="list-decimal list-inside space-y-1 text-text-muted">
            <li>Sur l'appareil principal: ouvrez la synchronisation QR.</li>
            <li>Affichez le QR de transfert.</li>
            <li>Sur ce nouvel appareil: scannez le QR ou collez le payload.</li>
          </ol>
          <button
            onclick={openQrGuideSync}
            class="w-full mt-2 px-3 py-2 rounded-xl bg-cn-dark text-white font-medium hover:bg-gray-800 transition-colors"
          >
            Ouvrir la synchronisation QR
          </button>
        </div>
      </Modal>

      {#if showLogs}
        <div class="fixed inset-0 z-50 flex flex-col md:relative md:inset-auto md:z-auto md:block">
          <LogsPanel
            logs={statusLog}
            onClose={() => (showLogs = false)}
            onGenerateKeyPackage={() => session.devGenerateKeyPackage(log)}
            onAddMember={() =>
              session.devAddMember(
                convs.selectedContact
                  ? (convs.conversations.get(convs.selectedContact)?.id ?? '')
                  : '',
                log
              )}
            onProcessWelcome={() => session.devProcessWelcome(log)}
            lastKeyPackage={session.lastKeyPackage}
            lastCommit={session.lastCommit}
            lastWelcome={session.lastWelcome}
            incomingBytesHex={session.incomingBytesHex}
            onIncomingBytesChange={(value) => (session.incomingBytesHex = value)}
          />
        </div>
      {/if}
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
    z-index: 1;
    backdrop-filter: saturate(1.02);
  }
</style>
