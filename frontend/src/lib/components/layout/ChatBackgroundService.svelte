<script lang="ts">
  /**
   * ChatBackgroundService — toujours actif dans le layout.
   *
   * Responsabilités :
   * - Initialisation de la session MLS + WebSocket (PIN, biométrie).
   * - Reconnexion au WS lors des changements de visibilité de page.
   * - Affichage global : modal PIN, overlay d'appel, notices d'invitation de canal,
   *   prompt d'enrôlement biométrique.
   *
   * En utilisant les singletons globaux (globalChatSingleton.svelte.ts), la
   * connexion persiste sur toutes les routes et non seulement sur /chat.
   */
  import { onMount, untrack } from 'svelte';
  import { goto, afterNavigate } from '$app/navigation';
  import { BiometricService } from '$lib/services/biometric';
  import { currentUserId } from '$lib/stores/user';
  import { channelKeyManager } from '$lib/crypto/ChannelKeyVault';
  import { ChannelService } from '$lib/services/ChannelService';
  import {
    globalSession,
    globalConvs,
    globalMessaging,
    globalChannels,
    globalNotifs,
    appendLog,
  } from '$lib/stores/globalChatSingleton.svelte';
  import PinModal from '$lib/components/auth/PinModal.svelte';
  import CallOverlay from '$lib/components/chat/CallOverlay.svelte';
  import type { ConversationContext } from '$lib/composables/useConversations.svelte';
  import type { MessagingContext } from '$lib/composables/useMessaging.svelte';

  let showPinModal = $state(false);

  // Guard against concurrent login attempts (e.g. onMount + afterNavigate both firing).
  let _loginInProgress = false;

  // ── Context builders ──────────────────────────────────────────────────────
  // Mirror de MainChatPage mais référence les singletons globaux.

  function convCtx(): ConversationContext {
    return {
      storage: globalSession.storage,
      ensureMls: globalSession.ensureMls,
      userId: globalSession.userId,
      pin: globalSession.pin,
      historyBaseUrl: globalSession.historyBaseUrl,
      messageReactions: globalMessaging.messageReactions,
      log: appendLog,
      addMessageToChat: (sid, content, contactName, replyTo, isSystem, msgId, ts) =>
        globalMessaging.addMessageToChat(
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

  function msgCtx(): MessagingContext {
    return {
      ensureMls: globalSession.ensureMls,
      conversations: globalConvs.conversations,
      userId: globalSession.userId,
      pin: globalSession.pin,
      authToken: globalSession.authToken,
      setAuthToken: (v: string) => {
        globalSession.authToken = v;
      },
      selectedContact: globalConvs.selectedContact,
      getSendError: () => globalConvs.sendError,
      setSendError: (v: string) => {
        globalConvs.sendError = v;
      },
      getChatContainer: () => globalConvs.chatContainer,
      storage: globalSession.storage,
      log: appendLog,
      saveConversation: (name: string) => globalConvs.saveConversation(name, convCtx()),
      verifyCurrentUserMembership: (name: string) =>
        globalConvs.verifyCurrentUserMembership(name, convCtx()),
      playNotificationTone: globalNotifs.playNotificationTone,
      playSendTone: globalNotifs.playSendTone,
      playReceiveTone: globalNotifs.playReceiveTone,
      playReadTone: globalNotifs.playReadTone,
      sendSystemNotification: globalNotifs.sendSystemNotification,
    };
  }

  function channelsCtx() {
    return {
      conversations: globalConvs.conversations,
      saveConversation: (name: string) => globalConvs.saveConversation(name, convCtx()),
      selectConversation: globalConvs.selectConversation,
      log: appendLog,
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

  /** Callbacks complets pour globalSession.login() / session callbacks. */
  function sessionCb() {
    return {
      conversations: globalConvs.conversations,
      loadAndRestoreConversations: () => globalConvs.loadAndRestoreConversations(convCtx()),
      addMessageToChat: (
        sid: string,
        content: string,
        contactName: string,
        replyTo?: any,
        isSystem?: boolean,
        msgId?: string,
        ts?: Date
      ) =>
        globalMessaging.addMessageToChat(
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
        globalMessaging.addSystemMessage(content, contactName, msgCtx()),
      saveConversation: (name: string) => globalConvs.saveConversation(name, convCtx()),
      selectConversation: globalConvs.selectConversation,
      onChannelMemberJoined: (event: any) => {
        if (!event.channelId) return;
        const channelConversationId = `channel_${event.channelId}`;
        void bootstrapChannelKey(event.channelId);
        const workspace = globalChannels.ensureWorkspaceForChannelEvent(event);
        const isPrivate = event.visibility === 'private';
        globalChannels.addChannelToWorkspace(workspace.id, {
          id: channelConversationId,
          name: (event.channelName || 'canal').toLowerCase(),
          isPrivate,
        });
        if (!globalConvs.conversations.has(channelConversationId)) {
          globalConvs.conversations.set(channelConversationId, {
            id: channelConversationId,
            contactName: channelConversationId,
            name: (event.channelName || 'canal').toLowerCase(),
            messages: [],
            isReady: true,
            mlsStateHex: null,
          });
        }
        globalNotifs.showChannelMembershipNotice(
          isPrivate
            ? `Vous avez ete ajoute au canal prive #${event.channelName || event.channelId}`
            : `Vous avez ete ajoute au canal #${event.channelName || event.channelId}`,
          isPrivate ? channelConversationId : undefined
        );
        void globalNotifs.sendSystemNotification(
          'Canal rejoint',
          `Vous avez ete ajoute au canal #${event.channelName || event.channelId}`
        );
        appendLog(`Ajout au canal #${event.channelName || event.channelId}`);
      },
      onChannelMemberKicked: (event: any) => {
        if (!event.channelId) return;
        const channelConversationId = `channel_${event.channelId}`;
        globalConvs.conversations.delete(channelConversationId);
        globalChannels.removeChannelFromWorkspaces(channelConversationId);
        if (globalConvs.selectedContact === channelConversationId) {
          globalConvs.selectedContact = null;
          globalConvs.mobileView = 'list';
          globalConvs.sendError = '';
        }
        if (globalChannels.selectedChannelConversationId === channelConversationId) {
          globalChannels.selectedChannelConversationId = '';
        }
        globalNotifs.clearActionChannel(channelConversationId);
        globalNotifs.showChannelMembershipNotice(
          `Vous avez ete retire du canal #${event.channelName || event.channelId}`
        );
        void globalNotifs.sendSystemNotification(
          'Canal quitte',
          `Vous avez ete retire du canal #${event.channelName || event.channelId}`
        );
        appendLog(`Retire du canal #${event.channelName || event.channelId}`);
      },
      onSendError: (msg: string) => {
        globalConvs.sendError = msg;
      },
      onShowSyncGuidePrompt: () => {
        globalConvs.showSyncGuidePrompt = true;
      },
      log: appendLog,
      messageReactions: globalMessaging.messageReactions,
      getSelectedContact: () => globalConvs.selectedContact,
      setSelectedContact: (v: string | null) => {
        globalConvs.selectedContact = v;
      },
      setMobileView: (v: 'list' | 'chat') => {
        globalConvs.mobileView = v;
      },
      onLoadHistoryForConversation: (contactName: string, groupId: string) =>
        globalConvs.loadHistoryForConversation(contactName, groupId, convCtx()),
    };
  }

  // ── Post-login : chargement des canaux ─────────────────────────────────
  $effect(() => {
    if (!globalSession.isLoggedIn) return;
    untrack(() => {
      void globalChannels.loadChannelWorkspacesFromBackend(channelsCtx());
    });
  });

  // ── Mount ─────────────────────────────────────────────────────────────────
  onMount(() => {
    // Déjà connecté (ex. navigation depuis /chat) → rien à faire.
    if (globalSession.isLoggedIn) return;

    void globalNotifs.requestSystemNotificationPermission();

    const w = window as Window & {
      wasm_bindings_log?: (level: string, msg: string) => void;
      __TAURI_INTERNALS__?: unknown;
    };
    w.wasm_bindings_log = (level: string, msg: string) => appendLog(`[RUST::${level}] ${msg}`);

    globalSession.initServices(appendLog);

    const tryLogin = async () => {
      // Prevent concurrent calls from onMount + afterNavigate.
      if (_loginInProgress || globalSession.isLoggedIn) return;
      _loginInProgress = true;
      try {
        const configured = await BiometricService.isConfigured().catch(() => false);
        if (configured && w.__TAURI_INTERNALS__) {
          await globalSession.biometricLogin(sessionCb());
          return;
        }
        const savedUser = currentUserId();
        const savedPin = localStorage.getItem('canari_saved_pin');
        if (savedUser && savedPin) {
          globalSession.userId = savedUser;
          globalSession.pin = savedPin;
          void globalSession.login(sessionCb());
        } else if (savedUser) {
          globalSession.userId = savedUser;
          showPinModal = true;
        } else {
          const cur = window.location.pathname + window.location.search;
          void goto(`/login?returnTo=${encodeURIComponent(cur)}`, { replaceState: true });
        }
      } finally {
        // Reset flag so afterNavigate can re-try if this invocation did nothing
        // useful (e.g. redirected to /login because no user was available yet).
        if (!globalSession.isLoggedIn && !showPinModal) _loginInProgress = false;
      }
    };

    void tryLogin();

    // Reconnexion lors du retour de l'onglet ou du focus
    const handleVisibilityChange = () => {
      if (
        document.visibilityState === 'visible' &&
        globalSession.isLoggedIn &&
        !globalSession.isWsConnected
      ) {
        appendLog('Page visible de nouveau — reconnexion...');
        void globalSession.attemptReconnect(sessionCb());
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // ── Tauri notification click → show & focus window ─────────────────────
    let unlistenNotif: (() => void) | null = null;
    if ((window as any).__TAURI_INTERNALS__) {
      import('@tauri-apps/plugin-notification')
        .then(({ onAction }) => {
          onAction((notification) => {
            import('@tauri-apps/api/window')
              .then(({ getCurrentWindow }) => {
                const win = getCurrentWindow();
                win.show().catch(() => {});
                win.unminimize().catch(() => {});
                win.setFocus().catch(() => {});
              })
              .catch(() => {});
          });
        })
        .catch(() => {});
    }

    // ── IndexedDB garbage collection: delete messages older than 90 days ───
    const GC_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
    const MESSAGE_MAX_AGE = 90 * 24 * 60 * 60 * 1000; // 90 days
    const gcTimer = setInterval(() => {
      const storage = globalSession.storage;
      if (storage) {
        storage
          .deleteOldMessages(MESSAGE_MAX_AGE)
          .then((n) => {
            if (n > 0) appendLog(`[GC] ${n} ancien(s) message(s) supprimé(s) de IndexedDB`);
          })
          .catch(() => {});
      }
    }, GC_INTERVAL);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(gcTimer);
    };
  });

  function handlePinSubmit(pin: string) {
    showPinModal = false;
    globalSession.pin = pin;
    _loginInProgress = true;
    void globalSession.login(sessionCb());
  }

  // Safety net for the OIDC / dev-login race condition:
  // `onMount` runs once on the initial page load.  When the user first arrives
  // via the OIDC callback (`/auth/callback`) or via `devLogin()` on `/login`,
  // `onMount` fires before `currentUserId()` is set, so `tryLogin()` does
  // nothing useful.  After the callback/login sets the user and navigates to
  // `/chat`, this `afterNavigate` hook re-tries the login flow.
  afterNavigate(({ to }) => {
    const path = to?.url.pathname ?? window.location.pathname;
    const isAuthRoute = path === '/login' || path.startsWith('/login') || path.startsWith('/auth/');
    if (isAuthRoute) return;
    if (globalSession.isLoggedIn || _loginInProgress) return;

    const uid = currentUserId();
    if (!uid) return;

    // Arriving on a non-auth route with a user but not yet logged in:
    // trigger the login flow that onMount missed.
    globalSession.initServices(appendLog);
    const savedPin = localStorage.getItem('canari_saved_pin');
    if (savedPin) {
      globalSession.userId = uid;
      globalSession.pin = savedPin;
      _loginInProgress = true;
      void globalSession.login(sessionCb());
    } else {
      globalSession.userId = uid;
      showPinModal = true;
    }
  });
</script>

<!-- PIN modal global (visible sur toutes les routes) -->
<PinModal open={showPinModal} onSubmit={handlePinSubmit} />

<!-- Notice d'invitation de canal (toutes routes) -->
{#if globalNotifs.channelMembershipNotice}
  <div
    class="pointer-events-none fixed left-1/2 top-[calc(env(safe-area-inset-top,0px)+4.5rem)] z-40 w-[min(92vw,42rem)] -translate-x-1/2"
  >
    <div
      class="pointer-events-auto flex items-center gap-3 rounded-2xl border border-cn-border bg-white/95 px-4 py-3 text-sm font-semibold text-text-main shadow-lg backdrop-blur"
    >
      <p class="flex-1">{globalNotifs.channelMembershipNotice}</p>
      {#if globalNotifs.channelMembershipActionChannelId}
        <button
          type="button"
          class="rounded-lg border border-cn-border bg-white px-3 py-1.5 text-xs font-bold text-text-main hover:border-cn-yellow"
          onclick={() => {
            globalNotifs.openJoinedChannelFromNotice(
              globalConvs.selectConversation,
              (id) => (globalChannels.selectedChannelConversationId = id)
            );
            void (async () => {
              const { goto: gotoPage } = await import('$app/navigation');
              void gotoPage('/chat');
            })();
          }}
        >
          Rejoindre
        </button>
      {/if}
    </div>
  </div>
{/if}

<!-- Overlay d'appel (toutes routes) -->
{#if globalSession.callService && globalSession.callState !== 'idle'}
  <CallOverlay
    callService={globalSession.callService}
    remoteName={globalConvs.currentConvo?.name ?? 'Correspondant'}
  />
{/if}

<!-- Prompt d'enrôlement biométrique (toutes routes) -->
{#if globalSession.showBiometricEnrollPrompt}
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
      <p class="text-sm font-semibold text-text-main">Activer le deverrouillage par empreinte ?</p>
      <p class="text-xs text-text-muted">
        Votre PIN sera stocke de facon securisee et recuperable uniquement par biometrie.
      </p>
    </div>
    <div class="flex gap-2 shrink-0">
      <button
        onclick={() => (globalSession.showBiometricEnrollPrompt = false)}
        class="px-3 py-1.5 text-xs text-text-muted rounded-xl border border-cn-border hover:border-cn-yellow transition-colors"
      >
        Plus tard
      </button>
      <button
        onclick={() => globalSession.enrollBiometric()}
        class="px-3 py-1.5 text-xs font-bold text-cn-dark bg-cn-yellow rounded-xl hover:bg-cn-yellow-hover transition-colors"
      >
        Activer
      </button>
    </div>
  </div>
{/if}
