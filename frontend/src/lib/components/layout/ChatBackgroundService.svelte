<script lang="ts">
  /**
   * ChatBackgroundService — toujours actif dans le layout.
   *
   * Responsabilités :
   * - Initialisation de la session MLS + WebSocket (PIN, biométrie).
   * - Reconnexion au WS lors des changements de visibilité de page.
   * - Affichage global : modal PIN, overlay d'appel, notices d'invitation de canal,
   * prompt d'enrôlement biométrique.
   *
   * En utilisant les singletons globaux (globalChatSingleton.svelte.ts), la
   * connexion persiste sur toutes les routes et non seulement sur /chat.
   */
  import { onMount, untrack } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import { BiometricService } from '$lib/services/biometric';
  import { loadPin } from '$lib/utils/pinVault';
  import { currentUserId } from '$lib/stores/user';
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
  import { Bell, Fingerprint } from 'lucide-svelte';

  let showPinModal = $state(false);
  let pinError = $state('');
  let pinLoading = $state(false);
  let biometricConfigured = $state(false);

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
      addMessageToChat: (
        sid: string,
        content: string,
        contactName: string,
        options?: any
      ) =>
        globalMessaging.addMessageToChat(
          sid,
          content,
          contactName,
          msgCtx(),
          options
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
      deleteConversation: (name: string) =>
        globalSession.storage?.deleteConversation(name) ?? Promise.resolve(),
      selectConversation: globalConvs.selectConversation,
      ensureMls: globalSession.ensureMls,
      startDirectConversation: (targetUserId: string) =>
        globalConvs.startNewConversation(targetUserId, convCtx()),
      getSelectedConversationId: () => globalConvs.selectedContact,
      reloadChannelHistory: (channelConversationId: string) =>
        globalConvs.loadHistoryForConversation(
          channelConversationId,
          channelConversationId,
          convCtx()
        ),
      log: appendLog,
    };
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
        options?: any
      ) =>
        globalMessaging.addMessageToChat(
          sid,
          content,
          contactName,
          msgCtx(),
          options
        ),
      saveConversation: (name: string) => globalConvs.saveConversation(name, convCtx()),
      selectConversation: globalConvs.selectConversation,
      onChannelMemberJoined: (event: any) => {
        if (!event.channelId) return;
        const channelConversationId = `channel_${event.channelId}`;
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
          `Je t'invite à rejoindre #${event.channelName || event.channelId}`,
          channelConversationId
        );
        void globalNotifs.sendSystemNotification(
          'Canal rejoint',
          `Je t'invite à rejoindre #${event.channelName || event.channelId}`,
          channelConversationId
        );
        appendLog(`Ajout au canal #${event.channelName || event.channelId}`);
      },
      onChannelMemberKicked: (event: any) => {
        if (!event.channelId) return;
        const channelConversationId = `channel_${event.channelId}`;
        globalConvs.conversations.delete(channelConversationId);
        void globalSession.storage?.deleteConversation(channelConversationId).catch(() => {});
        globalChannels.removeChannelFromWorkspaces(channelConversationId);
        if (globalConvs.selectedContact === channelConversationId) {
          globalConvs.selectedContact = null;
          globalConvs.sendError = '';
        }
        if (globalChannels.selectedChannelConversationId === channelConversationId) {
          globalChannels.selectedChannelConversationId = '';
        }
        globalNotifs.clearActionChannel(channelConversationId);
        globalNotifs.showChannelMembershipNotice(
          `Vous avez été retiré du canal #${event.channelName || event.channelId}`
        );
        void globalNotifs.sendSystemNotification(
          'Canal quitté',
          `Vous avez été retiré du canal #${event.channelName || event.channelId}`
        );
        appendLog(`Retiré du canal #${event.channelName || event.channelId}`);
      },
      onChannelUpdated: (event: {
        channelId: string;
        name?: string;
        imageMediaId?: string;
      }) => {
        if (!event.channelId) return;
        const channelConversationId = `channel_${event.channelId}`;
        if (event.name) {
          globalChannels.channelWorkspaces = globalChannels.channelWorkspaces.map((ws) => ({
            ...ws,
            channels: ws.channels.map((ch) =>
              ch.id === channelConversationId ? { ...ch, name: event.name! } : ch
            ),
          }));
        }
        const convo = globalConvs.conversations.get(channelConversationId);
        if (convo) {
          globalConvs.conversations.set(channelConversationId, {
            ...convo,
            ...(event.name ? { name: event.name } : {}),
            ...(event.imageMediaId !== undefined ? { imageMediaId: event.imageMediaId } : {}),
          });
        }
      },
      onChannelDeleted: (event: { channelId: string }) => {
        if (!event.channelId) return;
        const channelConversationId = `channel_${event.channelId}`;
        globalConvs.conversations.delete(channelConversationId);
        void globalSession.storage?.deleteConversation(channelConversationId).catch(() => {});
        globalChannels.removeChannelFromWorkspaces(channelConversationId);
        if (globalConvs.selectedContact === channelConversationId) {
          globalConvs.selectedContact = null;
        }
        if (globalChannels.selectedChannelConversationId === channelConversationId) {
          globalChannels.selectedChannelConversationId = '';
        }
      },
      onWorkspaceUpdated: (event: { workspaceId: string; imageMediaId?: string }) => {
        globalChannels.handleWorkspaceUpdated(event);
      },
      onReadReceiptReceived: () => {
        globalNotifs.playReadTone();
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
      onLoadHistoryForConversation: (contactName: string, groupId: string) =>
        globalConvs.loadHistoryForConversation(contactName, groupId, convCtx()),
      onGroupReady: (groupId: string) => {
        if (globalMessaging.pendingRetry?.convoId === groupId) {
          void globalMessaging.drainPendingRetry(groupId, msgCtx());
        }
      },
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
        biometricConfigured = configured;
        if (configured && w.__TAURI_INTERNALS__) {
          // Only invoke the biometric prompt if the device actually has enrolled
          // biometrics. If not (e.g., fingerprint hardware present but no fingerprint
          // set up), skip straight to PIN to avoid a confusing OS error dialog.
          const biometricAvailable = await BiometricService.isAvailable().catch(() => false);
          if (biometricAvailable) {
            await globalSession.biometricLogin(sessionCb());
          }
          if (!globalSession.isLoggedIn) {
            // Biométrie annulée, échouée ou non disponible → fallback modal PIN
            const savedUser2 = currentUserId();
            if (savedUser2) {
              globalSession.userId = savedUser2;
              showPinModal = true;
            } else {
              // No saved user — the layout auth guard will redirect to /login.
            }
          }
          return;
        }
        const savedUser = currentUserId();
        const savedPin = await loadPin();
        if (savedUser && savedPin) {
          globalSession.userId = savedUser;
          globalSession.pin = savedPin;
          void globalSession.login({
            ...sessionCb(),
            onLoginFailed: (msg: string) => {
              // Le PIN sauvegardé est invalide — on demande à l'utilisateur
              pinError = msg;
              showPinModal = true;
            },
          });
        } else if (savedUser) {
          globalSession.userId = savedUser;
          showPinModal = true;
        } else {
          // No saved user — the layout auth guard will redirect to /login.
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

  async function handleBiometricFromModal() {
    pinError = '';
    pinLoading = true;
    await globalSession.biometricLogin(sessionCb());
    pinLoading = false;
    if (globalSession.isLoggedIn) {
      showPinModal = false;
    } else {
      pinError = "L'empreinte digitale a échoué. Entrez votre PIN.";
    }
  }

  async function handlePinSubmit(submittedPin: string) {
    pinError = '';
    pinLoading = true;
    globalSession.pin = submittedPin;
    _loginInProgress = true;

    await globalSession.login({
      ...sessionCb(),
      onLoginFailed: (msg: string) => {
        pinError = msg;
        // La modal reste ouverte — pinLoading s'arrête ci-dessous
      },
    });

    pinLoading = false;
    if (globalSession.isLoggedIn) {
      showPinModal = false;
    }
  }

  // Safety net for the OIDC / dev-login race condition:
  // `onMount` runs once on the initial page load.  When the user first arrives
  // via the OIDC callback (`/auth/callback`) or via `devLogin()` on `/login`,
  // `onMount` fires before `currentUserId()` is set, so `tryLogin()` does
  // nothing useful.  After the callback/login sets the user and navigates to
  // `/chat`, this `afterNavigate` hook re-tries the login flow.
  afterNavigate(async ({ to }) => {
    const path = to?.url.pathname ?? window.location.pathname;
    const isAuthRoute = path === '/login' || path.startsWith('/login') || path.startsWith('/auth/');
    if (isAuthRoute) return;
    if (globalSession.isLoggedIn || _loginInProgress) return;

    const uid = currentUserId();
    if (!uid) return;

    // Arriving on a non-auth route with a user but not yet logged in:
    // trigger the login flow that onMount missed.
    globalSession.initServices(appendLog);
    const savedPin = await loadPin();
    if (savedPin) {
      globalSession.userId = uid;
      globalSession.pin = savedPin;
      _loginInProgress = true;
      void globalSession.login({
        ...sessionCb(),
        onLoginFailed: (msg: string) => {
          pinError = msg;
          showPinModal = true;
          _loginInProgress = false;
        },
      });
    } else {
      globalSession.userId = uid;
      showPinModal = true;
    }
  });
</script>

<!-- PIN modal global (visible sur toutes les routes) -->
<PinModal
  open={showPinModal}
  onSubmit={handlePinSubmit}
  onClose={() => {
    showPinModal = false;
    _loginInProgress = false;
    void goto('/login', { replaceState: true });
  }}
  onBiometricRequest={handleBiometricFromModal}
  showBiometricButton={biometricConfigured}
  externalError={pinError}
  isLoading={pinLoading}
/>

<!-- Notice d'invitation de canal (toutes routes) -->
{#if globalNotifs.channelMembershipNotice}
  <div
    class="pointer-events-none fixed left-1/2 top-[calc(env(safe-area-inset-top,0px)+4.5rem)] z-50 w-[min(92vw,32rem)] -translate-x-1/2 transition-all duration-300"
  >
    <div
      class="pointer-events-auto flex items-center gap-4 rounded-2xl border border-black/5 dark:border-white/10 bg-white/80 dark:bg-black/50 px-4 py-3 shadow-xl shadow-black/5 dark:shadow-black/20 backdrop-blur-2xl"
    >
      <div
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-400"
      >
        <Bell size={16} />
      </div>
      <p class="flex-1 text-sm font-semibold text-text-main leading-snug">
        {globalNotifs.channelMembershipNotice}
      </p>
      {#if globalNotifs.channelMembershipActionChannelId}
        <button
          type="button"
          class="shrink-0 rounded-xl bg-amber-500 px-4 py-2 text-xs font-bold text-[#151B2C] shadow-sm transition-all hover:-translate-y-0.5 hover:bg-amber-400 hover:shadow-md"
          onclick={() => {
            globalNotifs.openJoinedChannelFromNotice(
              globalConvs.selectConversation,
              (id) => (globalChannels.selectedChannelConversationId = id)
            );
            void (async () => {
              const { goto: gotoPage } = await import('$app/navigation');
              void gotoPage('/communities');
            })();
          }}
        >
          Rejoindre
        </button>
      {/if}
    </div>
  </div>
{/if}

<!-- Overlay d'appel désactivé temporairement -->
{#if false}
  <CallOverlay
    callService={globalSession.callService}
    remoteName={globalConvs.currentConvo?.name ?? 'Correspondant'}
  />
{/if}

<!-- Prompt d'enrôlement biométrique (toutes routes) -->
{#if globalSession.showBiometricEnrollPrompt}
  <div
    class="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)] left-4 right-4 md:left-auto md:right-6 md:w-fit max-w-[90vw] z-50 p-4 rounded-[1.25rem] border border-black/5 dark:border-white/10 bg-white/95 dark:bg-black/80 backdrop-blur-2xl shadow-2xl flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-4 transition-all duration-300"
  >
    <div class="flex items-center gap-3 w-full sm:w-auto">
      <div
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-400"
      >
        <Fingerprint size={24} strokeWidth={2.5} />
      </div>

      <div class="flex-1 min-w-0 pr-2">
        <p class="text-sm font-bold text-text-main mb-0.5">Connexion rapide</p>
        <p class="text-[11px] sm:text-xs text-text-muted leading-relaxed">
          Activer l'empreinte digitale ?
        </p>
      </div>
    </div>

    <!-- Le conteneur des boutons est maintenant compact et aligné à droite sur mobile -->
    <div class="flex items-center gap-2 shrink-0 self-end sm:self-auto mt-1 sm:mt-0">
      <button
        onclick={() => globalSession.dismissBiometricPrompt()}
        class="px-3 py-2 text-xs font-semibold text-text-muted hover:text-text-main rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        Plus tard
      </button>
      <button
        onclick={async () => {
          try {
            await globalSession.enrollBiometric();
            globalSession.showBiometricEnrollPrompt = false;
          } catch (e) {
            // Si l'appareil n'a pas d'empreinte configurée, on attrape l'erreur
            if (String(e).includes('At least one biometric must be enrolled')) {
              alert("Aucune empreinte n'est configurée sur votre téléphone. Veuillez en ajouter une dans les paramètres d'Android.");
              globalSession.showBiometricEnrollPrompt = false;
            }
          }
        }}
        class="px-4 py-2 text-xs font-bold text-[#151B2C] bg-amber-500 rounded-xl hover:bg-amber-400 shadow-sm transition-all whitespace-nowrap"
      >
        Activer
      </button>
    </div>
  </div>
{/if}
