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
  import { afterNavigate } from '$app/navigation';
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
  import ChangePinModal from '$lib/components/auth/ChangePinModal.svelte';
  import BiometricBottomSheet from '$lib/components/auth/BiometricBottomSheet.svelte';
  import CallOverlay from '$lib/components/chat/CallOverlay.svelte';
  import type { ConversationContext } from '$lib/composables/useConversations.svelte';
  import type { MessagingContext } from '$lib/composables/useMessaging.svelte';
  import type { BulkIngestPhase } from '$lib/mls-client';
  import { Fingerprint } from '@lucide/svelte';
  import type { IStorage, StoredMessage } from '$lib/db';
  import { consumeFcmCache } from '$lib/utils/chat/fcmCache';
  import { reconcileOutboxSent } from '$lib/utils/chat/outboxMirror';
  import {
    refreshAppVersionCheck,
    shouldBlockSessionUnlock,
  } from '$lib/stores/appVersionCheck.svelte';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { isTauriRuntime } from '$lib/utils/openExternal';
  import { resolveConversationListPresentation } from '$lib/utils/chat/conversations';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import type { CallParticipant } from '$lib/services/CallService';
  import { notifNav } from '$lib/stores/notifNav.svelte';
  import { openConversationFromId } from '$lib/utils/chat/openConversationFromId';
  import { warnIfSiblingDeviceInCall } from '$lib/utils/callPresence';
  import { mergeFcmMessagesIntoConversations } from '$lib/utils/chat/fcmMemoryMerge';
  import { subscribeTabMessageUpdates } from '$lib/mls-client/tabMessageSync';
  import { insertMessageOrdered } from '$lib/utils/chat/messageOrder';

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

  /** Last call id we started ringing for (dedupes effect re-runs). */
  let lastIncomingRingCallId = $state<string | null>(null);

  /** Ring + OS notification when an MLS call invite arrives (any route). */
  $effect(() => {
    const state = globalSession.callState;
    const callId = globalSession.callService?.currentCallId ?? null;
    const groupId = globalSession.callService?.currentGroupId ?? null;
    const callerId = globalSession.callService?.incomingCallerId ?? null;

    if (state === 'incoming' && callId && groupId) {
      if (lastIncomingRingCallId !== callId) {
        lastIncomingRingCallId = callId;
        const callerName = getUserDisplayNameSync(callerId ?? '');
        globalNotifs.startIncomingCallRingtone();
        void globalNotifs.notifyIncomingCall(callerName, groupId);
      }
      return;
    }

    if (lastIncomingRingCallId !== null) {
      lastIncomingRingCallId = null;
    }
    globalNotifs.stopIncomingCallRingtone();
    // Call left the "incoming" state (answered on any device, declined, or ended):
    // close the lingering "X vous appelle" OS notification.
    void globalNotifs.dismissIncomingCall();
  });

  /** Opens the conversation targeted by a notification tap (works outside /chat). */
  $effect(() => {
    const id = notifNav.pending;
    if (!id || !globalSession.isLoggedIn) return;
    if (openConversationFromId(globalConvs, convCtx(), id)) {
      notifNav.clear();
    }
  });

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
  let pinStep = $state('');
  let biometricConfigured = $state(false);

  // "PIN changed on another device" recovery (offered on a mismatch when local state exists).
  let canRecoverPin = $state(false);
  let showRecoverModal = $state(false);
  let recoverError = $state('');
  let recoverLoading = $state(false);
  let recoverProgress = $state<import('$lib/utils/chat/pinChange').PinOperationProgress | null>(
    null
  );

  /**
   * Enables the recovery link when a local MLS state exists and the failure is either a
   * PIN mismatch (tried the old PIN) or the explicit "PIN changed on another device"
   * signal (tried the new PIN but the local state is still sealed under the old one).
   */
  async function evaluateRecoverable(uid: string, msg: string) {
    const recoverable = /PIN incorrect/i.test(msg) || /changé sur un autre appareil/i.test(msg);
    if (!uid || !recoverable) {
      canRecoverPin = false;
      return;
    }
    try {
      const { loadMlsState } = await import('$lib/utils/hex');
      canRecoverPin = !!(await loadMlsState(uid));
    } catch {
      canRecoverPin = false;
    }
  }

  /** Opens the recovery modal (old PIN → new PIN, no data loss). */
  function handleOpenRecover() {
    recoverError = '';
    showRecoverModal = true;
  }

  /** Runs the cross-device PIN recovery, then closes the modals on success. */
  async function handleRecoverSubmit(oldPin: string, newPin: string) {
    recoverError = '';
    recoverLoading = true;
    recoverProgress = { percent: 0, stage: 'verify' };
    let failMsg = '';
    try {
      await globalSession.recoverPin(
        { ...sessionCb(), onLoginFailed: (m: string) => (failMsg = m), onMlsReady: () => {} },
        oldPin,
        newPin,
        (progress) => {
          recoverProgress = progress;
        }
      );
      if (!globalSession.isLoggedIn) {
        throw new Error(failMsg || 'Échec de la connexion après récupération.');
      }
      showRecoverModal = false;
      showPinModal = false;
      canRecoverPin = false;
      pinError = '';
    } catch (e) {
      recoverError = e instanceof Error ? e.message : String(e);
    } finally {
      recoverLoading = false;
      recoverProgress = null;
    }
  }

  let showBiometricSheet = $state(false);

  function onBiometricSkip() {
    showBiometricSheet = false;
  }

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
    void evaluateRecoverable(globalSession.userId || currentUserId() || '', msg);
  }

  /**
   * Returns true only when the user has never registered a PIN (no PinVerifier row
   * server-side) - the genuine "first setup" case. This is the source of truth, unlike
   * a device-count check which wrongly reports "first setup" for a user whose devices
   * were all revoked/GC'd but who still has a registered PIN (picking a new PIN would
   * then fail the verifier with a confusing mismatch). Defaults to false on any
   * network/auth failure so the "first setup" wording is never shown by mistake.
   */
  async function detectFirstPinSetup(uid: string): Promise<boolean> {
    try {
      const token = await getToken();
      const res = await fetch(`/api/mls/security/pin-status/${encodeURIComponent(uid)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return false;
      const { registered } = (await res.json()) as { registered: boolean };
      return !registered;
    } catch {
      return false;
    }
  }

  // Guard against concurrent login attempts (e.g. onMount + afterNavigate both firing).
  let _loginInProgress = false;

  /** Ferme PIN/biométrie dès que MLS est déverrouillé ; le rattrapage continue en arrière-plan. */
  function dismissAuthPrompts() {
    showBiometricSheet = false;
    showPinModal = false;
    pinLoading = false;
    pinStep = '';
  }

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

  /**
   * Warns when another device of the same account is already in a call.
   */
  function checkSiblingCallWarning() {
    const deviceId = globalSession.myDeviceId;
    if (!deviceId || globalSession.callState !== 'idle') return;
    void warnIfSiblingDeviceInCall(deviceId);
  }

  /**
   * Callbacks complets pour globalSession.login() / session callbacks.
   * @param overrides Per-call hooks (e.g. handlePinSubmit step timer).
   */
  function sessionCb(overrides: Partial<import('$lib/composables/session/sessionTypes').ChatSessionCallbacks> = {}) {
    const base = {
      conversations: globalConvs.conversations,
      loadAndRestoreConversations: () => globalConvs.loadAndRestoreConversations(convCtx()),
      addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
        globalMessaging.addMessageToChat(sid, content, contactName, msgCtx(), options),
      beginBulkMessageIngest: (phase: BulkIngestPhase) =>
        globalMessaging.beginBulkMessageIngest(phase),
      endBulkMessageIngest: (phase: BulkIngestPhase) =>
        globalMessaging.endBulkMessageIngest(msgCtx(), phase),
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
      onReadReceiptReceived: (e: { conversationKey: string; senderId: string; messageIds: string[] }) => {
        // Son uniquement quand un autre utilisateur lit MON message, dans la conversation
        // ouverte et l'onglet visible (jamais pour mes propres lectures cross-device).
        if (e.senderId === globalSession.userId) return;
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        if (e.conversationKey !== globalConvs.selectedContact) return;
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
      onMlsReady: () => {
        dismissAuthPrompts();
        checkSiblingCallWarning();
        overrides.onMlsReady?.();
      },
    };
    return { ...base, ...overrides, onMlsReady: base.onMlsReady };
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
    if (globalMessaging.isMessageCatchupActive) return;
    const injected = await consumeFcmCache(pin, storage).catch(() => [] as StoredMessage[]);
    if (injected.length === 0 || !globalSession.userId) return;
    mergeFcmMessagesIntoConversations(injected, globalConvs.conversations, globalSession.userId);
  }

  /** Applies leader-tab message broadcasts to follower tab UI state. */
  function applyTabMessageEvent(
    event: import('$lib/mls-client/tabMessageSync').TabMessageEvent
  ) {
    if (globalSession.isTabLeader) return;
    const convo = globalConvs.conversations.get(event.conversationId);
    if (!convo) return;

    if (event.type === 'message_added') {
      if (convo.messages.some((m) => m.id === event.message.id)) return;
      globalConvs.conversations.set(event.conversationId, {
        ...convo,
        messages: insertMessageOrdered(convo.messages, event.message),
        lastMessageAt: event.lastMessageAt,
        unreadCount: event.unreadCount,
      });
      return;
    }

    const existingIds = new Set(convo.messages.map((m) => m.id));
    const toAdd = event.messages.filter((m) => !existingIds.has(m.id));
    if (toAdd.length === 0) return;
    let merged = convo.messages;
    for (const msg of toAdd) {
      merged = insertMessageOrdered(merged, msg);
    }
    globalConvs.conversations.set(event.conversationId, {
      ...convo,
      messages: merged,
      lastMessageAt: event.lastMessageAt,
      unreadCount: event.unreadCount,
    });
  }

  /**
   * Core login flow: checks platform, discovers biometrics/saved PIN, and either starts
   * loginImpl or opens the PIN modal. Shared between onMount, afterNavigate, and the
   * reactive $effect so the flow triggers regardless of how the user reaches a page.
   *
   * Sets globalSession.isLoginInProgress = true BEFORE any await so the layout guard
   * (`+layout.ts`) never fires fetchUserProfile while login is pending.
   */
  async function startLoginFlow() {
    if (_loginInProgress || globalSession.isLoggedIn || globalSession.isLoginInProgress) return;
    _loginInProgress = true;
    globalSession.isLoginInProgress = true;
    try {
      if (!(await ensurePlatformAllowsUnlock())) {
        globalSession.isLoginInProgress = false;
        return;
      }

      const configured = await BiometricService.isConfigured().catch(() => false);
      biometricConfigured = configured;

      if (configured && isTauriRuntime()) {
        // Only invoke the biometric prompt if the device actually has enrolled
        // biometrics. If not (e.g., fingerprint hardware present but no fingerprint
        // set up), skip straight to PIN to avoid a confusing OS error dialog.
        const biometricAvailable = await BiometricService.isAvailable().catch(() => false);
        if (biometricAvailable) {
          // Sheet backdrop for the OS prompt; dismissed via onMlsReady as soon as MLS unlocks.
          showBiometricSheet = true;
          globalSession.isLoginInProgress = false;
          await globalSession.biometricLogin({
            ...sessionCb(),
            onLoginFailed: onSavedPinFailed,
          });
          dismissAuthPrompts();
        }
        if (!globalSession.isLoggedIn) {
          // Biométrie annulée, échouée ou non disponible → fallback modal PIN
          const savedUser2 = currentUserId();
          if (savedUser2) {
            globalSession.isLoginInProgress = false;
            await openPinModal(savedUser2);
          } else {
            globalSession.isLoginInProgress = false;
          }
        }
        return;
      }

      const savedUser = currentUserId();
      const savedPin = await loadPin();
      if (savedUser && savedPin) {
        globalSession.userId = savedUser;
        globalSession.pin = savedPin;
        // loginImpl checks isLoginInProgress itself and will bail if it's true.
        // Reset it here so loginImpl can set it and manage its own lifecycle.
        globalSession.isLoginInProgress = false;
        void globalSession.login({ ...sessionCb(), onLoginFailed: onSavedPinFailed });
      } else if (savedUser) {
        globalSession.userId = savedUser;
        if (isTauriRuntime()) {
          const ok = await globalSession.nativeStorageLogin({
            ...sessionCb(),
            onLoginFailed: onSavedPinFailed,
          });
          if (ok) return;
        }
        globalSession.isLoginInProgress = false;
        await openPinModal(savedUser);
      } else {
        globalSession.isLoginInProgress = false;
      }
    } finally {
      if (!globalSession.isLoggedIn && !showPinModal) _loginInProgress = false;
    }
  }

  // ── Reactive trigger: userId becomes available after OIDC (Tauri Android) ──
  // Fires as soon as currentUserId() transitions from null → value so the PIN/
  // biometric modal appears immediately without requiring a manual navigation.
  $effect(() => {
    const uid = currentUserId();
    const loggedIn = globalSession.isLoggedIn;
    if (!uid || loggedIn) return;
    if (typeof window === 'undefined') return;
    const path = window.location.pathname;
    if (path.startsWith('/login') || path.startsWith('/auth/') || path.startsWith('/legal')) return;
    untrack(() => {
      globalSession.initServices(appendLog);
      void startLoginFlow();
    });
  });

  // ── Mount ─────────────────────────────────────────────────────────────────
  onMount(() => {
    // Déjà connecté (ex. navigation depuis /chat) → rien à faire.
    if (globalSession.isLoggedIn) return;

    const w = window as Window & {
      wasm_bindings_log?: (level: string, msg: string) => void;
    };
    w.wasm_bindings_log = (level: string, msg: string) => appendLog(`[RUST::${level}] ${msg}`);

    globalSession.initServices(appendLog);
    void startLoginFlow();

    // Pause/resume WebSocket based on app visibility.
    // On mobile/Tauri, pause immediately when backgrounded (OS will kill the process soon).
    // On desktop web, don't pause: browsers keep WebSocket connections alive in background
    // tabs, and pausing breaks recovery timers (60s reboot) and causes unnecessary reconnects.
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && globalSession.isLoggedIn) {
        if (isTauriRuntime()) {
          globalSession.pauseConnection();
        }
        return;
      }
      if (document.visibilityState === 'visible' && globalSession.isLoggedIn) {
        const { pin, storage } = globalSession;
        // Reconcile entries the native background service already delivered (outbox_sent.ndjson)
        // BEFORE the outbox flusher re-reads the queue on this same `visible` transition. Without
        // this the foreground would re-send a message already sent in the background, re-encoding
        // it against a possibly-stale epoch (SecretReuse). Reconciliation was login-only before;
        // a backgrounded-but-alive app never re-logs in, so it never cleared these until now.
        if (storage) void reconcileOutboxSent(storage);
        if (!globalSession.isWsConnected) {
          appendLog('Page visible de nouveau - reconnexion...');
          void globalSession.attemptReconnect(sessionCb());
        }
        checkSiblingCallWarning();
        // Injecter les messages FCM mis en cache pendant l'arrière-plan
        if (pin && storage) {
          void flushFcmCache(pin, storage);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    const unsubscribeTabMessages = subscribeTabMessageUpdates(applyTabMessageEvent);

    // ── FCM cache polling (Tauri/Android only) ────────────────────────────
    // Messages received via FCM while the app is in the foreground are written
    // to fcm_message_cache.ndjson by the Kotlin service but the visibility-change
    // handler above only fires on background→foreground transitions, so those
    // messages would only appear after a restart. Poll every 5 s while visible.
    const FCM_POLL_INTERVAL = 5_000;
    const isTauri = isTauriRuntime();
    const fcmPollTimer = isTauri
      ? setInterval(() => {
          if (document.hidden || globalMessaging.isMessageCatchupActive) return;
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
      unsubscribeTabMessages();
      if (fcmPollTimer !== null) clearInterval(fcmPollTimer);
      clearInterval(gcTimer);
    };
  });

  async function handleBiometricFromModal() {
    pinError = '';
    pinLoading = true;
    await globalSession.biometricLogin(
      sessionCb({
        onLoginFailed: (msg: string) => {
          pinError = msg;
          pinLoading = false;
          void evaluateRecoverable(globalSession.userId || currentUserId() || '', msg);
        },
      })
    );
    pinLoading = false;
    if (globalSession.isLoggedIn) {
      dismissAuthPrompts();
    } else if (!pinError) {
      pinError = "L'empreinte digitale a échoué. Entrez votre PIN.";
    }
  }

  function handlePinSubmit(submittedPin: string) {
    pinError = '';
    pinLoading = true;
    pinStep = 'Vérification du PIN…';
    canRecoverPin = false;
    globalSession.pin = submittedPin;
    _loginInProgress = true;

    // Transition to the MLS loading step after PIN derivation (~800 ms)
    const stepTimer = setTimeout(() => {
      if (pinLoading) pinStep = 'Chargement MLS…';
    }, 800);

    void globalSession.login(
      sessionCb({
        onMlsReady: () => {
          clearTimeout(stepTimer);
        },
        onLoginFailed: (msg: string) => {
          clearTimeout(stepTimer);
          pinError = msg;
          pinLoading = false;
          pinStep = '';
          void evaluateRecoverable(globalSession.userId || currentUserId() || '', msg);
        },
      })
    );
  }

  /**
   * "PIN oublié" reset: wipes the user's PIN-protected MLS state server-side (keeping
   * the account, posts and community), clears local MLS state, then re-opens the modal
   * in first-setup mode so the user chooses a new PIN. Past encrypted messages are lost.
   */
  async function handlePinReset() {
    const uid = globalSession.userId || currentUserId();
    if (!uid) return;
    pinError = '';
    pinLoading = true;
    pinStep = 'Réinitialisation du PIN…';
    appendLog(`[PIN_RESET] Démarrage pour userId=${uid.slice(0, 8)}…`);
    try {
      const token = await getToken();
      const res = await fetch('/api/mls/security/pin-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userId: uid }),
      });
      if (!res.ok) throw new Error('Échec de la réinitialisation côté serveur.');
      // Local MLS state is encrypted under the old PIN - wipe it so a new PIN starts fresh.
      await globalSession.resetDeviceAsFresh(uid, sessionCb());
      appendLog('[PIN_RESET] État MLS effacé - choix d un nouveau PIN.');
      globalSession.userId = uid;
      isFirstPinSetup = true;
      showPinModal = true;
    } catch (e) {
      pinError = e instanceof Error ? e.message : String(e);
      appendLog(`[PIN_RESET] Échec: ${pinError}`);
    } finally {
      pinLoading = false;
      pinStep = '';
    }
  }

  // Safety net for navigations that arrive before onMount's startLoginFlow completes
  // (e.g. the OIDC callback navigates to /posts while onMount already ran with uid=null).
  afterNavigate(async ({ to }) => {
    const path = to?.url.pathname ?? window.location.pathname;
    const isAuthRoute =
      path === '/login' ||
      path.startsWith('/login') ||
      path.startsWith('/auth/') ||
      path.startsWith('/legal');
    if (isAuthRoute) return;
    if (globalSession.isLoggedIn || _loginInProgress || globalSession.isLoginInProgress) return;

    const uid = currentUserId();
    if (!uid) return;

    // Set the flag early - before the first async call - so that the layout guard
    // in +layout.ts sees isLoginInProgress = true and skips fetchUserProfile.
    globalSession.isLoginInProgress = true;

    if (!(await ensurePlatformAllowsUnlock())) {
      globalSession.isLoginInProgress = false;
      return;
    }

    // Arriving on a non-auth route with a user but not yet logged in:
    // trigger the login flow that onMount missed.
    globalSession.initServices(appendLog);
    const savedPin = await loadPin();
    if (savedPin) {
      globalSession.userId = uid;
      globalSession.pin = savedPin;
      _loginInProgress = true;
      // loginImpl bails if isLoginInProgress=true - reset before delegating.
      globalSession.isLoginInProgress = false;
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
      // biometricConfigured is set by startLoginFlow which runs before afterNavigate.
      if (biometricConfigured) {
        const bioAvailable = await BiometricService.isAvailable().catch(() => false);
        if (bioAvailable) {
          _loginInProgress = true;
          // loginImpl bails if isLoginInProgress=true - reset before delegating.
          globalSession.isLoginInProgress = false;
          await globalSession.biometricLogin({ ...sessionCb(), onLoginFailed: onSavedPinFailed });
          if (globalSession.isLoggedIn) return;
          _loginInProgress = false;
        }
      }
      globalSession.isLoginInProgress = false;
      await openPinModal(uid);
    }
  });
</script>

<!-- Biometric choice sheet (shown before OS biometric prompt) -->
<BiometricBottomSheet open={showBiometricSheet} onSkip={onBiometricSkip} />

<!-- PIN modal global (visible sur toutes les routes) -->
<PinModal
  open={showPinModal}
  onSubmit={handlePinSubmit}
  onClose={() => {
    showPinModal = false;
    _loginInProgress = false;
    globalSession.isLoginInProgress = false;
  }}
  onBiometricRequest={handleBiometricFromModal}
  showBiometricButton={biometricConfigured}
  externalError={pinError}
  isLoading={pinLoading}
  loadingStep={pinStep}
  isFirstSetup={isFirstPinSetup}
  onForgotPinReset={handlePinReset}
  onRecoverPin={canRecoverPin ? handleOpenRecover : undefined}
/>

<!-- Récupération après changement de PIN sur un autre appareil -->
<ChangePinModal
  open={showRecoverModal}
  variant="recover"
  onSubmit={handleRecoverSubmit}
  onClose={() => (showRecoverModal = false)}
  externalError={recoverError}
  isLoading={recoverLoading}
  loadingProgress={recoverProgress}
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
