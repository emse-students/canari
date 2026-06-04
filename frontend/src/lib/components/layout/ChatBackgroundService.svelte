<script lang="ts">
  /**
   * ChatBackgroundService - toujours actif dans le layout.
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
  import { getToken } from '$lib/stores/auth';
  import { showToast } from '$lib/stores/toast.svelte';
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
  import { Fingerprint } from '@lucide/svelte';
  import type { IStorage, StoredMessage } from '$lib/db';
  import { consumeFcmCache } from '$lib/utils/chat/fcmCache';
  import { refreshAppVersionCheck, shouldBlockSessionUnlock } from '$lib/stores/appVersionCheck.svelte';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { isTauriRuntime } from '$lib/utils/openExternal';
  import { mapStoredMessagesToChatMessages } from '$lib/utils/chat/history';
  import { compareMessageOrder } from '$lib/utils/chat/messageOrder';
  import { resolveConversationListPresentation } from '$lib/utils/chat/conversations';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import type { CallParticipant } from '$lib/services/CallService';

  /** Remote users to show on the call overlay (avatars / labels), excluding the local user. */
  function buildRemoteCallParticipants(): CallParticipant[] {
    const uid = (globalSession.userId || currentUserId() || '').toLowerCase();
    const convo = globalConvs.currentConvo;
    const callerId = globalSession.callService?.incomingCallerId?.toLowerCase();

    if (!convo) {
      if (callerId && callerId !== uid) {
        return [{ userId: callerId, displayName: getUserDisplayNameSync(callerId) }];
      }
      return [];
    }

    const pres = resolveConversationListPresentation(
      {
        id: convo.id,
        name: convo.name,
        contactName: convo.contactName,
        conversationType: convo.conversationType,
        directPeerId: convo.directPeerId,
      },
      uid
    );

    if (pres.conversationType === 'direct') {
      const peer = pres.contactId.toLowerCase();
      if (!peer || peer === uid) return [];
      return [{ userId: peer, displayName: pres.displayName }];
    }

    return globalConvs.groupMembers
      .map((m) => m.toLowerCase())
      .filter((m) => m && m !== uid)
      .map((m) => ({ userId: m, displayName: getUserDisplayNameSync(m) }));
  }

  let callRemoteParticipants = $derived.by(buildRemoteCallParticipants);

  /** Load MLS group members while a group call is active so all avatars can be shown. */
  $effect(() => {
    if (globalSession.callState === 'idle' || !globalSession.isLoggedIn) return;
    const groupId = globalSession.callService?.currentGroupId;
    const convo = globalConvs.currentConvo;
    if (!groupId || !convo || (convo.conversationType ?? 'group') === 'direct') return;
    void globalConvs.loadGroupMembers(groupId, convCtx());
  });

  let showPinModal = $state(false);
  /** True when the user has no prior MLS device on this browser - shown as "choose your PIN". */
  let isFirstPinSetup = $state(false);
  let pinError = $state('');
  let pinLoading = $state(false);
  let biometricConfigured = $state(false);

  /** Returns false when min-version or maintenance gates block MLS unlock. */
  async function ensurePlatformAllowsUnlock(): Promise<boolean> {
    await refreshAppVersionCheck();
    if (shouldBlockSessionUnlock(isGlobalAdmin())) {
      appendLog('[platform] Déverrouillage MLS bloqué (maintenance ou version minimale)');
      return false;
    }
    return true;
  }

  /** Opens the PIN modal for the given user, computing isFirstSetup from the server. */
  async function openPinModal(uid: string) {
    if (!(await ensurePlatformAllowsUnlock())) return;
    globalSession.userId = uid;
    isFirstPinSetup = await detectFirstPinSetup(uid);
    showPinModal = true;
  }

  /** Called when a stored PIN is rejected; resets state and shows the PIN modal. */
  function onSavedPinFailed(msg: string) {
    pinError = msg;
    isFirstPinSetup = false;
    showPinModal = true;
  }

  /**
   * Returns true only if the user has zero MLS devices on the server — i.e. a genuinely
   * new account, not an existing user on a new device. Falls back to the localStorage
   * heuristic when the network is unavailable.
   */
  async function detectFirstPinSetup(uid: string): Promise<boolean> {
    try {
      const token = await getToken();
      const res = await fetch(`/api/mls/devices/${encodeURIComponent(uid)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return !localStorage.getItem(`mls_device_id_${uid}`);
      const devices: unknown[] = await res.json();
      return devices.length === 0;
    } catch {
      return !localStorage.getItem(`mls_device_id_${uid}`);
    }
  }

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
      addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
        globalMessaging.addMessageToChat(sid, content, contactName, msgCtx(), options),
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
      invalidateChannelHistoryCache: (channelConversationId: string) =>
        globalConvs.invalidateChannelHistoryCache(channelConversationId),
      log: appendLog,
    };
  }

  /** Callbacks complets pour globalSession.login() / session callbacks. */
  function sessionCb() {
    return {
      conversations: globalConvs.conversations,
      loadAndRestoreConversations: () => globalConvs.loadAndRestoreConversations(convCtx()),
      addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
        globalMessaging.addMessageToChat(sid, content, contactName, msgCtx(), options),
      beginBulkMessageIngest: (bulk?: boolean, overlay?: boolean) =>
        globalMessaging.beginBulkMessageIngest(bulk, overlay),
      endBulkMessageIngest: (bulk?: boolean, overlay?: boolean) =>
        globalMessaging.endBulkMessageIngest(msgCtx(), bulk, overlay),
      batchAddMessages: (
        msgs: Parameters<typeof globalMessaging.batchAddMessages>[0],
        contactName: string
      ) => globalMessaging.batchAddMessages(msgs, contactName, msgCtx()),
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
        appendLog(`Retiré du canal #${event.channelName || event.channelId}`);
      },
      onChannelUpdated: (event: { channelId: string; name?: string; imageMediaId?: string }) => {
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
        globalConvs.invalidateChannelHistoryCache(channelConversationId);
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

  /**
   * Consomme le cache FCM natif et injecte les messages directement dans l'état
   * réactif en mémoire. Permet un affichage immédiat sans attendre le prochain
   * rechargement de l'historique (poll 5 s et retour au premier plan).
   */
  async function flushFcmCache(pin: string, storage: IStorage) {
    const injected = await consumeFcmCache(pin, storage).catch(() => [] as StoredMessage[]);
    if (injected.length === 0 || !globalSession.userId) return;
    for (const msg of injected) {
      const convo = globalConvs.conversations.get(msg.conversationId);
      if (!convo) continue; // conversation pas encore chargée en mémoire
      if (convo.messages.some((m) => m.id === msg.id)) continue; // déjà présent
      // msg.content est le texte brut de la notification FCM, pas un MessageEnvelope JSON.
      // Le pipeline MLS réécrit l'entrée avec les données complètes (replyTo, média…)
      // dès que la delivery queue livre le même message. Pour les textes simples,
      // l'affichage est identique ; pour les médias le placeholder est acceptable.
      const chatMsg = mapStoredMessagesToChatMessages([msg], globalSession.userId)[0];
      const messages = [...convo.messages, chatMsg].sort(compareMessageOrder);
      globalConvs.conversations.set(msg.conversationId, { ...convo, messages });
    }
  }

  // ── Mount ─────────────────────────────────────────────────────────────────
  onMount(() => {
    // Déjà connecté (ex. navigation depuis /chat) → rien à faire.
    if (globalSession.isLoggedIn) return;

    const w = window as Window & {
      wasm_bindings_log?: (level: string, msg: string) => void;
    };
    w.wasm_bindings_log = (level: string, msg: string) => appendLog(`[RUST::${level}] ${msg}`);

    globalSession.initServices(appendLog);

    const tryLogin = async () => {
      // Prevent concurrent calls from onMount + afterNavigate.
      if (_loginInProgress || globalSession.isLoggedIn) return;
      _loginInProgress = true;
      try {
        if (!(await ensurePlatformAllowsUnlock())) return;

        const configured = await BiometricService.isConfigured().catch(() => false);
        biometricConfigured = configured;
        if (configured && isTauriRuntime()) {
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
              await openPinModal(savedUser2);
            } else {
              // No saved user - the layout auth guard will redirect to /login.
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
            onLoginFailed: onSavedPinFailed,
          });
        } else if (savedUser) {
          globalSession.userId = savedUser;
          // On Tauri (Android, no biometrics): try silent login from push_context.json
          if (isTauriRuntime()) {
            const ok = await globalSession.nativeStorageLogin({
              ...sessionCb(),
              onLoginFailed: onSavedPinFailed,
            });
            if (ok) return;
          }
          await openPinModal(savedUser);
        } else {
          // No saved user - the layout auth guard will redirect to /login.
        }
      } finally {
        // Reset flag so afterNavigate can re-try if this invocation did nothing
        // useful (e.g. redirected to /login because no user was available yet).
        if (!globalSession.isLoggedIn && !showPinModal) _loginInProgress = false;
      }
    };

    void tryLogin();

    // Pause/resume WebSocket based on app visibility (fires on Android when backgrounded).
    // Presence polling and other intervals self-manage via createPausableInterval.
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && globalSession.isLoggedIn) {
        globalSession.pauseConnection();
        return;
      }
      if (document.visibilityState === 'visible' && globalSession.isLoggedIn) {
        if (!globalSession.isWsConnected) {
          appendLog('Page visible de nouveau - reconnexion...');
          void globalSession.attemptReconnect(sessionCb());
        }
        // Injecter les messages FCM mis en cache pendant l'arrière-plan
        const { pin, storage } = globalSession;
        if (pin && storage) {
          void flushFcmCache(pin, storage);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // ── FCM cache polling (Tauri/Android only) ────────────────────────────
    // Messages received via FCM while the app is in the foreground are written
    // to fcm_message_cache.ndjson by the Kotlin service but the visibility-change
    // handler above only fires on background→foreground transitions, so those
    // messages would only appear after a restart. Poll every 5 s while visible.
    const FCM_POLL_INTERVAL = 5_000;
    const isTauri = isTauriRuntime();
    const fcmPollTimer = isTauri
      ? setInterval(() => {
          if (document.hidden) return;
          const { pin, storage } = globalSession;
          if (!pin || !storage) return;
          void flushFcmCache(pin, storage);
        }, FCM_POLL_INTERVAL)
      : null;

    // ── IndexedDB garbage collection: delete messages older than 90 days ───
    const GC_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
    const MESSAGE_MAX_AGE = 90 * 24 * 60 * 60 * 1000; // 90 days
    const gcTimer = setInterval(() => {
      if (document.hidden) return;
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
      if (fcmPollTimer !== null) clearInterval(fcmPollTimer);
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

  function handlePinSubmit(submittedPin: string) {
    pinError = '';
    pinLoading = true;
    globalSession.pin = submittedPin;
    _loginInProgress = true;

    void globalSession.login({
      ...sessionCb(),
      onMlsReady: () => {
        showPinModal = false;
        pinLoading = false;
      },
      onLoginFailed: (msg: string) => {
        pinError = msg;
        pinLoading = false;
      },
    });
  }

  // Safety net for the OIDC race condition:
  // `onMount` runs once on the initial page load. When the user first arrives
  // via the OIDC callback (`/auth/callback`), `onMount` fires before
  // `currentUserId()` is set, so `tryLogin()` does nothing useful.
  // After the callback sets the user and navigates to `/chat`,
  // this `afterNavigate` hook re-tries the login flow.
  afterNavigate(async ({ to }) => {
    const path = to?.url.pathname ?? window.location.pathname;
    const isAuthRoute =
      path === '/login' ||
      path.startsWith('/login') ||
      path.startsWith('/auth/') ||
      path.startsWith('/legal');
    if (isAuthRoute) return;
    if (globalSession.isLoggedIn || _loginInProgress) return;

    const uid = currentUserId();
    if (!uid) return;

    if (!(await ensurePlatformAllowsUnlock())) return;

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
          onSavedPinFailed(msg);
          _loginInProgress = false;
        },
      });
    } else {
      globalSession.userId = uid;
      // Try biometric before falling back to the PIN modal.
      // biometricConfigured is set by onMount.tryLogin which runs before afterNavigate.
      if (biometricConfigured) {
        const bioAvailable = await BiometricService.isAvailable().catch(() => false);
        if (bioAvailable) {
          _loginInProgress = true;
          await globalSession.biometricLogin(sessionCb());
          if (globalSession.isLoggedIn) return;
          _loginInProgress = false;
        }
      }
      await openPinModal(uid);
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
    const returnTo = encodeURIComponent(window.location.pathname);
    void goto(`/login?returnTo=${returnTo}`, { replaceState: true });
  }}
  onBiometricRequest={handleBiometricFromModal}
  showBiometricButton={biometricConfigured}
  externalError={pinError}
  isLoading={pinLoading}
  isFirstSetup={isFirstPinSetup}
/>


{#if globalSession.callService && globalSession.callState !== 'idle'}
  <CallOverlay
    callService={globalSession.callService}
    currentUserId={globalSession.userId || currentUserId() || ''}
    participants={callRemoteParticipants}
  />
{/if}

<!-- Prompt d'enrôlement biométrique (toutes routes) -->
{#if globalSession.showBiometricEnrollPrompt}
  <div
    data-keyboard-aware-toast
    class="keyboard-aware-bottom fixed bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)] left-4 right-4 md:left-auto md:right-6 md:w-fit max-w-[90vw] z-50 p-4 rounded-[1.25rem] border border-black/5 dark:border-white/10 bg-white/95 dark:bg-black/80 backdrop-blur-2xl shadow-2xl flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-4 transition-all duration-300"
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
              showToast(
                "Aucune empreinte n'est configurée. Ajoutez-en une dans les paramètres Android.",
                'info'
              );
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
