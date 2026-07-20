/**
 * Authentication functions extracted from useChatSession:
 * login, logout, nativeStorageLogin, biometricLogin, resetDeviceAsFresh.
 *
 * Each function receives `ctx: SessionContext` instead of the closure,
 * and `cb: ChatSessionCallbacks` to interact with conversations / UI.
 */
import { goto } from '$app/navigation';
import { SvelteSet } from 'svelte/reactivity';
import { getStorage } from '$lib/db';
import { computePinVerifier } from '$lib/utils/chat/auth';
import {
  applyNewPinLocally,
  reencryptLocalMessages,
  type PinProgressCallback,
} from '$lib/utils/chat/pinChange';
import { MLS_LOCAL_STATE_UNDECRYPTABLE } from '$lib/mls-client';
import { getToken, clearAuth, SessionExpiredError } from '$lib/stores/auth';
import { m } from '$lib/paraglide/messages';
import { saveUserLocally, clearUserLocally, currentUserId, isGlobalAdmin } from '$lib/stores/user';
import { requestReAdd } from '$lib/utils/chat/recovery';
import { solicitHistory, cancelAllHistorySolicit } from '$lib/utils/chat/historySolicit';
import { isInEpochGap } from '$lib/utils/chat/epochGapRegistry';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import {
  unregisterMlsStatePersister,
  flushActiveMlsStateEncrypted,
} from '$lib/mls-client/mlsStatePersisterRegistry';
import { uninstallMlsStatePersisterLifecycle } from '$lib/mls-client/mlsStatePersisterLifecycle';
import { disposeMlsEncryptWorker } from '$lib/mls-client/mlsEncryptWorkerSession';
import {
  setupMessageHandler,
  initializeConnection,
  initTabLeadershipAsync,
  getIsTabLeader,
} from '$lib/utils/chat/connection';
import {
  beginStartupCatchupBench,
  beginStartupCatchupPhase,
  endStartupCatchupPhase,
  finishStartupCatchupBench,
  cancelStartupCatchupBench,
  summarizeConversationStats,
  installCatchupBenchDevTools,
} from '$lib/mls-client/catchupBenchmark';
import { BiometricService } from '$lib/services/biometric';
import { savePin, clearPin, clearPinAndKey } from '$lib/utils/pinVault';
import { startPushService, stopPushService } from '$lib/services/PushNotificationService';
import { consumeFcmCache } from '$lib/utils/chat/fcmCache';
import { reconcileOutboxSent } from '$lib/utils/chat/outboxMirror';
import { mergeFcmMessagesIntoConversations } from '$lib/utils/chat/fcmMemoryMerge';
import { appendLog } from '$lib/stores/globalChatSingleton.svelte';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { isLikelyPrivateBrowsing } from '$lib/utils/isLikelyPrivateBrowsing';
import {
  handleWelcomeRequest,
  handleHistoryRequest,
  processPendingInvitations,
} from '$lib/utils/chat/actions';
import { markConversationDeletedRemotely } from '$lib/utils/chat/conversations';
import {
  registerOutbox,
  unregisterOutbox,
  flushOutbox,
  applyOutboxPendingStatuses,
} from '$lib/utils/chat/outbox';
import {
  getCallSystemMessageContext,
  handleCallSignalForChat,
  recordCallEnded,
  recordCallStarted,
  setCallSystemMessageContext,
} from '$lib/utils/chat/callSystemMessages';
import { resetSiblingCallWarning } from '$lib/utils/callPresence';
import type { ICallMsg } from '$lib/proto/codec';
import type { SessionContext, ChatSessionCallbacks } from './sessionTypes';
import {
  scheduleReconnectImpl,
  runGroupDiscoveryImpl,
  startConnectionWatchdogImpl,
  stopConnectionWatchdogImpl,
} from './sessionConnection';
import { startSyncWatchdogImpl } from './sessionWatchdogs';
import { isBiometricPromptDismissed } from './sessionBiometrics';

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Builds the RecoveryDeps required by requestReAdd / recoverForkedGroup.
 * Centralised here to avoid duplication across login and attemptReconnect.
 */
export function makeRecoveryDeps(ctx: SessionContext, cb: ChatSessionCallbacks) {
  const st = ctx.getStorage();
  return {
    mlsService: ctx.ensureMls(),
    storage: st,
    userId: ctx.getUserId(),
    pin: ctx.getPin(),
    conversations: cb.conversations,
    getSelectedContact: cb.getSelectedContact,
    setSelectedContact: cb.setSelectedContact,
    saveConversation: cb.saveConversation,
    deleteConversation: st ? (id: string) => st.deleteConversation(id) : undefined,
    log: cb.log,
  };
}

/**
 * Builds the OutboxDeps for the per-session message flusher. Recovery is non-destructive
 * (welcome_request only); a group is "healthy" to send into when its MLS state is in the WASM
 * AND it is not in a known unresolved epoch gap. Sending an application message into a group
 * whose local epoch is behind produces a ciphertext that up-to-date recipients cannot decrypt
 * (msg_epoch < their group_epoch) - the message is silently lost. Holding the outbox until the
 * gap resolves (commit catches us up, or escalation re-Welcomes us at the current epoch) makes
 * the eventual re-encode happen at the right epoch.
 */
export function makeOutboxDeps(ctx: SessionContext, cb: ChatSessionCallbacks) {
  return {
    mlsService: ctx.ensureMls(),
    storage: ctx.getStorage(),
    userId: ctx.getUserId(),
    pin: ctx.getPin(),
    conversations: cb.conversations,
    log: cb.log,
    requestReAdd: (groupId: string) =>
      requestReAdd(groupId, makeRecoveryDeps(ctx, cb), ctx.connectionRecoveryTimers),
    isGroupHealthy: (groupId: string) =>
      ctx.ensureMls().getLocalGroups().includes(groupId) && !isInEpochGap(groupId),
    markDeletedRemotely: (groupId: string) =>
      markConversationDeletedRemotely(cb.conversations, groupId, cb.saveConversation),
    uploadMedia: async (media: NonNullable<import('$lib/db').OutboxEntry['media']>) => {
      const { MediaService } = await import('$lib/media');
      const token = await getToken();
      const bytes = media.fileBytes ?? new Uint8Array(0);
      const file = new File([bytes.buffer as ArrayBuffer], media.fileName ?? 'file', {
        type: media.mimeType,
      });
      return new MediaService().encryptAndUpload(file, token, {
        width: media.width,
        height: media.height,
      });
    },
  };
}

/** Processes any pending MLS invitations from our own other devices (multi-device sync). Re-entrant safe. */
export async function processDeviceInvitationsLocally(
  ctx: SessionContext,
  cb: ChatSessionCallbacks
) {
  if (ctx.isSyncing()) return;
  ctx.setIsSyncing(true);
  try {
    await processPendingInvitations({
      mlsService: ctx.ensureMls(),
      storage: ctx.getStorage(),
      userId: ctx.getUserId(),
      pin: ctx.getPin(),
      conversations: cb.conversations,
      log: cb.log,
    });
  } finally {
    ctx.setIsSyncing(false);
  }
}

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Wipes all local MLS state, device ID, and stored DB for the given user.
 * Called when the server signals that this device has been revoked.
 */
export async function resetDeviceAsFreshImpl(
  ctx: SessionContext,
  userIdToReset: string,
  cb: ChatSessionCallbacks
): Promise<void> {
  const { removeMlsState } = await import('$lib/utils/hex');
  await removeMlsState(userIdToReset);
  localStorage.removeItem(`mls_device_id_${userIdToReset}`);
  localStorage.removeItem(`canari_sync_guide_seen_${userIdToReset}`);

  const deviceNamePrefix = `device-name:${userIdToReset}:`;
  const keysToDelete: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(deviceNamePrefix)) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    localStorage.removeItem(key);
  }

  try {
    const storageToClear = await getStorage(userIdToReset);
    await storageToClear.clear();
  } catch {
    // Best-effort cleanup: continue even if local DB is not accessible.
  }

  ctx.resetMls();
  ctx.setStorage(null);
  ctx.setMyDeviceId('');
  ctx.setIsLoggedIn(false);
  ctx.setIsWsConnected(false);
  clearPinAndKey();
  clearUserLocally();
  cb.log('[SECURITY] Revoked device detected: local state purged, reconnection required.');
}

/**
 * Full login flow: verifies the PIN against the server, initialises MLS, opens IndexedDB,
 * restores conversations, connects the WebSocket, and schedules device-sync.
 * On failure redirects to /login (or calls cb.onLoginFailed if provided).
 */
export async function loginImpl(ctx: SessionContext, cb: ChatSessionCallbacks): Promise<void> {
  const userId = ctx.getUserId();
  const pin = ctx.getPin();

  if (!userId.trim() || !pin.trim()) {
    const msg = 'Please fill in all fields.';
    ctx.setLoginError(msg);
    // Notify the caller so a PIN-modal spinner does not hang forever.
    cb.onLoginFailed?.(msg);
    return;
  }

  // Guard against concurrent calls (e.g. onMount + afterNavigate firing together).
  // Returning silently here is intentional: the in-flight login owns the flow and will
  // resolve the caller's UI. An explicit PIN submit must clear this flag before calling
  // (see handlePinSubmit) so a user action is never swallowed by a background login.
  if (ctx.isLoggedIn() || ctx.isReconnecting() || ctx.getIsLoginInProgress()) return;
  ctx.setIsLoginInProgress(true);

  ctx.setLoginError('');
  ctx.setUserId(userId.trim().toLowerCase());

  // Clear any stale reconnect timer from a previous session
  if (ctx.timers.reconnect !== null) {
    clearTimeout(ctx.timers.reconnect);
    ctx.timers.reconnect = null;
  }
  ctx.setReconnectAttempts(0);
  ctx.setReconnectCircuitOpen(false);

  ctx.setTabLeaderSessionCb(cb);

  try {
    const mlsService = ctx.ensureMls();
    cb.log('Verifying PIN...');

    // Start MLS state load immediately - pure I/O, doesn't need the token.
    const { loadMlsState } = await import('$lib/utils/hex');
    const mlsStatePromise = (async (): Promise<
      { bytes: Uint8Array; source: string } | undefined
    > => {
      const loaded = await loadMlsState(ctx.getUserId());
      if (loaded) return { bytes: loaded, source: 'indexeddb' };
      if (isTauriRuntime()) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const fallback = await invoke<number[] | null>('load_mls_state');
          if (fallback && fallback.length > 0)
            return { bytes: new Uint8Array(fallback), source: 'native' };
        } catch {
          // Non-blocking.
        }
      }
      return undefined;
    })();

    let accessToken: string;
    try {
      accessToken = await getToken();
    } catch (err) {
      ctx.setIsLoginInProgress(false);
      // A SessionExpiredError means the refresh cookie is dead (HTTP 401/403) - the session
      // cannot be recovered by re-entering the PIN. Surface it as a session loss (logout +
      // redirect to /login); fall back to a direct redirect when no callback is wired so
      // the user is never stranded in the PIN modal with a dead session.
      if (err instanceof SessionExpiredError) {
        if (cb.onSessionExpired) cb.onSessionExpired();
        else void goto('/login', { replaceState: true });
        return;
      }
      // Anything else is transient (network down, backend restarting): keep the PIN modal
      // open with a truthful retryable message - do NOT claim the session expired.
      const msg = m.auth_server_unreachable();
      ctx.setLoginError(msg);
      // Notify the caller so a PIN-modal spinner does not hang forever.
      cb.onLoginFailed?.(msg);
      return;
    }

    const verifier = await computePinVerifier(ctx.getUserId(), ctx.getPin());
    const verifierHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    };

    // Collect the MLS state that was loading in the background.
    const mlsStateResult = await mlsStatePromise;
    if (mlsStateResult) {
      cb.log(
        mlsStateResult.source === 'native'
          ? 'MLS state restored from native backup (mls.bin).'
          : 'MLS state loaded from IndexedDB.'
      );
    }

    cb.log('Initialising MLS...');
    // Resolve the device id and verify the PIN BEFORE init(). init() decrypts the
    // encrypted MLS state, and a WRONG PIN makes that decryption fail - which would
    // trigger a destructive fresh-start (generate a new id + deleteDevice → revocation).
    // By resolving the real deviceId (no state decryption) and verifying the PIN first:
    //  - a wrong PIN is rejected without ever touching the device's identity or state;
    //  - a revoked device is matched on its real deviceId (not the 'pending' placeholder),
    //    so the one-shot reset fires instead of leaving it banned forever.
    const deviceId = await mlsService.resolveDeviceId(ctx.getUserId());
    const verifierPayload = JSON.stringify({ userId: ctx.getUserId(), verifier, deviceId });
    const pinCheckRes = await fetch(`${ctx.getHistoryBaseUrl()}/api/mls/security/pin-check`, {
      method: 'POST',
      headers: verifierHeaders,
      body: verifierPayload,
    });
    if (!pinCheckRes.ok) {
      throw new Error('Cannot verify PIN (server unreachable).');
    }
    const pinCheckData = (await pinCheckRes.json()) as {
      status: string;
      resetRequired?: boolean;
    };

    if (pinCheckData.status === 'mismatch') {
      throw new Error(
        'Incorrect PIN: this PIN does not match the one registered for this user. All devices must use the same PIN.'
      );
    }
    if (pinCheckData.resetRequired === true) {
      ctx.resetMls();
      await resetDeviceAsFreshImpl(ctx, ctx.getUserId(), cb);
      ctx.setPin('');
      throw new Error(
        'This device has been revoked. Local state has been reset: sign in with your PIN to register it as a new device.'
      );
    }
    if (pinCheckData.status === 'registered') cb.log('First device: PIN registered.');

    // PIN verified server-side - now decrypt the local MLS state. When a saved state
    // exists, pass noFreshStart so an undecryptable state (the account PIN was rotated
    // on another device → local state still sealed under the old PIN) surfaces as a
    // recoverable signal instead of a destructive fresh-start that would drop history.
    const [mlsInitSettled, storageSettled] = await Promise.allSettled([
      mlsService.init(ctx.getUserId(), ctx.getPin(), mlsStateResult?.bytes, {
        noFreshStart: !!mlsStateResult?.bytes,
      }),
      getStorage(ctx.getUserId()),
    ]);
    if (mlsInitSettled.status === 'rejected') {
      const reason = mlsInitSettled.reason;
      const isUndecryptable =
        reason instanceof Error && reason.message === MLS_LOCAL_STATE_UNDECRYPTABLE;
      if (isUndecryptable) {
        throw new Error(
          'Your PIN was changed on another device. Recover your messages with your old PIN.'
        );
      }
      throw mlsInitSettled.reason;
    }
    if (storageSettled.status === 'rejected') throw storageSettled.reason;

    ctx.setStorage(storageSettled.value);
    ctx.setMyDeviceId(mlsService.getDeviceId());
    cb.log(`MLS identity initialised (device: ${ctx.getMyDeviceId()})`);
    console.log(
      `[INIT] MLS initialized for userId=${ctx.getUserId()} device=${ctx.getMyDeviceId()}`
    );
    cb.log('Local database initialised.');

    // Notify only on genuine private browsing (blocked / ephemeral storage).
    void isLikelyPrivateBrowsing()
      .then((privateBrowsing) => {
        if (!privateBrowsing) return;
        ctx.setMlsFatalError('private_mode');
        cb.log(
          '[WARN] Private browsing detected - MLS state will not be persisted after window close.'
        );
        appendLog(
          'ℹ️ Private browsing mode: your messages will not be saved after the tab is closed.'
        );
      })
      .catch(() => {});

    ctx.setAuthToken(await getToken());

    ctx.setIsLoggedIn(true);
    saveUserLocally({ id: ctx.getUserId(), admin: isGlobalAdmin() });
    ctx.setIsMessagingInitializing(true);
    installCatchupBenchDevTools();
    beginStartupCatchupBench();
    cb.log('[INIT] MLS ready - syncing messages in background.');
    cb.onMlsReady?.();

    // Fire-and-forget: savePin is independent of conversation loading.
    // On Tauri, BiometricService.isConfigured() is a fast read (localStorage +
    // optional native invoke) and does not need to block the rest of login.
    void (async () => {
      if (!isTauriRuntime() || !(await BiometricService.isConfigured().catch(() => false))) {
        await savePin(ctx.getPin());
      }
    })();

    // Biometric enrolment prompt: depends only on local state (Tauri + not configured
    // + not dismissed), not on syncs. Evaluated as soon as MLS is ready so the prompt
    // appears immediately, not at the very end of the startup catch-up.
    if (isTauriRuntime()) {
      void (async () => {
        const [isConfig, isDismissed] = await Promise.all([
          BiometricService.isConfigured().catch(() => false),
          isBiometricPromptDismissed(),
        ]);
        if (!isConfig && !isDismissed) ctx.setShowBiometricEnrollPrompt(true);
      })();
    }

    // Check push health AFTER registration so pending_push_secret.txt is present
    // (written by store_push_secret during startPushService) before the health check runs.
    void startPushService(ctx.getHistoryBaseUrl(), ctx.getAuthToken(), ctx.getMyDeviceId())
      .then(async () => {
        cb.log('[PUSH] Push token registration complete.');
        if (!isTauriRuntime()) return;
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const health = await invoke<{ ok: boolean; reason?: string }>('check_push_secret_health');
          if (!health.ok && health.reason === 'no_secret') {
            ctx.setMlsFatalError('keystore_lost');
            cb.log(
              '[WARN] Push keystore lost - background notifications are degraded. Restart the app to re-enable them.'
            );
            appendLog('⚠️ Push notifications degraded - restart the app to re-enable them.');
          }
        } catch {
          /* non-blocking */
        }
      })
      .catch((e) =>
        cb.log(`[WARN] Push registration failed: ${e instanceof Error ? e.message : String(e)}`)
      );

    // Message outbox: register the flusher before loading conversations so that
    // applyOutboxPendingStatuses can restore the "pending" status on restored messages.
    registerOutbox(makeOutboxDeps(ctx, cb));

    // Load conversations first: consumeFcmCache can access
    // the conversations Map via addMessageToChat once it is populated.
    beginStartupCatchupPhase('load_conversations');
    await cb.loadAndRestoreConversations();
    {
      const stats = summarizeConversationStats(cb.conversations);
      endStartupCatchupPhase({
        conversationCount: stats.conversationCount,
        messageCount: stats.localMessageCount,
      });
    }
    // Reconcile background sends (killed app) first: remove from the outbox any
    // messages already delivered by the native service, BEFORE re-deriving "pending"
    // statuses (otherwise an already-sent message would be shown as pending again).
    await reconcileOutboxSent(ctx.getStorage()!).catch(() => {});
    // Re-mark "pending" messages still in the outbox queue (derived status, not persisted).
    await applyOutboxPendingStatuses();

    beginStartupCatchupPhase('fcm_cache');
    const fcmInjected = await consumeFcmCache(ctx.getPin(), ctx.getStorage()!).catch(
      () => [] as []
    );
    if (Array.isArray(fcmInjected) && fcmInjected.length > 0) {
      const mergedCount = mergeFcmMessagesIntoConversations(
        fcmInjected,
        cb.conversations,
        ctx.getUserId()
      );
      cb.log(`[FCM_CACHE] ${mergedCount} message(s) merged in memory at login`);
    }
    endStartupCatchupPhase({
      messageCount: Array.isArray(fcmInjected) ? fcmInjected.length : 0,
    });

    try {
      const localMlsGroups = new SvelteSet(mlsService.getLocalGroups());
      const missingKeys: string[] = [];
      // Conversations stuck in 'pending' while their local MLS state exists:
      // the "Sync" badge would remain forever (DF5). Reconciliation demoted absent
      // groups but never promoted the inverse - this adds the mirror promotion.
      const recoveredKeys: string[] = [];
      for (const [key, c] of cb.conversations.entries()) {
        if (isChannelConversationId(c.id)) continue;
        if (c.lifecycle === 'active' && !localMlsGroups.has(c.id)) {
          cb.conversations.set(key, { ...c, lifecycle: 'pending' });
          missingKeys.push(key);
        } else if (c.lifecycle === 'pending' && localMlsGroups.has(c.id)) {
          cb.conversations.set(key, { ...c, lifecycle: 'active' });
          recoveredKeys.push(key);
        }
      }
      if (missingKeys.length > 0) {
        cb.log(
          `[WARN] Groups without local MLS state detected - ${missingKeys.length} conversation(s) marked not-ready, re-invite triggered on next connect.`
        );
        console.warn(
          `[INIT] ${missingKeys.length} conversation(s) missing local MLS state - marked not-ready`
        );
        await Promise.all(missingKeys.map((key) => cb.saveConversation(key).catch(() => {})));
      }
      if (recoveredKeys.length > 0) {
        cb.log(
          `[INIT] ${recoveredKeys.length} conversation(s) stuck pending but already synced - "Sync" badge cleared.`
        );
        await Promise.all(recoveredKeys.map((key) => cb.saveConversation(key).catch(() => {})));
      }
    } catch (e) {
      console.warn('[INIT] Error detecting missing MLS groups:', e);
    }

    // processDeviceInvitationsLocally is called at the end of syncConnectionAfterWsOpen -
    // calling it here before the WebSocket is opened is redundant.

    beginStartupCatchupPhase('setup_handler');

    const callSystemCtx = {
      userId: ctx.getUserId(),
      pin: ctx.getPin(),
      storage: ctx.getStorage(),
      conversations: cb.conversations,
      addMessageToChat: cb.addMessageToChat,
    };
    setCallSystemMessageContext(callSystemCtx);
    ctx.getCallService()?.setChatNotifier({
      onCallStarted: (groupId: string, callId: string) =>
        recordCallStarted(getCallSystemMessageContext(), groupId, callId, ctx.getUserId()),
      onCallEnded: (groupId: string, callId: string) =>
        recordCallEnded(getCallSystemMessageContext(), groupId, callId),
    });

    setupMessageHandler({
      mlsService,
      storage: ctx.getStorage(),
      userId: ctx.getUserId(),
      pin: ctx.getPin(),
      historyBaseUrl: ctx.getHistoryBaseUrl(),
      conversations: cb.conversations,
      messageReactions: cb.messageReactions,
      getSelectedContact: cb.getSelectedContact,
      setSelectedContact: cb.setSelectedContact,
      saveConversation: cb.saveConversation,
      deleteConversation: ctx.getStorage()
        ? (id) => ctx.getStorage()!.deleteConversation(id)
        : undefined,
      addMessageToChat: cb.addMessageToChat,
      batchAddMessages: cb.batchAddMessages,
      loadHistoryForConversation: cb.onLoadHistoryForConversation,
      onChannelMemberJoined: cb.onChannelMemberJoined,
      onChannelMemberKicked: cb.onChannelMemberKicked,
      onChannelUpdated: cb.onChannelUpdated,
      onChannelDeleted: cb.onChannelDeleted,
      onWorkspaceUpdated: cb.onWorkspaceUpdated,
      onReadReceiptReceived: cb.onReadReceiptReceived,
      onCallSignal: (senderId: string, groupId: string, callMsg) => {
        void handleCallSignalForChat(
          getCallSystemMessageContext(),
          senderId,
          groupId,
          callMsg as ICallMsg,
          ctx.getUserId()
        );
        ctx
          .getCallService()
          ?.handleCallSignal(
            senderId,
            groupId,
            callMsg,
            ctx.getUserId(),
            ctx.ensureMls().getDeviceId()
          );
      },
      onGroupReady: (() => {
        let t: ReturnType<typeof setTimeout> | null = null;
        return (readyGroupId: string) => {
          // The group just became sendable (Welcome processed / external join complete): drain
          // the outbox to deliver pending messages and refresh their status.
          flushOutbox();
          void applyOutboxPendingStatuses();
          const deferred = ctx.deferredWelcomeRequests.get(readyGroupId);
          if (deferred?.length) {
            ctx.deferredWelcomeRequests.delete(readyGroupId);
            for (const req of deferred) {
              handleWelcomeRequest({
                mlsService: ctx.ensureMls(),
                storage: ctx.getStorage(),
                userId: ctx.getUserId(),
                pin: ctx.getPin(),
                conversations: cb.conversations,
                log: cb.log,
                requesterUserId: req.requesterUserId,
                requesterDeviceId: req.requesterDeviceId,
                groupId: readyGroupId,
              }).catch(() => {});
            }
          }
          if (t !== null) clearTimeout(t);
          t = setTimeout(() => {
            t = null;
            processDeviceInvitationsLocally(ctx, cb).catch(() => {});
          }, 500);
        };
      })(),
      onMlsFatalError: (kind) => {
        ctx.setMlsFatalError(kind);
        if (kind === 'oom') {
          cb.log('[FATAL] Insufficient WASM memory - reload the application.');
          appendLog(
            '⚠️ Insufficient memory - reload the application to continue receiving messages.'
          );
        } else if (kind === 'private_mode') {
          cb.log(
            '[WARN] Private browsing detected - MLS state will not be persisted after window close.'
          );
          appendLog(
            'ℹ️ Private browsing mode: your messages will not be saved after the tab is closed.'
          );
        } else if (kind === 'keystore_lost') {
          cb.log('[WARN] Android keystore lost - push notifications degraded.');
          appendLog('⚠️ Push notifications degraded - restart the app to re-enable them.');
        }
      },
      recoveryTimers: ctx.connectionRecoveryTimers,
      log: cb.log,
    });

    if (cb.beginBulkMessageIngest && cb.endBulkMessageIngest) {
      const beginUi = cb.beginBulkMessageIngest;
      const endUi = cb.endBulkMessageIngest;
      mlsService.addBulkIngestObserver({
        onBulkIngestStart: (phase) => beginUi(phase),
        onBulkIngestEnd: (phase) => endUi(phase),
      });
    }
    endStartupCatchupPhase();

    if ('onWelcomeProcessed' in mlsService) {
      (mlsService as any).onWelcomeProcessed(async (groupId?: string) => {
        if (groupId) {
          cb.log(`[SYNC] Welcome processed for ${groupId}, refreshing...`);
          if (!cb.conversations.has(groupId)) {
            cb.conversations.set(groupId, {
              id: groupId,
              contactName: groupId,
              name: groupId,
              messages: [],
              lifecycle: 'active',
              mlsStateHex: null,
              unreadCount: 0,
              conversationType: 'group',
            });
            await cb.saveConversation(groupId);
            await cb
              .loadAndRestoreConversations()
              .catch((e) => cb.log(`[WARN] Error resyncing convs (Welcome): ${e}`));
            // Fresh join: the Welcome lands us at the current epoch with no pre-join history. The
            // inviter pushes a bundle on the foreground add path, but its background twin
            // (send-welcome-and-commit) does not, so we also solicit it ourselves (idempotent,
            // receipt-driven retries). Only for a genuinely new local conversation.
            solicitHistory(mlsService, ctx.getUserId(), groupId, cb.log);
          }
          cb.onLoadHistoryForConversation(groupId, groupId).catch((e) =>
            cb.log(`[WARN] Error refreshing conv ${groupId}: ${e}`)
          );
        } else {
          cb.log('[SYNC] Welcome processed, refreshing conversations...');
          cb.loadAndRestoreConversations().catch((e) =>
            cb.log(`[WARN] Error refreshing convs: ${e}`)
          );
        }
      });
    }

    mlsService.onWelcomeRequest(
      async (requesterUserId: string, requesterDeviceId: string, groupId: string) => {
        cb.log(
          `[SYNC] welcome_request received from ${requesterUserId}:${requesterDeviceId} for ${groupId}`
        );
        try {
          await handleWelcomeRequest({
            mlsService: ctx.ensureMls(),
            storage: ctx.getStorage(),
            userId: ctx.getUserId(),
            pin: ctx.getPin(),
            conversations: cb.conversations,
            log: cb.log,
            requesterUserId,
            requesterDeviceId,
            groupId,
            onNotReady: (terminalGroupId) => {
              const list = ctx.deferredWelcomeRequests.get(terminalGroupId) ?? [];
              list.push({ requesterUserId, requesterDeviceId });
              ctx.deferredWelcomeRequests.set(terminalGroupId, list);
              cb.log(`[WELCOME_REQ] ${terminalGroupId.slice(0, 8)}... not ready yet - deferred`);
            },
          });
        } catch (e) {
          cb.log(
            `[WARN] Echec handleWelcomeRequest: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    );

    mlsService.onHistoryRequest(
      async (requesterUserId: string, requesterDeviceId: string, groupId: string) => {
        cb.log(
          `[SYNC] history_request received from ${requesterUserId}:${requesterDeviceId} for ${groupId}`
        );
        try {
          await handleHistoryRequest({
            mlsService: ctx.ensureMls(),
            storage: ctx.getStorage(),
            pin: ctx.getPin(),
            conversations: cb.conversations,
            log: cb.log,
            requesterUserId,
            groupId,
          });
        } catch (e) {
          cb.log(
            `[WARN] Echec handleHistoryRequest: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    );

    const tabLeaderNow = await initTabLeadershipAsync(cb.log);
    ctx.setIsTabLeader(tabLeaderNow);
    if (!tabLeaderNow) {
      cb.log('[TAB] Follower tab - WebSocket active in another Canari tab.');
    }

    beginStartupCatchupPhase('initialize_connection');
    await initializeConnection({
      mlsService,
      userId: ctx.getUserId(),
      pin: ctx.getPin(),
      scheduleReconnect: () => scheduleReconnectImpl(ctx, cb),
      setIsWsConnected: (v) => ctx.setIsWsConnected(v),
      setReconnectAttempts: (v) => ctx.setReconnectAttempts(v),
      processDeviceInvitationsLocally: () => processDeviceInvitationsLocally(ctx, cb),
      log: cb.log,
      onGroupMissing: (groupId) =>
        requestReAdd(groupId, makeRecoveryDeps(ctx, cb), ctx.connectionRecoveryTimers),
      onGroupDeletedRemotely: (groupId) =>
        markConversationDeletedRemotely(cb.conversations, groupId, cb.saveConversation),
    });
    {
      const stats = summarizeConversationStats(cb.conversations);
      endStartupCatchupPhase({
        conversationCount: stats.conversationCount,
        messageCount: stats.localMessageCount,
      });
    }
    finishStartupCatchupBench(cb.log);

    // Connection established and groups reconciled: drain the outbox (covers reconnection,
    // which re-runs initializeConnection).
    flushOutbox();

    const STALE_SESSION_MS = 90 * 24 * 60 * 60 * 1_000;
    const lastActiveKey = `canari_last_active:${ctx.getUserId()}`;
    const lastActiveRaw = localStorage.getItem(lastActiveKey);
    if (lastActiveRaw) {
      const lastActive = parseInt(lastActiveRaw, 10);
      if (Number.isFinite(lastActive) && Date.now() - lastActive > STALE_SESSION_MS) {
        appendLog(
          '⚠️ You have not logged in for more than 3 months. Some older messages may no longer be available.'
        );
      }
    } else if (isTauriRuntime()) {
      // localStorage may be empty after Android process kill - try Tauri Store fallback.
      try {
        const { load } = await import('@tauri-apps/plugin-store');
        const store = await load('session-meta.json', { autoSave: true, defaults: {} });
        const nativeLastActive = await store.get<number>(lastActiveKey);
        if (
          typeof nativeLastActive === 'number' &&
          Date.now() - nativeLastActive > STALE_SESSION_MS
        ) {
          appendLog(
            '⚠️ You have not logged in for more than 3 months. Some older messages may no longer be available.'
          );
        }
      } catch {
        /* non-blocking */
      }
    }
    const nowMs = Date.now();
    localStorage.setItem(lastActiveKey, String(nowMs));
    // Persist to Tauri Store so the value survives Android process kills.
    if (isTauriRuntime()) {
      import('@tauri-apps/plugin-store')
        .then(({ load }) => load('session-meta.json', { autoSave: true, defaults: {} }))
        .then((store) => store.set(lastActiveKey, nowMs))
        .catch(() => {});
    }

    if (!getIsTabLeader()) return;

    runGroupDiscoveryImpl(ctx, cb, ctx.ensureMls());

    for (const delay of [35_000, 70_000]) {
      setTimeout(() => {
        if ([...cb.conversations.values()].some((c) => c.lifecycle === 'pending')) {
          runGroupDiscoveryImpl(ctx, cb, ctx.ensureMls(), 'retry');
        }
      }, delay);
    }

    startSyncWatchdogImpl(ctx, cb);
    startConnectionWatchdogImpl(ctx, cb);
  } catch (_e: unknown) {
    cancelStartupCatchupBench();
    const msg = _e instanceof Error ? _e.message : String(_e);
    ctx.setLoginError(msg);
    cb.log(`Error: ${msg}`);
    console.error('[INIT] Login failed:', msg);
    ctx.resetMls();
    clearUserLocally();
    clearPin();
    // A dead session (refresh cookie expired/revoked) is not retryable via the PIN modal:
    // hand it to onSessionExpired so the caller logs out and redirects to /login. When no
    // callback is wired, redirect directly so the user is never stranded in the modal.
    if (_e instanceof SessionExpiredError) {
      if (cb.onSessionExpired) cb.onSessionExpired();
      else void goto('/login', { replaceState: true });
    } else if (cb.onLoginFailed) {
      cb.onLoginFailed(msg);
    } else {
      const cur = window.location.pathname + window.location.search + window.location.hash;
      void goto(`/login?returnTo=${encodeURIComponent(cur)}`, { replaceState: true });
    }
  } finally {
    ctx.setIsLoginInProgress(false);
    ctx.setIsMessagingInitializing(false);
  }
}

/**
 * On Tauri/Android (no biometrics), reads the PIN from push_context.json and delegates to loginImpl().
 * Returns true if login succeeded, false if manual PIN is still needed.
 */
export async function nativeStorageLoginImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks
): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const nativeCtx = await invoke<{ pin?: string; userId?: string } | null>('load_push_context');
    if (!nativeCtx?.pin || !nativeCtx.userId || nativeCtx.userId !== ctx.getUserId()) return false;
    appendLog('[PIN] PIN restored from native storage - auto-login…');
    ctx.setPin(nativeCtx.pin);
    await loginImpl(ctx, cb);
    return ctx.isLoggedIn();
  } catch {
    return false;
  }
}

/**
 * Reads the PIN from the hardware biometric keystore and delegates to loginImpl().
 * Displays a user-friendly error if biometric authentication fails.
 */
export async function biometricLoginImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks
): Promise<void> {
  ctx.setLoginError('');
  cb.log('[BIOMETRIC] Biometric login attempt...');
  try {
    const savedUser = currentUserId();
    if (!savedUser) {
      ctx.setLoginError('No user registered for biometric authentication.');
      cb.log('[BIOMETRIC] Failed - no local user found.');
      return;
    }
    cb.log(`[BIOMETRIC] Authenticating for userId=${savedUser.slice(0, 8)}...`);
    const retrieved = await BiometricService.authenticateAndGetSecret();
    if (!retrieved) {
      ctx.setLoginError('Biometric authentication failed. Please enter your PIN manually.');
      cb.log('[BIOMETRIC] Failed - secret not retrieved, manual PIN required.');
      return;
    }
    cb.log('[BIOMETRIC] PIN retrieved via biometrics - calling login().');
    ctx.setUserId(savedUser);
    ctx.setPin(retrieved);

    // Capture a PIN-mismatch failure: the keystore holds a stale PIN (e.g. the PIN
    // was changed on another device). Disable biometric so the user re-enters the
    // new PIN and re-enrols, instead of the fingerprint failing on every attempt.
    let failMsg = '';
    await loginImpl(ctx, {
      ...cb,
      onLoginFailed: (msg: string) => {
        failMsg = msg;
        cb.onLoginFailed?.(msg);
      },
    });
    if (failMsg && /incorrect PIN/i.test(failMsg)) {
      await BiometricService.disable().catch(() => {});
      cb.log('[BIOMETRIC] Stale PIN detected - biometric disabled, re-enrolment required.');
    }
  } catch (e) {
    ctx.setLoginError('Biometric authentication failed. Please enter your PIN manually.');
    cb.log(`[BIOMETRIC] Exception: ${e instanceof Error ? e.message : String(e)}`);
    console.error(e);
  }
}

/**
 * "PIN changed on another device" recovery. The account PIN was rotated elsewhere, so
 * this device's local MLS state is still sealed under the OLD pin while the server now
 * expects the NEW one. Decrypts the local state with `oldPin` (non-destructively),
 * re-encrypts it under `newPin` (reusing changePIN), then logs in normally - preserving
 * every local message instead of falling back to a fresh-start.
 *
 * Throws a user-facing message when the new PIN is wrong, the old PIN does not decrypt
 * the local state, or there is no local state to recover.
 */
export async function recoverPinImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  oldPin: string,
  newPin: string,
  onProgress?: PinProgressCallback
): Promise<void> {
  const userId = ctx.getUserId();
  if (!userId.trim()) throw new Error('No user is currently signed in.');
  cb.log('[PIN_RECOVER] Starting recovery...');
  onProgress?.({ percent: 3, stage: 'verify' });

  const { loadMlsState } = await import('$lib/utils/hex');
  const state = await loadMlsState(userId);
  if (!state) {
    throw new Error('No local state to recover on this device.');
  }

  // The new PIN must be the real (rotated) account PIN: verify its verifier server-side.
  const newVerifier = await computePinVerifier(userId, newPin);
  const token = await getToken();
  const res = await fetch(`${ctx.getHistoryBaseUrl()}/api/mls/security/pin-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ userId, verifier: newVerifier }),
  });
  if (!res.ok) throw new Error('Cannot verify the new PIN (server unreachable).');
  const data = (await res.json()) as { status: string };
  if (data.status !== 'ok') {
    throw new Error('The new PIN is incorrect.');
  }

  onProgress?.({ percent: 15, stage: 'mls' });
  // Non-destructively decrypt local state with the old PIN, then re-encrypt under the new.
  const mls = ctx.ensureMls();
  const ok = await mls.recoverAndRekey(userId, oldPin, newPin, state);
  if (!ok) {
    throw new Error("The old PIN is incorrect (it does not decrypt this device's state).");
  }
  cb.log('[PIN_RECOVER] MLS state re-encrypted with the new PIN.');

  const storage = await getStorage(userId);
  await reencryptLocalMessages(storage, oldPin, newPin, cb.log, onProgress, {
    start: 20,
    end: 82,
  });
  cb.log('[PIN_RECOVER] Local messages re-encrypted with the new PIN.');

  onProgress?.({ percent: 88, stage: 'finalize' });
  await applyNewPinLocally(newPin, cb.log);
  ctx.setPin(newPin);

  onProgress?.({ percent: 92, stage: 'login' });
  // Continue with a normal login. init() is a no-op (recoverAndRekey already marked the
  // client initialised), so the decrypted client is reused and all messages are kept.
  await loginImpl(ctx, cb);
  if (!ctx.isLoggedIn()) {
    throw new Error('Login failed after recovery.');
  }
  onProgress?.({ percent: 100, stage: 'login' });
  cb.log('[PIN_RECOVER] Complete - messages preserved.');
}

/**
 * Clears all session state (conversations, tokens, push registration),
 * deregisters the device push token, and redirects to /login.
 */
export function logoutImpl(ctx: SessionContext, cb: ChatSessionCallbacks): void {
  cb.log(`[LOGOUT] Signing out userId=${ctx.getUserId()?.slice(0, 8) ?? 'unknown'}...`);
  unregisterOutbox();
  cancelAllHistorySolicit();
  void flushActiveMlsStateEncrypted().finally(() => {
    uninstallMlsStatePersisterLifecycle();
    unregisterMlsStatePersister();
    // Dispose after the final flush: flushEncrypted relies on the encrypt worker.
    disposeMlsEncryptWorker();
  });
  const tokenForPushCleanup = ctx.getAuthToken();
  const deviceForPushCleanup = ctx.getMyDeviceId();

  if (tokenForPushCleanup && deviceForPushCleanup) {
    void stopPushService(ctx.getHistoryBaseUrl(), tokenForPushCleanup, deviceForPushCleanup);
  }

  if (ctx.timers.reconnect !== null) {
    clearTimeout(ctx.timers.reconnect);
    ctx.timers.reconnect = null;
  }
  if (ctx.timers.health !== null) {
    clearInterval(ctx.timers.health);
    ctx.timers.health = null;
  }
  if (ctx.timers.syncWatchdog !== null) {
    clearInterval(ctx.timers.syncWatchdog);
    ctx.timers.syncWatchdog = null;
  }
  for (const t of ctx.connectionRecoveryTimers.values()) clearTimeout(t);
  ctx.connectionRecoveryTimers.clear();
  stopConnectionWatchdogImpl(ctx);
  ctx.setReconnectAttempts(0);
  ctx.setReconnectCircuitOpen(false);
  ctx.setTabLeaderSessionCb(null);
  ctx.setIsLoggedIn(false);
  ctx.setIsWsConnected(false);
  ctx.setIsMessagingInitializing(false);
  cb.conversations.clear();
  cb.setSelectedContact(null);
  ctx.setStorage(null);
  ctx.setAuthToken('');
  ctx.setShowBiometricEnrollPrompt(false);
  setCallSystemMessageContext(null);
  ctx.getCallService()?.setChatNotifier(null);
  resetSiblingCallWarning();
  clearUserLocally();
  clearPinAndKey();
  clearAuth();
  cb.log('[LOGOUT] Local state cleared - redirecting to /login.');
  void goto('/login', { replaceState: true });
}
