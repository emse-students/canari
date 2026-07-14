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
  import { m } from '$lib/paraglide/messages';
  import { BiometricService } from '$lib/services/biometric';
  import { loadPin } from '$lib/utils/pinVault';
  import { getToken, clearAuth } from '$lib/stores/auth';
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
  import { isAndroidTauriRuntime } from '$lib/utils/appVersion';
  import { createPausableInterval } from '$lib/utils/backgroundPausableInterval';
  import { resolveConversationListPresentation } from '$lib/utils/chat/conversations';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import type { CallParticipant } from '$lib/services/CallService';
  import { notifNav } from '$lib/stores/notifNav.svelte';
  import { openNotificationTarget } from '$lib/utils/chat/openConversationFromId';
  import { chatDeepLinkRoute } from '$lib/utils/chat/notificationRouting';
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

  function onBiometricSkip() {
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
        appendLog(`Joined channel #${event.channelName || event.channelId}`);
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

  // ── Post-login: load channel workspaces ───────────────────────────────────
  $effect(() => {
    if (!globalSession.isLoggedIn) return;
    untrack(() => {
      void globalChannels.loadChannelWorkspacesFromBackend(channelsCtx());
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
          // Biometric cancelled, failed, or unavailable: fall back to PIN modal.
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
    // Already logged in (e.g. navigating from /chat): nothing to do.
    if (globalSession.isLoggedIn) return;

    const w = window as Window & {
      wasm_bindings_log?: (level: string, msg: string) => void;
    };
    w.wasm_bindings_log = (level: string, msg: string) => appendLog(`[RUST::${level}] ${msg}`);

    globalSession.initServices(appendLog);
    void startLoginFlow();

    /** Fire-and-forget native MLS foreground-guard command (Android only; no-op elsewhere). */
    const invokeNative = (cmd: string): void => {
      void import('@tauri-apps/api/core').then(({ invoke }) => invoke(cmd)).catch(() => {});
    };

    // Foreground heartbeat (Android): keeps the native guard fresh while the app is visible so the
    // background JNI engines abstain from writing mls.bin. createPausableInterval auto-pauses on
    // hidden, so the guard expires shortly after backgrounding even without a clean `hidden` event.
    const stopForegroundHeartbeat = isAndroidTauriRuntime()
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
        const { pin, storage } = globalSession;
        // Ordered resume sequence. C2 first: reload mls.bin into the warm engine BEFORE anything
        // processes, because a background join/send may have advanced it while we were away; the
        // stale warm state would otherwise clobber that advance on the next save (SecretReuse).
        // No-op off Android. Then reconcile outbox_sent BEFORE the flusher re-reads the queue (so
        // we don't re-send a message the background already delivered), then reconnect/flush.
        void (async () => {
          await globalSession.ensureMls().reloadStateFromDisk();
          if (storage) await reconcileOutboxSent(storage).catch(() => {});
          if (!globalSession.isWsConnected) {
            appendLog('Page visible again - reconnecting…');
            void globalSession.attemptReconnect(sessionCb());
          }
          checkSiblingCallWarning();
          // Flush FCM messages cached while the app was in the background.
          if (pin && storage) {
            void flushFcmCache(pin, storage);
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

{#if globalSession.callService && globalSession.callState !== 'idle'}
  <CallOverlay
    callService={globalSession.callService}
    currentUserId={globalSession.userId || currentUserId() || ''}
    participants={callRemoteParticipants}
  />
{/if}

<!-- Biometric enrollment prompt (all routes) -->
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
        <p class="text-sm font-bold text-text-main mb-0.5">{m.auth_biometric_enroll_title()}</p>
        <p class="text-[11px] sm:text-xs text-text-muted leading-relaxed">
          {m.auth_biometric_enroll_prompt()}
        </p>
      </div>
    </div>

    <!-- Buttons container: compact and right-aligned on mobile. -->
    <div class="flex items-center gap-2 shrink-0 self-end sm:self-auto mt-1 sm:mt-0">
      <button
        onclick={() => globalSession.dismissBiometricPrompt()}
        class="px-3 py-2 text-xs font-semibold text-text-muted hover:text-text-main rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        {m.auth_biometric_later_btn()}
      </button>
      <button
        onclick={async () => {
          try {
            await globalSession.enrollBiometric();
            globalSession.showBiometricEnrollPrompt = false;
          } catch (e) {
            // If the device has no enrolled biometric, catch the error.
            if (String(e).includes('At least one biometric must be enrolled')) {
              showToast(
                m.auth_biometric_no_fingerprint_android(),
                'info'
              );
              globalSession.showBiometricEnrollPrompt = false;
            }
          }
        }}
        class="px-4 py-2 text-xs font-bold text-[#151B2C] bg-amber-500 rounded-xl hover:bg-amber-400 shadow-sm transition-all whitespace-nowrap"
      >
        {m.auth_biometric_enable_btn()}
      </button>
    </div>
  </div>
{/if}
