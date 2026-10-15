/**
 * Authentication functions extracted from useChatSession:
 * login, logout, nativeStorageLogin, biometricLogin, resetDeviceAsFresh.
 *
 * Each function receives `ctx: SessionContext` instead of the closure,
 * and `cb: ChatSessionCallbacks` to interact with conversations / UI.
 */
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { internalPath, loginReturningTo } from '$lib/utils/internalPath';
import { SvelteSet } from 'svelte/reactivity';
import { getStorage, type IStorage } from '$lib/db';
import { resetSalonUnread } from '$lib/utils/chat/salonUnread';
import { computePinVerifier } from '$lib/utils/chat/auth';
import {
  DeviceKeyMismatchError,
  KeyChangeInterruptedError,
  LocalStateUnopenableError,
  performPinChange,
  type PinProgressCallback,
} from '$lib/utils/chat/pinChange';
import { endIntoKeyRecovery } from '$lib/db/deviceKeyGate';
import { deriveDeviceKeyB64, isValidDeviceKeyB64 } from '$lib/crypto/deviceKey';
import { fetchOrUnreachable } from '$lib/utils/fetchOrUnreachable';
// Every `throw` below whose message is a Paraglide line is a `LocalizedError`: the modals rendering
// these PIN flows must be able to tell "the PIN you typed is not the current one" from a browser's
// `Failed to fetch`, and only the THROW knows which it is.
import { LocalizedError, localizedMessage } from '$lib/utils/localizedError';
import {
  LoginFailure,
  isExpectedLoginOutcome,
  isVaultRefusal,
  loginErrorCode,
} from './loginErrors';
import {
  MLS_LOCAL_STATE_UNDECRYPTABLE,
  isKeystoreKeyUnavailable,
  VaultOwnerUnprovenError,
  type VaultRefusal,
} from '$lib/mls-client';
import {
  getToken,
  clearAuth,
  SessionExpiredError,
  isRefreshCredentialProvenDead,
} from '$lib/stores/auth';
import { IdentitySplitError, isIdentitySplit } from '$lib/stores/tokenIdentity.svelte';
import { bindCurrentSessionDevice } from '$lib/services/authSessions';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { noteUnlockUnattended } from '$lib/stores/unlockPath.svelte';
import { notificationPreferences } from '$lib/stores/notificationPreferences.svelte';
import { resetAnnouncementState } from '$lib/stores/announcement.svelte';
import { registerOfflinePromotion, unregisterOfflinePromotion } from './promoteOfflineSession';
import {
  flushPendingGroupExits,
  registerPendingGroupExitDrain,
  unregisterPendingGroupExitDrain,
} from '$lib/utils/chat/pendingGroupExits';
import { m } from '$lib/paraglide/messages';
import { saveUserLocally, clearUserLocally, currentUserId, isGlobalAdmin } from '$lib/stores/user';
import {
  forgetProvenDeadEnds,
  recoverRosterDisagreement,
  requestReAdd,
} from '$lib/utils/chat/recovery';
import {
  answerAfterMailboxDrained,
  reconcileGroup,
  resetHistoryReconciliation,
  retryDeferredReconciliations,
  setHistoryProbeSender,
} from '$lib/utils/chat/historyReconcile';
import { resetWelcomeSent } from '$lib/utils/chat/welcomeSent';
import { onPeersCameOnline } from '$lib/stores/presenceStore';
import { sendHistoryProbe } from '$lib/utils/chat/groupActions';
import { digestIdentity } from '$lib/utils/chat/historyDigestRendezvous';
import { canSendInGroup } from '$lib/utils/chat/groupUsability';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import { measureRestoreShortfall } from '$lib/utils/chat/restoreShortfall';
import { graineRepairHoldObserver, setGraineRuntime } from '$lib/utils/graine/runtime';
import { handleDistributionFrame } from '$lib/utils/graine/frameHandler';
import { distributionGapListener } from '$lib/utils/graine/distributionGroup';
import { sweepExpiredGraineSeeds } from '$lib/utils/graine/retention';
import {
  unregisterMlsStatePersister,
  activeMlsStatePersister,
  flushActiveMlsStateEncrypted,
} from '$lib/mls-client/mlsStatePersisterRegistry';
import { uninstallMlsStatePersisterLifecycle } from '$lib/mls-client/mlsStatePersisterLifecycle';
import { disposeMlsEncryptWorker } from '$lib/mls-client/mlsEncryptWorkerSession';
import {
  setupMessageHandler,
  openGatewayConnection,
  startGatewayHandshake,
  syncConnectionAfterWsOpen,
  initTabLeadershipAsync,
  getIsTabLeader,
} from '$lib/utils/chat/connection';
import type { AbsentGroupVerdicts } from '$lib/utils/chat/groupSweep';
import {
  beginStartupCatchupBench,
  beginStartupCatchupPhase,
  endStartupCatchupPhase,
  finishStartupCatchupBench,
  cancelStartupCatchupBench,
  summarizeConversationStats,
  installCatchupBenchDevTools,
} from '$lib/mls-client/catchupBenchmark';
import {
  markBoot,
  beginBootSpan,
  endBootSpan,
  timeBootSpan,
  finishBootBench,
} from '$lib/mls-client/bootBenchmark';
import {
  saveDeviceKey,
  loadDeviceKey,
  clearDeviceKey,
  clearDeviceKeyAndWrapKey,
  forgetUnlabelledDeviceKey,
  retireUnlabelledDeviceKeyIfOwnedBy,
} from '$lib/utils/deviceKeyVault';
import { askPinSaltAhead, forgetPinSaltAhead, takePinSaltAhead } from './pinSaltAhead';
import { unlockWithPin, type PinCheckAnswer } from './pinUnlock';
import { wipeDeviceToFactory } from '$lib/utils/deviceReset';
import { startPushService, stopPushService } from '$lib/services/PushNotificationService';
import { consumeFcmCache } from '$lib/utils/chat/fcmCache';
import type { PushPlaceholder } from '$lib/utils/chat/fcmCache';
import { consumeNativeReadWatermarks } from '$lib/utils/chat/readWatermarkCache';
import { adoptOrphanedMirrorEntries, reconcileOutboxSent } from '$lib/utils/chat/outboxMirror';
import { mergeFcmMessagesIntoConversations } from '$lib/utils/chat/fcmMemoryMerge';
import { appendLog } from '$lib/utils/sessionLog';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { isLikelyPrivateBrowsing } from '$lib/utils/isLikelyPrivateBrowsing';
import { handleHistoryRequest, processPendingInvitations } from '$lib/utils/chat/actions';
import {
  drainDeferredWelcomeRequests,
  serveWelcomeRequest,
  type WelcomeRequestContext,
} from '$lib/utils/chat/welcomeRequestQueue';
import {
  buildConversationRow,
  deriveConversationIdentity,
  markConversationDeletedRemotely,
} from '$lib/utils/chat/conversations';
import { answerBaseRefreshRequest } from '$lib/utils/chat/staleBase';
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
import { ChannelService } from '$lib/services/ChannelService';
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
/**
 * Numbers each `loginImpl` run, so the local preview it draws (F1) carries its owner: a login that
 * ends without a session removes ITS preview, never the one a later, overlapping login drew.
 */
let loginSeq = 0;

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
    deviceKey: () => ctx.getDeviceKey(),
    conversations: cb.conversations,
    getSelectedContact: cb.getSelectedContact,
    setSelectedContact: cb.setSelectedContact,
    saveConversation: cb.saveConversation,
    deleteConversation: st ? (id: string) => st.deleteConversation(id) : undefined,
    log: cb.log,
  };
}

/**
 * Builds the dependency bag for the connection sequence: the WebSocket open
 * (`openGatewayConnection`) and the post-connect group reconciliation (`syncConnectionAfterWsOpen`),
 * which login takes in two pieces with the conversation restore between them, and
 * `promoteOfflineSession` takes in one (`initializeConnection`) because by then the conversations
 * are already loaded. ONE bag for all three - a second, hand-copied version would drift the moment
 * any of them gained a callback.
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
    onGroupMissing: (groupId: string) => requestReAdd(groupId, makeRecoveryDeps(ctx, cb)),
    onStrandedSeat: (groupId: string) =>
      recoverRosterDisagreement(groupId, makeRecoveryDeps(ctx, cb)),
    onGroupDeletedRemotely: (groupId: string) =>
      markConversationDeletedRemotely(
        cb.conversations,
        groupId,
        ctx.getUserId(),
        cb.saveConversation
      ),
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
    deviceKey: () => ctx.getDeviceKey(),
    conversations: cb.conversations,
    log: cb.log,
    requestReAdd: (groupId: string) => requestReAdd(groupId, makeRecoveryDeps(ctx, cb)),
    recoverRosterDisagreement: (groupId: string) =>
      recoverRosterDisagreement(groupId, makeRecoveryDeps(ctx, cb)),
    isGroupHealthy: (groupId: string) => canSendInGroup(ctx.ensureMls(), groupId),
    // A session unlocked offline holds no token: hold the queue until promoteOfflineSession has
    // one and has reopened the socket, then it flushes explicitly.
    canFlush: () => !ctx.isOfflineSession() && !isIdentitySplit(),
    markDeletedRemotely: (groupId: string) =>
      markConversationDeletedRemotely(
        cb.conversations,
        groupId,
        ctx.getUserId(),
        cb.saveConversation
      ),
    // The two halves `recordEviction` owes: the notice in the thread, and the durable row behind
    // the banner. Neither reached the outbox before, so a queue killed by an eviction left a red
    // bubble, no explanation, and a conversation that read as live again after a reload.
    addMessageToChat: cb.addMessageToChat,
    saveConversation: cb.saveConversation,
    uploadMedia: async (
      media: NonNullable<import('$lib/db').OutboxEntry['media']>,
      transport?: import('$lib/utils/uploadXhr').XhrUploadOptions
    ) => {
      const { MediaService } = await import('$lib/media');
      const token = await getToken();
      const bytes = media.fileBytes ?? new Uint8Array(0);
      const file = new File([bytes.buffer as ArrayBuffer], media.fileName ?? 'file', {
        type: media.mimeType,
      });
      return new MediaService().encryptAndUpload(
        file,
        token,
        { width: media.width, height: media.height },
        'ephemeral',
        transport
      );
    },
  };
}

/**
 * Everything serving a `welcome_request` needs - the SAME object at both entrances.
 *
 * A device that lost its MLS state asks to be re-added, and this session answers from the socket
 * and again when a group it was waiting on becomes ready. The two moments differ in WHERE the ask
 * came from and in nothing else, so they are one call with one deferral policy; what that policy is,
 * and why a drain must be able to re-defer, is on {@link serveWelcomeRequest}.
 */
export function makeWelcomeRequestContext(
  ctx: SessionContext,
  cb: ChatSessionCallbacks
): WelcomeRequestContext {
  return {
    mlsService: ctx.ensureMls(),
    storage: ctx.getStorage(),
    userId: ctx.getUserId(),
    deviceKeyB64: ctx.getDeviceKey(),
    conversations: cb.conversations,
    log: cb.log,
    deferred: ctx.deferredWelcomeRequests,
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
      requestReAdd: (groupId: string) => requestReAdd(groupId, makeRecoveryDeps(ctx, cb)),
      log: cb.log,
    });
  } finally {
    ctx.setIsSyncing(false);
  }
}

/**
 * The login failure for a vault key of unproven owner that was refused (`vaultOwnerUnproven`).
 *
 * TWO CODES, BECAUSE ONLY ONE OF THE REFUSALS KNOWS WHOSE STATE IS ON THE DEVICE. On a phone a
 * `mismatch` is PROVEN to be another account's state - `mls.bin` is one file per install and the key
 * opened it - so it is `device_holds_other_account`: the member is told so, and the gate withholds
 * the reset that would delete that file. `no_state` and `unopenable` prove nothing of the kind - the
 * store may be this account's own, evicted or sealed under an older key - and the web keeps one
 * state per account, so everywhere else it is `vault_not_this_account` with a NEUTRAL sentence that
 * accuses nobody.
 */
function vaultRefusedFailure(refusal: VaultRefusal): LoginFailure {
  if (refusal === 'mismatch' && isTauriRuntime()) {
    return new LoginFailure('device_holds_other_account', m.auth_vault_other_account_device());
  }
  return new LoginFailure('vault_not_this_account', m.auth_vault_unverified());
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
  // A SIGNED-OUT SESSION'S FINAL CHECKPOINT LANDS BEFORE THE DELETE, not after it: the "forgot PIN"
  // reset runs from the PIN gate of the next sign-in, and a write still in flight from the sign-out
  // (48 s measured on a Mi 9T) would put back the state under the OLD key that this deletes - so the
  // new PIN would meet an unopenable state. Settles at once when nothing is retiring.
  await ctx.whenMlsRetired();
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
    await storageToClear.close();
  } catch (e) {
    // Best-effort cleanup: continue even if local DB is not accessible - but never silently, since
    // a connection left open is what makes a later delete block instead of complete.
    console.warn('[SECURITY] could not clear the local database:', e);
  }

  // The session's OWN handle. `getStorage` shares one open store per user, so when the wipe targets
  // the signed-in user this IS the handle closed just above and `close()` is idempotent - the call
  // stays because the two are not the same fact: a wipe can target another user's store, and
  // dropping a reference never closes a connection, which is what defers a later delete.
  try {
    await ctx.getStorage()?.close();
  } catch (e) {
    console.warn('[SECURITY] could not close the session database:', e);
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
 * Returns a revoked device to a fresh install, whatever discovered the revocation.
 *
 * ONE CONSEQUENCE FOR ONE FACT. Three places learn that this device is revoked - the PIN check at
 * login, a `device_revoked` frame on a live session, and a vault or biometric login asking the
 * server - and the wipe must not differ between them. It did: the frame path skipped the MLS
 * teardown that the login path performs first, and it is the frame path that runs while the
 * service is live and could still write a key back.
 *
 * The steps are ordered on purpose: STOP the session first, revoke the refresh credential while the
 * network context still exists, and only then delete everything local - so nothing left running can
 * write a key back after the wipe. The PIN is cleared last because the wipe is what makes it
 * meaningless.
 *
 * "Tear the session down first" used to mean `resetMls()` alone, which nulls the client and stops
 * nothing: measured on prod 2026-08-28, the SYNC_WATCHDOG ticked 1.25 s later, rebuilt the MLS
 * database through `ensureMls()` and re-marked all ten groups not-ready - 8.2 MB of a device that
 * had just been returned to a fresh install. `tearDownLiveSession` is that step done properly, and
 * it runs BEFORE the first delete rather than alongside it.
 */
export async function wipeRevokedDevice(ctx: SessionContext, cb: ChatSessionCallbacks) {
  // BEFORE THE FIRST STEP, BECAUSE THE FIRST STEP IS WHAT OPENS THE DOOR. `tearDownLiveSession`
  // sets `isLoggedIn` false, and that is one of the three flags `loginImpl` reads to decide nobody
  // owns the flow - so the wipe was itself the event that let a login start and undo it. Measured on
  // prod 2026-08-29: a login began 3 ms after the `device_revoked` frame, its own revocation check
  // could not be answered (the wipe had already killed the session) so it read "not revoked", and it
  // reopened `CanariDB_<userId>` 24 ms before the delete - which does not fail on an open connection,
  // it BLOCKS. The store SURVIVED on a device its owner had declared lost.
  //
  // A latch and not a device id: between clearing `mls_device_id_<userId>` and deleting the stores
  // there is a window in which no identity exists to recognise, and a login slipping into it reopens
  // the database just the same. What must be excluded is the WIPE'S WHOLE DURATION, which is exactly
  // what this spans - and being released in `finally`, it can never leave a real user locked out.
  ctx.setWipingRevokedDevice(true);
  try {
    void tearDownLiveSession(ctx, cb, 'revoked');
    ctx.resetMls();
    await resetDeviceAsFreshImpl(ctx, ctx.getUserId(), cb);
    await clearAuth();
    await wipeDeviceToFactory();
    ctx.setPin('');
  } finally {
    ctx.setWipingRevokedDevice(false);
  }
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
 *
 * `opts.unattendedKeyRead` only matters in biometric mode: the keystore is read with no sheet,
 * because the biometric cadence said the last proof is recent enough ({@link biometricLoginImpl}).
 *
 * `opts.vaultOwnerUnproven` only matters on the vault path: the key came from the unlabelled vault
 * of an older build, and is accepted only if it opens a saved state of THIS account
 * (`MlsInitOptions.vaultOwnerUnproven`). Refused, the login fails with `vault_not_this_account`
 * having changed nothing; accepted, the key moves into this account's own slot.
 */
export async function loginImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  opts?: { unattendedKeyRead?: boolean; vaultOwnerUnproven?: boolean }
): Promise<void> {
  // EVERY OFFSET IN THIS REPORT IS MEASURED FROM NAVIGATION START, not from here, so the document,
  // the module graph and hydration are all visible as the gap before `login-start` without anything
  // needing to instrument them. That gap is the other half of the cold start, and a bench anchored
  // at this line would have hidden it exactly as the catch-up bench hid the 43% that precedes it.
  // The dev-tools install moved to `hooks.client.ts` on 2026-09-20: the report has to be reachable
  // from a boot that never gets this far, and that seam is where `app-first-line` is marked.
  markBoot('login-start');
  const userId = ctx.getUserId();
  const pin = ctx.getPin();
  // Reassigned below once the PIN branch has fetched the server salt and derived the key.
  let deviceKeyB64 = ctx.getDeviceKey();

  // Biometric mode: skip the PIN-fields guard. The keystore handles authentication.
  // Vault-based (nativeStorageLogin) also skips pin-check: deviceKeyB64 is loaded from
  // the encrypted vault, proving the user already authenticated with the correct PIN.
  const isBiometric = deviceKeyB64.length === 0 && pin.length === 0;
  const isVaultLogin = deviceKeyB64.length > 0 && pin.length === 0;
  /** A vault key that does not yet name its account - see `opts.vaultOwnerUnproven`. */
  const vaultOwnerUnproven = isVaultLogin && opts?.vaultOwnerUnproven === true;

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
    const msg = m.auth_login_fill_all();
    ctx.setLoginError(msg);
    cb.onLoginFailed?.(msg);
    return;
  }

  // Guard against a login starting while something else owns the flow: a concurrent call (onMount +
  // afterNavigate firing together), or the revocation wipe, whose teardown clears `isLoggedIn` and
  // would otherwise read as "nobody owns it" to the very login that then reopens what it deletes.
  // Returning silently here is intentional: the in-flight login owns the flow and will
  // resolve the caller's UI. An explicit PIN submit must clear this flag before calling
  // (see handlePinSubmit) so a user action is never swallowed by a background login.
  if (
    ctx.isLoggedIn() ||
    ctx.isReconnecting() ||
    ctx.getIsLoginInProgress() ||
    ctx.isWipingRevokedDevice()
  ) {
    // Name the flag that won. A swallowed user tap is otherwise indistinguishable in a log from a
    // tap that never reached loginImpl at all: on Android 2026-07-29 the FIRST biometric attempt of
    // a cold launch returned here and only a second tap 3 s later went through, with no way to tell
    // which of the three was still set - which is the whole reason that bug is still open.
    cb.log(
      `[LOGIN] Call ignored, a login already owns the flow (loggedIn=${ctx.isLoggedIn()}, ` +
        `reconnecting=${ctx.isReconnecting()}, loginInProgress=${ctx.getIsLoginInProgress()}, ` +
        `wipingRevokedDevice=${ctx.isWipingRevokedDevice()})`
    );
    return;
  }
  ctx.setIsLoginInProgress(true);

  // THE PREVIOUS ACCOUNT'S FINAL CHECKPOINT LANDS FIRST. A sign-out retires its MLS client once that
  // write is on disk (`endSessionImpl`), and this login reads the disk: opening the state while the
  // write is in flight would start from a state one write behind. Settles at once when nothing is
  // retiring, and never rejects.
  if (ctx.isMlsRetiring()) {
    cb.log('[LOGIN] Waiting for the signed-out session to finish its final MLS checkpoint.');
  }
  await ctx.whenMlsRetired();

  ctx.setLoginError('');
  ctx.setUserId(userId.trim().toLowerCase());

  // Clear any stale reconnect timer from a previous session
  if (ctx.timers.reconnect !== null) {
    clearTimeout(ctx.timers.reconnect);
    ctx.timers.reconnect = null;
  }
  ctx.setReconnectAttempts(0);

  ctx.setTabLeaderSessionCb(cb);

  // ── THE NOTIFICATION LANDING'S LOCAL PREVIEW (F1, decided by the user 2026-10-12) ──
  //
  // The landing's target is drawn from the local store the moment this login holds the device key
  // AND the open store - on the vault path that is HERE, before the token refresh and the
  // revocation answer, which is the one thing the user decided to allow: a conversation the device
  // already holds is SHOWN before the server has confirmed the device, and if the server then says
  // it is revoked (or the login fails for any other reason) everything drawn is removed and the
  // ordinary consequence follows. It reads and never acts - no request, no write, no MLS
  // (`landingPreview.ts`). The PIN path cannot start it before the PIN is proven: its device key is
  // derived from the server's salt AFTER `pin-check`, so nothing is decryptable before then, which
  // is what keeps the PIN gate's promise by construction rather than by a flag.
  //
  // A WITHDRAWAL NEVER WAITS ON THE STORE, AND IT ONLY TOUCHES THIS LOGIN'S PREVIEW. Every exit
  // that ends this login without a session withdraws SYNCHRONOUSLY: what is drawn is removed now,
  // and a read still in flight finds `isCurrent()` false and draws nothing - so an exit whose store
  // open hangs is never held behind it, and the login flag is released only after the cleanup. The
  // discard names `loginId`, so a later login that overlaps this one keeps what it drew. The
  // restore still awaits the read before rebuilding the map, so it cannot land after the rebuild.
  const loginId = ++loginSeq;
  let landingPreview: Promise<void> | null = null;
  let previewWithdrawn = false;
  let storageOpen: Promise<IStorage> | null = null;
  const startLandingPreview = (storage: Promise<IStorage>, previewKey: string): void => {
    const preview = cb.previewLandingTarget;
    if (!preview) return;
    const askedAt = performance.now();
    landingPreview = storage
      .then((s) =>
        preview({
          storage: s,
          deviceKeyB64: previewKey,
          userId: ctx.getUserId(),
          storeOpenMs: Math.round(performance.now() - askedAt),
          owner: loginId,
          isCurrent: () => !previewWithdrawn,
        })
      )
      .then(() => markBoot('landing-preview-read'))
      .catch((e: unknown) => cb.log(`[LANDING_PREVIEW] local read failed: ${String(e)}`));
  };
  const withdrawLandingPreview = (reason: string): void => {
    if (!landingPreview || previewWithdrawn) return;
    previewWithdrawn = true;
    cb.discardLandingPreview?.(reason, loginId);
  };

  try {
    const mlsService = ctx.ensureMls();
    if (isVaultLogin && !vaultOwnerUnproven) {
      // The vault returned the device key before this function was called, so the store can be
      // opened and read now - nothing about either needs the token. `getStorage` shares one handle
      // per user, and the init below awaits this same promise instead of opening a second one.
      // NOT for a key whose owner is unproven: nothing may be drawn from this account's store with
      // a key that may be another account's.
      storageOpen = getStorage(ctx.getUserId());
      startLandingPreview(storageOpen, deviceKeyB64);
    }
    if (isBiometric) {
      cb.log('[BIOMETRIC] Skipping PIN verification - using device keystore...');
    } else {
      cb.log('Verifying PIN...');
    }

    // Start the MLS state lookup immediately - pure I/O, doesn't need the token.
    //
    // UNDER TAURI THIS ASKS FOR THE SIZE AND NOT THE BYTES, and that is the whole of a defect
    // measured on a Pixel 6a on 2026-09-15. `mls.bin` is 7,8 MB on a real account; it was read by
    // Rust, serialised to the WebView as a JSON array of per-byte numbers (29 074 883 characters),
    // turned back into an array by `invokeInit` and serialised AGAIN on the way back to Rust, which
    // is where it had started. 908 ms of main thread warm - and on a cold launch a single 2 731 ms
    // block, during which the `invoke` that raises the fingerprint prompt sat in the queue behind
    // it. The prompt appeared 51 ms after the block ended. The native side reads the file itself
    // now (`stateOnDisk` below); the frontend only has to know THAT there is a state, which is one
    // `metadata()` syscall and a number.
    //
    // The web has no such bridge - the bytes come from IndexedDB and go to WASM in the same
    // process - so it still loads them, and the source is decided by the runtime rather than by
    // which call answered. The log used to report "IndexedDB" on a mobile launch that had just read
    // mls.bin, which is a misleading thing to hand someone debugging local storage.
    const { loadMlsState, mlsStateSize } = await import('$lib/utils/hex');
    const mlsStatePromise = (async (): Promise<
      { bytes?: Uint8Array; source: 'native' | 'indexeddb' } | undefined
    > => {
      if (isTauriRuntime()) {
        const size = await mlsStateSize();
        return size > 0 ? { source: 'native' } : undefined;
      }
      const loaded = await loadMlsState(ctx.getUserId());
      if (!loaded) return undefined;
      return { bytes: loaded, source: 'indexeddb' };
    })();

    let accessToken: string;
    try {
      beginBootSpan('access-token');
      accessToken = await getToken();
      endBootSpan('access-token');
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
        // The redirect first, the preview after it (synchronous), the flag last: nothing here may
        // wait on the store, and a second login must not start while this one's preview is up.
        if (cb.onSessionExpired) cb.onSessionExpired();
        else void goto(resolve('/login'), { replaceState: true });
        withdrawLandingPreview('session expired');
        ctx.setIsLoginInProgress(false);
        return;
      }
      // THE TOKEN IS FOR SOMEBODY ELSE THAN THIS DEVICE'S MLS IDENTITY. Not a transport failure
      // (the server answered) and not an expiry (the credential is alive): continuing would run
      // every send and seed request under the wrong account, and an offline unlock would do the
      // same once the network returned. The blocking notice offers the sign-out; the PIN modal has
      // nothing to add, and the MLS state is left untouched.
      if (err instanceof IdentitySplitError) {
        cb.log(
          `[LOGIN] IDENTITY SPLIT (token ${err.split.tokenSub} vs local ${err.split.localId}) - login stopped, sign-out required.`
        );
        cb.onLoginFailed?.(m.identity_split_title());
        withdrawLandingPreview('identity split');
        ctx.setIsLoginInProgress(false);
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
          ? // NOT "loaded", AND THE WORD MATTERS TO WHOEVER READS THIS LINE NEXT: on Tauri the
            // frontend only learns that mls.bin is there, and the native side opens it.
            'MLS state present on disk (mls.bin); the native side reads it.'
          : 'MLS state loaded from IndexedDB.'
      );
    }

    // A VAULT KEY OF UNPROVEN OWNER NEEDS A SAVED STATE TO PROVE ITSELF ON, and with none there is
    // nothing to prove it with - a fresh start would seal this account's first state under a key
    // that may be another account's. Refused HERE, before `resolveDeviceId` mints an id for an
    // attempt that is not going to run.
    if (vaultOwnerUnproven && !mlsStateResult) {
      cb.log(
        '[VAULT] unlabelled vault key refused - no saved state of this account to prove it on'
      );
      throw vaultRefusedFailure('no_state');
    }

    // THE REVOCATION QUESTION IS ASKED HERE AND READ AFTER THE DECRYPT, and this variable is the
    // whole of that: the keystore and vault paths put a network round trip in front of a purely
    // local decrypt, and the two have no data dependency at all. Measured on production
    // 2026-09-16, the gap between the login's last local line and MLS being ready was 162 ms of
    // waiting for `/revoked` with the CPU idle - 12% of a 1.3 s cold start, bought back by holding
    // the promise instead of awaiting it where it is asked.
    //
    // A HELD PROMISE AND NOT A `Promise.all`: what must be preserved is not "both finish" but
    // "nothing this device does on the server's behalf happens before the answer is in". The
    // decrypt below touches only local bytes a revoked device already holds, so overlapping it
    // costs nothing; everything after the gate - the token, the session/device binding, the push
    // registration, the first key-package publication - is on the far side of it. The PIN path
    // cannot join in and deliberately does not: its round trip RETURNS the salt the device key is
    // derived from, so there is a real data dependency there and no idle wait to reclaim.
    //
    // WHAT `init()` MAY DO WHILE THE ANSWER IS IN FLIGHT WAS ENUMERATED, NOT ASSUMED, and it is
    // one call. `_initImpl` publishes nothing: `generateKeyPackage` is reached from
    // `initializeConnection` and `republishKeyMaterial`, both far past this gate. Its only network
    // step is `deleteDevice` inside `rotateDeviceIdentity`, on the branch where the saved state
    // fails to open - and `DELETE /api/mls/devices/:userId/:deviceId` ADDS a `RevokedDevice` row,
    // or refreshes the `revokedAt` of one that exists (`devices.controller.ts`). It can therefore
    // only reinforce a revocation, never lift one. A fresh start likewise mints a client locally and nothing more; were it to reach
    // registration, `REGISTER_DEVICE` refuses a revoked id on the server's own authority. So the
    // overlap moves work, and moves no decision.
    let revocationAnswer: Promise<boolean> | null = null;

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
      // The per-user random salt is usually already in hand, asked while the keypad was up
      // (`prefetchPinSaltImpl`); the check, the derivations and the order between them are
      // `unlockWithPin`'s, where they are exercised on their own (`pinUnlock.test.ts`).
      const userIdForPin = ctx.getUserId();
      deviceKeyB64 = await unlockWithPin({
        saltAhead: takePinSaltAhead(userIdForPin),
        fetchSalt: () => fetchPinSalt(ctx, userIdForPin, accessToken),
        computeVerifier: (salt) => computePinVerifier(userIdForPin, pin, salt),
        deriveDeviceKey: (salt) => deriveDeviceKeyB64(userIdForPin, pin, salt),
        resolveDeviceId: () => mlsService.resolveDeviceId(userIdForPin),
        checkPin: async ({ verifier, deviceId, salt }) => {
          const res = await fetchOrUnreachable(
            `${ctx.getHistoryBaseUrl()}/api/mls/security/pin-check`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`,
              },
              body: JSON.stringify({ userId: userIdForPin, verifier, deviceId, salt }),
            },
            m.auth_pin_check_unreachable()
          );
          if (!res.ok) throw new LocalizedError(m.auth_pin_check_unreachable());
          return (await res.json()) as PinCheckAnswer;
        },
        wipeRevokedDevice: () => wipeRevokedDevice(ctx, cb),
        installDeviceKey: (key) => ctx.setDeviceKey(key),
        log: cb.log,
      });
      // Unlocked: any round trip a retry asked meanwhile belongs to a keypad that is gone.
      forgetPinSaltAhead('unlocked with the PIN', cb.log);
      // The first instant this path can decrypt anything: the PIN is proven and the device is not
      // revoked (`unlockWithPin` answered both above). Still under the gate, which stays up until the
      // session is.
      storageOpen = getStorage(ctx.getUserId());
      startLandingPreview(storageOpen, deviceKeyB64);
    } else {
      forgetPinSaltAhead(isVaultLogin ? 'unlocked by the vault' : 'unlocked by biometrics', cb.log);
      cb.log(
        isVaultLogin
          ? 'Initialising MLS (vault device key path)...'
          : 'Initialising MLS (biometric keystore path)...'
      );
      // NEVER LEARN BY FAILING WHAT A FACT COULD HAVE TOLD YOU. These two paths skip the PIN check
      // on purpose - the keystore and the vault ARE the authentication factor - but `resetRequired`
      // was the only thing that ever asked whether this device is still allowed to exist, so they
      // skipped that too. A device revoked while it was offline then logged straight back in and
      // kept everything, and the only remaining trigger was a `device_revoked` frame that had
      // already been sent to a device that was not there to receive it.
      //
      // The revocation is a server fact with a route of its own, so ASK IT, on every login path.
      // `resolveDeviceId` is safe here for the same reason the PIN path calls it before `init()`:
      // it reads the stored id and decrypts nothing. `isDeviceRevoked` answers `false` when it
      // cannot reach the server, so an offline login is never wiped by a transport failure.
      beginBootSpan('resolve-device-id');
      const deviceId = await mlsService.resolveDeviceId(ctx.getUserId());
      endBootSpan('resolve-device-id');
      revocationAnswer = mlsService.isDeviceRevoked(ctx.getUserId(), deviceId);
    }

    // PIN verified server-side (or biometric mode) - now decrypt the local MLS state.
    // When a saved state exists, pass noFreshStart so an undecryptable state (the account
    // PIN was rotated on another device → local state still sealed under the old PIN)
    // surfaces as a recoverable signal instead of a destructive fresh-start that would
    // drop history. In biometric mode, an empty PIN is passed so the Rust side invokes
    // retrieve_device_key (single BiometricPrompt).
    // TAB LEADERSHIP IS DECIDED HERE BECAUSE IT IS WHAT DECIDES WHETHER TO OPEN A SOCKET AT ALL,
    // and it costs a Web Lock acquisition - measured at 6 ms on the 2026-09-16 export. Nothing
    // between here and its old position below the restore reads `getIsTabLeader()`, so the move is
    // a reordering of two independent facts and not a change of meaning.
    beginBootSpan('tab-leadership');
    const tabLeaderNow = await initTabLeadershipAsync(cb.log);
    endBootSpan('tab-leadership', { leader: tabLeaderNow });
    ctx.setIsTabLeader(tabLeaderNow);
    if (!tabLeaderNow) {
      cb.log('[TAB] Follower tab - WebSocket active in another Canari tab.');
    }

    // THE HANDSHAKE STARTS HERE AND IS AWAITED 200 MS LOWER DOWN. `resolveDeviceId` has answered on
    // both paths above, which is everything the socket needs; the MLS state load below needs
    // nothing from the socket. Measured on production 2026-09-16, the two ran one after the other
    // and cost 236 ms + 182 ms of a 1308 ms cold start.
    //
    // THE ORDER THAT MATTERS IS NOT "BOTH FINISH" BUT "NOTHING IS PROCESSED BEFORE THE THING THAT
    // CAN PROCESS IT EXISTS", exactly as for the revocation answer above. A frame that arrives on
    // this socket before MLS is ready is HELD by `BaseMlsService`, in arrival order, and replayed by
    // the `markInboundReady` below - which is the precondition of this line and must stay paired
    // with it. An offline session opens nothing: there is no token to carry and no server to reach.
    if (!offlineSession) markBoot('gateway-handshake-started');
    const startedHandshake = offlineSession
      ? null
      : startGatewayHandshake({ mlsService, log: cb.log });

    // THE PAIR KEEPS ITS CLOCK AND EACH HALF GAINS ONE, because the pair's clock cannot answer the
    // question the pair's cost raises. On the Mi 9T this block was 1621.9 ms - 78% of everything
    // after `login-start` - and `allSettled` means that number is the SLOWER of two concurrent
    // things, with nothing saying which. Three spans, not one: the two halves overlap by
    // construction, which is what this bench was built to report rather than flatten.
    beginBootSpan('mls-init-and-storage');
    const [mlsInitSettled, storageSettled] = await Promise.allSettled([
      timeBootSpan(
        'mls-init',
        mlsService.init(ctx.getUserId(), deviceKeyB64, mlsStateResult?.bytes, {
          // `!!bytes` WOULD NOW BE WRONG ON MOBILE: the bytes were deliberately not loaded, and a
          // saved state read as absent is a FRESH START, which rotates the device identity. The
          // question is whether a state exists, and `mlsStateResult` is what answers it.
          noFreshStart: !!mlsStateResult,
          // Says which of the two things an absent `state` means here - see the lookup above.
          stateOnDisk: mlsStateResult?.source === 'native',
          // Only the PIN paths can carry it, and only a snapshot older than the v0.11.0 envelope
          // change needs it: init re-seals such a snapshot instead of reporting a PIN rotation.
          legacyPin: !isBiometric && !isVaultLogin ? pin : undefined,
          unattendedKeyRead: isBiometric && opts?.unattendedKeyRead === true,
          // A key from an older build's unlabelled vault must PROVE it is this account's on the
          // saved state, and changes nothing if it does not - see `MlsInitOptions.vaultOwnerUnproven`.
          vaultOwnerUnproven,
        })
      ),
      timeBootSpan('storage-open', storageOpen ?? getStorage(ctx.getUserId())),
    ]);
    // THE GATE, AND IT IS READ BEFORE THE INIT VERDICT ON PURPOSE. A device that is both revoked
    // and carrying an unopenable state has exactly one correct answer, and it is not "enter the PIN
    // you used before": `local_state_unopenable` would park its owner in a recovery modal for a
    // device they have already declared lost. Revocation is the stronger fact, so it is consulted
    // first - which is also the order the awaited version had, one round trip earlier.
    //
    // `isDeviceRevoked` answers `false` when it cannot reach the server and never rejects, so this
    // await can neither throw into the destructive catch below nor leave a rejection unhandled when
    // an earlier line throws past it.
    endBootSpan('mls-init-and-storage');
    beginBootSpan('revocation-gate');
    const revoked = revocationAnswer !== null && (await revocationAnswer);
    endBootSpan('revocation-gate', { asked: revocationAnswer !== null });
    if (revoked) {
      // What the local preview drew comes off the screen BEFORE the wipe, and the wipe starts only
      // once the read is over - it deletes the store that read was reading. The store is already
      // open here (the init above awaited it), so this wait is the read alone and cannot hang.
      withdrawLandingPreview('device revoked');
      if (landingPreview) await landingPreview;
      await wipeRevokedDevice(ctx, cb);
      cb.log('[SECURITY] Revoked device: signed out and reset to a fresh install.');
      throw new LoginFailure('device_revoked', m.auth_device_revoked_reset());
    }

    if (mlsInitSettled.status === 'rejected') {
      const reason = mlsInitSettled.reason;
      // The init changed nothing (`MlsInitOptions.vaultOwnerUnproven`): the PIN gate, typed.
      if (reason instanceof VaultOwnerUnprovenError) throw vaultRefusedFailure(reason.refusal);
      const reasonStr = reason instanceof Error ? reason.message : String(reason);
      const isUndecryptable = reasonStr === MLS_LOCAL_STATE_UNDECRYPTABLE;
      if (isUndecryptable) {
        throw new LoginFailure('local_state_unopenable', m.auth_local_state_unopenable());
      }
      // Empty keystore on biometric path: no key stored yet (first launch or
      // keystore was wiped). Surface a clean message and let the caller recover.
      if (isBiometric && isKeystoreKeyUnavailable(reason)) {
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
      beginBootSpan('keystore-session-key');
      const sessionKey = await mlsService.resolveSessionDeviceKey();
      endBootSpan('keystore-session-key');
      if (!sessionKey || !isValidDeviceKeyB64(sessionKey)) {
        throw new LoginFailure('keystore_empty', m.auth_keystore_empty_enter_pin());
      }
      ctx.setDeviceKey(sessionKey);
      // The keystore path learns its key only here, behind the single prompt and after the gate.
      // Not awaited before the session flips: the landing selects the row whenever it arrives.
      startLandingPreview(Promise.resolve(storageSettled.value), sessionKey);
    }

    ctx.setStorage(storageSettled.value);
    ctx.setMyDeviceId(mlsService.getDeviceId());
    cb.log(`MLS identity initialised (device: ${ctx.getMyDeviceId()})`);
    console.log(
      `[INIT] MLS initialized for userId=${ctx.getUserId()} device=${ctx.getMyDeviceId()}`
    );
    cb.log('Local database initialised.');

    // WHICH HELD GROUPS CARRY GRAINE SEEDS, KNOWN BEFORE ANYTHING ROUTES A FRAME. The community loop
    // that used to be the only source of this fact starts below, un-awaited, and the drain starts
    // long before it finishes: a key group's backlog then took the conversation path and was refused,
    // on every load, for ever (production 2026-09-28: 51 frames, a device 8 epochs behind). Both the
    // local store and the MLS state are open at this point, which is all the restore needs, and it
    // is one read. Wired first, so the loop's own registrations below are stored too.
    mlsService.setDistributionGroupStore(storageSettled.value);
    await mlsService.hydrateDistributionGroups();

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
    // catch calls resetMls() + clearDeviceKey(). A network blip would then
    // destroy the very session that just unlocked. The empty token is what every network-touching
    // helper reads as "not authenticated yet"; promoteOfflineSession fills it in.
    beginBootSpan('auth-token-final');
    ctx.setAuthToken(offlineSession ? '' : await getToken());
    endBootSpan('auth-token-final', { offline: offlineSession });
    ctx.setIsOfflineSession(offlineSession);

    ctx.setIsLoggedIn(true);
    saveUserLocally({ id: ctx.getUserId(), admin: isGlobalAdmin() });
    ctx.setIsMessagingInitializing(true);
    // THE BOOT MEASUREMENT ENDS EXACTLY WHERE THE CATCH-UP ONE BEGINS, on the same line, so the two
    // reports abut with no gap and no overlap. That adjacency is the point: between them they cover
    // the whole cold start, and the 43% that used to have no clock at all is the first of the two.
    finishBootBench();
    installCatchupBenchDevTools();
    beginStartupCatchupBench();
    cb.log('[INIT] MLS ready - syncing messages in background.');
    cb.onMlsReady?.();

    // WHAT THE KEY PACKAGE COUNT IS MADE OF, ONCE PER SESSION, ON BOTH PLATFORMS.
    //
    // The composition line printed at load prints a COUNT, and a count names no remedy: expired
    // debt, superseded fallbacks and a revoked pool stack into one number and are reclaimed by three
    // different mechanisms. This is the breakdown - two production console exports on 2026-09-16,
    // twelve minutes apart on one profile, read 933 -> 983 -> 1013 with nothing reclaimed, and could
    // say how many and not which.
    //
    // **THIS LINE USED TO BE GUARDED BY `!isTauriRuntime()`, AND THE GUARD WAS THE DEFECT.** Native
    // was not without a census: it printed one from INSIDE `load_or_create`, on the awaited path of
    // `initialiser_mls`, in front of the first screen - the one place this call site's own comment
    // said it must not be. Measured on OXYGEN 2026-09-17, 5 groups, a 1000-package pool: a cold load
    // costs 24.5 ms with that diagnostic and 12.9 ms without, so HALF of it was this. The native
    // census is now `recenser_key_packages`, called from here like the web one.
    //
    // HERE RATHER THAN IN `init()`: it deserialises every stored bundle, and a thousand of those do
    // not belong in front of the connected badge. The socket is still ~200 ms away at this line
    // (measured 2026-09-16), so this is not free either - it is 15 ms on web for 1033 bundles, 1% of
    // the boot, which does not justify machinery. What it is NOT any more is on the critical path of
    // a native cold start.
    mlsService.logKeyPackageCensus();

    // Fire-and-forget: saveDeviceKey is independent of conversation loading.
    // The device key is always saved — on Tauri it feeds push_context.json for
    // background FCM decryption; on web it powers auto-login.
    // Biometric mode derives nothing: the keystore holds the key, so there is nothing to vault.
    //
    // INTO THIS ACCOUNT'S OWN SLOT. Then, and only then - this login has SUCCEEDED and the key is
    // safe in its own slot - the unlabelled slot of an older build is retired IF it holds the key
    // this account unlocked with, whichever path the login took: that proves it is this account's.
    // One holding any other key may be another account's, never proven, and is kept for it
    // (`retireUnlabelledDeviceKeyIfOwnedBy`). A failed save skips the retirement: the key survives.
    {
      const owner = ctx.getUserId();
      const unlockedWith = ctx.getDeviceKey();
      void (async () => {
        if (deviceKeyB64) await saveDeviceKey(owner, deviceKeyB64);
        if (unlockedWith && (await retireUnlabelledDeviceKeyIfOwnedBy(owner, unlockedWith))) {
          cb.log(`[VAULT] unlabelled vault proven to be ${owner.slice(0, 8)}'s - retired`);
        }
      })().catch((e: unknown) => cb.log(`[VAULT] saving the device key failed: ${String(e)}`));
    }

    // Stamp this session with the device that just unlocked. It is the ONLY
    // join between a login (core-service) and a device (delivery service), and
    // without it the security settings can list both but never say which row on
    // one is which row on the other. Fire-and-forget: an unstamped session is
    // fully functional, it simply shows as a row of its own - so a failure is
    // reported and dropped rather than delaying a screen the user is waiting on.
    // Skipped offline: there is no token yet, and promoteOfflineSession re-runs it.
    if (!offlineSession) {
      void bindCurrentSessionDevice(ctx.getMyDeviceId()).catch((e) =>
        cb.log(`[WARN] Session/device binding failed: ${String(e)}`)
      );
    }

    // Check push health AFTER registration so pending_push_secret.txt is present
    // (written by store_push_secret during startPushService) before the health check runs.
    // Skipped offline - registering a push token requires the server, and the resulting failure
    // would raise a spurious "push degraded" fatal error. promoteOfflineSession re-runs it.
    // The account's notification switches, which this client's own local notifications consult.
    // Skipped offline for the same reason; promoteOfflineSession loads them once it is online.
    if (!offlineSession) void notificationPreferences.load();
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
        .catch((e) => cb.log(`[WARN] Push registration failed: ${String(e)}`));
    }

    // Message outbox: register the flusher before loading conversations so that
    // applyOutboxPendingStatuses can restore the "pending" status on restored messages.
    registerOutbox(makeOutboxDeps(ctx, cb));

    // Watch for connectivity returning. Registered on every session, not only the offline ones:
    // promoteOfflineSession no-ops on a session that already holds a token, and registering here
    // unconditionally keeps one lifecycle (login registers, logout unregisters) instead of a flag
    // deciding whether a listener exists.
    registerOfflinePromotion(ctx, cb, () => makeConnectionDeps(ctx, cb));

    // Group exits this device decided and the server never answered. Same lifecycle and the same
    // seam as the one above: a delete or a leave that met no server is owed until one answers, and
    // the answer cannot be waited for with a timer (see `pendingGroupExits`).
    registerPendingGroupExitDrain({
      getStorage: () => ctx.getStorage(),
      ensureMls: () => ctx.ensureMls(),
      getUserId: () => ctx.getUserId(),
      log: cb.log,
    });

    // THE INBOUND PIPELINE IS REGISTERED BEFORE ANYTHING CAN PULL, and that ordering is load-
    // bearing rather than tidy. The startup archive replay takes the mailbox barrier, the barrier
    // PULLS the delivery queue, and `processQueue` cannot drain a single frame until
    // `setupMessageHandler` has set the message callback - so with this block below the restore, a
    // device holding anything server-side pulled it into a queue with no consumer and waited for an
    // idle that could never come. Measured on prod 2026-08-15: 2 queued frames were enough to stop
    // a browser mid-boot, before tab leadership, with no socket and no error line, on every reload.

    beginStartupCatchupPhase('setup_handler');

    // A key-distribution group has its external-join base on social-service, not on chat-delivery:
    // the base IS the capability to read every seed on it, so it is gated on membership of the
    // scope it belongs to - a community, or one private salon - which only social-service holds.
    // Wired as a transport rather than imported, so the MLS layer never learns to speak to the
    // communities API.
    const distributionChannels = new ChannelService();
    mlsService.setDistributionGroupInfoTransport({
      fetch: async (scope) => {
        const ref = await distributionChannels.getDistributionGroup(scope);
        return ref.groupInfo !== null && ref.baseEpoch !== null
          ? { groupInfo: ref.groupInfo, baseEpoch: ref.baseEpoch, activeEpoch: ref.activeEpoch }
          : null;
      },
      publish: (scope, groupInfo, baseEpoch, deviceId) =>
        distributionChannels.publishDistributionGroupInfo(scope, groupInfo, baseEpoch, deviceId),
    });

    // Sealing a salon message needs the device key, the local store, the MLS client and who this
    // device is - four things a crypto utility has no business reaching for. They are decided here
    // and invalid after logout, so they are installed here and cleared in `logout`.
    setGraineRuntime({
      storage: ctx.getStorage()!,
      deviceKey: () => ctx.getDeviceKey(),
      userId: ctx.getUserId(),
      mlsService,
    });
    // What a frame arriving on a distribution group MEANS. The MLS layer routes them here and
    // refuses to acknowledge one with no handler wired, so this is the difference between a seed
    // stored and a seed redelivered for ever.
    mlsService.onDistributionFrame(handleDistributionFrame);
    // A drain re-reads each salon its seeds repaired ONCE, at its end, instead of once per seed.
    // Registered before the inbound gate opens below, so no window can close that this did not see
    // open. Only the drain's window holds - see `graineRepairHoldObserver`.
    mlsService.addBulkIngestObserver(graineRepairHoldObserver);
    // Who acts on a key group found behind its epoch: rung 2 through the loader, and the requests
    // held while it was behind. Wired with the frame handler, before the drain can produce one.
    mlsService.onDistributionGapVerdict(
      distributionGapListener(mlsService, distributionChannels, cb.log)
    );

    const callSystemCtx = {
      userId: ctx.getUserId(),
      deviceKey: () => ctx.getDeviceKey(),
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
      // Read at each write: a PIN change moves the session's key while this handler lives on.
      deviceKey: () => ctx.getDeviceKey(),
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
      onRolePermissionsChanged: cb.onRolePermissionsChanged,
      onChannelDeleted: cb.onChannelDeleted,
      onWorkspaceUpdated: cb.onWorkspaceUpdated,
      onSalonUnreadCleared: cb.onSalonUnreadCleared,
      onWorkspaceRoleChanged: cb.onWorkspaceRoleChanged,
      onWorkspaceDeleted: cb.onWorkspaceDeleted,
      onChannelMessageDeleted: cb.onChannelMessageDeleted,
      onReadStateAdvanced: cb.onReadStateAdvanced,
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
          // The askers this group kept waiting. Served through the SAME path the socket uses, so
          // one that is still too early is put back on the queue rather than dropped: "ready" here
          // is the MLS group becoming sendable, which is not yet this device's conversation row.
          void drainDeferredWelcomeRequests(makeWelcomeRequestContext(ctx, cb), readyGroupId);
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

    /**
     * THE GATE OPENS HERE, AND NOT ONE LINE EARLIER, AND THE SOCKET IS ALREADY UP BEHIND IT.
     *
     * Both preconditions of {@link IMlsService.markInboundReady} are true on this line and on no
     * earlier one: the MLS client is initialised, and `setupMessageHandler` just above registered
     * the inbound pipeline every held payload frame needs. It is AWAITED because a Welcome and the
     * Commit behind it may only be processed in the order they arrived. Silent and free when
     * nothing was held - every follower tab, every offline session, and every boot where the
     * handshake simply finished first.
     *
     * WHY THE SOCKET MUST BE UP BEFORE THE RESTORE, which is the older half of this and still the
     * reason the two lines below sit here rather than further down. Measured on production
     * 2026-09-15, from the user's own console: the app announced `Initialised in WEB mode` at
     * 22:24:17 and `[TAB] Leadership acquired (Web Locks)` at 22:24:39, with `[WS] Opening
     * connection` behind it - so for the whole of the archive replay this client had no socket. Two
     * things followed, and only one of them is obvious:
     *
     *  - nothing live could arrive for twenty-two seconds, and
     *  - **every mailbox barrier re-pulled the whole mailbox.** `settleBarrier` trusts a previous
     *    pull only while `mailboxEmptiedByAPull && isWsOpen()`, and that second half is exactly
     *    right: with no socket the server can have queued a row since the pull and nothing would
     *    have pushed it. So with the socket closed the flag is worth nothing, and twenty
     *    conversations meant twenty HTTP round trips answering `[PENDING] No pending MLS messages`.
     *
     * Since 2026-09-16 the handshake no longer STARTS here either - it was started before the MLS
     * state load, 182 ms further up, and what remains on this path is the gate and the await. The
     * concurrency that buys is paid for by the hold queue and by nothing else: frames are held, not
     * dropped, and they are replayed by the call below before a single line past it runs.
     *
     * Only the SOCKET moved, twice. `syncConnectionAfterWsOpen` - KeyPackage publication, the group
     * sweep, reconciliation - stays where it was, below the restore, because it reasons about the
     * conversations this device holds and must not run before they are loaded.
     */
    await mlsService.markInboundReady();

    // Offline: skip the connection entirely rather than let it fail. `openGatewayConnection` would
    // degrade correctly on its own, but the attempt costs a timeout on a launch that already knows
    // there is no network, and it logs "Gateway inaccessible" for a device that never had one.
    let gatewayIsOpen = false;
    if (offlineSession) {
      cb.log('[INIT] Offline session - gateway connection deferred until the network returns.');
    } else {
      beginStartupCatchupPhase('open_gateway');
      // The handshake this awaits was started before the MLS state load, not here - see
      // `startGatewayHandshake` above. Everything after the socket opens is unchanged.
      gatewayIsOpen = await openGatewayConnection(makeConnectionDeps(ctx, cb), startedHandshake);
      endStartupCatchupPhase();
    }

    // Adopt anything the native side queued on its own (an undelivered notification quick reply
    // lives only in the mirror file, which the next mirror rewrite would erase). BEFORE the load:
    // the adopted message is written to the store, so the ordinary history load displays it and
    // applyOutboxPendingStatuses below marks it pending.
    await adoptOrphanedMirrorEntries(ctx.getStorage()!, ctx.getDeviceKey(), ctx.getUserId()).catch(
      (e) => cb.log(`[OUTBOX_MIRROR] Adoption pass failed: ${String(e)}`)
    );

    // EVERYTHING FROM HERE TO THE FCM MERGE IS ONE SPAN, and a deep-link landing must not conclude
    // anything about this device's conversations until it closes. The restore below marks itself
    // finished the moment IndexedDB is read, which is BEFORE `consumeFcmCache` writes the
    // placeholder for a group joined in the background - so a tap on a first message from a new
    // correspondent used to see a settled map without its target and abandon, milliseconds early.
    // Opened BEFORE the restore rather than around the cache alone: the two are separated by
    // awaits, and a gap between them is the whole defect in miniature.
    cb.beginConversationSource();
    try {
      // The local preview's write lands BEFORE the rebuild, never after it: a row it added after
      // the restore would be a stale copy the restore no longer knows about. Long settled by now
      // on every path - it is one store read, and the gateway was awaited since.
      if (landingPreview) await landingPreview;
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
      await reconcileOutboxSent(ctx.getStorage()!).catch((e) =>
        cb.log(`[OUTBOX_MIRROR] Login reconcile failed: ${String(e)}`)
      );
      // Re-mark "pending" messages still in the outbox queue (derived status, not persisted).
      await applyOutboxPendingStatuses();

      beginStartupCatchupPhase('fcm_cache');
      // THE PLACEHOLDERS TRAVEL WITH THE MESSAGES, and at login as much as on resume: the
      // conversations were loaded from storage a few lines above, which is BEFORE this call writes
      // the placeholder for a group joined in the background - so a first message from a new
      // correspondent has no conversation in the map here either.
      const fcmInjected = await consumeFcmCache(
        ctx.getDeviceKey(),
        ctx.getStorage()!,
        ctx.getUserId()
      ).catch(() => ({ messages: [], placeholders: new Map<string, PushPlaceholder>() }));
      if (fcmInjected.messages.length > 0) {
        const mergedCount = mergeFcmMessagesIntoConversations(
          fcmInjected.messages,
          cb.conversations,
          ctx.getUserId(),
          fcmInjected.placeholders
        );
        cb.log(`[FCM_CACHE] ${mergedCount} message(s) merged in memory at login`);
      }
      endStartupCatchupPhase({
        messageCount: fcmInjected.messages.length,
      });
    } finally {
      // A throw anywhere in the span still has to release the landing, or a failed restore would
      // leave every deep link waiting for a source that is never coming back.
      cb.endConversationSource();
    }

    // What the notification shade acknowledged while the app was not running. AFTER the FCM cache:
    // the watermark's whole job is to recompute `unreadCount`, and it must count the messages that
    // pre-injection just added, not the ones that were there a moment ago.
    await consumeNativeReadWatermarks(cb.conversations, ctx.getUserId(), cb.saveConversation).catch(
      (e) => cb.log(`[READ_WATERMARK] Merge pass failed: ${String(e)}`)
    );

    try {
      const localMlsGroups = new SvelteSet(mlsService.getLocalGroups());
      // THE RESTORE'S OWN VERDICT, taken BEFORE the demotion below rewrites the rows: afterwards the
      // evidence is gone and a partial restore looks complete. Reported through the existing
      // fatal-error banner, and accused at `error` because a row on screen that cannot work is the
      // visible end of an MLS state that did not come back with it.
      const shortfall = measureRestoreShortfall(cb.conversations.values(), localMlsGroups);
      if (shortfall) {
        ctx.setMlsFatalError('restore_shortfall');
        const ids = shortfall.missingIds.map((id) => id.slice(0, 8)).join(', ');
        cb.log(
          `[ERROR] Partial restore: ${shortfall.restored}/${shortfall.expected} conversation(s) hold their MLS group - missing ${ids}`
        );
        console.error(
          `[INIT] Partial restore: ${shortfall.restored}/${shortfall.expected} conversation(s) hold their MLS group (missing ${ids})`
        );
      }
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

    if ('onWelcomeProcessed' in mlsService) {
      (mlsService as any).onWelcomeProcessed(async (groupId?: string) => {
        if (groupId) {
          cb.log(`[SYNC] Welcome processed for ${groupId}, refreshing...`);
          if (!cb.conversations.has(groupId)) {
            // THE ENVELOPE'S GROUP ID, WHICH IS NOT ALWAYS THE JOINED ONE - that difference is the
            // only reason this branch exists, and it used to answer it with the worst row of the
            // thirteen: the raw id as the display name, and `group` asserted whatever the id said.
            // There is nothing here but the id, so the id is what the identity is read from.
            cb.conversations.set(
              groupId,
              buildConversationRow({
                id: groupId,
                lifecycle: 'active',
                identity: deriveConversationIdentity(groupId, ctx.getUserId(), groupId),
              })
            );
            await cb.saveConversation(groupId);
            await cb
              .loadAndRestoreConversations()
              .catch((e) => cb.log(`[WARN] Error resyncing convs (Welcome): ${e}`));
            // Fresh join: the Welcome lands us at the current epoch with no pre-join history. The
            // inviter pushes a bundle on the foreground add path, but its background twin
            // (send-welcome-and-commit) does not, so we compare here as well - which costs one
            // frame when the bundle already arrived, and repairs the group when it did not.
            await reconcileGroup(mlsService, groupId, cb.log);
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

    mlsService.onDeviceRevoked(() => {
      void (async () => {
        // GATED ON A SERVER FACT, NEVER ON THE FRAME. The frame says "you were deleted"; erasing a
        // device on the strength of a message is exactly the destructive-control shape that has to
        // be confirmed first. `isDeviceRevoked` answers false when it cannot reach the server, so a
        // transport failure can never destroy anything - a status code is an answer, a transport
        // failure is not.
        const deviceId = await mlsService.resolveDeviceId(ctx.getUserId());
        const revoked = await mlsService.isDeviceRevoked(ctx.getUserId(), deviceId);
        if (!revoked) {
          cb.log('[SECURITY] device_revoked frame received but the server disagrees - ignored.');
          return;
        }
        cb.log('[SECURITY] This device was revoked by its owner - signing out and resetting.');
        await wipeRevokedDevice(ctx, cb);
        // A REVOCATION IS NOT A FAILED LOGIN ATTEMPT, AND THE SEAM DECIDES WHAT THE USER SEES.
        // `onLoginFailed` means "the credential you just offered was refused, stay in the modal and
        // try again" - which is right at the two login-path call sites above, where a person is
        // standing at the gate. Here there is no gate and nothing to retry: the wipe one line up has
        // just returned this device to a fresh install, so there is no PIN, no device id and no
        // session left for a modal to act on. The live callbacks bind `onLoginFailed` to the
        // saved-PIN handler, so this call REOPENED THE PIN PROMPT on top of /chat and the app then
        // sat there - measured on prod 2026-08-29: no sidebar, no session, no navigation, until the
        // prompt's own attempt drew a 401 and the session-expired path finally did the redirect.
        //
        // `onSessionExpired` is the seam written for exactly this - an authentication loss rather
        // than a retryable error - and it is the one callback the background service wires
        // unconditionally: it clears the auth and goes to /login. Nothing is lost by the change,
        // because the message it replaces was displayed in a modal the app abandoned two seconds
        // later anyway.
        cb.onSessionExpired?.();
      })();
    });

    // A DEVICE ASKING FOR A BASE REFRESH IS A DEVICE THAT CANNOT GET IN AT ALL, so this is answered
    // before anything else and logged at a level that accuses. The published external-join base names
    // an epoch the group has left; nothing but a member's publish can move it, and only a commit
    // otherwise does - so on a quiet conversation a stale base is permanent. Measured on production
    // 2026-09-04: four groups stale, all by exactly one epoch, two of them since 2026-08-30 with
    // three devices sitting `pending` on them.
    //
    // WHAT THIS IS NOT: it is not an Add. Nothing here mutates the tree, takes the group's add lock
    // or changes an epoch - `refreshGroupInfo` exports what this device already holds and publishes
    // it. That is the whole reason the requester asks for THIS rather than for a Welcome.
    //
    // THE ANSWER ITSELF IS IN `staleBase.ts`, NEXT TO THE REPAIR IT IS THE SIBLING OF - and the
    // reasoning it carried moved with it, along with the reading of what the server did, which the
    // steady-state repair was discarding while this one read it. What is left here is the wiring and
    // the one thing only this scope knows: WHO asked. A responder buried in this file could not be
    // driven by a test, and it was the half of the pair with no coverage at all.
    mlsService.onBaseRefreshRequest(
      async (requesterUserId: string, requesterDeviceId: string, groupId: string) => {
        cb.log(
          `[BASE_REFRESH] ${groupId.slice(0, 8)}... asked by ${requesterUserId.slice(0, 8)}:${requesterDeviceId.slice(0, 12)}` +
            ` - a device cannot external-join this group`
        );
        await answerBaseRefreshRequest(ctx.ensureMls(), groupId, cb.log);
      }
    );

    mlsService.onWelcomeRequest(
      async (requesterUserId: string, requesterDeviceId: string, groupId: string) => {
        cb.log(
          `[SYNC] welcome_request received from ${requesterUserId}:${requesterDeviceId} for ${groupId}`
        );
        await serveWelcomeRequest(
          makeWelcomeRequestContext(ctx, cb),
          { requesterUserId, requesterDeviceId },
          groupId
        );
      }
    );

    // The only place holding the store, the device key and the MLS client at once, so it is where
    // the reconciliation's probe sender is installed. Every solicitation says what this device HOLDS
    // before asking anything, which is what lets the usual answer be silence.
    setHistoryProbeSender(async (groupId: string) => {
      const mls = ctx.ensureMls();
      return sendHistoryProbe(groupId, digestIdentity(ctx.getUserId(), mls.getDeviceId()), {
        storage: ctx.getStorage(),
        deviceKeyB64: ctx.getDeviceKey(),
        mlsService: mls,
        log: cb.log,
      });
    });

    // INSTALLING THE SENDER IS ITSELF AN EDGE, and this is where it is discharged. Frames drain
    // before this point in the setup, so a frame MLS could never decrypt has already asked for the
    // one repair that exists and has already been acked off the server - the ask is the only trace
    // of the gap left anywhere. Dropping it kept a production DM permanently short of the messages
    // it had lost. Fired here, in the same tick as the registration, so nothing drained in between
    // falls in the gap; it returns immediately when nothing is deferred.
    void retryDeferredReconciliations(mlsService, mlsService.getLocalGroups(), cb.log);

    // A reconciliation the server could not elect anybody for has to wait for a member to return,
    // and presence tells us that within ten seconds. This is that seam, and it retries ONLY the
    // groups that could not be asked at all - every other group was already compared on this
    // connection, and a presence edge says nothing new about them.
    unregisterPeerReturn?.();
    unregisterPeerReturn = onPeersCameOnline(() => {
      // `ensureMls` CREATES the service when there is none, so it must never be reached from a
      // background callback: storage is what says a session is live, the same guard `sendDisconnect`
      // uses. Without it a stray edge after teardown would build an MLS client for nobody.
      if (!ctx.getStorage()) return;
      const mls = ctx.ensureMls();
      cb.log('[HISTORY_RECONCILE] a peer came back online - retrying what nobody could answer');
      void retryDeferredReconciliations(mls, mls.getLocalGroups(), cb.log);
      // THE SAME EDGE, THE OTHER RECORD OF THE SAME ANSWER. A group whose base nobody was online to
      // republish is locked out until somebody is, and this is the moment somebody is - see
      // `forgetProvenDeadEnds` for why waiting on the epochs alone rests on the far side's build.
      forgetProvenDeadEnds(cb.log);
    });

    mlsService.onHistoryRequest(
      async (requesterUserId: string, requesterDeviceId: string, groupId: string) => {
        cb.log(
          `[SYNC] history_request received from ${requesterUserId}:${requesterDeviceId} for ${groupId}`
        );
        // OUR MAILBOX FIRST, here too: this is the leg where we state what we hold, and a state key
        // computed over a store still being filled makes this device an unreliable source - it can
        // claim agreement it does not have yet, which ends the exchange with the two still apart.
        // Deferred rather than awaited for the same reason as every other leg: whether this
        // callback runs inside the drain is not something this call site should have to know.
        answerAfterMailboxDrained(ctx.ensureMls(), groupId, async () => {
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
            cb.log(`[WARN] Echec handleHistoryRequest: ${String(e)}`);
          }
        });
      }
    );

    // The socket and tab leadership were settled before the restore - see the block that does it,
    // above. What is left here is the half that reasons about the conversations this device holds:
    // publishing KeyPackages, sweeping the server's group list, reconciling history. It is skipped
    // when the socket never opened, exactly as `initializeConnection` skipped it.
    /** What the connection sync learnt about absent local groups, handed to discovery below. */
    let passVerdicts: AbsentGroupVerdicts | undefined;
    if (offlineSession) {
      cb.log('[INIT] Offline session - group reconciliation deferred until the network returns.');
      finishStartupCatchupBench(cb.log);
    } else {
      beginStartupCatchupPhase('initialize_connection');
      if (gatewayIsOpen)
        passVerdicts = await syncConnectionAfterWsOpen(makeConnectionDeps(ctx, cb));
      {
        const stats = summarizeConversationStats(cb.conversations);
        endStartupCatchupPhase({
          conversationCount: stats.conversationCount,
          messageCount: stats.localMessageCount,
        });
      }
      finishStartupCatchupBench(cb.log);

      // Connection established and groups reconciled: drain the outbox. THIS IS LOGIN, AND THE
      // PARENTHESIS THAT USED TO BE HERE - "covers reconnection, which re-runs
      // initializeConnection" - WAS FALSE. The login path opens the socket above the restore and
      // syncs here; `initializeConnection` (open + sync in one call) is now left to the offline
      // promotion alone. Each runs once per session, and a reconnect goes through
      // `attemptReconnectImpl`, which calls neither. Reconnection is covered inside the outbox by
      // `connectivity.onReconnect`, and believing otherwise makes this line look redundant and
      // that path look uncovered - both wrong, in opposite directions.
      flushOutbox();

      // Same moment, and NOT covered by the reconnect listener: an app killed while offline comes
      // back with the link already up, so no `online` edge ever fires for the exit it still owes.
      void flushPendingGroupExits();
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
    // part: the connection watchdog would schedule a reconnect every tick against a network that is
    // not there, and an offline session has no access token for the handshake to carry anyway - so
    // every attempt is known-futile before it is made, which is the one case where NOT retrying is
    // the right answer. promoteOfflineSession starts all of this once a token exists.
    if (offlineSession) return;

    // The same pass as the sync above, so the absent groups it asked about are not asked again.
    runGroupDiscoveryImpl(ctx, cb, ctx.ensureMls(), '', passVerdicts);

    // Graine retention, once per boot and LEADER-ONLY: two tabs sweeping would ask the same
    // question twice and race each other's deletes. Deliberately after the startup bench is closed
    // - it is maintenance, not startup, and nothing waits on it. Its own failures are logged and
    // swallowed inside; the catch here only exists because this call site cannot await it.
    sweepExpiredGraineSeeds().catch((e: unknown) => {
      console.warn(`[GRAINE] retention sweep threw: ${String(e)}`);
    });

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
    // A login that failed shows nothing it drew before the session: the PIN gate, the recovery
    // modal or the login page come back over the same screen they would have without F1.
    withdrawLandingPreview(`login did not complete (${loginErrorCode(_e)})`);
    // THE SHOWN SENTENCE AND THE LOGGED ONE ARE NOT THE SAME STRING, which is the whole of the
    // defect this closes. Six of the throws below this catch are `LoginFailure(code, m.auth_...())`
    // and their message IS the French line the member must read; everything else - a
    // `SessionExpiredError` carrying "Session expired - please log in again", a `TypeError` from a
    // dead socket, a bug of our own - reached the same field verbatim, in English.
    const shown = localizedMessage(_e, m.auth_pin_login_failed());
    const code = loginErrorCode(_e);
    ctx.setLoginError(shown);
    // AN ORDINARY OUTCOME IS NARRATED, A DEFECT IS ACCUSED - see `isExpectedLoginOutcome` for why
    // one catch cannot say both with one level. The code is read here rather than below because the
    // log is the first thing anybody looks at, and a mistyped PIN or a train tunnel filed under
    // `[INIT] Login failed` beside a WASM that would not load is a line whose reader learns to skip
    // it. The code is NAMED in the line so the two can still be told apart at a glance.
    if (isExpectedLoginOutcome(code)) {
      cb.log(`[INIT] Login did not complete (${code}): ${String(_e)}`);
      console.warn(`[INIT] Login did not complete (${code}):`, _e);
    } else {
      cb.log(`Error: ${String(_e)}`);
      console.error(`[INIT] Login failed (${code}):`, _e);
    }
    ctx.resetMls();
    // THIS ACCOUNT'S SLOT ONLY: another account's, and the unlabelled one of an older build, are not
    // this login's to judge - a refused unlabelled key may be the previous account's, kept for it.
    clearDeviceKey(ctx.getUserId());
    // And a refused key leaves the session too: it was never this account's to hold.
    if (isVaultRefusal(code)) ctx.setDeviceKey('');
    // A dead session (refresh cookie expired/revoked) is not retryable via the PIN modal:
    // hand it to onSessionExpired so the caller logs out and redirects to /login. When no
    // callback is wired, redirect directly so the user is never stranded in the modal.
    //
    // THE REMEMBERED IDENTITY IS FORGOTTEN ON THIS BRANCH ONLY, because it is the only failure
    // that says anything about WHO is signed in. A wrong PIN, an empty keystore, an unopenable
    // state or a server nobody reached all leave the same person at the same gate - and forgetting
    // them there is what broke the PIN modal's "use biometrics": it reads the remembered id, found
    // none, and stopped before any keystore read (check U step 5, Mi 9T 2026-09-28). A revoked
    // device needs nothing here either: `wipeRevokedDevice` has already forgotten it.
    if (_e instanceof SessionExpiredError) {
      clearUserLocally();
      if (cb.onSessionExpired) cb.onSessionExpired();
      else void goto(resolve('/login'), { replaceState: true });
    } else if (cb.onLoginFailed) {
      cb.onLoginFailed(shown, code);
    } else {
      const loc = window.location;
      void goto(resolve(internalPath(loginReturningTo(loc.pathname, loc.search, loc.hash))), {
        replaceState: true,
      });
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
  // push_context.json - and THIS ACCOUNT'S slot of it: a key another account left is never offered
  // (`loadDeviceKey`), and the unlabelled one of an older build must prove its owner in the login.
  try {
    const userId = ctx.getUserId();
    const vaulted = await loadDeviceKey(userId);
    if (!vaulted) {
      appendLog('[PIN] No device key in vault for this account - auto-login impossible');
      return false;
    }
    // Builds before the derivation existed stored the raw PIN under this key. Such a value can
    // never decrypt anything, so refuse the auto-login and let the PIN modal re-derive a real
    // key rather than failing deeper in the crypto stack with an opaque error.
    if (!isValidDeviceKeyB64(vaulted.deviceKeyB64)) {
      appendLog('[PIN] Vaulted device key is not a 32-byte key - discarding, PIN required');
      if (vaulted.ownerProven) clearDeviceKey(userId);
      else forgetUnlabelledDeviceKey();
      return false;
    }
    appendLog(
      vaulted.ownerProven
        ? '[PIN] Device key restored from PinVault - auto-login…'
        : '[PIN] Device key restored from the UNLABELLED PinVault - auto-login, owner to be proven…'
    );
    // This account's key is in hand and nobody is prompted: pages may draw its local data (F1).
    if (vaulted.ownerProven) noteUnlockUnattended(userId);
    ctx.setDeviceKey(vaulted.deviceKeyB64);
    await loginImpl(ctx, cb, { vaultOwnerUnproven: !vaulted.ownerProven });
    return ctx.isLoggedIn();
  } catch (e) {
    // EVERY SWALLOWED BRANCH LOGS: `false` sends the member to the PIN gate, and a throw here that
    // said nothing would look exactly like an empty vault.
    appendLog(`[PIN] Vault auto-login threw - PIN required: ${String(e)}`);
    return false;
  }
}

/**
 * Biometric login: delegates to loginImpl() WITHOUT a PIN. The platform keystore
 * (Android KeyStore / iOS Keychain) holds the MLS decryption key directly (see
 * docs/wiki/frontend/modules/auth.md, "Where the key lives"). `retrieve_device_key`
 * triggers the single biometric prompt.
 *
 * When the keystore is empty (first launch, app reinstall), the biometric prompt
 * still appears (user-presence check) but loginImpl will surface a clean
 * "keystore empty" error — the caller should then fall back to the PIN modal
 * without showing an error to the user.
 *
 * `opts.unattended` reads the key with NO sheet. The CALLER decides it, because only the caller
 * knows whether a person asked for the sheet: the cold-launch flow asks the biometric cadence, a tap
 * on "use biometrics" never does. A successful PROMPTED unlock is recorded here - and only that one,
 * or an unattended unlock would renew the window it depends on without any proof.
 */
export async function biometricLoginImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  opts: { unattended?: boolean } = {}
): Promise<void> {
  ctx.setLoginError('');
  const unattended = opts.unattended === true;
  cb.log(`[BIOMETRIC] Biometric login attempt (keystore key path, unattended=${unattended})...`);
  try {
    const savedUser = currentUserId();
    if (!savedUser) {
      ctx.setLoginError(m.auth_biometric_no_user());
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
    await loginImpl(ctx, cb, { unattendedKeyRead: unattended });
    if (!unattended && ctx.isLoggedIn()) {
      const { recordPromptedBiometricUnlock } = await import('$lib/services/biometricCadence');
      recordPromptedBiometricUnlock();
    }
  } catch (e) {
    ctx.setLoginError(m.auth_biometric_failed_fallback());
    cb.log(`[BIOMETRIC] Exception: ${String(e)}`);
    console.error(e);
  }
}

/**
 * Fetches this user's PIN salt from the server. The salt is the shared input to BOTH the
 * account verifier ({@link computePinVerifier}) and this device's at-rest key
 * ({@link deriveDeviceKeyB64}), so every flow that touches the PIN needs it.
 */
async function fetchPinSalt(ctx: SessionContext, userId: string, token: string): Promise<string> {
  const res = await fetchOrUnreachable(
    `${ctx.getHistoryBaseUrl()}/api/mls/security/pin-salt/${encodeURIComponent(userId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
    m.auth_pin_salt_unreachable()
  );
  if (!res.ok) throw new LocalizedError(m.auth_pin_salt_unreachable());
  const { salt } = (await res.json()) as { salt: string };
  return salt;
}

/**
 * Starts the salt round trip for the signed-in user while the PIN keypad is up (see
 * `pinSaltAhead.ts` for why, and for the lifecycle).
 *
 * CALLED FOR A RETURNING USER ONLY: `GET pin-salt` WRITES for a user without a salt (it creates the
 * placeholder row that `pin-status` then reads as "registered"), so asking ahead on a first setup
 * could turn an abandoned keypad into a skipped PIN choice. A returning user's salt already exists
 * and the call reads it.
 */
export function prefetchPinSaltImpl(ctx: SessionContext, log: (msg: string) => void): void {
  const userId = ctx.getUserId();
  askPinSaltAhead(userId, async () => fetchPinSalt(ctx, userId, await getToken()), log);
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
 *  2. Re-derive this device's key from the new PIN and re-seal every device-key-sealed store
 *     (messages, Graine seeds, outbox) and the MLS state under it ({@link performPinChange}).
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
  if (!userId.trim()) throw new LocalizedError(m.auth_no_user_signed_in());
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
  if (res.status === 403) throw new LocalizedError(m.auth_pin_change_current_incorrect());
  if (!res.ok) throw new LocalizedError(m.auth_pin_change_server_error());
  log('[PIN_CHANGE] Account verifier rotated server-side.');

  // Derive both device keys from the same salt: the old one to read the existing state,
  // the new one to re-seal it.
  const [currentDeviceKeyB64, newDeviceKeyB64] = await Promise.all([
    deriveDeviceKeyB64(userId, currentPin, salt),
    deriveDeviceKeyB64(userId, newPin, salt),
  ]);

  // The live client, whose state is already open under the current key - which the server verifier
  // has just proven, so no stored row can refuse it.
  try {
    await performPinChange(
      {
        userId,
        mls: ctx.ensureMls(),
        setDeviceKey: (k: string) => ctx.setDeviceKey(k),
        log,
        onProgress,
      },
      currentDeviceKeyB64,
      newDeviceKeyB64
    );
  } catch (e) {
    if (e instanceof KeyChangeInterruptedError) {
      // The unattended unlock already holds the new key while the MLS state may not: this session
      // must not run on, and the recovery (old PIN, new PIN) is what finishes the move.
      log(
        `[PIN_CHANGE] Interrupted at the ${e.stage} step - ending the session into the recovery.`
      );
      endIntoKeyRecovery('the PIN change was interrupted');
      throw new LocalizedError(m.auth_pin_change_interrupted());
    }
    throw e;
  }
  log('[PIN_CHANGE] Complete - local state re-encrypted under the new PIN.');
}

/**
 * "PIN changed on another device" recovery. The account PIN was rotated elsewhere, so
 * this device's local state is still sealed under the OLD pin while the server now expects the
 * NEW one. Both keys derive from the same salt, so the old one is still derivable here: every
 * sealed store (messages, Graine seeds, outbox) and the MLS state (opened non-destructively with
 * the old key) move to the new one through `performPinChange`, the in-session change's own path,
 * then a normal login follows - preserving everything instead of falling back to a fresh start.
 * It is also how an in-session change killed half way is finished (see `performPinChange`).
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
  if (!userId.trim()) throw new LocalizedError(m.auth_no_user_signed_in());
  cb.log('[PIN_RECOVER] Starting recovery...');
  onProgress?.({ percent: 3, stage: 'verify' });

  // The state is read as a signed-out session LEFT it, so its final checkpoint lands first (see
  // `loginImpl`), and the client that wrote it is retired before `ensureMls` below builds ours.
  await ctx.whenMlsRetired();
  const { loadMlsState } = await import('$lib/utils/hex');
  const state = await loadMlsState(userId);
  if (!state) {
    throw new LocalizedError(m.auth_no_local_state_recover());
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
  if (!res.ok) throw new LocalizedError(m.auth_pin_verify_new_unreachable());
  const data = (await res.json()) as { status: string };
  if (data.status !== 'ok') {
    throw new LocalizedError(m.auth_pin_new_incorrect());
  }

  // Both device keys come from the same salt: the old one still seals the local state,
  // the new one is what every device will derive from now on.
  const [oldDeviceKeyB64, newDeviceKeyB64] = await Promise.all([
    deriveDeviceKeyB64(userId, oldPin, salt),
    deriveDeviceKeyB64(userId, newPin, salt),
  ]);

  // THE SAME PATH AS AN IN-SESSION CHANGE (`performPinChange`). Only the MLS source differs: the
  // stored blob, opened (non-destructively) with the old key - the proof the old PIN is right.
  try {
    await performPinChange(
      {
        userId,
        mls: ctx.ensureMls(),
        storedMlsState: state,
        setDeviceKey: (k: string) => ctx.setDeviceKey(k),
        log: cb.log,
        onProgress,
      },
      oldDeviceKeyB64,
      newDeviceKeyB64
    );
  } catch (e) {
    if (e instanceof DeviceKeyMismatchError) {
      cb.log('[PIN_RECOVER] The old PIN does not open the local MLS state - nothing was changed.');
      throw new LocalizedError(m.auth_pin_old_incorrect());
    }
    if (e instanceof LocalStateUnopenableError) {
      cb.log(
        `[PIN_RECOVER] The local MLS state opens with no PIN (${e.failure}) - nothing changed.`
      );
      throw new LocalizedError(m.auth_pin_recover_state_unopenable());
    }
    if (e instanceof KeyChangeInterruptedError) {
      // Not logged in yet, so there is no session to end: the same two PINs finish what moved.
      cb.log(`[PIN_RECOVER] Interrupted at the ${e.stage} step - the same two PINs finish it.`);
      throw new LocalizedError(m.auth_pin_recover_interrupted());
    }
    throw e;
  }
  ctx.setPin(newPin);
  cb.log('[PIN_RECOVER] Local state re-sealed with the new device key.');

  onProgress?.({ percent: 92, stage: 'login' });
  // Continue with a normal login. init() is a no-op (openLocalStateWithKey already marked the
  // client initialised), so the decrypted client is reused and all messages are kept.
  await loginImpl(ctx, cb);
  if (!ctx.isLoggedIn()) {
    throw new LocalizedError(m.auth_login_failed_after_recovery());
  }
  onProgress?.({ percent: 100, stage: 'login' });
  cb.log('[PIN_RECOVER] Complete - messages preserved.');
}

/**
 * Stops everything this session is running, and stops it for good.
 *
 * ONE SEAM FOR "THIS SESSION IS OVER", because the two exits differ only in what they may still
 * write. A sign-out and a revocation both leave a five-second watchdog, an outbox, four timers and
 * a set of listeners behind, and only `logoutImpl` ever took them down: the revocation path set its
 * flags and wiped the disk while the SYNC_WATCHDOG kept ticking. Measured on prod 2026-08-28:
 * 1.25 s after a device was revoked and wiped, the watchdog found ten conversations still in memory
 * and an empty WASM, and drove `requestReAdd` for all ten - re-marking every group not-ready and
 * REBUILDING the MLS database through `ensureMls()`, which creates a client whenever it finds none.
 * A wipe is not a wipe while something is still running that can put the state back.
 *
 * `reason` is the only discriminator, and both differences follow from it. A revoked device must not
 * FLUSH its MLS state on the way out - that write is the one thing the wipe exists to remove - and
 * must not deregister its push token, which the server already deleted when it revoked the device,
 * so asking would earn a 401 and nothing else.
 *
 * It deliberately does NOT clear the auth token or the storage handle: `clearAuth` needs the token
 * to revoke the refresh credential, and the wipe needs the handle to close the connection that
 * would otherwise defer every delete. Each caller owns its own erasure, in its own order.
 */
export function tearDownLiveSession(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  reason: 'logout' | 'revoked'
): Promise<void> {
  unregisterOutbox();
  // Detach the reconnect listener too, or a regained network would promote a session that no
  // longer exists - reopening a WebSocket for the user who just signed out.
  unregisterOfflinePromotion();
  // Same reason: an exit owed by the user who just signed out must not be replayed with the next
  // one's token. The row survives in storage, and that user's next login replays it.
  unregisterPendingGroupExitDrain();
  resetHistoryReconciliation();
  // A Welcome this session sent says nothing about the next user's requests.
  resetWelcomeSent();
  // The probe sender closes over this session's storage and device key, so it must not outlive it:
  // a reconciliation from the next login would otherwise describe the previous user's store.
  setHistoryProbeSender(null);
  // Same reason, and the presence poll outlives a logout: an edge arriving afterwards would
  // reconcile history for the user who just signed out.
  unregisterPeerReturn?.();
  unregisterPeerReturn = null;

  // THE PERSISTER THIS SESSION REGISTERED, named now: the removal below runs after the final flush,
  // and only what this session installed may be removed then (see `unregisterMlsStatePersister`).
  const persister = activeMlsStatePersister();
  const releasePersister = () => {
    uninstallMlsStatePersisterLifecycle(persister);
    unregisterMlsStatePersister(persister);
    // The encrypt worker is shared and recreated on demand; it is disposed only when no session
    // has registered a persister since - the one that has may be using it.
    if (activeMlsStatePersister() === null) disposeMlsEncryptWorker();
  };
  let finalWrite: Promise<void>;
  if (reason === 'logout') {
    // Dispose after the final flush: flushEncrypted relies on the encrypt worker. NEVER REJECTS:
    // the caller chains the MLS client's retirement, and the next login's wait, on it.
    finalWrite = flushActiveMlsStateEncrypted()
      .catch((e) => console.error(`[LOGOUT] Final MLS checkpoint failed: ${String(e)}`))
      .then(releasePersister);
  } else {
    // NO FINAL FLUSH FOR A REVOKED DEVICE. Persisting the state the next step deletes is precisely
    // the write that must not survive the wipe, so the persister is uninstalled without one.
    releasePersister();
    finalWrite = Promise.resolve();
  }

  if (reason === 'logout') {
    const tokenForPushCleanup = ctx.getAuthToken();
    const deviceForPushCleanup = ctx.getMyDeviceId();
    if (isRefreshCredentialProvenDead()) {
      // A DEAD SESSION ENDING: the server already refused this session's credential, so the
      // deregistration would only earn a refusal - known here, so it is not asked.
      cb.log('[LOGOUT] Push token left registered - the session is already dead on the server.');
    } else if (tokenForPushCleanup && deviceForPushCleanup) {
      void stopPushService(ctx.getHistoryBaseUrl(), tokenForPushCleanup, deviceForPushCleanup);
    }
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
  stopConnectionWatchdogImpl(ctx);
  ctx.setReconnectAttempts(0);
  ctx.setTabLeaderSessionCb(null);
  ctx.setIsLoggedIn(false);
  ctx.setIsWsConnected(false);
  // A pause belongs to the session that was backgrounded; the next one starts in the foreground.
  ctx.setConnectionPaused(false);
  ctx.setIsMessagingInitializing(false);
  // The watchdog's candidate set IS the live conversation map, so emptying it is half of why
  // nothing can drive recovery for a session that has ended.
  cb.conversations.clear();
  resetSalonUnread();
  cb.setSelectedContact(null);
  setCallSystemMessageContext(null);
  // Decrypted Graine seeds and the channel-to-community map belong to the account that just left.
  setGraineRuntime(null);
  ctx.getCallService()?.setChatNotifier(null);
  resetSiblingCallWarning();
  return finalWrite;
}

/**
 * Ends the live session on the device because the user signed out - the device half of `clearAuth`.
 *
 * REACHED FROM `clearAuth` ITSELF (through `setSignOutHandler`, wired by the app shell), because
 * every sign-out in the app is `clearAuth()` then `/login` and none of them could reach the session.
 * This used to be `logoutImpl`, which had NO caller since 2026-04-09: the navbar refactor dropped the
 * last one, so a sign-out ended the session on the server and left it live on the device - socket
 * resume armed, `isLoggedIn` true. Measured on the Mi 9T 2026-10-14: the foreground resume after the
 * sign-in browser reconnected that ghost session before the OIDC callback had its token, met the dead
 * credential, and the new sign-in was never unlocked.
 *
 * IDEMPOTENT ON THE SESSION'S OWN STATE: a session that is not logged in has nothing running, which
 * is also what keeps the revocation wipe's `clearAuth` from running a second, flushing teardown.
 *
 * What a PIN protects is untouched - `mls.bin`, the message database and the device-key vault -
 * because a sign-out keeps the local state (user, "deconnecter seulement, garder l'etat"); the
 * identity and the credentials are `clearAuth`'s own work.
 */
export function endSessionImpl(ctx: SessionContext, cb: ChatSessionCallbacks): void {
  if (!ctx.isLoggedIn()) {
    cb.log('[LOGOUT] Signed out with no live session on this device - nothing to stop.');
    return;
  }
  cb.log(`[LOGOUT] Signing out userId=${ctx.getUserId()?.slice(0, 8) ?? 'unknown'}...`);
  // THE SOCKET GOES BEFORE THE FINAL FLUSH. The gateway does not close it when the server revokes the
  // session, and the teardown below unregisters the state persister: left open, it kept decrypting
  // and ACKing the leaving account's frames, and every MLS advance they made after the flush was in
  // memory only - lost at the next process death, an epoch behind what the server had delivered.
  try {
    ctx.ensureMls().pauseSocket();
  } catch (e) {
    cb.log(`[LOGOUT] Could not release the socket - frames may still arrive: ${String(e)}`);
  }
  const finalWrite = tearDownLiveSession(ctx, cb, 'logout');
  // THE CLIENT LEAVES WITH ITS ACCOUNT. Kept, it served the next sign-in as it was: `init` returns at
  // once on a client that ran, and `resolveDeviceId` hands back its cached id - so account B unlocked
  // on account A's state and device id. Let go of NOW, destroyed once the final checkpoint above has
  // landed; `loginImpl` waits for that before it opens any state. See `mlsHolder.ts`.
  void ctx
    .retireMls(finalWrite)
    .then(() => cb.log('[LOGOUT] MLS client retired - the next sign-in opens the state afresh.'));
  notificationPreferences.reset();
  // The announcement asked for, and the one waiting, belong to the account that is leaving: without
  // this the next account signing in in the same tab was never asked on its own behalf (the store's
  // `checked` latch stayed set) and could be shown the previous account's.
  resetAnnouncementState();
  ctx.setStorage(null);
  ctx.setAuthToken('');
  cb.log('[LOGOUT] Live session stopped.');
}
