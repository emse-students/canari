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
  import { Bell, Fingerprint } from 'lucide-svelte';

  let showPinModal = $state(false);
  let pinError = $state('');
  let pinLoading = $state(false);

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
            ? `Vous avez été ajouté au canal privé #${event.channelName || event.channelId}`
            : `Vous avez été ajouté au canal #${event.channelName || event.channelId}`,
          isPrivate ? channelConversationId : undefined
        );
        void globalNotifs.sendSystemNotification(
          'Canal rejoint',
          `Vous avez été ajouté au canal #${event.channelName || event.channelId}`
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
      onChannelUpdated: (event: { channelId: string; name?: string }) => {
        if (!event.channelId || !event.name) return;
        const channelConversationId = `channel_${event.channelId}`;
        globalChannels.channelWorkspaces = globalChannels.channelWorkspaces.map((ws) => ({
          ...ws,
          channels: ws.channels.map((ch) =>
            ch.id === channelConversationId ? { ...ch, name: event.name! } : ch
          ),
        }));
        const convo = globalConvs.conversations.get(channelConversationId);
        if (convo)
          globalConvs.conversations.set(channelConversationId, { ...convo, name: event.name });
      },
      onChannelDeleted: (event: { channelId: string }) => {
        if (!event.channelId) return;
        const channelConversationId = `channel_${event.channelId}`;
        globalConvs.conversations.delete(channelConversationId);
        globalChannels.removeChannelFromWorkspaces(channelConversationId);
        if (globalConvs.selectedContact === channelConversationId) {
          globalConvs.selectedContact = null;
        }
        if (globalChannels.selectedChannelConversationId === channelConversationId) {
          globalChannels.selectedChannelConversationId = '';
        }
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
          if (!globalSession.isLoggedIn) {
            // Biométrie annulée ou échouée → fallback modal PIN
            const savedUser2 = currentUserId();
            if (savedUser2) {
              globalSession.userId = savedUser2;
              showPinModal = true;
            } else {
              const cur2 = window.location.pathname + window.location.search;
              void goto(`/login?returnTo=${encodeURIComponent(cur2)}`, { replaceState: true });
            }
          }
          return;
        }
        const savedUser = currentUserId();
        const savedPin = localStorage.getItem('canari_saved_pin');
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
    let _unlistenNotif: (() => void) | null = null;
    if ((window as any).__TAURI_INTERNALS__) {
      import('@tauri-apps/plugin-notification')
        .then(({ onAction }) => {
          onAction((_notification) => {
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
      <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-400">
        <Bell size={16} />
      </div>
      <p class="flex-1 text-sm font-semibold text-text-main leading-snug">{globalNotifs.channelMembershipNotice}</p>
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
    class="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)] left-4 right-4 md:left-auto md:right-6 md:w-96 z-50 p-4 sm:p-5 rounded-[1.5rem] border border-black/5 dark:border-white/10 bg-white/80 dark:bg-black/50 backdrop-blur-2xl shadow-2xl shadow-black/10 dark:shadow-black/30 flex items-start sm:items-center gap-4 transition-all duration-300"
  >
    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-400">
      <Fingerprint size={24} strokeWidth={2.5} />
    </div>

    <div class="flex-1 min-w-0">
      <p class="text-sm font-bold text-text-main mb-0.5">Connexion rapide</p>
      <p class="text-[11px] sm:text-xs text-text-muted leading-relaxed">
        Activer l'empreinte digitale ? Votre PIN sera stocké de façon sécurisée.
      </p>
    </div>

    <div class="flex flex-col sm:flex-row gap-2 shrink-0 mt-3 sm:mt-0 w-full sm:w-auto">
      <button
        onclick={() => (globalSession.showBiometricEnrollPrompt = false)}
        class="px-3 py-2 text-xs font-semibold text-text-muted hover:text-text-main rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        Plus tard
      </button>
      <button
        onclick={() => globalSession.enrollBiometric()}
        class="px-4 py-2 text-xs font-bold text-[#151B2C] bg-amber-500 rounded-xl hover:bg-amber-400 hover:-translate-y-0.5 shadow-sm hover:shadow-md transition-all"
      >
        Activer
      </button>
    </div>
  </div>
{/if}
