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
  applyNewDeviceKeyLocally,
  performPinChange,
  reencryptLocalMessages,
  type PinProgressCallback,
} from '$lib/utils/chat/pinChange';
import { deriveDeviceKeyB64, isValidDeviceKeyB64 } from '$lib/crypto/deviceKey';
import { LoginFailure, loginErrorCode } from './loginErrors';
import { MLS_LOCAL_STATE_UNDECRYPTABLE } from '$lib/mls-client';
import { getToken, clearAuth, SessionExpiredError } from '$lib/stores/auth';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { registerOfflinePromotion, unregisterOfflinePromotion } from './promoteOfflineSession';
import { m } from '$lib/paraglide/messages';
import { saveUserLocally, clearUserLocally, currentUserId, isGlobalAdmin } from '$lib/stores/user';
import { requestReAdd } from '$lib/utils/chat/recovery';
import {
  solicitHistoryIfMissing,
  cancelAllHistorySolicit,
  reSolicitAwaitingHistory,
  setHistoryDigestBroadcaster,
  startAwaitingHistorySweep,
} from '$lib/utils/chat/historySolicit';
import { onPeersCameOnline } from '$lib/stores/presenceStore';
import { sendHistoryDigest } from '$lib/utils/chat/groupActions';
import { digestIdentity } from '$lib/utils/chat/historyDigestRendezvous';
import { historyRequestPendingStore } from '$lib/stores/historyRequestPending.svelte';
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
import { saveDeviceKey, clearDeviceKey, clearDeviceKeyAndWrapKey } from '$lib/utils/deviceKeyVault';
import { startPushService, stopPushService } from '$lib/services/PushNotificationService';
import { consumeFcmCache } from '$lib/utils/chat/fcmCache';
import { adoptOrphanedMirrorEntries, reconcileOutboxSent } from '$lib/utils/chat/outboxMirror';
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

/**
 * Unregisters this session's presence listener. Module-level because the presence store outlives
 * any one session, so the subscription has to be revocable from logout, which is elsewhere.
 */
let unregisterPeerReturn: (() => void) | null = null;

/** Stops this session's periodic awaiting-history sweep. Module-level for the same reason. */
let stopAwaitingSweep: (() => void) | null = null;

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
    deviceKeyB64: ctx.getDeviceKey(),
    conversations: cb.conversations,
    getSelectedContact: cb.getSelectedContact,
    setSelectedContact: cb.setSelectedContact,
    saveConversation: cb.saveConversation,
    deleteConversation: st ? (id: string) => st.deleteConversation(id) : undefined,
    log: cb.log,
  };
}

/**
 * Builds the dependency bag for `initializeConnection` (WebSocket open + post-connect group
 * reconciliation). Shared by the login path and `promoteOfflineSession`, which must perform the
 * exact same connection sequence - a second, hand-copied version would drift the moment either one
 * gained a callback.
 */
export function makeConnectionDeps(ctx: SessionContext, cb: ChatSessionCallbacks) {
  return {
    mlsService: ctx.ensureMls(),
    userId: ctx.getUserId(),
    deviceKeyB64: ctx.getDeviceKey(),
    scheduleReconnect: () => scheduleReconnectImpl(ctx, cb),
    setIsWsConnected: (v: boolean) => ctx.setIsWsConnected(v),
    setReconnectAttempts: (v: number) => ctx.setReconnectAttempts(v),
    processDeviceInvitationsLocally: () => processDeviceInvitationsLocally(ctx, cb),
    log: cb.log,
    onGroupMissing: (groupId: string) =>
      requestReAdd(groupId, makeRecoveryDeps(ctx, cb), ctx.connectionRecoveryTimers),
    onGroupDeletedRemotely: (groupId: string) =>
      markConversationDeletedRemotely(cb.conversations, groupId, cb.saveConversation),
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
    deviceKeyB64: ctx.getDeviceKey(),
    conversations: cb.conversations,
    log: cb.log,
    requestReAdd: (groupId: string) =>
      requestReAdd(groupId, makeRecoveryDeps(ctx, cb), ctx.connectionRecoveryTimers),
    isGroupHealthy: (groupId: string) =>
      ctx.ensureMls().getLocalGroups().includes(groupId) && !isInEpochGap(groupId),
    // A session unlocked offline holds no token: hold the queue until promoteOfflineSession has
    // one and has reopened the socket, then it flushes explicitly.
    canFlush: () => !ctx.isOfflineSession(),
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
      deviceKeyB64: ctx.getDeviceKey(),
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
  clearDeviceKeyAndWrapKey();
  clearUserLocally();
  cb.log('[SECURITY] Revoked device detected: local state purged, reconnection required.');
}

/**
 * Full login flow: verifies the PIN against the server (unless biometric mode),
 * initialises MLS, opens IndexedDB, restores conversations, connects the WebSocket,
 * and schedules device-sync.
 *
 * When `pin` is empty, biometric mode is assumed: the server-side pin-check is
 * skipped, and `mlsService.init()` is called with an empty PIN so the Rust side
 * path (`load_encrypted_with_keystore(pin: None)`) uses the platform keystore
 * (single biometric prompt via `retrieve_device_key`).
 *
 * On failure redirects to /login (or calls cb.onLoginFailed if provided).
 */
export async function loginImpl(ctx: SessionContext, cb: ChatSessionCallbacks): Promise<void> {
  const userId = ctx.getUserId();
  const pin = ctx.getPin();
  // Reassigned below once the PIN branch has fetched the server salt and derived the key.
  let deviceKeyB64 = ctx.getDeviceKey();

  // Biometric mode: skip the PIN-fields guard. The keystore handles authentication.
  // Vault-based (nativeStorageLogin) also skips pin-check: deviceKeyB64 is loaded from
  // the encrypted vault, proving the user already authenticated with the correct PIN.
  const isBiometric = deviceKeyB64.length === 0 && pin.length === 0;
  const isVaultLogin = deviceKeyB64.length > 0 && pin.length === 0;

  /**
   * Whether this login can complete with no network at all.
   *
   * Exactly the two paths above, and for exactly the reason they skip the server PIN check when
   * online: the platform keystore (biometrics) or the encrypted device-key vault IS the
   * authentication factor, so no server answer is part of the decision. Unlocking them offline
   * therefore verifies everything it verifies online - nothing is skipped and nothing is deferred.
   *
   * The PIN path is deliberately excluded: its at-rest key derives from a per-user salt that only
   * the server holds (`/api/mls/security/pin-salt`), and caching that salt on the device is what
   * would turn a 4-character PIN into an offline-bruteforceable secret. A PIN user offline still
   * gets the honest "cannot reach the server".
   */
  const offlineCapable = isBiometric || isVaultLogin;
  /** Set when the token could not be obtained: the session runs on local state only. */
  let offlineSession = false;

  if (!userId.trim()) {
    const msg = 'Please fill in all fields.';
    ctx.setLoginError(msg);
    cb.onLoginFailed?.(msg);
    return;
  }

  // Guard against concurrent calls (e.g. onMount + afterNavigate firing together).
  // Returning silently here is intentional: the in-flight login owns the flow and will
  // resolve the caller's UI. An explicit PIN submit must clear this flag before calling
  // (see handlePinSubmit) so a user action is never swallowed by a background login.
  if (ctx.isLoggedIn() || ctx.isReconnecting() || ctx.getIsLoginInProgress()) {
    // Name the flag that won. A swallowed user tap is otherwise indistinguishable in a log from a
    // tap that never reached loginImpl at all: on Android 2026-07-29 the FIRST biometric attempt of
    // a cold launch returned here and only a second tap 3 s later went through, with no way to tell
    // which of the three was still set - which is the whole reason that bug is still open.
    cb.log(
      `[LOGIN] Call ignored, a login already owns the flow (loggedIn=${ctx.isLoggedIn()}, ` +
        `reconnecting=${ctx.isReconnecting()}, loginInProgress=${ctx.getIsLoginInProgress()})`
    );
    return;
  }
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
    if (isBiometric) {
      cb.log('[BIOMETRIC] Skipping PIN verification - using device keystore...');
    } else {
      cb.log('Verifying PIN...');
    }

    // Start MLS state load immediately - pure I/O, doesn't need the token.
    const { loadMlsState } = await import('$lib/utils/hex');
    // loadMlsState already picks the backend for the runtime: `load_mls_state` (mls.bin) under
    // Tauri, IndexedDB on the web. So the source is decided by the runtime, not by which call
    // answered - the log used to report "IndexedDB" on a mobile launch that had just read mls.bin,
    // which is a misleading thing to hand someone reading a log to debug local storage. The
    // Tauri-only retry that used to sit here invoked the very same command loadMlsState had just
    // failed on, and could not answer where that one had not.
    const mlsStatePromise = (async (): Promise<
      { bytes: Uint8Array; source: 'native' | 'indexeddb' } | undefined
    > => {
      const loaded = await loadMlsState(ctx.getUserId());
      if (!loaded) return undefined;
      return { bytes: loaded, source: isTauriRuntime() ? 'native' : 'indexeddb' };
    })();

    let accessToken: string;
    try {
      accessToken = await getToken();
    } catch (err) {
      // A SessionExpiredError means the refresh cookie is dead (HTTP 401/403) - the session
      // cannot be recovered by re-entering the PIN. Surface it as a session loss (logout +
      // redirect to /login); fall back to a direct redirect when no callback is wired so
      // the user is never stranded in the PIN modal with a dead session.
      //
      // This branch stays unconditional, offline unlock or not: a 401 is an ANSWER. The server
      // was reached and refused us, which is precisely the case that must never be papered over
      // as "no network".
      if (err instanceof SessionExpiredError) {
        ctx.setIsLoginInProgress(false);
        if (cb.onSessionExpired) cb.onSessionExpired();
        else void goto('/login', { replaceState: true });
        return;
      }
      // Anything else is a transport failure (no network, backend restarting): the server was
      // never reached, so it has said nothing about this session.
      if (offlineCapable) {
        // Nothing this path needs from the server has been skipped - see `offlineCapable`. Carry
        // on with an empty token: the MLS state, the encrypted message store and the outbox are
        // all local, and `promoteOfflineSession` settles the session when the network returns.
        offlineSession = true;
        accessToken = '';
        connectivity.notifyServerUnreachable();
        cb.log('[LOGIN] Offline unlock (no token) - local session, will promote on reconnect.');
      } else {
        // The PIN path genuinely cannot continue: the salt it needs lives on the server. Keep the
        // PIN modal open with a truthful retryable message - do NOT claim the session expired.
        ctx.setIsLoginInProgress(false);
        const msg = m.auth_server_unreachable();
        ctx.setLoginError(msg);
        // Notify the caller so a PIN-modal spinner does not hang forever.
        cb.onLoginFailed?.(msg);
        return;
      }
    }

    // Collect the MLS state that was loading in the background.
    const mlsStateResult = await mlsStatePromise;
    if (mlsStateResult) {
      cb.log(
        mlsStateResult.source === 'native'
          ? 'MLS state loaded from mls.bin (native).'
          : 'MLS state loaded from IndexedDB.'
      );
    }

    // Biometric mode & vault-based login: skip server-side PIN verification.
    // The keystore (retrieve_device_key → BiometricPrompt) or the encrypted
    // device key vault are the authentication factors.
    if (!isBiometric && !isVaultLogin) {
      cb.log('Initialising MLS...');
      // Resolve the device id and verify the PIN BEFORE init(). init() decrypts the
      // encrypted MLS state, and a WRONG PIN makes that decryption fail - which would
      // trigger a destructive fresh-start (generate a new id + deleteDevice → revocation).
      // By resolving the real deviceId (no state decryption) and verifying the PIN first:
      //  - a wrong PIN is rejected without ever touching the device's identity or state;
      //  - a revoked device is matched on its real deviceId (not the 'pending' placeholder),
      //    so the one-shot reset fires instead of leaving it banned forever.
      // Fetch the per-user random salt from the server
      const saltRes = await fetch(
        `${ctx.getHistoryBaseUrl()}/api/mls/security/pin-salt/${encodeURIComponent(ctx.getUserId())}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!saltRes.ok) {
        throw new Error(m.auth_pin_salt_unreachable());
      }
      const { salt } = (await saltRes.json()) as { salt: string };
      const verifier = await computePinVerifier(ctx.getUserId(), ctx.getPin(), salt);
      const verifierHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      };
      const deviceId = await mlsService.resolveDeviceId(ctx.getUserId());
      const verifierPayload = JSON.stringify({ userId: ctx.getUserId(), verifier, deviceId });
      const pinCheckRes = await fetch(`${ctx.getHistoryBaseUrl()}/api/mls/security/pin-check`, {
        method: 'POST',
        headers: verifierHeaders,
        body: verifierPayload,
      });
      if (!pinCheckRes.ok) {
        throw new Error(m.auth_pin_check_unreachable());
      }
      const pinCheckData = (await pinCheckRes.json()) as {
        status: string;
        resetRequired?: boolean;
      };

      if (pinCheckData.status === 'mismatch') {
        throw new LoginFailure('pin_mismatch', m.auth_pin_mismatch());
      }
      if (pinCheckData.resetRequired === true) {
        ctx.resetMls();
        await resetDeviceAsFreshImpl(ctx, ctx.getUserId(), cb);
        ctx.setPin('');
        throw new LoginFailure('device_revoked', m.auth_device_revoked_reset());
      }
      if (pinCheckData.status === 'registered') cb.log('First device: PIN registered.');

      // PIN accepted: derive this device's at-rest key from it. Done here rather than at the
      // call site because it needs the same server salt the verifier was just computed with,
      // and it must not run before the PIN has been proven correct.
      deviceKeyB64 = await deriveDeviceKeyB64(ctx.getUserId(), pin, salt);
      ctx.setDeviceKey(deviceKeyB64);
    } else if (isVaultLogin) {
      cb.log('Initialising MLS (vault device key path)...');
    } else {
      cb.log('Initialising MLS (biometric keystore path)...');
    }

    // PIN verified server-side (or biometric mode) - now decrypt the local MLS state.
    // When a saved state exists, pass noFreshStart so an undecryptable state (the account
    // PIN was rotated on another device → local state still sealed under the old PIN)
    // surfaces as a recoverable signal instead of a destructive fresh-start that would
    // drop history. In biometric mode, an empty PIN is passed so the Rust side invokes
    // retrieve_device_key (single BiometricPrompt).
    const [mlsInitSettled, storageSettled] = await Promise.allSettled([
      mlsService.init(ctx.getUserId(), deviceKeyB64, mlsStateResult?.bytes, {
        noFreshStart: !!mlsStateResult?.bytes,
        // Only the PIN paths can carry it, and only a snapshot older than the v0.11.0 envelope
        // change needs it: init re-seals such a snapshot instead of reporting a PIN rotation.
        legacyPin: !isBiometric && !isVaultLogin ? pin : undefined,
      }),
      getStorage(ctx.getUserId()),
    ]);
    if (mlsInitSettled.status === 'rejected') {
      const reason = mlsInitSettled.reason;
      const reasonStr = reason instanceof Error ? reason.message : String(reason);
      const isUndecryptable = reasonStr === MLS_LOCAL_STATE_UNDECRYPTABLE;
      if (isUndecryptable) {
        throw new LoginFailure('state_sealed_with_old_key', m.auth_state_sealed_old_pin());
      }
      // Empty keystore on biometric path: no key stored yet (first launch or
      // keystore was wiped). Surface a clean message and let the caller recover.
      if (isBiometric && /no keystore key/i.test(reasonStr)) {
        throw new LoginFailure('keystore_empty', m.auth_keystore_empty_enter_pin());
      }
      throw mlsInitSettled.reason;
    }
    if (storageSettled.status === 'rejected') throw storageSettled.reason;

    // Biometric mode derived no key: init() passed an empty one and the native side resolved the
    // real key from the platform keystore, behind the single prompt this login already raised.
    // Pull it into the session now, BEFORE anything below reads ctx.getDeviceKey().
    //
    // This is not cosmetic. `deviceKeyB64` seals more than mls.bin, which Rust handles on its own:
    // locally stored messages are AES-256-GCM blobs encrypted *in the frontend*, so a session left
    // with an empty key cannot decrypt a single stored row (importDeviceKey rejects a zero-length
    // key) and cannot write a new one either - silently, because every persistence call site
    // swallows its error. That is a whole biometric session of history quietly not being saved.
    //
    // The local `deviceKeyB64` deliberately stays empty: it means "a key the caller supplied", and
    // it is what gates the device-key vault write and store_push_context further down. Biometric
    // mode must keep both skipped - the keystore is the only place this key belongs at rest.
    if (isBiometric) {
      const sessionKey = await mlsService.resolveSessionDeviceKey();
      if (!sessionKey || !isValidDeviceKeyB64(sessionKey)) {
        throw new LoginFailure('keystore_empty', m.auth_keystore_empty_enter_pin());
      }
      ctx.setDeviceKey(sessionKey);
    }

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

    // Offline: there is no token to set, and asking again would throw INSIDE this try - whose
    // catch calls resetMls() + clearUserLocally() + clearDeviceKey(). A network blip would then
    // destroy the very session that just unlocked. The empty token is what every network-touching
    // helper reads as "not authenticated yet"; promoteOfflineSession fills it in.
    ctx.setAuthToken(offlineSession ? '' : await getToken());
    ctx.setIsOfflineSession(offlineSession);

    ctx.setIsLoggedIn(true);
    saveUserLocally({ id: ctx.getUserId(), admin: isGlobalAdmin() });
    ctx.setIsMessagingInitializing(true);
    installCatchupBenchDevTools();
    beginStartupCatchupBench();
    cb.log('[INIT] MLS ready - syncing messages in background.');
    cb.onMlsReady?.();

    // Fire-and-forget: saveDeviceKey is independent of conversation loading.
    // The device key is always saved — on Tauri it feeds push_context.json for
    // background FCM decryption; on web it powers auto-login.
    // Biometric mode derives nothing: the keystore holds the key, so there is nothing to vault.
    if (deviceKeyB64) {
      void (async () => {
        await saveDeviceKey(deviceKeyB64);
      })();
    }

    // Check push health AFTER registration so pending_push_secret.txt is present
    // (written by store_push_secret during startPushService) before the health check runs.
    // Skipped offline - registering a push token requires the server, and the resulting failure
    // would raise a spurious "push degraded" fatal error. promoteOfflineSession re-runs it.
    if (offlineSession) {
      cb.log('[PUSH] Registration deferred - offline session.');
    } else {
      void startPushService(ctx.getHistoryBaseUrl(), ctx.getAuthToken(), ctx.getMyDeviceId())
        .then(async () => {
          cb.log('[PUSH] Push token registration complete.');
          if (!isTauriRuntime()) return;
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            const health = await invoke<{ ok: boolean; reason?: string }>(
              'check_push_secret_health'
            );
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
    }

    // Message outbox: register the flusher before loading conversations so that
    // applyOutboxPendingStatuses can restore the "pending" status on restored messages.
    registerOutbox(makeOutboxDeps(ctx, cb));

    // Watch for connectivity returning. Registered on every session, not only the offline ones:
    // promoteOfflineSession no-ops on a session that already holds a token, and registering here
    // unconditionally keeps one lifecycle (login registers, logout unregisters) instead of a flag
    // deciding whether a listener exists.
    registerOfflinePromotion(ctx, cb, () => makeConnectionDeps(ctx, cb));

    // Adopt anything the native side queued on its own (an undelivered notification quick reply
    // lives only in the mirror file, which the next mirror rewrite would erase). BEFORE the load:
    // the adopted message is written to the store, so the ordinary history load displays it and
    // applyOutboxPendingStatuses below marks it pending.
    await adoptOrphanedMirrorEntries(ctx.getStorage()!, ctx.getDeviceKey(), ctx.getUserId()).catch(
      (e) => cb.log(`[OUTBOX_MIRROR] Adoption pass failed: ${String(e)}`)
    );

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
    const fcmInjected = await consumeFcmCache(ctx.getDeviceKey(), ctx.getStorage()!).catch(
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
      deviceKeyB64: ctx.getDeviceKey(),
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
      deviceKeyB64: ctx.getDeviceKey(),
      historyBaseUrl: ctx.getHistoryBaseUrl(),
      conversations: cb.conversations,
      messageReactions: cb.messageReactions,
      getSelectedContact: cb.getSelectedContact,
      setSelectedContact: cb.setSelectedContact,
      saveConversation: cb.saveConversation,
      deleteConversation: ctx.getStorage()
        ? (id) => ctx.getStorage()!.deleteConversation(id)
        : undefined,
      drainOrphanMessages: cb.drainOrphanMessages,
      addMessageToChat: cb.addMessageToChat,
      batchAddMessages: cb.batchAddMessages,
      loadHistoryForConversation: cb.onLoadHistoryForConversation,
      onChannelMemberJoined: cb.onChannelMemberJoined,
      onChannelMemberKicked: cb.onChannelMemberKicked,
      onChannelUpdated: cb.onChannelUpdated,
      onChannelDeleted: cb.onChannelDeleted,
      onWorkspaceUpdated: cb.onWorkspaceUpdated,
      onWorkspaceDeleted: cb.onWorkspaceDeleted,
      onChannelMessageDeleted: cb.onChannelMessageDeleted,
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
                deviceKeyB64: ctx.getDeviceKey(),
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
            // receipt-driven retries) - but only when the local store cannot already show it.
            await solicitHistoryIfMissing({
              mlsService,
              storage: ctx.getStorage(),
              userId: ctx.getUserId(),
              deviceKeyB64: ctx.getDeviceKey(),
              groupId,
              log: cb.log,
            });
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
            deviceKeyB64: ctx.getDeviceKey(),
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

    // WP-HIST-3: the only place holding the store, the device key and the MLS client at once, so it
    // is where the digest broadcaster is installed. Every solicitation now says what this device
    // HOLDS before asking, which is what lets the answer be a difference instead of a whole store.
    setHistoryDigestBroadcaster(async (groupId: string) => {
      const mls = ctx.ensureMls();
      return sendHistoryDigest(groupId, digestIdentity(ctx.getUserId(), mls.getDeviceId()), {
        storage: ctx.getStorage(),
        deviceKeyB64: ctx.getDeviceKey(),
        mlsService: mls,
        log: cb.log,
      });
    });

    // A solicitation that found nobody reachable is not retried until its own backoff or the next
    // reconnect, although presence tells us within ten seconds that a peer is back. This is that
    // seam: an offline -> online edge re-solicits every group still awaiting history. Groups already
    // soliciting are skipped inside `reSolicitAwaitingHistory`, so a burst of peers costs one round.
    unregisterPeerReturn?.();
    unregisterPeerReturn = onPeersCameOnline(() => {
      // `ensureMls` CREATES the service when there is none, so it must never be reached from a
      // background callback: storage is what says a session is live, the same guard `sendDisconnect`
      // uses. Without it a stray edge after teardown would build an MLS client for nobody.
      if (!ctx.getStorage()) return;
      const mls = ctx.ensureMls();
      cb.log('[HISTORY_REQ] a peer came back online - re-soliciting what is still awaited');
      reSolicitAwaitingHistory(mls, ctx.getUserId(), mls.getLocalGroups(), cb.log);
    });

    // Every other trigger is an event, and a session left open all day is not guaranteed another
    // one: presence is only polled for peers the UI displays, and a reconnect may never come. This
    // is the floor under them - see `AWAITING_SWEEP_INTERVAL_MS`. Same live-session guard as above.
    stopAwaitingSweep?.();
    stopAwaitingSweep = startAwaitingHistorySweep({
      mlsService: {
        sendHistoryRequest: (groupId) => ctx.ensureMls().sendHistoryRequest(groupId),
      },
      userId: ctx.getUserId(),
      getLocalGroups: () => (ctx.getStorage() ? ctx.ensureMls().getLocalGroups() : []),
      log: cb.log,
    });

    mlsService.onHistoryRequest(
      async (requesterUserId: string, requesterDeviceId: string, groupId: string) => {
        cb.log(
          `[SYNC] history_request received from ${requesterUserId}:${requesterDeviceId} for ${groupId}`
        );
        try {
          await handleHistoryRequest({
            mlsService: ctx.ensureMls(),
            storage: ctx.getStorage(),
            deviceKeyB64: ctx.getDeviceKey(),
            conversations: cb.conversations,
            log: cb.log,
            requesterUserId,
            requesterDeviceId,
            selfUserId: ctx.getUserId(),
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

    // Offline: skip the connection entirely rather than let it fail. openGatewayConnection would
    // degrade correctly on its own, but the attempt costs a timeout on a launch that already knows
    // there is no network, and it logs "Gateway inaccessible" for a device that never had one.
    if (offlineSession) {
      cb.log('[INIT] Offline session - gateway connection deferred until the network returns.');
      finishStartupCatchupBench(cb.log);
    } else {
      beginStartupCatchupPhase('initialize_connection');
      await initializeConnection(makeConnectionDeps(ctx, cb));
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
    }

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

    // Everything below talks to the server. On an offline session the watchdogs are the harmful
    // part: the connection watchdog would schedule a reconnect every tick, burn the
    // MAX_RECONNECT_ATTEMPTS budget against a network that is not there, and leave the circuit
    // OPEN - so the moment the user regains signal they would face a "Retry" button instead of a
    // working app. promoteOfflineSession starts all of this once a token exists.
    if (offlineSession) return;

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
    clearDeviceKey();
    // A dead session (refresh cookie expired/revoked) is not retryable via the PIN modal:
    // hand it to onSessionExpired so the caller logs out and redirects to /login. When no
    // callback is wired, redirect directly so the user is never stranded in the modal.
    if (_e instanceof SessionExpiredError) {
      if (cb.onSessionExpired) cb.onSessionExpired();
      else void goto('/login', { replaceState: true });
    } else if (cb.onLoginFailed) {
      cb.onLoginFailed(msg, loginErrorCode(_e));
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
 * On Tauri (no biometrics), restores the device key from the vault and delegates to loginImpl().
 * Returns true if login succeeded, false if manual PIN entry is still needed.
 *
 * Option C: when biometrics are configured, do NOT attempt the automatic login. The flow must
 * go through the PinModal (or the biometric prompt) so the platform keystore stays the
 * authentication factor.
 */
export async function nativeStorageLoginImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  biometricConfigured?: boolean
): Promise<boolean> {
  if (!isTauriRuntime()) return false;

  // Option C: skip the auto-login when biometrics are configured. Biometrics take priority --
  // the flow must go through the BiometricBottomSheet or the PinModal, not the auto-login.
  try {
    let isConfigured: boolean;
    if (biometricConfigured !== undefined) {
      isConfigured = biometricConfigured;
    } else {
      const { BiometricService } = await import('$lib/services/biometric');
      isConfigured = await BiometricService.isConfigured();
    }
    if (isConfigured) {
      appendLog('[PIN] Biometric configured - skipping native storage auto-login');
      return false;
    }
  } catch {
    // Cannot determine the biometric state: fall through to the auto-login attempt.
  }

  // Read deviceKeyB64 from the device key vault (AES-GCM encrypted), never from
  // push_context.json.
  try {
    const { loadDeviceKey } = await import('$lib/utils/deviceKeyVault');
    const deviceKeyB64 = await loadDeviceKey();
    if (!deviceKeyB64) {
      appendLog('[PIN] No device key in vault - auto-login impossible');
      return false;
    }
    // Builds before the derivation existed stored the raw PIN under this key. Such a value can
    // never decrypt anything, so refuse the auto-login and let the PIN modal re-derive a real
    // key rather than failing deeper in the crypto stack with an opaque error.
    if (!isValidDeviceKeyB64(deviceKeyB64)) {
      appendLog('[PIN] Vaulted device key is not a 32-byte key - discarding, PIN required');
      const { clearDeviceKeyAndWrapKey: dropVault } = await import('$lib/utils/deviceKeyVault');
      dropVault();
      return false;
    }
    appendLog('[PIN] Device key restored from PinVault - auto-login…');
    ctx.setDeviceKey(deviceKeyB64);
    await loginImpl(ctx, cb);
    return ctx.isLoggedIn();
  } catch {
    return false;
  }
}

/**
 * Biometric login: delegates to loginImpl() WITHOUT a PIN. The platform keystore
 * (Android KeyStore / iOS Keychain) holds the MLS decryption key directly (see
 * KEYSTORE_PLAN.md). `retrieve_device_key` triggers the single biometric prompt.
 *
 * When the keystore is empty (first launch, app reinstall), the biometric prompt
 * still appears (user-presence check) but loginImpl will surface a clean
 * "keystore empty" error — the caller should then fall back to the PIN modal
 * without showing an error to the user.
 */
export async function biometricLoginImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks
): Promise<void> {
  ctx.setLoginError('');
  cb.log('[BIOMETRIC] Biometric login attempt (keystore key path)...');
  try {
    const savedUser = currentUserId();
    if (!savedUser) {
      ctx.setLoginError('No user registered for biometric authentication.');
      cb.log('[BIOMETRIC] Failed - no local user found.');
      return;
    }
    cb.log(`[BIOMETRIC] Authenticating for userId=${savedUser.slice(0, 8)} via device keystore...`);
    ctx.setUserId(savedUser);
    // Pass an empty PIN AND an empty device key — loginImpl selects its mode from that pair,
    // and only (deviceKey === '' && pin === '') means biometric. Clearing the device key is
    // required, not cosmetic: after a failed PIN attempt the session still holds the derived
    // key, which would put loginImpl in vault mode and silently retry that same key instead
    // of reading the keystore. loginImpl then calls load_encrypted_with_keystore(key: None),
    // which triggers retrieve_device_key → single BiometricPrompt.
    ctx.setPin('');
    ctx.setDeviceKey('');

    // P2-B: never swallow the authentication error. If the user cancels the BiometricPrompt
    // the error must reach startLoginFlow, which then shows the PinModal (P2-A). Rust
    // distinguishes "empty keystore" from "authentication cancelled" via distinct messages.
    await loginImpl(ctx, cb);
  } catch (e) {
    ctx.setLoginError('Biometric authentication failed. Please enter your PIN manually.');
    cb.log(`[BIOMETRIC] Exception: ${e instanceof Error ? e.message : String(e)}`);
    console.error(e);
  }
}

/**
 * Fetches this user's PIN salt from the server. The salt is the shared input to BOTH the
 * account verifier ({@link computePinVerifier}) and this device's at-rest key
 * ({@link deriveDeviceKeyB64}), so every flow that touches the PIN needs it.
 */
async function fetchPinSalt(ctx: SessionContext, userId: string, token: string): Promise<string> {
  const res = await fetch(
    `${ctx.getHistoryBaseUrl()}/api/mls/security/pin-salt/${encodeURIComponent(userId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(m.auth_pin_salt_unreachable());
  const { salt } = (await res.json()) as { salt: string };
  return salt;
}

/**
 * Changes the account PIN for a logged-in user.
 *
 * Two halves that must both happen, in this order:
 *  1. Rotate the account-wide verifier server-side (`POST mls/security/pin-change`), which
 *     also proves the user knows the current PIN. Done FIRST: if the local re-encryption
 *     then fails, the account already expects the new PIN and the user can finish with
 *     {@link recoverPinImpl} (old PIN -> new PIN). The reverse order would leave the
 *     account on the old PIN with local state sealed under the new key -- unrecoverable.
 *  2. Re-derive this device's key from the new PIN and re-encrypt the MLS state plus every
 *     locally stored message under it ({@link performPinChange}).
 *
 * The other devices keep their old key locally and will hit a verifier mismatch at their
 * next login; {@link recoverPinImpl} is what gets them across. That is inherent: the device
 * key never leaves the device.
 *
 * @throws A user-facing (localized) message when the current PIN is wrong or the server is
 *         unreachable.
 */
export async function changePinImpl(
  ctx: SessionContext,
  log: (msg: string) => void,
  currentPin: string,
  newPin: string,
  onProgress?: PinProgressCallback
): Promise<void> {
  const userId = ctx.getUserId();
  if (!userId.trim()) throw new Error(m.auth_no_user_signed_in());
  log('[PIN_CHANGE] Starting PIN change...');
  onProgress?.({ percent: 2, stage: 'verify' });

  const token = await getToken();
  const salt = await fetchPinSalt(ctx, userId, token);
  const [oldVerifier, newVerifier] = await Promise.all([
    computePinVerifier(userId, currentPin, salt),
    computePinVerifier(userId, newPin, salt),
  ]);

  onProgress?.({ percent: 6, stage: 'server' });
  const res = await fetch(`${ctx.getHistoryBaseUrl()}/api/mls/security/pin-change`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ userId, oldVerifier, newVerifier }),
  });
  if (res.status === 403) throw new Error(m.auth_pin_change_current_incorrect());
  if (!res.ok) throw new Error(m.auth_pin_change_server_error());
  log('[PIN_CHANGE] Account verifier rotated server-side.');

  // Derive both device keys from the same salt: the old one to read the existing state,
  // the new one to re-seal it.
  const [currentDeviceKeyB64, newDeviceKeyB64] = await Promise.all([
    deriveDeviceKeyB64(userId, currentPin, salt),
    deriveDeviceKeyB64(userId, newPin, salt),
  ]);

  await performPinChange(
    {
      userId,
      mlsService: ctx.ensureMls(),
      setDeviceKey: (k: string) => ctx.setDeviceKey(k),
      log,
      onProgress,
    },
    currentDeviceKeyB64,
    newDeviceKeyB64
  );
  log('[PIN_CHANGE] Complete - local state re-encrypted under the new PIN.');
}

/**
 * "PIN changed on another device" recovery. The account PIN was rotated elsewhere, so
 * this device's local MLS state is still sealed under the OLD pin while the server now
 * expects the NEW one. Decrypts the local state with the OLD device key (non-destructively),
 * re-encrypts it under the NEW one, then logs in normally - preserving every local message
 * instead of falling back to a fresh-start.
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
  if (!userId.trim()) throw new Error(m.auth_no_user_signed_in());
  cb.log('[PIN_RECOVER] Starting recovery...');
  onProgress?.({ percent: 3, stage: 'verify' });

  const { loadMlsState } = await import('$lib/utils/hex');
  const state = await loadMlsState(userId);
  if (!state) {
    throw new Error(m.auth_no_local_state_recover());
  }

  // The new PIN must be the real (rotated) account PIN: verify its verifier server-side.
  const token = await getToken();
  const salt = await fetchPinSalt(ctx, userId, token);
  const newVerifier = await computePinVerifier(userId, newPin, salt);
  const res = await fetch(`${ctx.getHistoryBaseUrl()}/api/mls/security/pin-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ userId, verifier: newVerifier }),
  });
  if (!res.ok) throw new Error(m.auth_pin_verify_new_unreachable());
  const data = (await res.json()) as { status: string };
  if (data.status !== 'ok') {
    throw new Error(m.auth_pin_new_incorrect());
  }

  // Both device keys come from the same salt: the old one still seals the local state,
  // the new one is what every device will derive from now on.
  const [oldDeviceKeyB64, newDeviceKeyB64] = await Promise.all([
    deriveDeviceKeyB64(userId, oldPin, salt),
    deriveDeviceKeyB64(userId, newPin, salt),
  ]);

  onProgress?.({ percent: 15, stage: 'mls' });
  // Non-destructively decrypt local state with the old key, then re-encrypt under the new.
  const mls = ctx.ensureMls();
  const ok = await mls.recoverAndRekey(userId, oldDeviceKeyB64, newDeviceKeyB64, state);
  if (!ok) {
    throw new Error(m.auth_pin_old_incorrect());
  }
  cb.log('[PIN_RECOVER] MLS state re-encrypted with the new device key.');

  const storage = await getStorage(userId);
  await reencryptLocalMessages(storage, oldDeviceKeyB64, newDeviceKeyB64, cb.log, onProgress, {
    start: 20,
    end: 82,
  });
  cb.log('[PIN_RECOVER] Local messages re-encrypted with the new device key.');

  onProgress?.({ percent: 88, stage: 'finalize' });
  await applyNewDeviceKeyLocally(newDeviceKeyB64, cb.log);
  ctx.setPin(newPin);
  ctx.setDeviceKey(newDeviceKeyB64);

  onProgress?.({ percent: 92, stage: 'login' });
  // Continue with a normal login. init() is a no-op (recoverAndRekey already marked the
  // client initialised), so the decrypted client is reused and all messages are kept.
  await loginImpl(ctx, cb);
  if (!ctx.isLoggedIn()) {
    throw new Error(m.auth_login_failed_after_recovery());
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
  // Detach the reconnect listener too, or a regained network would promote a session that no
  // longer exists - reopening a WebSocket for the user who just signed out.
  unregisterOfflinePromotion();
  cancelAllHistorySolicit();
  // The broadcaster closes over this session's storage and device key, so it must not outlive it:
  // a solicitation from the next login would otherwise describe the previous user's store.
  setHistoryDigestBroadcaster(null);
  // Same reason, and the presence poll outlives a logout: an edge arriving afterwards would solicit
  // history for the user who just signed out.
  unregisterPeerReturn?.();
  unregisterPeerReturn = null;
  stopAwaitingSweep?.();
  stopAwaitingSweep = null;
  historyRequestPendingStore.cancelAll();
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
  setCallSystemMessageContext(null);
  ctx.getCallService()?.setChatNotifier(null);
  resetSiblingCallWarning();
  clearUserLocally();
  clearDeviceKeyAndWrapKey();
  clearAuth();
  cb.log('[LOGOUT] Local state cleared - redirecting to /login.');
  void goto('/login', { replaceState: true });
}
