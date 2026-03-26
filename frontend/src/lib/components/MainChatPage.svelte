<script lang="ts">
  import { goto } from '$app/navigation';
  import { BiometricService } from '$lib/services/biometric';
  import { onMount, tick, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import { Users } from 'lucide-svelte';
  import { sendReadReceipt } from '$lib/utils/chat/messaging';
  import { useChatSession } from '$lib/composables/useChatSession.svelte';
  import { useConversations } from '$lib/composables/useConversations.svelte';
  import { useMessaging } from '$lib/composables/useMessaging.svelte';
  import { useChannelWorkspaces } from '$lib/composables/useChannelWorkspaces.svelte';
  import { useSyncSession } from '$lib/composables/useSyncSession.svelte';
  import { useNotifications } from '$lib/composables/useNotifications.svelte';
  import { loadPersistedArchivedIds } from '$lib/utils/chat/conversations';
  import Modal from './shared/Modal.svelte';
  import Navbar from './navigation/Navbar.svelte';
  import Sidebar from './sidebar/Sidebar.svelte';
  import ChannelMembersSidebar from './chat/ChannelMembersSidebar.svelte';
  import ChannelSettingsModal from './chat/ChannelSettingsModal.svelte';
  import SyncSessionModal from './chat/SyncSessionModal.svelte';
  import ChatArea from './chat/ChatArea.svelte';
  import LogsPanel from './dev/LogsPanel.svelte';
  import CallOverlay from '$lib/components/chat/CallOverlay.svelte';

  interface Props {
    routeMode?: 'chat' | 'communities';
  }

  let { routeMode = 'chat' }: Props = $props();

  // ─── Composables ──────────────────────────────────────────────────────────
  const session = useChatSession();
  const convs = useConversations();
  const messaging = useMessaging();
  const channels = useChannelWorkspaces();
  const sync = useSyncSession();
  const notifs = useNotifications();

  // ─── Dev / log state ──────────────────────────────────────────────────────
  let statusLog = $state<string[]>([]);
  let showLogs = $state(false);
  let messageText = $state('');

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function log(msg: string) {
    statusLog = [...statusLog, `[${new Date().toLocaleTimeString()}] ${msg}`];
    tick().then(() => {
      const el = document.getElementById('logContainer');
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

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
      syncOwnDevicesToGroupsLocally: () => session.syncOwnDevicesToGroupsLocally(sessionCb()),
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
      sendSystemNotification: notifs.sendSystemNotification,
    };
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
        const workspace = channels.ensureWorkspaceForChannelEvent(event);
        const isPrivate = event.visibility === 'private';
        channels.addChannelToWorkspace(workspace.id, {
          id: channelConversationId,
          name: (event.channelName || 'canal').toLowerCase(),
          isPrivate,
        });
        if (!convs.conversations.has(channelConversationId)) {
          convs.conversations.set(channelConversationId, {
            contactName: channelConversationId,
            name: (event.channelName || 'canal').toLowerCase(),
            groupId: channelConversationId,
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
            }).catch(() => {});
          } catch {
            /* MLS not ready */
          }
        });
      }, 2000);
    }
  });

  // ─── Mount ────────────────────────────────────────────────────────────────
  onMount(() => {
    void notifs.requestSystemNotificationPermission();

    const w = window as Window & {
      wasm_bindings_log?: (level: string, msg: string) => void;
      __TAURI_INTERNALS__?: unknown;
    };
    w.wasm_bindings_log = (level: string, msg: string) => log(`[RUST::${level}] ${msg}`);

    // Initialise MLS + CallService via session composable
    session.initServices(log);

    if (w.__TAURI_INTERNALS__) {
      void (async () => {
        const configured = await BiometricService.isConfigured();
        if (configured) {
          await session.biometricLogin(sessionCb());
          return;
        }
        const savedUser = localStorage.getItem('canari_saved_user');
        const savedPin = localStorage.getItem('canari_saved_pin');
        if (savedUser && savedPin) {
          session.userId = savedUser;
          session.pin = savedPin;
          void session.login(sessionCb());
        } else {
          const cur = window.location.pathname + window.location.search;
          void goto(`/login?returnTo=${encodeURIComponent(cur)}`, { replaceState: true });
        }
      })();
    } else {
      const savedUser = localStorage.getItem('canari_saved_user');
      const savedPin = localStorage.getItem('canari_saved_pin');
      if (savedUser && savedPin) {
        session.userId = savedUser;
        session.pin = savedPin;
        void session.login(sessionCb());
      } else {
        const cur = window.location.pathname + window.location.search;
        void goto(`/login?returnTo=${encodeURIComponent(cur)}`, { replaceState: true });
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && session.isLoggedIn && !session.isWsConnected) {
        log('Page visible de nouveau — reconnexion...');
        void session.attemptReconnect(sessionCb());
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  });

  // ─── Post-login init (load channels + archived ids) ───────────────────────
  $effect(() => {
    if (!session.isLoggedIn) return;
    untrack(() => {
      convs.archivedConversationIds = loadPersistedArchivedIds(session.userId);
      convs.showArchivedConversations = false;
      void channels.loadChannelWorkspacesFromBackend(channelsCtx());
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
    Redirection vers la page de connexion...
  </div>
{:else}
  <div class="app-layout" in:fade>
    <Navbar
      isWsConnected={session.isWsConnected}
      onToggleLogs={() => (showLogs = !showLogs)}
      onLogout={() => session.logout(sessionCb())}
    />

    {#if notifs.channelMembershipNotice}
      <div
        class="pointer-events-none fixed left-1/2 top-[calc(env(safe-area-inset-top,0px)+4.5rem)] z-40 w-[min(92vw,42rem)] -translate-x-1/2"
      >
        <div
          class="pointer-events-auto flex items-center gap-3 rounded-2xl border border-cn-border bg-white/95 px-4 py-3 text-sm font-semibold text-text-main shadow-lg backdrop-blur"
        >
          <p class="flex-1">{notifs.channelMembershipNotice}</p>
          {#if notifs.channelMembershipActionChannelId}
            <button
              type="button"
              class="rounded-lg border border-cn-border bg-white px-3 py-1.5 text-xs font-bold text-text-main hover:border-cn-yellow"
              onclick={() =>
                notifs.openJoinedChannelFromNotice(
                  convs.selectConversation,
                  (id) => (channels.selectedChannelConversationId = id)
                )}
            >
              Rejoindre
            </button>
          {/if}
        </div>
      </div>
    {/if}

    {#if session.callService && session.callState !== 'idle'}
      <CallOverlay
        callService={session.callService}
        remoteName={convs.currentConvo?.name ?? 'Correspondant'}
      />
    {/if}

    {#if session.showBiometricEnrollPrompt}
      <div
        class="fixed bottom-[env(safe-area-inset-bottom,0px)] left-0 right-0 z-50 mx-4 mb-4 p-4 rounded-2xl border border-cn-border shadow-lg flex items-center gap-3"
        style="background: color-mix(in srgb, var(--cn-surface) 95%, transparent); backdrop-filter: blur(10px);"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="shrink-0 text-cn-yellow"
        >
          <path d="M12 10a2 2 0 0 0-2 2c0 1.02.5 1.93 1.27 2.49" />
          <path d="M12 2a10 10 0 0 1 9.39 6.52" />
          <path d="M12 22C6.48 22 2 17.52 2 12" />
          <path d="M4.93 4.93a10 10 0 0 0-.93 3" />
          <path d="M19.07 4.93A10 10 0 0 1 22 12" />
          <path d="M15.36 17.12A5 5 0 0 1 7 14" />
          <path d="M12 7a5 5 0 0 1 4.9 4" />
        </svg>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold text-text-main">
            Activer le deverrouillage par empreinte ?
          </p>
          <p class="text-xs text-text-muted">
            Votre PIN sera stocke de facon securisee et recuperable uniquement par biometrie.
          </p>
        </div>
        <div class="flex gap-2 shrink-0">
          <button
            onclick={() => (session.showBiometricEnrollPrompt = false)}
            class="px-3 py-1.5 text-xs text-text-muted rounded-xl border border-cn-border hover:border-cn-yellow transition-colors"
          >
            Plus tard
          </button>
          <button
            onclick={() => session.enrollBiometric()}
            class="px-3 py-1.5 text-xs font-bold text-cn-dark bg-cn-yellow rounded-xl hover:bg-cn-yellow-hover transition-colors"
          >
            Activer
          </button>
        </div>
      </div>
    {/if}

    <main class="main-content">
      <Sidebar
        viewMode={routeMode === 'communities' ? 'communities' : 'chat'}
        conversations={convs.conversations}
        archivedConversationIds={convs.archivedConversationIds}
        showArchivedConversations={convs.showArchivedConversations}
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
        onToggleArchivedView={() => {
          convs.showArchivedConversations = !convs.showArchivedConversations;
        }}
        onRestoreConversation={(id) => convs.restoreConversation(id, session.userId)}
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
        isHidden={convs.mobileView === 'chat'}
      />

      <ChatArea
        conversation={convs.currentConvo}
        {messageText}
        isChannel={routeMode === 'communities'}
        onMessageChange={(value) => (messageText = value)}
        onSend={handleSendChat}
        onInviteMembers={(ids) => void convs.inviteMembersToCurrentGroup(ids, convCtx())}
        onBack={convs.goBackToMenu}
        onOpenConversations={() => {
          convs.isConversationDrawerOpen = true;
        }}
        onOpenSettings={routeMode === 'communities'
          ? () => (convs.isChannelSettingsModalOpen = true)
          : undefined}
        isHidden={convs.mobileView === 'list'}
        groupMembers={convs.groupMembers}
        sendError={convs.sendError}
        onGroupRename={(name) => void convs.handleRenameGroup(name, convCtx())}
        onGroupDelete={() => convs.handleDeleteGroup(session.userId)}
        onGroupRemoveMember={(memberId) => void convs.handleRemoveMember(memberId, convCtx())}
        messageReactions={messaging.messageReactions}
        replyingTo={messaging.replyingTo}
        onReply={messaging.handleReply}
        onReact={(msgId, emoji) => void messaging.handleAddReaction(msgId, emoji, msgCtx())}
        onDelete={(msgId) => void messaging.handleDeleteMessage(msgId, msgCtx())}
        onEdit={(msgId, text) => void messaging.handleEditMessage(msgId, text, msgCtx())}
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
              session.callService.startCall(convo.groupId).catch((e: unknown) => {
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
          archivedConversationIds={convs.archivedConversationIds}
          showArchivedConversations={convs.showArchivedConversations}
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
          onToggleArchivedView={() => {
            convs.showArchivedConversations = !convs.showArchivedConversations;
          }}
          onRestoreConversation={(id) => convs.restoreConversation(id, session.userId)}
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
                  ? (convs.conversations.get(convs.selectedContact)?.groupId ?? '')
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
