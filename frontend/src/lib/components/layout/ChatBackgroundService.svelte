<script lang="ts">
  /**
   * Always-on layout component for the MLS session lifecycle.
   *
   * Responsibilities:
   * - MLS session + WebSocket initialization (PIN, biometrics).
   * - WS reconnection on page visibility changes.
   * - Global UI: PIN modal, call overlay, channel invite notices, biometric enrollment prompt.
   *
   * Uses global singletons (globalChatSingleton.svelte.ts) so the connection
   * persists across all routes, not only /chat.
   */
  import { onMount, untrack } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { m } from '$lib/paraglide/messages';
  import { BiometricService } from '$lib/services/biometric';
  import {
    loadDeviceKey,
    isDeviceKeyPersistenceEnabled,
    setDeviceKeyPersistence,
  } from '$lib/utils/deviceKeyVault';
  import { isBiometricPromptDismissed } from '$lib/composables/session/sessionBiometrics';
  import { getToken, clearAuth } from '$lib/stores/auth';
  import { currentUserId } from '$lib/stores/user';
  import {
    globalSession,
    globalConvs,
    globalMessaging,
    globalChannels,
    globalNotifs,
    appendLog,
  } from '$lib/stores/globalChatSingleton.svelte';
  import { resolveDisplayNames } from '$lib/utils/users/displayName';
  import { serializeEnvelope, mkSystemEnvelope } from '$lib/envelope';
  import type { ChatMessage } from '$lib/types';
  import PinModal from '$lib/components/auth/PinModal.svelte';
  import ChangePinModal from '$lib/components/auth/ChangePinModal.svelte';
  import BiometricBottomSheet from '$lib/components/auth/BiometricBottomSheet.svelte';
  import CallOverlay from '$lib/components/chat/CallOverlay.svelte';
  import type { ConversationContext } from '$lib/composables/useConversations.svelte';
  import type { MessagingContext } from '$lib/composables/useMessaging.svelte';
  import type { BulkIngestPhase } from '$lib/mls-client';
  import { Fingerprint, Phone, PhoneOff, Video } from '@lucide/svelte';
  import { fly } from 'svelte/transition';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import type { IStorage, StoredMessage } from '$lib/db';
  import { consumeFcmCache } from '$lib/utils/chat/fcmCache';
  import { reconcileOutboxSent } from '$lib/utils/chat/outboxMirror';
  import {
    refreshAppVersionCheck,
    shouldBlockSessionUnlock,
  } from '$lib/stores/appVersionCheck.svelte';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { isTauriRuntime } from '$lib/utils/openExternal';
  import { isMobileTauriRuntime } from '$lib/utils/appVersion';
  import { createPausableInterval } from '$lib/utils/backgroundPausableInterval';
  import { resolveConversationListPresentation } from '$lib/utils/chat/conversations';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import type { CallParticipant } from '$lib/services/CallService';
  import { notifNav } from '$lib/stores/notifNav.svelte';
  import { openNotificationTarget } from '$lib/utils/chat/openConversationFromId';
  import { chatDeepLinkRoute } from '$lib/utils/chat/notificationRouting';
  import { drainNativePendingCallAccept } from '$lib/stores/pendingCallAccept';
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

  /** Whether the current route is the chat page (where the full call overlay is native). */
  let isOnChatPage = $derived(
    typeof window !== 'undefined' && $page.url.pathname.startsWith('/chat')
  );

  /** When NOT on the chat page, show a compact incoming-call toast instead of the full hero screen. */
  let showIncomingToast = $derived(globalSession.callState === 'incoming' && !isOnChatPage);

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
        globalNotifs.startBlinkingTitle();
        void globalNotifs.notifyIncomingCall(callerName, groupId);
      }
      return;
    }

    if (lastIncomingRingCallId !== null) {
      lastIncomingRingCallId = null;
    }
    globalNotifs.stopIncomingCallRingtone();
    globalNotifs.stopBlinkingTitle();
    // Call left the "incoming" state (answered on any device, declined, or ended):
    // dismiss the lingering incoming-call OS notification.
    void globalNotifs.dismissIncomingCall();
  });

  /**
   * Notification target we have already routed to /chat for. Plain (non-reactive) so updating
   * it never re-triggers the effect; it only dedupes the one-shot navigation per pending target.
   */
  let lastNavigatedNotifTarget: string | null = null;

  /** Routes to the targeted conversation on a notification tap (works from any route). */
  $effect(() => {
    const id = notifNav.pending;
    if (!id || !globalSession.isLoggedIn) return;
    // Route to the view that can show this target once per pending id. hooks.client.ts also routes,
    // but on a cold start that goto can fire before the SvelteKit router is ready and silently
    // no-op, leaving the user on the home feed. This effect runs post-mount (router ready) and
    // re-runs as login completes / conversations load, so it reliably reaches the right route and
    // selects the target. Community channels live under /communities, DMs/groups under /chat.
    const targetRoute = chatDeepLinkRoute(id);
    if (lastNavigatedNotifTarget !== id) {
      lastNavigatedNotifTarget = id;
      if (window.location.pathname !== targetRoute) {
        appendLog(`[notifNav] routing to ${targetRoute} for pending conversation ${id}`);
        void goto(targetRoute);
      }
    }
    if (
      openNotificationTarget(
        globalConvs,
        convCtx(),
        id,
        (channelId) => (globalChannels.selectedChannelConversationId = channelId)
      )
    ) {
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
  // "Stay signed in" opt-in (browser only): persists the PIN vault across browser restarts.
  // Offered on the PIN modal; initialised from the stored preference so it reflects a prior choice.
  // Desactive quand la biometric est configuree car le PIN sauvegarde ne sera jamais utilise
  // (le flux biometrique prend le pas au prochain lancement).
  let showStaySignedIn = $derived(!biometricConfigured);
  let pinStaySignedIn = $state(true);

  // Bannière d'enrôlement biométrique post-login (Tauri uniquement)
  let showBiometricEnrollBanner = $state(false);
  let biometricCheckedForEnrollment = $state(false);

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
    const recoverable = /incorrect PIN/i.test(msg) || /changed on another device/i.test(msg);
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
        throw new Error(failMsg || 'Login failed after recovery.');
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
  /** Flag permettant à startLoginFlow() de savoir que l'utilisateur a choisi
   *  "Utiliser le code PIN" plutôt que la biométrie sur le BiometricBottomSheet. */
  let biometricCancelled = $state(false);

  function onBiometricSkip() {
    biometricCancelled = true;
    showBiometricSheet = false;
  }

  /** Returns false when min-version or maintenance gates block MLS unlock. */
  async function ensurePlatformAllowsUnlock(): Promise<boolean> {
    await refreshAppVersionCheck();
    if (shouldBlockSessionUnlock(isGlobalAdmin())) {
      appendLog('[platform] MLS unlock blocked (maintenance or minimum version gate)');
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

  /**
   * Called when the session is definitively dead (refresh cookie expired/revoked). Rather
   * than leave a "Session expired" message stuck in the PIN modal - which strands the user
   * with no clear action - close the modal, clear the auth state, and redirect straight to
   * the login page so they can sign in again.
   */
  async function handleSessionExpired() {
    appendLog('[AUTH] Session expired - logging out and redirecting to /login.');
    dismissAuthPrompts();
    pinError = '';
    _loginInProgress = false;
    globalSession.isLoginInProgress = false;
    await clearAuth().catch(() => {});
    void goto('/login', { replaceState: true });
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

  /** Closes PIN/biometric modals as soon as MLS unlocks; catch-up continues in the background. */
  function dismissAuthPrompts() {
    showBiometricSheet = false;
    showPinModal = false;
    pinLoading = false;
    pinStep = '';
  }

  // ── Context builders ──────────────────────────────────────────────────────
  // Same shape as MainChatPage context builders, but references global singletons.

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
      startDirectConversation: (targetUserId: string, opts?: { silent?: boolean }) =>
        globalConvs.startNewConversation(targetUserId, convCtx(), opts),
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
   * Builds the full callback object for globalSession.login() / session callbacks.
   * @param overrides Per-call hooks (e.g. handlePinSubmit step timer).
   */
  function sessionCb(
    overrides: Partial<import('$lib/composables/session/sessionTypes').ChatSessionCallbacks> = {}
  ) {
    const base = {
      conversations: globalConvs.conversations,
      loadAndRestoreConversations: () => globalConvs.loadAndRestoreConversations(convCtx()),
      addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
        globalMessaging.addMessageToChat(sid, content, contactName, msgCtx(), options),
      drainOrphanMessages: (convoKey: string) =>
        globalMessaging.drainOrphanMessages(convoKey, msgCtx()),
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
            lifecycle: 'active',
            mlsStateHex: null,
          });
        }
        // The join event carries no key material, so hydrate the channel's epoch key now.
        // Without this the channel is registered but undecryptable until an app relaunch runs
        // the full workspace hydration (fixes: freshly-added channel unusable in-session on mobile).
        void globalChannels.hydrateJoinedChannelKey(event.channelId);
        appendLog(`Joined channel #${event.channelName || event.channelId}`);

        // Add a system message to the channel so the inviter (and other members) see who joined.
        if (event.invitedBy && event.joinedBy) {
          void (async () => {
            try {
              const getName = await resolveDisplayNames([event.invitedBy, event.joinedBy]);
              const inviterName = getName(event.invitedBy);
              const joinedName = getName(event.joinedBy);

              // The invitee already receives mkChannelInviteEnvelope via the key distribution DM.
              const currentUserIdLower = globalSession.userId?.toLowerCase();
              if (event.joinedBy.toLowerCase() === currentUserIdLower) return;

              const systemText = m.chat_system_member_added({
                sender: inviterName,
                members: joinedName,
              });

              const convo = globalConvs.conversations.get(channelConversationId);
              if (!convo) return;

              const newMsg: ChatMessage = {
                id: crypto.randomUUID(),
                senderId: 'system',
                content: serializeEnvelope(mkSystemEnvelope(systemText as string)),
                timestamp: new Date(),
                isOwn: false,
                isSystem: true,
              };
              globalConvs.conversations.set(channelConversationId, {
                ...convo,
                messages: [...convo.messages, newMsg],
                lastMessageAt: Math.max(convo.lastMessageAt ?? 0, newMsg.timestamp.getTime()),
              });
            } catch {
              // Non-blocking: system message is best-effort.
            }
          })();
        }
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
        appendLog(`Removed from channel #${event.channelName || event.channelId}`);
      },
      onChannelUpdated: (event: { channelId: string; name?: string }) => {
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
        if (convo && event.name) {
          globalConvs.conversations.set(channelConversationId, {
            ...convo,
            name: event.name,
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
      onReadReceiptReceived: (e: {
        conversationKey: string;
        senderId: string;
        messageIds: string[];
      }) => {
        // Sound only when another user reads MY message, in the open conversation on the visible tab
        // (never for my own cross-device reads).
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
      onSessionExpired: handleSessionExpired,
    };
    return {
      ...base,
      ...overrides,
      onMlsReady: base.onMlsReady,
      onSessionExpired: base.onSessionExpired,
    };
  }

  /** Navigates to the channel community when the user clicks "Rejoindre la communauté". */
  function handleJoinChannel(channelId: string) {
    const channelConversationId = `channel_${channelId}`;
    notifNav.navigate(channelConversationId);
    goto('/chat');
  }

  // ── Post-login: load channel workspaces ───────────────────────────────────
  $effect(() => {
    if (!globalSession.isLoggedIn) return;
    untrack(() => {
      void globalChannels.loadChannelWorkspacesFromBackend(channelsCtx());
    });
  });

  // ── Post-login: propose biometric enrollment on mobile ────────────────────
  // After a successful PIN login on Tauri, check if biometric enrollment
  // should be offered (hardware available, not already configured, not dismissed).
  $effect(() => {
    const loggedIn = globalSession.isLoggedIn;
    const isTauri = isTauriRuntime();
    if (!loggedIn || !isTauri) return;
    if (biometricCheckedForEnrollment) return;
    if (showPinModal || showBiometricSheet) return;

    biometricCheckedForEnrollment = true;
    untrack(async () => {
      const configured = await BiometricService.isConfigured().catch(() => false);
      if (configured) return;
      const dismissed = await isBiometricPromptDismissed();
      if (dismissed) return;
      const available = await BiometricService.isAvailable().catch(() => false);
      if (!available) return;

      showBiometricEnrollBanner = true;
    });
  });

  /**
   * Consumes the native FCM cache and injects messages directly into reactive memory,
   * enabling immediate display without waiting for the next history poll (5s or foreground resume).
   */
  async function flushFcmCache(pin: string, storage: IStorage) {
    if (globalMessaging.isMessageCatchupActive) return;
    const injected = await consumeFcmCache(pin, storage).catch(() => [] as StoredMessage[]);
    if (injected.length === 0 || !globalSession.userId) return;
    mergeFcmMessagesIntoConversations(injected, globalConvs.conversations, globalSession.userId);
  }

  /** Applies leader-tab message broadcasts to follower tab UI state. */
  function applyTabMessageEvent(event: import('$lib/mls-client/tabMessageSync').TabMessageEvent) {
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

      // ── BRANCHE TAURI (MOBILE) ──
      if (isTauriRuntime()) {
        const savedUser = currentUserId();
        if (!savedUser) {
          globalSession.isLoginInProgress = false;
          return;
        }
        globalSession.userId = savedUser;

        // Étape 1 : Vérifier si biométrie est CONFIGURÉE (flag utilisateur) — P1-A
        // Ne JAMAIS interroger le keystore si l'utilisateur a désactivé la biométrie,
        // même si une clé résiduelle est présente.
        let biometricAttempted = false;
        const isBiometricConfigured = await BiometricService.isConfigured();

        if (isBiometricConfigured) {
          const deviceKey = `mls_device_id_${savedUser}`;
          const storedDeviceId = localStorage.getItem(deviceKey);
          const hasExistingDevice = storedDeviceId !== null;

          if (hasExistingDevice) {
            const alias = `mls_device_key_${savedUser}_${storedDeviceId}`;
            const keyPresent = await BiometricService.isKeyPresent(alias).catch(() => false);

            if (keyPresent) {
              biometricAttempted = true;
              // Connexion suivante avec biométrie ENROLÉE → BiometricBottomSheet directe
              biometricConfigured = true;
              biometricCancelled = false;
              showBiometricSheet = true;

              // Laisse un court délai pour que l'utilisateur puisse interagir avec
              // le BiometricBottomSheet (choisir "Utiliser le code PIN"). Si onSkip
              // est déclenché pendant ce délai, biometricCancelled passe à true et
              // on évite d'afficher le prompt biométrique OS.
              await new Promise((resolve) => setTimeout(resolve, 250));
              if (biometricCancelled) {
                showBiometricSheet = false;
              } else {
                await globalSession.biometricLogin({
                  ...sessionCb(),
                  onLoginFailed: onSavedPinFailed,
                });
                dismissAuthPrompts();
              }
            }
          }
        }

        if (!globalSession.isLoggedIn) {
          // P2-A : Pas de fallback automatique après échec biométrique.
          // Si la biométrie a été tentée et a échoué/été annulée, l'utilisateur
          // doit saisir son PIN explicitement — pas de nativeStorageLogin.
          if (!biometricAttempted) {
            globalSession.isLoginInProgress = false;
            const ok = await globalSession.nativeStorageLogin(
              {
                ...sessionCb(),
                onLoginFailed: onSavedPinFailed,
              },
              isBiometricConfigured
            );
            if (ok) return;
          }

          // Fallback : PIN modal SANS bouton empreinte
          biometricConfigured = false;
          globalSession.isLoginInProgress = false;
          await openPinModal(savedUser);
        }
        return;
      }

      // ── BRANCHE WEB ──
      const savedUser = currentUserId();
      const savedDeviceKeyB64 = await loadDeviceKey();
      if (savedUser && savedDeviceKeyB64) {
        globalSession.userId = savedUser;
        globalSession.deviceKeyB64 = savedDeviceKeyB64;
        // loginImpl checks isLoginInProgress itself and will bail if it's true.
        // Reset it here so loginImpl can set it and manage its own lifecycle.
        globalSession.isLoginInProgress = false;
        void globalSession.login({ ...sessionCb(), onLoginFailed: onSavedPinFailed });
      } else if (savedUser) {
        globalSession.userId = savedUser;
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
    // Already logged in (e.g. navigating from /chat): nothing to do.
    if (globalSession.isLoggedIn) return;

    const w = window as Window & {
      wasm_bindings_log?: (level: string, msg: string) => void;
    };
    w.wasm_bindings_log = (level: string, msg: string) => appendLog(`[RUST::${level}] ${msg}`);

    globalSession.initServices(appendLog);
    // WP-XP-5: a CallKit answer may predate this cold start (app launched from the call UI).
    // Drain it before login so the auto-accept fires as soon as the invite arrives over WS.
    void drainNativePendingCallAccept();
    void startLoginFlow();

    /** Fire-and-forget native MLS foreground-guard command (mobile only; no-op on desktop/web). */
    const invokeNative = (cmd: string): void => {
      void import('@tauri-apps/api/core').then(({ invoke }) => invoke(cmd)).catch(() => {});
    };

    // Foreground heartbeat (Android + iOS): keeps the native guard fresh while the app is visible so
    // the background engines abstain from writing mls.bin. The FOREGROUND_GRACE_MS guard gates the
    // background writers on BOTH platforms, but iOS only refreshes it once (canari_ios_on_resume);
    // without this 10s heartbeat the guard would expire ~30s into a genuinely-foregrounded iOS
    // session and an in-process FCM data push could clobber the warm engine's in-memory state. The
    // native mls_foreground_heartbeat command is platform-agnostic (mark_foreground_active).
    // createPausableInterval auto-pauses on hidden, so the guard expires shortly after backgrounding
    // even without a clean `hidden` event.
    const stopForegroundHeartbeat = isMobileTauriRuntime()
      ? createPausableInterval(() => invokeNative('mls_foreground_heartbeat'), 10_000)
      : null;

    // Pause/resume WebSocket based on app visibility.
    // On mobile/Tauri, pause immediately when backgrounded (OS will kill the process soon).
    // On desktop web, don't pause: browsers keep WebSocket connections alive in background
    // tabs, and pausing breaks recovery timers and causes unnecessary reconnects.
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && globalSession.isLoggedIn) {
        if (isTauriRuntime()) {
          globalSession.pauseConnection();
        }
        // Release the native foreground guard so the background JNI engines may write mls.bin
        // again (they abstain while the foreground is active). It would expire on its own after
        // ~30s; this makes the clean background transition immediate so background delivery is not
        // delayed. (C1/FCM3)
        invokeNative('pause_mls_foreground');
        return;
      }
      if (document.visibilityState === 'visible' && globalSession.isLoggedIn) {
        const { deviceKeyB64, storage } = globalSession;
        // Ordered resume sequence. C2 first: reload mls.bin into the warm engine BEFORE anything
        // processes, because a background join/send may have advanced it while we were away; the
        // stale warm state would otherwise clobber that advance on the next save (SecretReuse).
        // No-op off Android. Then reconcile outbox_sent BEFORE the flusher re-reads the queue (so
        // we don't re-send a message the background already delivered), then reconnect/flush.
        void (async () => {
          await globalSession.ensureMls().reloadStateFromDisk();
          if (storage) await reconcileOutboxSent(storage).catch(() => {});
          // WP-XP-5: the user may have answered a CallKit ring while we were away - record
          // the intent BEFORE the WS reconnect delivers the MLS invite that auto-accepts it.
          await drainNativePendingCallAccept();
          if (!globalSession.isWsConnected) {
            appendLog('Page visible again - reconnecting…');
            void globalSession.attemptReconnect(sessionCb());
          }
          checkSiblingCallWarning();
          // Flush FCM messages cached while the app was in the background.
          if (deviceKeyB64 && storage) {
            void flushFcmCache(deviceKeyB64, storage);
          }
        })();
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
          const { deviceKeyB64, storage } = globalSession;
          if (!deviceKeyB64 || !storage) return;
          void flushFcmCache(deviceKeyB64, storage);
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
            if (n > 0) appendLog(`[GC] Deleted ${n} old message(s) from IndexedDB`);
          })
          .catch(() => {});
      }
    }, GC_INTERVAL);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      unsubscribeTabMessages();
      if (fcmPollTimer !== null) clearInterval(fcmPollTimer);
      clearInterval(gcTimer);
      stopForegroundHeartbeat?.();
    };
  });

  // ── Biométrie : handlers d'enrôlement post-login ──────────────────────────

  async function handleBiometricEnroll() {
    showBiometricEnrollBanner = false;
    await globalSession.enrollBiometric();
    // Après enrôlement réussi, mettre à jour biometricConfigured pour le prochain flux
    if (globalSession.isLoggedIn) {
      biometricConfigured = await BiometricService.isConfigured().catch(() => false);
    }
  }

  async function handleBiometricEnrollDismiss() {
    showBiometricEnrollBanner = false;
    await globalSession.dismissBiometricPrompt();
  }

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
      pinError = m.auth_biometric_failed_fallback();
    }
  }

  function handlePinSubmit(submittedPin: string) {
    pinError = '';
    pinLoading = true;
    pinStep = m.auth_pin_step_verifying();
    canRecoverPin = false;
    globalSession.pin = submittedPin;
    // Record the "stay signed in" choice before login: loginImpl's savePin then writes the
    // PIN vault into the matching store (localStorage when persistent, sessionStorage otherwise).
    if (showStaySignedIn) void setDeviceKeyPersistence(pinStaySignedIn, null);
    _loginInProgress = true;
    // An explicit PIN submit takes priority over any background login that may have set
    // this flag (onMount/afterNavigate race); loginImpl bails silently if it is still set.
    globalSession.isLoginInProgress = false;

    // Transition to the MLS loading step after PIN derivation (~800 ms)
    const stepTimer = setTimeout(() => {
      if (pinLoading) pinStep = m.auth_pin_step_loading_mls();
    }, 800);

    // Temporal safety net: if neither onMlsReady nor onLoginFailed fires within 10 s
    // (e.g. an unexpected early return or a hung network call), unblock the spinner so
    // the user can retry instead of staring at an infinite loader.
    const watchdog = setTimeout(() => {
      if (!pinLoading) return;
      clearTimeout(stepTimer);
      pinError = m.auth_pin_timeout();
      pinLoading = false;
      pinStep = '';
      _loginInProgress = false;
      appendLog('[PIN] Login watchdog fired after 10s - unblocking PIN modal.');
    }, 10_000);

    void globalSession
      .login(
        sessionCb({
          onMlsReady: () => {
            clearTimeout(stepTimer);
            clearTimeout(watchdog);
          },
          onLoginFailed: (msg: string) => {
            clearTimeout(stepTimer);
            clearTimeout(watchdog);
            pinError = msg;
            pinLoading = false;
            pinStep = '';
            void evaluateRecoverable(globalSession.userId || currentUserId() || '', msg);
          },
        })
      )
      .catch((e: unknown) => {
        // login() routes errors through onLoginFailed; this guards against a rejection
        // that escapes that path (e.g. before the internal try) leaving the spinner stuck.
        clearTimeout(stepTimer);
        clearTimeout(watchdog);
        const msg = e instanceof Error ? e.message : String(e);
        pinError = msg;
        pinLoading = false;
        pinStep = '';
        _loginInProgress = false;
        appendLog(`[PIN] login() rejected: ${msg}`);
      });
  }

  /**
   * "Forgot PIN" reset: wipes the user's PIN-protected MLS state server-side (keeping
   * the account, posts and community), clears local MLS state, then re-opens the modal
   * in first-setup mode so the user chooses a new PIN. Past encrypted messages are lost.
   */
  async function handlePinReset() {
    const uid = globalSession.userId || currentUserId();
    if (!uid) return;
    pinError = '';
    pinLoading = true;
    pinStep = m.auth_pin_step_resetting();
    appendLog(`[PIN_RESET] Starting for userId=${uid.slice(0, 8)}…`);
    try {
      const token = await getToken();
      const res = await fetch('/api/mls/security/pin-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userId: uid }),
      });
      if (!res.ok) throw new Error('Server-side PIN reset failed.');
      // Local MLS state is encrypted under the old PIN - wipe it so a new PIN starts fresh.
      await globalSession.resetDeviceAsFresh(uid, sessionCb());
      appendLog('[PIN_RESET] MLS state wiped - choose a new PIN.');
      globalSession.userId = uid;
      isFirstPinSetup = true;
      showPinModal = true;
    } catch (e) {
      pinError = e instanceof Error ? e.message : String(e);
      appendLog(`[PIN_RESET] Failed: ${pinError}`);
    } finally {
      pinLoading = false;
      pinStep = '';
    }
  }

  // Safety net for navigations that arrive before onMount's startLoginFlow completes
  // (e.g. the OIDC callback navigates to /posts while onMount already ran with uid=null).
  // Delegates to startLoginFlow which handles both mobile and web paths uniformly.
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
    // Reset the flag so startLoginFlow can proceed (it sets it again internally).
    globalSession.isLoginInProgress = false;
    void startLoginFlow();
  });
</script>

{#if showBiometricEnrollBanner}
  <!-- Bannière d'enrôlement biométrique post-login (Tauri uniquement) -->
  <div
    class="fixed bottom-6 left-1/2 -translate-x-1/2 z-[300] max-w-sm w-[calc(100%-2rem)] bg-[#1a1f2e]/95 backdrop-blur-2xl rounded-2xl shadow-2xl ring-1 ring-white/10 px-5 py-4 flex items-center gap-4"
    transition:fly={{ y: 20, duration: 300 }}
  >
    <div class="p-3 rounded-full bg-amber-500/10 shrink-0">
      <Fingerprint size={24} strokeWidth={1.5} class="text-amber-500" />
    </div>
    <div class="min-w-0 flex-1">
      <p class="text-sm font-bold text-white">{m.auth_biometric_enroll_title()}</p>
      <p class="text-xs text-white/55 mt-0.5">{m.auth_biometric_enroll_prompt()}</p>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      <button
        onclick={handleBiometricEnrollDismiss}
        class="px-3 py-1.5 text-xs font-semibold text-white/60 hover:text-white transition-colors"
      >
        {m.auth_biometric_later_btn()}
      </button>
      <button
        onclick={handleBiometricEnroll}
        class="px-4 py-1.5 text-xs font-bold bg-amber-500 text-[#151B2C] rounded-lg hover:bg-amber-400 transition-all active:scale-95"
      >
        {m.auth_biometric_enable_btn()}
      </button>
    </div>
  </div>
{/if}

<!-- Biometric choice sheet (shown before OS biometric prompt) -->
<BiometricBottomSheet open={showBiometricSheet} onSkip={onBiometricSkip} />

<!-- PIN modal (visible on all routes) -->
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
  {showStaySignedIn}
  bind:staySignedIn={pinStaySignedIn}
  externalError={pinError}
  isLoading={pinLoading}
  loadingStep={pinStep}
  isFirstSetup={isFirstPinSetup}
  onForgotPinReset={handlePinReset}
  onRecoverPin={canRecoverPin ? handleOpenRecover : undefined}
/>

<!-- PIN recovery after a cross-device PIN change -->
<ChangePinModal
  open={showRecoverModal}
  variant="recover"
  onSubmit={handleRecoverSubmit}
  onClose={() => (showRecoverModal = false)}
  externalError={recoverError}
  isLoading={recoverLoading}
  loadingProgress={recoverProgress}
/>

{#if showIncomingToast}
  <!-- Compact incoming-call toast when user is browsing another page (P5) -->
  {@const callerName = getUserDisplayNameSync(globalSession.callService?.incomingCallerId ?? '')}
  {@const isVideoCall = globalSession.callService?.incomingHasVideo ?? true}
  <div
    class="fixed top-4 left-1/2 -translate-x-1/2 z-[310] max-w-sm w-[calc(100%-2rem)] bg-[#0a0d14]/95 backdrop-blur-2xl rounded-2xl shadow-2xl ring-1 ring-white/10 px-4 py-3 flex items-center gap-3 animate-[slideDown_0.3s_ease-out]"
    transition:fly={{ y: -20, duration: 250 }}
  >
    <div class="relative h-10 w-10 shrink-0">
      <span
        class="absolute -right-0.5 -top-0.5 z-10 h-3 w-3 rounded-full bg-amber-400 animate-pulse ring-2 ring-[#0a0d14]"
      ></span>
      <div class="h-full w-full overflow-hidden rounded-full ring-1 ring-white/20 bg-black/30">
        <Avatar
          userId={globalSession.callService?.incomingCallerId ?? ''}
          fill
          shape="circle"
          fallbackLabel={callerName}
        />
      </div>
    </div>
    <div class="min-w-0 flex-1">
      <p class="text-sm font-bold text-white truncate">{callerName || m.call_incoming_label()}</p>
      <p class="text-xs text-white/55 flex items-center gap-1">
        {#if isVideoCall}
          <Video size={12} strokeWidth={2.5} />
        {:else}
          <Phone size={12} strokeWidth={2.5} />
        {/if}
        {isVideoCall ? m.chat_video_call_label() : m.chat_audio_call_label()}
      </p>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      <div class="flex flex-col items-center gap-0.5">
        <button
          class="p-2 rounded-full bg-emerald-500 hover:bg-emerald-400 text-white transition-all active:scale-95"
          onclick={() =>
            globalSession.callService?.acceptCall(
              globalSession.callService.currentGroupId ?? '',
              globalSession.callService.currentCallId ?? ''
            )}
          aria-label={m.call_accept_label()}
        >
          <Phone size={18} class="fill-current" />
        </button>
        <span class="text-[9px] font-bold text-emerald-400 uppercase tracking-wider"
          >{m.call_accept_label()}</span
        >
      </div>
      <div class="flex flex-col items-center gap-0.5">
        <button
          class="p-2 rounded-full bg-red-500 hover:bg-red-400 text-white transition-all active:scale-95"
          onclick={() => globalSession.callService?.endCall()}
          aria-label={m.call_decline_label()}
        >
          <PhoneOff size={18} />
        </button>
        <span class="text-[9px] font-bold text-red-400 uppercase tracking-wider"
          >{m.call_decline_label()}</span
        >
      </div>
    </div>
  </div>
{:else if globalSession.callService && globalSession.callState !== 'idle'}
  <CallOverlay
    callService={globalSession.callService}
    currentUserId={globalSession.userId || currentUserId() || ''}
    participants={callRemoteParticipants}
  />
{/if}
