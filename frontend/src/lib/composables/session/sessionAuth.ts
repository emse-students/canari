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
import { reportRejectionOnce } from '$lib/utils/reportRejectionOnce';
import { SvelteSet } from 'svelte/reactivity';
import { getStorage, type IStorage } from '$lib/db';
import { resetSalonUnread } from '$lib/utils/chat/salonUnread';
import { computePinVerifier } from '$lib/utils/chat/auth';
import {
  DeviceKeyMismatchError,
  KeyChangeInterruptedError,
  KeyChangeSupersededError,
  LocalStateUnopenableError,
  LocalStateUnreadableNowError,
  moveSealedStoresOnly,
  performPinChange,
  thisTabMayChangeDeviceKey,
  type PinProgressCallback,
} from '$lib/utils/chat/pinChange';
import { endIntoKeyRecovery, joinDeviceKeyLock } from '$lib/db/deviceKeyGate';
import { deriveDeviceKeyB64, isValidDeviceKeyB64 } from '$lib/crypto/deviceKey';
import {
  HardwareKeyUnavailableError,
  hardwareHeldKeyApplies,
  noteHardwareHeldDeviceKey,
  readHardwareHeldKey,
  tauriHardwareKeyPort,
  type AtRestKeyScheme,
  type HardwareKeyPort,
} from '$lib/crypto/hardwareHeldKey';
import {
  finishMigrationAtUnlock,
  settledAtRestScheme,
  startHardwareKeyMigration,
} from '$lib/utils/chat/hardwareKeyMigration';
import { noteBackupOwedAfterKeyMove } from '$lib/crypto/deviceRecoveryCode';
import { showToast } from '$lib/stores/toast.svelte';
import { fetchOrUnreachable } from '$lib/utils/fetchOrUnreachable';
// Every `throw` below whose message is a Paraglide line is a `LocalizedError`: the modals rendering
// these PIN flows must be able to tell "the PIN you typed is not the current one" from a browser's
// `Failed to fetch`, and only the THROW knows which it is.
import { LocalizedError, localizedMessage } from '$lib/utils/localizedError';
import { refusalFromResponse } from '$lib/utils/apiRefusalError';
import { describeRefusalCode } from '$lib/utils/refusalCodes';
import {
  LoginFailure,
  LoginStoppedBySignOutError,
  type LoginStop,
  hardwareKeyLoginFailure,
  isExpectedLoginOutcome,
  isVaultRefusal,
  loginErrorCode,
} from './loginErrors';
import {
  SavedStateUnopenedError,
  SavedStateOfAnotherAccountError,
  isKeystoreKeyUnavailable,
  VaultOwnerUnprovenError,
  LocalStateNotReadyError,
  type IMlsService,
  type VaultRefusal,
} from '$lib/mls-client';
import { MlsStateWriteRefusedError } from '$lib/utils/hex';
import {
  getToken,
  clearAuth,
  SessionExpiredError,
  SignOutInProgressError,
  isRefreshCredentialProvenDead,
  revokedDeviceOfEndedSession,
  signOutGeneration,
} from '$lib/stores/auth';
import { IdentitySplitError, isIdentitySplit } from '$lib/stores/tokenIdentity.svelte';
import { bindCurrentSessionDevice } from '$lib/services/authSessions';
import { ensureRestoreKey } from '$lib/services/restoreCredential';
import {
  clearRestoreKey,
  forgetRestoreKeyRegistrations,
  markRestoreAttempted,
} from '$lib/services/restoreKey';
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
import { measureRestoreShortfall } from '$lib/utils/chat/restoreShortfall';
import { graineRepairHoldObserver, setGraineRuntime } from '$lib/utils/graine/runtime';
import { clearParkedAsks } from '$lib/utils/graine/parkedAsks';
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
import { forgetRefusedRotationReloads } from '$lib/mls-client/refusedRotationReloads';
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
  isDeviceKeyPersistenceEnabled,
  retireUnlabelledDeviceKeyIfOwnedBy,
} from '$lib/utils/deviceKeyVault';
import { askPinSaltAhead, forgetPinSaltAhead, takePinSaltAhead } from './pinSaltAhead';
import { unlockWithPin, type PinCheckAnswer } from './pinUnlock';
import { wipeDeviceToFactory } from '$lib/utils/deviceReset';
import { startPushService, stopPushService } from '$lib/services/PushNotificationService';
import { consumeFcmCache } from '$lib/utils/chat/fcmCache';
import type { PushPlaceholder } from '$lib/utils/chat/fcmCache';
import { consumeNativeReadWatermarks } from '$lib/utils/chat/readWatermarkCache';
import {
  adoptOrphanedMirrorEntries,
  dateBackgroundSentRow,
  reconcileOutboxSent,
} from '$lib/utils/chat/outboxMirror';
import { mergeFcmMessagesIntoConversations } from '$lib/utils/chat/fcmMemoryMerge';
import { appendLog } from '$lib/utils/sessionLog';
import { Log } from '$lib/utils/Log';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { isLikelyPrivateBrowsing } from '$lib/utils/isLikelyPrivateBrowsing';
import {
  handleHistoryRequest,
  processPendingInvitations,
  raiseAnnouncedJoinAsk,
} from '$lib/utils/chat/actions';
import type { JoinApprovalRequest } from '$lib/utils/chat/actions';
import {
  raiseJoinRequest,
  settleJoinRequest,
  beginJoinRequestSweep,
  settleSweptJoinRequests,
} from '$lib/utils/chat/joinRequests.svelte';
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
import { applyRestoredLifecycles } from '$lib/utils/chat/admissionState';
import {
  captureGroupReadyAnnouncer,
  setGroupReadyAnnouncer,
} from '$lib/utils/chat/groupReadyAnnouncer';
import {
  registerOutbox,
  unregisterOutbox,
  flushOutbox,
  resumeOutboxGroup,
  applyOutboxPendingStatuses,
  OutboxPrepareRefusedError,
  type PreparedOutboxMedia,
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
import type { CallEndReason, ICallMsg } from '$lib/proto/codec';
import {
  closeDeletedAccountHandles,
  wipeDeletedAccountLocalData,
} from '$lib/utils/accountLocalWipe';
import type { SessionContext, ChatSessionCallbacks } from './sessionTypes';
import {
  scheduleReconnectImpl,
  runGroupDiscoveryImpl,
  startConnectionWatchdogImpl,
  stopConnectionWatchdogImpl,
} from './sessionConnection';
import { startSyncWatchdogImpl } from './sessionWatchdogs';
import { takeKeyGroupPushJoins } from '$lib/utils/graine/keyGroupPushJoins';
import { drainNseOutcomes } from '$lib/mobile/nseOutcomes';
import { uploadClassFor } from '$lib/reels/chatReelWriter';
import { ACCOUNT_KEY, SESSION_META_STORE } from '$lib/utils/accountLocalKeys';
import { isDeletedAccountHere } from '$lib/utils/deletedAccountMarker';
import { registerDeviceNotices } from '$lib/utils/chat/deviceNoticeWiring';

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
/**
 * The login that set `isLoginInProgress` last, by its `loginSeq` number. A login clears the flag only
 * while it still owns it: `handlePinSubmit` clears the flag to start a sign-in beside a login still
 * running, and that older login's exit must not release the newer one's flow.
 */
let loginFlowOwner = 0;
/**
 * Settles when the login holding the flow has ended - its catch or its success, never a clock. A
 * sign-out during that login retires the MLS client ON IT (`endSessionImpl`): the holder lets go at
 * once, so the next sign-in waits (`whenMlsRetired`) and then builds its own client, and the stopped
 * login's client is destroyed only once that login has released its socket. Null when no login runs.
 */
let loginInFlightSettled: Promise<void> | null = null;
/**
 * Cancels the network waits of the login in flight, aborted by a sign-out (`endSessionImpl`). The
 * retirement above waits for that login to END, and a request with no deadline (a refresh, the PIN
 * salt, pin-check, the revocation question) would hold the next sign-in behind it for as long as the
 * network chose. The sign-out ends those waits by cancelling them, not a clock. Null when no login runs.
 */
let loginInFlightAbort: AbortController | null = null;

/**
 * What stopped the flow in flight, read from its abort: `endLostSessionImpl` aborts with the
 * {@link LoginStop} `'lost session'` as the reason, a sign-out with none. A typed value the abort
 * carries, never a message.
 */
function loginStopOf(signal: AbortSignal): LoginStop {
  return signal.reason === 'lost session' ? 'lost session' : 'sign-out';
}

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
    // An external join is the other way a group becomes ready, and it owes what a Welcome owes -
    // to THIS session only: captured now, it announces nothing once the session has ended.
    onGroupReady: captureGroupReadyAnnouncer(),
  };
}

/** The pending debounce of {@link announceGroupReady}'s invitation sweep, one per session. */
const groupReadySweeps = new WeakMap<SessionContext, ReturnType<typeof setTimeout>>();

/**
 * ONE GROUP JUST BECAME SENDABLE - a Welcome installed (the message pipeline's `onGroupReady`) or an
 * external join landed (`requestReAdd`, through `RecoveryDeps.onGroupReady`). ONE function for both,
 * because what is owed is the same and the external join used to owe it and do none of it: its row
 * went `active` and nothing resumed the messages held for the group.
 *
 * Owed, in order: the entries held for this group are resumed and the queue drained
 * (`resumeOutboxGroup`, which skips their backoff - a plain flush did not); their statuses are
 * refreshed; the askers this group kept waiting are served; and the invitation sweep runs, debounced
 * once per session, since a burst of Welcomes needs one sweep.
 *
 * NOT EXPORTED, AND REACHED ONLY THROUGH THE REGISTRY: every one of those steps reaches module-level
 * state, so a call that lands after this session ended acts on the next. The session registers this
 * function (`setGroupReadyAnnouncer`) and every `onGroupReady` is `captureGroupReadyAnnouncer()`,
 * whose one liveness check is the only way in.
 */
function announceGroupReady(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  readyGroupId: string
): void {
  resumeOutboxGroup(readyGroupId);
  void applyOutboxPendingStatuses();
  // The askers this group kept waiting. Served through the SAME path the socket uses, so one that
  // is still too early is put back on the queue rather than dropped: "ready" here is the MLS group
  // becoming sendable, which is not yet this device's conversation row.
  void drainDeferredWelcomeRequests(makeWelcomeRequestContext(ctx, cb), readyGroupId);
  const pending = groupReadySweeps.get(ctx);
  if (pending !== undefined) clearTimeout(pending);
  groupReadySweeps.set(
    ctx,
    setTimeout(() => {
      groupReadySweeps.delete(ctx);
      processDeviceInvitationsLocally(ctx, cb).catch((e: unknown) =>
        cb.log(`[SYNC] invitation sweep after a group became ready failed: ${String(e)}`)
      );
    }, 500)
  );
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
    onCaughtUp: () => ctx.onConnectionCaughtUp(),
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
      transport?: import('$lib/utils/uploadXhr').XhrUploadOptions,
      resume?: { persist: (state: import('$lib/db/types').OutboxResumableUpload) => Promise<void> }
    ) => {
      const { MediaService } = await import('$lib/media');
      const bytes = media.fileBytes ?? new Uint8Array(0);
      const retentionClass = uploadClassFor(media);
      // A CHAT REEL GOES THROUGH A RESUMABLE SESSION (RC-5): a cut or a kill resends only the parts
      // the server lacks. It is sealed from the outbox's own bytes, part by part - no `File` copy.
      // Everything else keeps the one-shot route it always took.
      if (retentionClass === 'chat-reel' && resume) {
        return new MediaService().uploadResumably(
          bytes,
          { mimeType: media.mimeType, fileName: media.fileName },
          getToken,
          { width: media.width, height: media.height },
          retentionClass,
          { state: media.upload, persist: resume.persist },
          transport
        );
      }
      const file = new File([bytes.buffer as ArrayBuffer], media.fileName ?? 'file', {
        type: media.mimeType,
      });
      const token = await getToken();
      return new MediaService().encryptAndUpload(
        file,
        token,
        { width: media.width, height: media.height },
        retentionClass,
        transport
      );
    },
    prepareMedia: prepareQueuedChatReel,
    releaseUpload: async (uploadId: string, why: string) => {
      const { MediaService } = await import('$lib/media');
      await new MediaService().releaseResumableUpload(uploadId, getToken, why);
    },
  };
}

/**
 * Prepares a queued RAW chat-reel take for the outbox (RC-5) with the encoder the composer used for
 * it before (`prepareVideoForUpload`, the server's plaintext ceiling as its budget). A cancel is
 * re-thrown as the outbox's `UploadAbortedError`, so it is read as the member's act and never as a
 * failure of the take.
 */
async function prepareQueuedChatReel(
  media: NonNullable<import('$lib/db').OutboxEntry['media']>,
  opts: { signal: AbortSignal; onProgress: (fraction: number) => void }
): Promise<PreparedOutboxMedia> {
  const [
    { MediaService },
    { prepareVideoForUpload, isVideoPrepareError },
    { UploadAbortedError },
    { videoPrepareFailureMessage, isUnpreparableFault },
  ] = await Promise.all([
    import('$lib/media'),
    import('$lib/video/prepareVideoForUpload'),
    import('$lib/utils/uploadXhr'),
    import('$lib/video/videoPrepareMessages'),
  ]);
  const raw = media.fileBytes ?? new Uint8Array(0);
  const source = new File([raw.buffer as ArrayBuffer], media.fileName ?? 'take', {
    type: media.mimeType,
  });
  const limits = await new MediaService().uploadLimits();
  try {
    const prepared = await prepareVideoForUpload(source, {
      maxBytes: limits?.maxPlaintextBytes,
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    return {
      bytes: new Uint8Array(await prepared.file.arrayBuffer()),
      mimeType: prepared.file.type,
      fileName: prepared.file.name,
      width: prepared.width,
      height: prepared.height,
      durationMs: Math.max(1, Math.round(prepared.durationSeconds * 1000)),
    };
  } catch (e) {
    if (isVideoPrepareError(e) && e.fault === 'aborted') {
      throw new UploadAbortedError(opts.signal.reason);
    }
    // A FACT OF THE TAKE OR THE ENGINE, classified here at the throw by its typed fault: failed for
    // good with the composer's own sentence for it, never a retry that is refused the same way.
    if (isVideoPrepareError(e) && isUnpreparableFault(e.fault)) {
      throw new OutboxPrepareRefusedError(
        videoPrepareFailureMessage(e) ?? m.video_prepare_failed(),
        e
      );
    }
    throw e;
  }
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
    onJoinApprovalRequested: raiseJoinRequest,
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
    // A new person's pending device is never added by the sweep; it raises a member's approval. The
    // sweep reads the server's durable rows, so what a completed one raised replaces what is shown.
    const raised: JoinApprovalRequest[] = [];
    const notSwept = new Set<string>();
    // Before the sweep reads anything: an ask announced while it reads is not its to take away.
    const sweep = beginJoinRequestSweep();
    const swept = await processPendingInvitations({
      mlsService: ctx.ensureMls(),
      storage: ctx.getStorage(),
      userId: ctx.getUserId(),
      deviceKeyB64: ctx.getDeviceKey(),
      conversations: cb.conversations,
      requestReAdd: (groupId: string) => requestReAdd(groupId, makeRecoveryDeps(ctx, cb)),
      log: cb.log,
      onJoinApprovalRequested: (request) => raised.push(request),
      onGroupNotSwept: (groupId) => notSwept.add(groupId),
    });
    if (swept) settleSweptJoinRequests(sweep, raised, notSwept);
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

/**
 * The login failure for a saved state that `init` refused to open or replace - under `noFreshStart`,
 * or for a cause that proves nothing about the bytes, which is never replaced
 * (`recoveryOfStateLoadFailure`).
 *
 * READ FROM THE TYPE, NEVER FROM `reason.message`: it used to compare the message against one
 * shared marker, which collapsed every cause into one screen. Three answers now, each with the
 * sentence its cause has EARNED. Another account's state (`mls.owner`) is
 * `device_holds_other_account`, the gate withholding the reset. A framed state whose header names
 * another key (`rotated`) is a fact - the old PIN opens it - and says so without the "otherwise
 * damaged" branch, which the fingerprint has ruled out. A legacy blob or an untyped failure is
 * still only the observation, and keeps the sentence naming both remedies. An `unknown` cause proves
 * nothing and gets a retry-first sentence with no reset. `keystore_unavailable` never reaches here
 * (`recoveryOfStateLoadFailure` rethrows it to the PIN modal).
 */
export function savedStateFailure(
  reason: SavedStateUnopenedError | SavedStateOfAnotherAccountError | MlsStateWriteRefusedError
): LoginFailure {
  // The device identity rotation could not record its fresh state: another tab of this account
  // wrote the stored one after this login loaded it (`BaseMlsService.rotateDeviceIdentity`).
  // Nothing was moved, so the remedy is the other tab, never the PIN or a reset.
  if (reason instanceof MlsStateWriteRefusedError) {
    return new LoginFailure('state_written_by_another_tab', m.auth_state_written_by_another_tab());
  }
  if (reason instanceof SavedStateOfAnotherAccountError) {
    return new LoginFailure('device_holds_other_account', m.auth_vault_other_account_device());
  }
  if (reason.reason === 'rotated') {
    return new LoginFailure('local_state_sealed_under_old_pin', m.auth_local_state_old_pin());
  }
  if (reason.reason === 'unreadable_now') {
    return new LoginFailure('local_state_unreadable_now', m.auth_local_state_unreadable_now());
  }
  // An untyped cause (IPC fault, disk read, panic, install lock) proves nothing about the bytes: it
  // never earns the "damaged, only a reset helps" sentence, which pushes towards a destructive act.
  if (reason.reason === 'unknown') {
    return new LoginFailure('local_state_unknown', m.auth_local_state_unknown());
  }
  return new LoginFailure('local_state_unopenable', m.auth_local_state_unopenable());
}

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * THE EXPLICIT RESET, and the only path that frees a hardware-held key's keystore entry: the marker
 * goes ONLY once this account's database was cleared, so the next PIN unlock may store a new key
 * there. A database that survived keeps its marker - and with it the guard over the only key that
 * opens it - exactly as the account deletion does (`accountLocalWipe.ts`).
 */
export async function forgetAtRestMarkerOnceDataIsGone(
  databaseCleared: boolean,
  userId: string,
  port: Pick<HardwareKeyPort, 'forget'>,
  log: (msg: string) => void
): Promise<void> {
  if (!databaseCleared) {
    log(
      '[SECURITY] ERROR: the local database was not cleared - the at-rest key marker is KEPT, so its key stays guarded'
    );
    return;
  }
  try {
    await port.forget(userId);
    log('[SECURITY] At-rest key marker forgotten - the keystore entry is free again.');
  } catch (e) {
    log(`[SECURITY] ERROR: the at-rest key marker could not be forgotten: ${String(e)}`);
  }
}

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
  localStorage.removeItem(ACCOUNT_KEY.deviceId(userIdToReset));
  localStorage.removeItem(ACCOUNT_KEY.syncGuideSeen(userIdToReset));

  const deviceNamePrefix = ACCOUNT_KEY.deviceName(userIdToReset, '');
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

  let databaseCleared = false;
  try {
    const storageToClear = await getStorage(userIdToReset);
    await storageToClear.clear();
    databaseCleared = true;
    await storageToClear.close();
  } catch (e) {
    // Best-effort cleanup: continue even if local DB is not accessible - but never silently, since
    // a connection left open is what makes a later delete block instead of complete.
    console.warn('[SECURITY] could not clear the local database:', e);
  }

  if (hardwareHeldKeyApplies()) {
    await forgetAtRestMarkerOnceDataIsGone(
      databaseCleared,
      userIdToReset,
      tauriHardwareKeyPort,
      cb.log
    );
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
 * Removes a DELETED account's local message database and vault slot, once its session has ended.
 *
 * Called after `clearAuth()` (which ends the live session through the sign-out handler): the final
 * MLS checkpoint of that session is awaited first, so no write in flight can recreate what is
 * deleted. Never `wipeDeviceToFactory` - another account on the device keeps everything it has.
 *
 * @param ranHere the deleted account is the one this realm ran (the page showed it): its handles are
 *   closed first. FALSE when the server deleted another account than the one on screen - this realm's
 *   handles are that other account's, and the deleted one's live in the tab its notice ends.
 */
export async function wipeDeletedAccountImpl(
  ctx: SessionContext,
  log: (msg: string) => void,
  userId: string,
  ranHere: boolean
): Promise<void> {
  await ctx.whenMlsRetired();
  const failures = await wipeDeletedAccountLocalData(userId, {
    closeThisRunsHandles: ranHere,
    expectNativeDatabase: false,
  });
  log(
    failures.length === 0
      ? `[DEL-LOCAL] Local data of the deleted account removed (${userId.slice(0, 8)}).`
      : `[DEL-LOCAL] Local data of the deleted account NOT fully removed: ${failures.join(', ')}`
  );
}

/**
 * In a tab told by ANOTHER tab that its account was deleted: once `clearAuth()` has ended this
 * tab's session, waits for its final MLS checkpoint and closes its handles on that account's stores,
 * so it stops writing and the deleting tab's deferred database deletes can complete.
 */
export async function releaseDeletedAccountImpl(
  ctx: SessionContext,
  userId: string
): Promise<void> {
  await ctx.whenMlsRetired();
  await closeDeletedAccountHandles(userId);
}

/**
 * The revoked-device wipe in progress, if any - so a second discoverer of the same revocation JOINS
 * it instead of starting another (see {@link wipeRevokedDevice}).
 */
let revokedDeviceWipe: Promise<void> | null = null;

/**
 * The devices (`userId:deviceId`) a revoked-device reset has COMPLETED for in this page. A fact, not a
 * window: a discoverer arriving after the reset finished - a late `device_revoked` frame, a replay of
 * the session-expired verdict to a handler registered late - finds its device here and erases nothing
 * a second time. The page holds nothing else of that device by then; a reload starts empty, and so do
 * the stores the reset deleted.
 */
const revokedDevicesReset = new Set<string>();

/** This install's device id for `userId`, as the store every rotation rewrites holds it. */
function storedDeviceIdOf(userId: string): string | null {
  return userId ? localStorage.getItem(ACCOUNT_KEY.deviceId(userId)) : null;
}

/**
 * Returns a revoked device to a fresh install, whatever discovered the revocation.
 *
 * ONE CONSEQUENCE FOR ONE FACT. Four places learn that this device is revoked - the PIN check at
 * login, a `device_revoked` frame on a live session, a vault or biometric login asking the server,
 * and the session-expired reaction when the refresh refusal says the session died BY this
 * revocation (`revokedDeviceOfEndedSession`, the only one left once the revocation has ended
 * the session) - and the wipe must not differ between them.
 *
 * ONE RUN, WHATEVER THE ORDER OF ARRIVAL. The frame and the refusal are two discoverers of one
 * revocation and usually arrive together: the frame's own check is what meets the refusal. A call
 * while a wipe runs joins it; a call after it completed finds its device in
 * {@link revokedDevicesReset} and erases nothing again - so neither the order nor the lateness of a
 * discoverer matters. It did: the frame path skipped the MLS
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
  if (revokedDeviceWipe) {
    cb.log('[SECURITY] Revoked-device reset already running - joined, not run twice.');
    return revokedDeviceWipe;
  }
  // Read BEFORE the run: the reset deletes the very key that names the device.
  const device = `${ctx.getUserId()}:${storedDeviceIdOf(ctx.getUserId()) ?? ''}`;
  if (revokedDevicesReset.has(device)) {
    cb.log('[SECURITY] Revoked-device reset already done for this device - nothing erased again.');
    return;
  }
  cb.log('[SECURITY] Revoked-device reset starting.');
  revokedDeviceWipe = runRevokedDeviceWipe(ctx, cb);
  try {
    await revokedDeviceWipe;
    revokedDevicesReset.add(device);
  } finally {
    revokedDeviceWipe = null;
  }
}

/** The ordered steps of {@link wipeRevokedDevice}; the order is the mechanism. */
async function runRevokedDeviceWipe(ctx: SessionContext, cb: ChatSessionCallbacks) {
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
 * Answers a `device_revoked` frame on a live session: confirms the revocation with the server, then
 * runs the ONE revocation reset and hands the user to the session-expired seam.
 *
 * Its own function, not a closure inside `loginImpl`, so the ordering against the session-expired
 * reaction (`settleSessionEndByRevocationImpl`) can be driven by a test: frame first or refusal first,
 * the device must end in the same single reset (DEV-2, 2026-10-25).
 */
export async function answerDeviceRevokedFrame(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  mlsService: Pick<IMlsService, 'resolveDeviceId' | 'isDeviceRevoked'>
): Promise<void> {
  // GATED ON A SERVER FACT, NEVER ON THE FRAME. The frame says "you were deleted"; erasing a
  // device on the strength of a message is exactly the destructive-control shape that has to
  // be confirmed first. `isDeviceRevoked` answers false when it cannot reach the server, so a
  // transport failure can never destroy anything - a status code is an answer, a transport
  // failure is not. The revocation ENDS this device's session, so the check usually meets a
  // dead credential: the refresh refusal then SAYS it died by this revocation, which is the
  // answer `true` - and the session-expired reaction has already begun the same wipe, which
  // the call below joins (DEV-2, 2026-10-25).
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
  // try again" - which is right at the two login-path call sites in `loginImpl`, where a person is
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
  cb.onSessionExpired?.({ alreadySignedOut: true });
}

/**
 * The session-expired reaction's half of a revocation: when the refresh refusal said the session
 * died BECAUSE ITS OWNER REVOKED THIS DEVICE (`revokedDeviceOfEndedSession`, naming this device and
 * `account`), runs the ONE
 * revocation reset - joined if the `device_revoked` frame already began it - and answers `true`.
 * Any other dead session answers `false` and resets nothing: an expired or signed-out session keeps
 * its stores, by the user's decision.
 *
 * WHY HERE AND NOT ONLY IN THE FRAME HANDLER: the revocation ends this device's session, so once it
 * has, the refusal is the only fact left that says why - the frame's own check is asked with the dead
 * credential, and a device that was offline during the revocation (DEV-3) gets no frame at all. The
 * cause is read from the latch, never from the caller, so the order of arrival never matters.
 *
 * @param account The account whose credential was refused - the saved user when no login has named
 *   one to the session yet (a cold start). Empty: nothing on this device to reset, said once.
 * @throws Whatever the reset throws - the caller accuses it; a revoked device whose stores remain is
 *   never a silent outcome.
 */
export async function settleSessionEndByRevocationImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  account: string
): Promise<boolean> {
  const revoked = revokedDeviceOfEndedSession();
  if (!revoked) return false;
  if (!account) {
    cb.log(
      '[SECURITY] Session ended by a device revocation, but no account is known on this device - nothing to reset.'
    );
    return false;
  }
  // A RESET ALREADY RUNNING OR DONE IS CHECKED BEFORE THE IDENTITY COMPARISON below, because the reset
  // deletes the very key that comparison reads (`mls_device_id_<userId>`): a refusal arriving mid-wipe
  // would read `none`, log a false "not this device" and sign out a second time while the wipe runs.
  // The wipe is started only by a discoverer that confirmed THIS device's revocation, so joining it
  // is the answer; its own `clearAuth` is the sign-out.
  if (revokedDeviceWipe) {
    await wipeRevokedDevice(ctx, cb);
    return true;
  }
  if (revokedDevicesReset.has(`${revoked.userId}:${revoked.deviceId}`)) {
    cb.log('[SECURITY] Revoked-device reset already done for this device - nothing erased again.');
    return true;
  }
  // ONLY THIS DEVICE OF THIS ACCOUNT: the session may be bound to an id this install has rotated
  // away from (its revocation says nothing about the current one), and a refusal naming another
  // account is not this device's either. Either is the plain sign-out that keeps the stores.
  const local = storedDeviceIdOf(account);
  if (revoked.userId !== account || revoked.deviceId !== local) {
    cb.log(
      `[SECURITY] Session ended by the revocation of ${revoked.userId.slice(0, 8)}:${revoked.deviceId.slice(0, 16)} - ` +
        `not this device (${account.slice(0, 8)}:${(local ?? 'none').slice(0, 16)}) - signing out, nothing reset.`
    );
    return false;
  }
  if (ctx.getUserId() !== account) ctx.setUserId(account);
  cb.log(
    '[SECURITY] This device was revoked by its owner (the server said so when its session ended) - resetting it.'
  );
  await wipeRevokedDevice(ctx, cb);
  return true;
}

/**
 * Releases what a login stopped by a sign-out took: its gateway socket and its MLS client.
 *
 * THE SAME TWO STEPS AS `endSessionImpl`, and for the same reason - the socket goes first (a socket
 * left open keeps decrypting and ACKing the leaving account's frames), then the client goes, so the
 * next sign-in builds a fresh one. Nothing else: the session never went live, or it did and the
 * sign-out's own `endSessionImpl` already tore it down, and the stop is found right after the await
 * the sign-out ran during, so nothing was registered since.
 *
 * `client` is the client THIS login built, held by name: after a sign-out of a live session the
 * holder has already let go of it, and the socket a late handshake opens is on it. `handshake`, when
 * the login started one, may still be in flight; the socket it opens is released when it settles
 * (it never rejects - see `StartedHandshake`).
 */
function releaseLoginStoppedBySignOut(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  client: ReturnType<SessionContext['ensureMls']> | null,
  handshake: ReturnType<typeof startGatewayHandshake>
): void {
  if (client) {
    client.pauseSocket();
    if (handshake) {
      // AND AFTER ANY REOPEN QUEUED BEHIND IT: a rotation during this login's init reopens the
      // socket under the new id, and released at the handshake alone that reopen would outlive us.
      const release = (): void => {
        cb.log('[INIT] Stopped login: its gateway handshake settled - socket released.');
        client.pauseSocket();
      };
      void handshake.then(() => client.gatewaySocketSettled()).then(release, release);
    }
  }
  // A live session here is another login's (this one's was ended by the sign-out), and so is its flag.
  if (!ctx.isLoggedIn()) ctx.setIsWsConnected(false);
  // THIS LOGIN'S CLIENT ONLY. A sign-out of the live session has already retired it (and destroys it
  // after its final write), and the next sign-in may have built its own since - which is not ours.
  if (client) ctx.resetMls(client);
  cb.log('[INIT] Stopped login released its socket and its MLS client.');
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
  // BEFORE any key is read: the key-change epoch this session's key belongs to is recorded here, so a
  // change another tab makes before this session's first storage call is still seen as one.
  joinDeviceKeyLock(userId);
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
  const loginId = ++loginSeq;
  ctx.setIsLoginInProgress(true);
  loginFlowOwner = loginId;
  let settleLogin: () => void = () => {};
  const thisLoginSettled = new Promise<void>((done) => (settleLogin = done));
  loginInFlightSettled = thisLoginSettled;
  const loginAbort = new AbortController();
  loginInFlightAbort = loginAbort;
  /**
   * `work`, unless a sign-out cancels this login first: then it rejects at once with the stop, typed,
   * and `work`'s own late answer (or rejection) is dropped. For the awaits that wait on the NETWORK
   * only - a local step (the MLS decrypt) is let finish, because the next login opens the same state.
   */
  const untilSignedOut = <T>(work: Promise<T>, stage: string): Promise<T> =>
    new Promise<T>((resolveWork, rejectWork) => {
      const onAbort = (): void =>
        rejectWork(
          new LoginStoppedBySignOutError(`${stage} (cancelled)`, loginStopOf(loginAbort.signal))
        );
      if (loginAbort.signal.aborted) {
        onAbort();
        void work.catch(() => {});
        return;
      }
      loginAbort.signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value) => {
          loginAbort.signal.removeEventListener('abort', onAbort);
          resolveWork(value);
        },
        (e: unknown) => {
          loginAbort.signal.removeEventListener('abort', onAbort);
          rejectWork(e);
        }
      );
    });
  /** Set once this login starts its OWN revocation wipe, which signs out on purpose. */
  let ownWipeStarted = false;
  /**
   * Marks this login's own revocation wipe as started. The wipe's `clearAuth` reaches
   * `endSessionImpl`, which aborts the login in flight - this one, doing the wipe - so the login
   * withdraws itself from that abort first: its outcome is `device_revoked`, not a stopped login.
   */
  const startOwnWipe = (): void => {
    ownWipeStarted = true;
    if (loginInFlightAbort === loginAbort) loginInFlightAbort = null;
    cb.log(
      '[SECURITY] Revocation wipe started by this login - its own sign-out does not cancel it.'
    );
  };
  /** Clears the login flag only while this login still owns the flow - see `loginFlowOwner`. */
  const releaseLoginFlag = (): void => {
    if (loginFlowOwner !== loginId) {
      cb.log('[LOGIN] Flag left set - a newer login owns the flow.');
      return;
    }
    ctx.setIsLoginInProgress(false);
  };

  // A SIGN-OUT DURING THIS LOGIN STOPS IT, read after every await. The sign-out finds no live session
  // while the login runs (`isLoggedIn` is still false), so `endSessionImpl` stops nothing; left alone,
  // the login completed afterwards and set `isLoggedIn` for a signed-out user. A sign-out can only
  // run while this function is suspended, so a re-read right after each await is enough for nothing
  // below it to act for a signed-out account. Thrown as a type; the catch releases what was taken.
  //
  // A LOST MLS SESSION STOPS IT THE SAME WAY (`endLostSessionImpl`): no sign-out runs then, so the
  // generation does not move, and the stop is read from this login's abort, whose reason names it.
  const signOutsAtStart = signOutGeneration();
  const signedOutSinceStart = (): boolean => signOutGeneration() !== signOutsAtStart;
  const stopIfSignedOut = (stage: string): void => {
    if (signedOutSinceStart()) throw new LoginStoppedBySignOutError(stage);
    if (loginAbort.signal.aborted) {
      throw new LoginStoppedBySignOutError(stage, loginStopOf(loginAbort.signal));
    }
  };

  // THE PREVIOUS ACCOUNT'S FINAL CHECKPOINT LANDS FIRST. A sign-out retires its MLS client once that
  // write is on disk (`endSessionImpl`), and this login reads the disk: opening the state while the
  // write is in flight would start from a state one write behind. Settles at once when nothing is
  // retiring, and never rejects.
  if (ctx.isMlsRetiring()) {
    cb.log('[LOGIN] Waiting for the signed-out session to finish its final MLS checkpoint.');
  }
  await ctx.whenMlsRetired();

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
  // WHAT A LOGIN STOPPED BY A SIGN-OUT MUST RELEASE, named as they are taken: the client this login
  // builds and the handshake it starts beside the state load (see `releaseLoginStoppedBySignOut`).
  let loginClient: ReturnType<SessionContext['ensureMls']> | null = null;
  let loginHandshake: ReturnType<typeof startGatewayHandshake> = null;
  /** Set when THIS login raised `isLoggedIn`, so its failure lowers the flag only if it raised it. */
  let thisLoginWentLive = false;

  try {
    // The wait above is the first await a sign-out can run during, so nothing - not even the
    // session's identity or the tab-leader callback - is set before this re-read.
    stopIfSignedOut('previous-account-retired');

    ctx.setLoginError('');
    ctx.setUserId(userId.trim().toLowerCase());

    // Clear any stale reconnect timer from a previous session
    if (ctx.timers.reconnect !== null) {
      clearTimeout(ctx.timers.reconnect);
      ctx.timers.reconnect = null;
    }
    ctx.setReconnectAttempts(0);

    ctx.setTabLeaderSessionCb(cb);
    // AN ACCOUNT DELETED FROM THIS DEVICE OPENS NOTHING, refused before the first store is touched
    // (the landing preview and the MLS state lookup below both open one). Its wipe is owed or running,
    // and a session would re-create what the wipe removes - the offline unlock above all, which has no
    // server to refuse it and holds no token the resumed wipe could see. EVERY entry reaches this
    // line: the vault and keystore unlocks of a saved user, the PIN gate, a reloaded follower tab.
    // Lifted only by an online sign-in of that subject, which the server allows once the erasure
    // completed (`forgetDeletedAccountOnSignIn`).
    if (isDeletedAccountHere(ctx.getUserId()) || isDeletedAccountHere(userId.trim())) {
      cb.log(
        `[LOGIN] ${ctx.getUserId().slice(0, 8)} was deleted from this device - refused, an online sign-in is required`
      );
      throw new LoginFailure('account_deleted', m.auth_account_deleted_here());
    }
    const mlsService = ctx.ensureMls();
    loginClient = mlsService;
    // WHICH KEY SEALS THIS PHONE'S DATA, read from the marker beside `mls.bin` before any key is asked
    // for: the PIN-derived one, a hardware-held random one, or one of the two mid-migration
    // (`hardwareHeldKey.ts`). The web and desktop builds are always `pin-derived`. A re-key running
    // in this page is awaited first (`settledAtRestScheme`).
    const atRestScheme: AtRestKeyScheme = hardwareHeldKeyApplies()
      ? await settledAtRestScheme(tauriHardwareKeyPort, ctx.getUserId())
      : 'pin-derived';
    stopIfSignedOut('at-rest-scheme');
    if (atRestScheme === 'unreadable') {
      // Never guessed into a scheme: the PIN-derived key over hardware-sealed rows would let the next
      // re-key strand them. Nor called lost: the marker could not be READ, which proves nothing gone.
      throw hardwareKeyLoginFailure('unreadable', cb.log);
    }
    if (isBiometric && atRestScheme === 'migrating') {
      // Mid-migration the keystore may hold the new key while the state is still under the old one.
      // Only the PIN path finishes the re-key (`finishMigrationAtUnlock`), so the keypad is asked for.
      cb.log('[AT_REST_KEY] keystore unlock skipped - a re-key is under way, the PIN settles it');
      throw new LoginFailure('keystore_empty', m.auth_keystore_empty_enter_pin());
    }
    /** Set when the PIN unlock found a re-key already complete: nothing to resume after the login. */
    let migrationCompleteAtUnlock = false;
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
    stopIfSignedOut('state-lookup-import');
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
      accessToken = await untilSignedOut(getToken(), 'access-token');
      endBootSpan('access-token');
    } catch (err) {
      // THE USER IS SIGNING OUT, OR SIGNED OUT WHILE THIS WAS ASKED: this login stops, and that is
      // all. Not a session loss - answering it with `onSessionExpired` was the second sign-out (Mi 9T,
      // 2026-10-17), and a 401 met after a sign-out is that sign-out's own revocation - and not a
      // failed login either, which would put the PIN gate up over the sign-out. Handed to the outer
      // catch, which releases what this login took.
      if (err instanceof SignOutInProgressError || signedOutSinceStart()) {
        throw new LoginStoppedBySignOutError('access-token');
      }
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
        else void goto(resolve('/login'), { replace: true });
        withdrawLandingPreview('session expired');
        releaseLoginFlag();
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
        releaseLoginFlag();
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
        releaseLoginFlag();
        const msg = m.auth_server_unreachable();
        ctx.setLoginError(msg);
        // Notify the caller so a PIN-modal spinner does not hang forever.
        cb.onLoginFailed?.(msg);
        return;
      }
    }
    stopIfSignedOut('access-token');

    // Collect the MLS state that was loading in the background.
    const mlsStateResult = await mlsStatePromise;
    stopIfSignedOut('state-lookup');
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
      deviceKeyB64 = await untilSignedOut(
        unlockWithPin({
          saltAhead: takePinSaltAhead(userIdForPin),
          fetchSalt: () => fetchPinSalt(ctx, userIdForPin, accessToken, loginAbort.signal),
          computeVerifier: (salt) => computePinVerifier(userIdForPin, pin, salt),
          // ON A HARDWARE-HELD PHONE THE PIN DERIVES NOTHING THAT OPENS DATA: the key is read from the
          // keystore, and `unlockWithPin` installs it only once the server accepted the PIN - the same
          // gate the derived key went through. A key the keystore lost is typed here, so a wrong PIN
          // is still reported as one (the read is awaited only after the check).
          deriveDeviceKey: async (salt) => {
            if (atRestScheme !== 'hardware') return deriveDeviceKeyB64(userIdForPin, pin, salt);
            try {
              return await readHardwareHeldKey(tauriHardwareKeyPort, userIdForPin, cb.log);
            } catch (e) {
              if (e instanceof HardwareKeyUnavailableError) {
                throw hardwareKeyLoginFailure(e.refusal, cb.log);
              }
              throw e;
            }
          },
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
                signal: loginAbort.signal,
              },
              m.auth_pin_check_unreachable()
            );
            if (!res.ok) throw new LocalizedError(m.auth_pin_check_unreachable());
            return (await res.json()) as PinCheckAnswer;
          },
          // Re-read first: the wipe waits for the MLS retirement, which a sign-out during this login
          // chains on this login's own end - a wipe started after one would wait on itself.
          wipeRevokedDevice: () => {
            stopIfSignedOut('pin-check-revoked');
            startOwnWipe();
            return wipeRevokedDevice(ctx, cb);
          },
          // A key proven after a sign-out belongs to nobody signed in.
          installDeviceKey: (key) => {
            stopIfSignedOut('pin-check-install');
            ctx.setDeviceKey(key);
          },
          log: cb.log,
        }),
        'pin-check'
      );
      stopIfSignedOut('pin-check');
      if (atRestScheme === 'migrating') {
        // The PIN is proven: the interrupted re-key is FINISHED here, before any store is opened for
        // the session, so no session ever runs over rows under two keys (`finishMigrationAtUnlock`).
        deviceKeyB64 = await finishMigrationAtUnlockForLogin(
          mlsService,
          userIdForPin,
          deviceKeyB64,
          cb
        );
        stopIfSignedOut('at-rest-migration-finished');
        migrationCompleteAtUnlock = true;
        noteHardwareHeldDeviceKey(deviceKeyB64);
        ctx.setDeviceKey(deviceKeyB64);
      }
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
      stopIfSignedOut('resolve-device-id');
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
    stopIfSignedOut('tab-leadership');
    ctx.setIsTabLeader(tabLeaderNow);
    if (!tabLeaderNow) {
      cb.log('[TAB] Follower tab - WebSocket active in another Canari tab.');
    }

    // THE HANDSHAKE STARTS HERE AND IS AWAITED 200 MS LOWER DOWN. `resolveDeviceId` has answered on
    // both paths above, which is everything the socket needs; the MLS state load below needs
    // nothing from the socket. Measured on production 2026-09-16, the two ran one after the other
    // and cost 236 ms + 182 ms of a 1308 ms cold start.
    //
    // THE ID IT CARRIES IS NOT YET FINAL: the init below can rotate it (a lost state re-enrolled, a
    // credential naming someone else). The rotation reopens the socket under the new id itself, and
    // `openGatewayConnection` waits for that reopen (`gatewaySocketSettled`) before anything uses it.
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
    loginHandshake = startedHandshake;

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
    // THE LONGEST AWAIT OF THE LOGIN (~12 s of native decrypt on a Mi 9T), and the window the open
    // defect was found in. A signed-out device is not wiped for a revocation either: the sign-out
    // already ended the session, and the next login asks the server again.
    stopIfSignedOut('mls-init-and-storage');
    beginBootSpan('revocation-gate');
    const revoked =
      revocationAnswer !== null && (await untilSignedOut(revocationAnswer, 'revocation-gate'));
    endBootSpan('revocation-gate', { asked: revocationAnswer !== null });
    stopIfSignedOut('revocation-gate');
    if (revoked) {
      // What the local preview drew comes off the screen BEFORE the wipe, and the wipe starts only
      // once the read is over - it deletes the store that read was reading. The store is already
      // open here (the init above awaited it), so this wait is the read alone and cannot hang.
      withdrawLandingPreview('device revoked');
      if (landingPreview) await landingPreview;
      // Same reason as on the PIN path: a wipe started after a sign-out would wait on this login.
      stopIfSignedOut('revocation-preview-settled');
      startOwnWipe();
      await wipeRevokedDevice(ctx, cb);
      cb.log('[SECURITY] Revoked device: signed out and reset to a fresh install.');
      throw new LoginFailure('device_revoked', m.auth_device_revoked_reset());
    }

    if (mlsInitSettled.status === 'rejected') {
      const reason = mlsInitSettled.reason;
      // The init changed nothing (`MlsInitOptions.vaultOwnerUnproven`): the PIN gate, typed.
      if (reason instanceof VaultOwnerUnprovenError) throw vaultRefusedFailure(reason.refusal);
      if (
        reason instanceof SavedStateUnopenedError ||
        reason instanceof SavedStateOfAnotherAccountError ||
        reason instanceof MlsStateWriteRefusedError
      ) {
        throw savedStateFailure(reason);
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
      stopIfSignedOut('keystore-session-key');
      if (!sessionKey || !isValidDeviceKeyB64(sessionKey)) {
        throw new LoginFailure('keystore_empty', m.auth_keystore_empty_enter_pin());
      }
      // Read from the keystore: on a hardware-held phone no vault may copy it out (`saveDeviceKey`).
      if (atRestScheme === 'hardware') noteHardwareHeldDeviceKey(sessionKey);
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
    // The key groups the push service joined while the app was shut (channel-encryption section
    // 26): their trees are in the state just loaded, their registry rows are not - until this.
    // Info level: one line per ledger entry at start, each a decision a device reading must name.
    await takeKeyGroupPushJoins(mlsService, (line) => Log.i('LOGIN', line));
    stopIfSignedOut('distribution-groups');
    // What the iOS notification extension did while the app was shut: decrypted, fell back, timed
    // out or killed - one `[NSE_OUTCOME]` line each (`nseOutcomes.ts`). Not awaited: nothing below
    // depends on it, and a log line must never hold a login.
    void drainNseOutcomes(appendLog);

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
    const sessionToken = offlineSession ? '' : await untilSignedOut(getToken(), 'auth-token-final');
    endBootSpan('auth-token-final', { offline: offlineSession });
    // THE LAST READ BEFORE THE SESSION GOES LIVE, and the one the defect was about. Nothing below
    // awaits before `setIsLoggedIn(true)`, so from here a sign-out finds a live session and
    // `endSessionImpl` stops it - and every await further down re-reads the generation.
    stopIfSignedOut('auth-token-final');
    ctx.setAuthToken(sessionToken);
    ctx.setIsOfflineSession(offlineSession);

    ctx.setIsLoggedIn(true);
    thisLoginWentLive = true;
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
    // said it must not be. Measured on the workstation 2026-09-17, 5 groups, a 1000-package pool: a cold load
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

    // A PHONE STILL ON THE PIN-DERIVED KEY MOVES TO A HARDWARE-HELD ONE, once, in this session: every
    // sealed store is re-sealed under a random key by the PIN change's own resumable path
    // (`hardwareKeyMigration.ts`). The leader only, like a PIN change: it re-seals from the live client.
    // Not awaited - the session is usable meanwhile, its storage calls held for the re-seal's length.
    if (
      hardwareHeldKeyApplies() &&
      atRestScheme !== 'hardware' &&
      !migrationCompleteAtUnlock &&
      tabLeaderNow
    ) {
      const migratingUser = ctx.getUserId();
      void startHardwareKeyMigration({
        userId: migratingUser,
        deviceId: ctx.getMyDeviceId(),
        currentKeyB64: ctx.getDeviceKey(),
        port: tauriHardwareKeyPort,
        changeKey: (oldKeyB64, newKeyB64) =>
          performPinChange(
            {
              userId: migratingUser,
              mls: mlsService,
              setDeviceKey: (k: string) => ctx.setDeviceKey(k),
              log: cb.log,
            },
            oldKeyB64,
            newKeyB64
          ),
        ...backupNoticeDeps(migratingUser),
        log: cb.log,
      });
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
      // The restore key of this session (WP-RESTORE-1, Android only), for the same reason and on the
      // same terms: fire-and-forget, a failure is logged and the next start tries again. Skipped
      // offline: promoteOfflineSession runs it once a token exists.
      void ensureRestoreKey(ctx.getUserId()).catch((e) =>
        cb.log(`[WARN] Restore key registration failed: ${String(e)}`)
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
    // With the outbox it resumes: the recovery callers built outside the session reach it by name.
    setGroupReadyAnnouncer((groupId) => announceGroupReady(ctx, cb, groupId));

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
      fetch: async (scope, deviceId) => {
        const ref = await distributionChannels.getDistributionGroup(scope, deviceId);
        return ref.groupInfo !== null && ref.baseEpoch !== null
          ? {
              groupInfo: ref.groupInfo,
              baseEpoch: ref.baseEpoch,
              activeEpoch: ref.activeEpoch,
              ...(ref.seat ? { seat: ref.seat } : {}),
            }
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
      onCallEnded: (groupId: string, callId: string, outcome?: CallEndReason, starterId?: string) =>
        recordCallEnded(
          getCallSystemMessageContext(),
          groupId,
          callId,
          outcome,
          starterId ?? ctx.getUserId()
        ),
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
      onChannelRemovalReleased: cb.onChannelRemovalReleased,
      onChannelUpdated: cb.onChannelUpdated,
      onRolePermissionsChanged: cb.onRolePermissionsChanged,
      onChannelDeleted: cb.onChannelDeleted,
      onWorkspaceUpdated: cb.onWorkspaceUpdated,
      onSalonUnreadCleared: cb.onSalonUnreadCleared,
      onWorkspaceRoleChanged: cb.onWorkspaceRoleChanged,
      onWorkspaceDeleted: cb.onWorkspaceDeleted,
      onChannelMessageDeleted: cb.onChannelMessageDeleted,
      // The ask every online admitted member is told of, and its outcome, whoever answered it.
      onJoinAsk: (ask) => {
        void raiseAnnouncedJoinAsk({
          mlsService,
          conversations: cb.conversations,
          ask,
          log: cb.log,
          onJoinApprovalRequested: raiseJoinRequest,
        }).catch((e: unknown) =>
          cb.log(
            `[JOIN_ASK] the announced ask of ${ask.requesterUserId} in ${ask.groupId.slice(0, 8)}... was not raised: ${String(e).slice(0, 120)}`
          )
        );
      },
      onJoinAskSettled: settleJoinRequest,
      onReadStateAdvanced: cb.onReadStateAdvanced,
      onCallSignal: (senderId: string, groupId: string, callMsg) => {
        void handleCallSignalForChat(
          getCallSystemMessageContext(),
          senderId,
          groupId,
          callMsg as ICallMsg,
          ctx.getUserId()
        );
        void ctx
          .getCallService()
          ?.handleCallSignal(
            senderId,
            groupId,
            callMsg,
            ctx.getUserId(),
            ctx.ensureMls().getDeviceId()
          );
      },
      // The group just became sendable (a Welcome processed): the one seam an external join shares.
      // Captured after `setGroupReadyAnnouncer` above: a Welcome processed after this session ended
      // announces nothing into the next one.
      onGroupReady: captureGroupReadyAnnouncer(),
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
    // The new-device notices consume the device events from here on, and drain what is pending.
    registerDeviceNotices(mlsService, {
      getUserId: () => ctx.getUserId(),
      getMyDeviceId: () => ctx.getMyDeviceId(),
      conversations: cb.conversations,
      storedConversation: (groupId) => storageSettled.value.getConversation(groupId),
      addMessageToChat: (senderId, content, contactName, options) =>
        cb.addMessageToChat(senderId, content, contactName, options),
    });
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
     *
     * THE ROWS GO IN FIRST, AND THAT IS WHAT MAKES THE GATE SAFE TO OPEN (2026-11-01). A frame for a
     * conversation the map does not hold is refused `absent-conversation` and fetched again later,
     * and before this the map was empty here: the restore seeded it only after the gateway, so on a
     * cold start every queued frame - held, live, or drained by the post-connect pull - met no row
     * and was read twice (iPhone 12, `1.5.4-alpha.1`). The seed is the restore's LOCAL half: the
     * store and the map, no socket. Its history half, whose barriers need the socket, stays below
     * the gateway and replays what this seeded rather than seeding again. The landing preview lands
     * before it: a row the preview added after the seed would be a stale copy the restore no longer
     * knows about, and the seed's rebuild is the one that keeps the previewed page.
     */
    if (landingPreview) await landingPreview;
    stopIfSignedOut('landing-preview');
    beginStartupCatchupPhase('seed_conversations');
    await cb.seedConversationRows();
    endStartupCatchupPhase({ conversationCount: cb.conversations.size });
    stopIfSignedOut('seed-conversations');
    await mlsService.markInboundReady();
    stopIfSignedOut('inbound-ready');

    // Offline: skip the connection entirely rather than let it fail. `openGatewayConnection` would
    // degrade correctly on its own, but the attempt costs a timeout on a launch that already knows
    // there is no network, and it logs "[WS] Gateway connection failed" for a device that never had one.
    let gatewayIsOpen = false;
    if (offlineSession) {
      cb.log('[INIT] Offline session - gateway connection deferred until the network returns.');
    } else {
      beginStartupCatchupPhase('open_gateway');
      // The handshake this awaits was started before the MLS state load, not here - see
      // `startGatewayHandshake` above. Everything after the socket opens is unchanged.
      gatewayIsOpen = await openGatewayConnection(makeConnectionDeps(ctx, cb), startedHandshake);
      endStartupCatchupPhase();
      stopIfSignedOut('open-gateway');
    }

    // Adopt anything the native side queued on its own (an undelivered notification quick reply
    // lives only in the mirror file, which the next mirror rewrite would erase). BEFORE the load:
    // the adopted message is written to the store, so the ordinary history load displays it and
    // applyOutboxPendingStatuses below marks it pending.
    await adoptOrphanedMirrorEntries(ctx.getStorage()!, ctx.getDeviceKey(), ctx.getUserId()).catch(
      (e) => cb.log(`[OUTBOX_MIRROR] Adoption pass failed: ${String(e)}`)
    );
    stopIfSignedOut('mirror-adoption');

    // EVERYTHING FROM HERE TO THE FCM MERGE IS ONE SPAN, and a deep-link landing must not conclude
    // anything about this device's conversations until it closes. The restore below marks itself
    // finished the moment IndexedDB is read, which is BEFORE `consumeFcmCache` writes the
    // placeholder for a group joined in the background - so a tap on a first message from a new
    // correspondent used to see a settled map without its target and abandon, milliseconds early.
    // Opened BEFORE the restore rather than around the cache alone: the two are separated by
    // awaits, and a gap between them is the whole defect in miniature.
    cb.beginConversationSource();
    try {
      // The history half of the restore: the rows were seeded above the inbound gate, and the
      // landing preview landed before that seed. consumeFcmCache below reaches the map through
      // addMessageToChat, so this comes first.
      beginStartupCatchupPhase('load_conversations');
      await cb.loadAndRestoreConversations();
      stopIfSignedOut('load-conversations');
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
      await reconcileOutboxSent(ctx.getStorage()!, {
        deviceKeyB64: ctx.getDeviceKey(),
        userId: ctx.getUserId(),
        onDated: (id, receivedAt) => dateBackgroundSentRow(cb.conversations, id, receivedAt),
      }).catch((e) => cb.log(`[OUTBOX_MIRROR] Login reconcile failed: ${String(e)}`));
      stopIfSignedOut('outbox-reconcile');
      // Re-mark "pending" messages still in the outbox queue (derived status, not persisted).
      await applyOutboxPendingStatuses();
      stopIfSignedOut('outbox-statuses');

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
      stopIfSignedOut('fcm-cache');
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
    stopIfSignedOut('read-watermarks');

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
      // The demotion of rows whose group is not held, and its mirror: the promotion of `pending`
      // rows whose group is - on MEMBERSHIP, never on held state alone - each written as it changed.
      await applyRestoredLifecycles({
        conversations: cb.conversations,
        localGroups: localMlsGroups,
        mlsService,
        saveConversation: cb.saveConversation,
        log: cb.log,
      });
    } catch (e) {
      console.warn('[INIT] Error detecting missing MLS groups:', e);
    }
    // After the block, not inside it: its catch would swallow the stop.
    stopIfSignedOut('restore-verdict');

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
            // A burst of Welcomes is folded into ONE queued restore, so its failure is one line,
            // not one per Welcome.
            await reportRejectionOnce(cb.loadAndRestoreConversations(), (e) =>
              cb.log(`[WARN] Error resyncing convs (Welcome): ${e}`)
            );
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
      answerDeviceRevokedFrame(ctx, cb, mlsService).catch((e: unknown) => {
        // ACCUSED, never swallowed: the stores of a disowned device may remain.
        console.error('[SECURITY] The device_revoked frame could not be answered:', e);
        cb.log(
          `[SECURITY] The device_revoked frame could not be answered - local data may remain: ${e}`
        );
      });
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
      stopIfSignedOut('connection-sync');
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
    const lastActiveKey = ACCOUNT_KEY.lastActive(ctx.getUserId());
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
        const store = await load(SESSION_META_STORE, { autoSave: true, defaults: {} });
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
    stopIfSignedOut('last-active');
    const nowMs = Date.now();
    localStorage.setItem(lastActiveKey, String(nowMs));
    // Persist to Tauri Store so the value survives Android process kills.
    if (isTauriRuntime()) {
      import('@tauri-apps/plugin-store')
        .then(({ load }) => load(SESSION_META_STORE, { autoSave: true, defaults: {} }))
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
    // A SIGN-OUT STOPPED THIS LOGIN - nothing failed. The client it was building goes (as on any
    // login that did not complete), and NOTHING ELSE: no error under the PIN, no `onSessionExpired`
    // (a second sign-out), and above all not `clearDeviceKey` below, which would forget this
    // account's "Rester connecte" slot that a sign-out keeps on purpose.
    //
    // Whatever was thrown, once a sign-out began it is THAT sign-out's consequence, not a failure:
    // the refresh refused during it, this login's own re-read of the generation, and any await that
    // REJECTED after it and so never reached a re-read - a 401 from the session it revoked (the PIN
    // check, a refresh), a store the teardown closed. Read by type and by code, never by message.
    // The one exception is this login's own revocation wipe, which signs out on purpose and whose
    // outcome (`device_revoked`) the PIN gate must still show.
    if (ownWipeStarted && loginErrorCode(_e) !== 'device_revoked') {
      // THE WIPE ITSELF FAILED, after its own `clearAuth`: the sign-out below is the wipe's, and what
      // must be read in the log is that a revoked device may still hold its data.
      cb.log(`[SECURITY] The revoked-device wipe FAILED - local data may remain: ${String(_e)}`);
      console.error('[SECURITY] The revoked-device wipe failed - local data may remain:', _e);
    }
    if (
      _e instanceof SignOutInProgressError ||
      _e instanceof LoginStoppedBySignOutError ||
      (signedOutSinceStart() && loginErrorCode(_e) !== 'device_revoked')
    ) {
      const lost = _e instanceof LoginStoppedBySignOutError && _e.by === 'lost session';
      withdrawLandingPreview(
        lost ? 'MLS session lost during the login' : 'signed out during the login'
      );
      cb.log(
        `[INIT] Login stopped - ${
          lost ? 'its MLS session was lost during it' : 'the account signed out during it'
        } (${
          _e instanceof LoginStoppedBySignOutError
            ? `after ${_e.stage}`
            : `${_e instanceof Error ? _e.name : typeof _e} thrown after the sign-out`
        }).`
      );
      releaseLoginStoppedBySignOut(ctx, cb, loginClient, loginHandshake);
      return;
    }
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
    // A LOGIN THAT FAILED AFTER IT WENT LIVE LEAVES NOTHING ACTING ON ITS SESSION. A failed reopen of
    // its handshake arms the reconnect ladder (`openGatewayConnection`); left armed over a raised
    // flag, the rung would build a fresh, uninitialised client from the holder and connect it.
    if (thisLoginWentLive) {
      if (ctx.timers.reconnect !== null) {
        clearTimeout(ctx.timers.reconnect);
        ctx.timers.reconnect = null;
        cb.log('[INIT] Failed login: the reconnect rung it armed is cleared.');
      }
      ctx.setIsLoggedIn(false);
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
      // The server ended this session, and its restore key with it (WP-RESTORE-1): the platform's
      // copy goes too. Here and not only in `clearAuth`, because with no callback wired this branch
      // forgets the user without passing through it.
      forgetRestoreKeyRegistrations();
      markRestoreAttempted();
      void clearRestoreKey('session expired');
      if (cb.onSessionExpired) cb.onSessionExpired();
      else void goto(resolve('/login'), { replace: true });
    } else if (cb.onLoginFailed) {
      cb.onLoginFailed(shown, code);
    } else {
      const loc = window.location;
      void goto(resolve(internalPath(loginReturningTo(loc.pathname, loc.search, loc.hash))), {
        replace: true,
      });
    }
  } finally {
    if (loginFlowOwner === loginId) ctx.setIsMessagingInitializing(false);
    releaseLoginFlag();
    if (loginInFlightSettled === thisLoginSettled) loginInFlightSettled = null;
    if (loginInFlightAbort === loginAbort) loginInFlightAbort = null;
    settleLogin();
  }
}

/**
 * What the move to the hardware-held key needs for decision 4 of 2026-10-22: whether the install held
 * conversations before it, and how to ask for a new backup once it is done - a notice the backup
 * panel keeps until an export clears it, and a toast now.
 */
function backupNoticeDeps(userId: string): {
  hadLocalData: () => Promise<boolean>;
  onBackupsSuperseded: () => void;
} {
  return {
    hadLocalData: async () => (await (await getStorage(userId)).getConversations()).length > 0,
    onBackupsSuperseded: () => {
      noteBackupOwedAfterKeyMove(userId);
      showToast(m.profile_backup_owed_after_key_move(), 'info', 10_000);
    },
  };
}

/**
 * The PIN login's half of {@link finishMigrationAtUnlock}: wires the stored state, the recovery's
 * re-key and the stores-only move onto this login's client, and turns each failure into the login
 * outcome that names it. Runs after the server accepted the PIN and before any store is opened.
 *
 * @returns the hardware-held key the session runs on
 * @throws {LoginFailure} `hardware_key_unavailable` when the keystore will not hand the key back,
 *   `local_state_unopenable` when the stored state opens under neither key; anything else as thrown
 */
async function finishMigrationAtUnlockForLogin(
  mls: IMlsService,
  userId: string,
  pinDerivedKeyB64: string,
  cb: ChatSessionCallbacks
): Promise<string> {
  const { loadMlsState: loadStored } = await import('$lib/utils/hex');
  try {
    return await finishMigrationAtUnlock({
      userId,
      pinDerivedKeyB64,
      port: tauriHardwareKeyPort,
      loadStoredState: async () => (await loadStored(userId)) ?? null,
      openStoredStateWith: (keyB64, state) => mls.openLocalStateWithKey(userId, keyB64, state),
      completeReKey: (oldKeyB64, newKeyB64, state) =>
        performPinChange(
          { userId, mls, storedMlsState: state, setDeviceKey: () => {}, log: cb.log },
          oldKeyB64,
          newKeyB64
        ),
      resealStoresOnly: (oldKeyB64, newKeyB64) =>
        moveSealedStoresOnly(userId, oldKeyB64, newKeyB64, cb.log),
      ...backupNoticeDeps(userId),
      log: cb.log,
    });
  } catch (e) {
    if (e instanceof HardwareKeyUnavailableError) {
      throw hardwareKeyLoginFailure(e.refusal, cb.log);
    }
    if (e instanceof DeviceKeyMismatchError || e instanceof LocalStateUnopenableError) {
      throw new LoginFailure('local_state_unopenable', m.auth_local_state_unopenable());
    }
    throw e;
  }
}

/**
 * The auto-login when this account has no vault slot. ON A HARDWARE-HELD PHONE "STAY SIGNED IN"
 * READS THE KEYSTORE, because the vault never holds that key (`saveDeviceKey`): the same unattended
 * read the biometric cadence and the background push make - the keystore is the factor, as the
 * vault was. Anywhere else no slot means the PIN is asked.
 */
async function stayingSignedInWithoutVault(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  userId: string
): Promise<boolean> {
  if (
    hardwareHeldKeyApplies() &&
    isDeviceKeyPersistenceEnabled() &&
    (await settledAtRestScheme(tauriHardwareKeyPort, userId)) === 'hardware'
  ) {
    appendLog('[PIN] Stay signed in on a hardware-held key - keystore unlock, no prompt');
    noteUnlockUnattended(userId);
    ctx.setPin('');
    ctx.setDeviceKey('');
    await loginImpl(ctx, cb, { unattendedKeyRead: true });
    return ctx.isLoggedIn();
  }
  appendLog('[PIN] No device key in vault for this account - auto-login impossible');
  return false;
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
    // Before the vault is read, for the reason `loginImpl` gives.
    joinDeviceKeyLock(userId);
    const vaulted = await loadDeviceKey(userId);
    if (!vaulted) return await stayingSignedInWithoutVault(ctx, cb, userId);
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
async function fetchPinSalt(
  ctx: SessionContext,
  userId: string,
  token: string,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetchOrUnreachable(
    `${ctx.getHistoryBaseUrl()}/api/mls/security/pin-salt/${encodeURIComponent(userId)}`,
    { headers: { Authorization: `Bearer ${token}` }, signal },
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
  // BEFORE THE SERVER IS ASKED ANYTHING: a follower tab cannot re-seal the MLS state (see
  // thisTabMayChangeDeviceKey), and a verifier rotated for a change that cannot finish here costs
  // the user a recovery.
  if (!thisTabMayChangeDeviceKey(log)) throw new LocalizedError(m.auth_pin_change_follower_tab());
  // ALSO BEFORE THE SERVER: a re-key to the hardware-held key re-seals the same stores, and a PIN
  // change deriving keys over rows already half moved would strand them. Wait for one in flight; refuse
  // while one is interrupted (the next unlock resumes it).
  const atRestScheme: AtRestKeyScheme = hardwareHeldKeyApplies()
    ? await settledAtRestScheme(tauriHardwareKeyPort, userId)
    : 'pin-derived';
  if (atRestScheme === 'migrating' || atRestScheme === 'unreadable') {
    log(`[PIN_CHANGE] Refused before the server: the at-rest key is ${atRestScheme}.`);
    throw new LocalizedError(m.auth_pin_change_key_migration_pending());
  }
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
  if (!res.ok) {
    // Worded from the refusal's stable code (PIN_INCORRECT, PIN_NOT_SET), never its prose or a bare
    // status: a 403 here is the one refusal, but the code is what says so.
    const refusal = await refusalFromResponse(res, 'PIN change refused');
    throw new LocalizedError(describeRefusalCode(refusal.code) ?? m.auth_pin_change_server_error());
  }
  log('[PIN_CHANGE] Account verifier rotated server-side.');

  if (atRestScheme === 'hardware') {
    // THE PIN DERIVES NOTHING ON THIS PHONE: its stores are sealed under the hardware-held key, which
    // a PIN change does not touch. The server now expects the new PIN, and that is the whole change.
    onProgress?.({ percent: 100, stage: 'finalize' });
    log('[PIN_CHANGE] Complete - the at-rest key is hardware-held, nothing to re-seal.');
    return;
  }

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
    if (e instanceof KeyChangeSupersededError) {
      // Another tab changed the PIN first: this tab's key is the retired one.
      endIntoKeyRecovery('another tab changed the PIN first');
      throw new LocalizedError(m.auth_pin_change_superseded());
    }
    if (e instanceof KeyChangeInterruptedError) {
      if (!e.dataMoved) {
        // Nothing here moved: the session's key still seals everything, so it runs on. The account
        // already expects the new PIN, so the NEXT unlock is the one the recovery finishes.
        log(
          `[PIN_CHANGE] Interrupted at the ${e.stage} step - no data moved, the session runs on.`
        );
        throw new LocalizedError(m.auth_pin_change_not_applied());
      }
      // Data may sit under two keys: this session must not run on, and the recovery (old PIN, new
      // PIN) is what finishes the move.
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
 *
 * **A RECOVERY IS A FLOW IN FLIGHT, TRACKED AS A LOGIN IS** (`loginInFlightSettled`). It opens the
 * state and installs a native manager while no session is live, so a sign-out from the gate during it
 * found "nothing to stop": the client was destroyed mid-await and the native session ended before the
 * recovery's own `initialiser_mls` installed one, which then stayed installed. A sign-out now retires
 * the client on the recovery's END, and the recovery stops - typed, `LoginStoppedBySignOutError` -
 * at the next step that would touch the state, so it never builds a client the sign-out cannot see.
 */
export async function recoverPinImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  oldPin: string,
  newPin: string,
  onProgress?: PinProgressCallback
): Promise<void> {
  let settleRecovery: () => void = () => {};
  const recoverySettled = new Promise<void>((done) => (settleRecovery = done));
  const recoveryAbort = new AbortController();
  loginInFlightSettled = recoverySettled;
  loginInFlightAbort = recoveryAbort;
  /** Throws, typed, once a sign-out has stopped this recovery - checked before each step on the state. */
  const stillWanted = (stage: string): void => {
    if (!recoveryAbort.signal.aborted) return;
    const by = loginStopOf(recoveryAbort.signal);
    cb.log(`[PIN_RECOVER] Stopped (${by}) before ${stage} - the state is left as it was.`);
    throw new LoginStoppedBySignOutError(stage, by);
  };
  try {
    await recoverPinSteps(
      ctx,
      cb,
      oldPin,
      newPin,
      { signal: recoveryAbort.signal, stillWanted },
      onProgress
    );
  } finally {
    if (loginInFlightSettled === recoverySettled) loginInFlightSettled = null;
    if (loginInFlightAbort === recoveryAbort) loginInFlightAbort = null;
    settleRecovery();
  }
}

/**
 * The steps of {@link recoverPinImpl}. `stop.signal` cancels its network waits once a sign-out stopped
 * it (a request with no deadline would hold the retirement, and the next sign-in, behind it), and
 * `stop.stillWanted` throws, typed, before each step that would touch the state.
 */
async function recoverPinSteps(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  oldPin: string,
  newPin: string,
  stop: { signal: AbortSignal; stillWanted: (stage: string) => void },
  onProgress?: PinProgressCallback
): Promise<void> {
  const { stillWanted } = stop;
  const userId = ctx.getUserId();
  if (!userId.trim()) throw new LocalizedError(m.auth_no_user_signed_in());
  cb.log('[PIN_RECOVER] Starting recovery...');
  onProgress?.({ percent: 3, stage: 'verify' });

  // The state is read as a signed-out session LEFT it, so its final checkpoint lands first (see
  // `loginImpl`), and the client that wrote it is retired before `ensureMls` below builds ours.
  await ctx.whenMlsRetired();
  stillWanted('reading the stored state');
  const { loadMlsState } = await import('$lib/utils/hex');
  const state = await loadMlsState(userId);
  if (!state) {
    throw new LocalizedError(m.auth_no_local_state_recover());
  }

  // The new PIN must be the real (rotated) account PIN: verify its verifier server-side. A sign-out
  // cancels these waits; the cancellation is named as the stop it is, never as an unreachable server.
  let salt: string;
  let res: Response;
  try {
    const token = await getToken();
    salt = await fetchPinSalt(ctx, userId, token, stop.signal);
    const newVerifier = await computePinVerifier(userId, newPin, salt);
    res = await fetch(`${ctx.getHistoryBaseUrl()}/api/mls/security/pin-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId, verifier: newVerifier }),
      signal: stop.signal,
    });
  } catch (e) {
    stillWanted('the new PIN check');
    throw e;
  }
  if (!res.ok) throw new LocalizedError(m.auth_pin_verify_new_unreachable());
  const data = (await res.json()) as { status: string };
  if (data.status !== 'ok') {
    throw new LocalizedError(m.auth_pin_new_incorrect());
  }

  // Both device keys come from the same salt: the old one still seals the local state,
  // the new one is what every device will derive from now on.
  //
  // ON A HARDWARE-HELD PHONE THE NEW KEY IS THE KEYSTORE'S, never the new PIN's: a PIN change does
  // not touch that key. Two cases reach here. The state already opens with it - nothing to move,
  // the login follows. Or it is still under the key the PIN derived when the re-key ran (a background
  // push wrote the state back under it, or the re-key was interrupted): the old PIN derives that key,
  // and the same path moves it onto the hardware-held one. A re-key running in this page is awaited
  // first (`settledAtRestScheme`).
  const atRestScheme: AtRestKeyScheme = hardwareHeldKeyApplies()
    ? await settledAtRestScheme(tauriHardwareKeyPort, userId)
    : 'pin-derived';
  if (atRestScheme === 'unreadable') throw hardwareKeyLoginFailure('unreadable', cb.log);
  let hardwareKeyB64: string | null = null;
  if (atRestScheme === 'hardware' || atRestScheme === 'migrating') {
    // `migrating` here is SETTLED (`cle_au_repos_schema`): a marker whose key never reached the
    // keystore was reverted to `pin-derived` before this read, so a refusal now is never "fall back
    // to the new PIN's key" - that would aim the re-key at a key the guard refuses to store.
    const read = await tauriHardwareKeyPort.read(userId);
    if (!('key' in read)) {
      cb.log(`[PIN_RECOVER] The hardware-held key is unavailable (${read.refusal}).`);
      throw hardwareKeyLoginFailure(read.refusal, cb.log);
    }
    hardwareKeyB64 = read.key;
  }
  if (hardwareKeyB64) {
    stillWanted('opening the state with the hardware-held key');
    const opened = await ctx.ensureMls().openLocalStateWithKey(userId, hardwareKeyB64, state);
    if (opened.opened) {
      await tauriHardwareKeyPort.mark(userId, hardwareKeyB64);
      cb.log('[PIN_RECOVER] The state opens with the hardware-held key - nothing to move.');
      stillWanted('the login with the hardware-held key');
      ctx.setPin(newPin);
      onProgress?.({ percent: 92, stage: 'login' });
      await loginImpl(ctx, cb);
      if (!ctx.isLoggedIn()) throw new LocalizedError(m.auth_login_failed_after_recovery());
      onProgress?.({ percent: 100, stage: 'login' });
      return;
    }
    cb.log(`[PIN_RECOVER] The state is not under the hardware-held key (${opened.cause}).`);
  }
  const [oldDeviceKeyB64, newDeviceKeyB64] = await Promise.all([
    deriveDeviceKeyB64(userId, oldPin, salt),
    hardwareKeyB64 ?? deriveDeviceKeyB64(userId, newPin, salt),
  ]);

  // THE SAME PATH AS AN IN-SESSION CHANGE (`performPinChange`). Only the MLS source differs: the
  // stored blob, opened (non-destructively) with the old key - the proof the old PIN is right.
  stillWanted('opening the state with the old PIN');
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
    if (e instanceof LocalStateUnreadableNowError) {
      cb.log(
        '[PIN_RECOVER] The local MLS state could not be read right now - nothing changed, no reset offered.'
      );
      throw new LocalizedError(m.auth_local_state_unreadable_now());
    }
    if (e instanceof LocalStateUnopenableError) {
      cb.log(
        `[PIN_RECOVER] The local MLS state opens with no PIN (${e.failure}) - nothing changed.`
      );
      throw new LocalizedError(m.auth_pin_recover_state_unopenable());
    }
    if (e instanceof LocalStateNotReadyError) {
      // The state OPENED with the old key, but could not be made ready (its groups not listed):
      // nothing moved, and the same two PINs retry it.
      cb.log(
        `[PIN_RECOVER] The opened state could not be made ready - nothing moved: ${e.message}`
      );
      throw new LocalizedError(m.auth_pin_recover_interrupted());
    }
    if (e instanceof KeyChangeSupersededError) {
      cb.log('[PIN_RECOVER] Another tab changed the device key first - this tab restarts.');
      endIntoKeyRecovery('another tab changed the PIN first');
      throw new LocalizedError(m.auth_pin_change_superseded());
    }
    if (e instanceof KeyChangeInterruptedError) {
      // Not logged in yet, so there is no session to end: the same two PINs finish what moved.
      cb.log(`[PIN_RECOVER] Interrupted at the ${e.stage} step - the same two PINs finish it.`);
      throw new LocalizedError(m.auth_pin_recover_interrupted());
    }
    throw e;
  }
  // Every store now under the hardware-held key: the marker says so (idempotent when it already did).
  // The mark records what the disk now holds, so it is written even when a sign-out came meanwhile.
  if (hardwareKeyB64) await tauriHardwareKeyPort.mark(userId, hardwareKeyB64);
  stillWanted('the login after the re-seal');
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
  reason: 'logout' | 'revoked' | 'lost'
): Promise<void> {
  unregisterOutbox();
  setGroupReadyAnnouncer(null);
  // Detach the reconnect listener too, or a regained network would promote a session that no
  // longer exists - reopening a WebSocket for the user who just signed out.
  unregisterOfflinePromotion();
  // Same reason: an exit owed by the user who just signed out must not be replayed with the next
  // one's token. The row survives in storage, and that user's next login replays it.
  unregisterPendingGroupExitDrain();
  resetHistoryReconciliation();
  // A Welcome this session sent says nothing about the next user's requests.
  resetWelcomeSent();
  // Nor does a run of refused rotations: a sign-in after this one in the same tab starts its own.
  forgetRefusedRotationReloads();
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
    // NOR FOR A LOST SESSION (`endLostSessionImpl`): the client in memory no longer describes what
    // is installed - no manager at all, or an identity a failed rotation never recorded - and its
    // checkpoint would write that over the state the PIN gate is about to reopen.
    releasePersister();
    finalWrite = Promise.resolve();
  }

  // THE SERVER-SIDE DEREGISTRATION OF A LIVE SESSION, and only that. The device deletes its own push
  // registration at every sign-out regardless (`endPushRegistration`, run by `clearAuth`), and the
  // server ends the device's push token itself when it ends the session (logout and every
  // revocation, core-service) - so this call is a third, redundant path, kept for a live session.
  if (reason === 'logout') {
    const tokenForPushCleanup = ctx.getAuthToken();
    const deviceForPushCleanup = ctx.getMyDeviceId();
    if (isRefreshCredentialProvenDead()) {
      // A DEAD SESSION ENDING: the server already refused this session's credential, so this call
      // would only earn a refusal. The device's own deletion still runs from `clearAuth`.
      cb.log(
        '[LOGOUT] Server push deregistration skipped - the session is already dead; the device deletes its token.'
      );
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
  // nothing can drive recovery for a session that has ended. The restore chain goes with it, or a
  // restore this session queued would refill the map as the account that just left.
  cb.invalidateRestores();
  cb.conversations.clear();
  cb.forgetUnconfirmedSalonDraws();
  resetSalonUnread();
  cb.setSelectedContact(null);
  setCallSystemMessageContext(null);
  // Decrypted Graine seeds and the channel-to-community map belong to the account that just left.
  setGraineRuntime(null);
  // So are the seed asks parked for a drain (sender ids, request ids); the MLS service's destroy
  // settles its own drain waiters.
  clearParkedAsks();
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
    // A LOGIN IN FLIGHT HOLDS A CLIENT THAT IS NOW THE SIGNED-OUT ACCOUNT'S. The holder lets go of it
    // now, so the next sign-in cannot be handed it (it waits for this retirement, then builds its
    // own); the client is destroyed once that login has stopped and released its socket.
    const stopping = loginInFlightSettled;
    if (stopping) {
      // ITS NETWORK WAITS ARE CANCELLED, so it ends now rather than when a hung request gives up -
      // the retirement below, and the next sign-in behind it, wait for that end.
      loginInFlightAbort?.abort();
      cb.log(
        '[LOGOUT] Signed out during a login - its MLS client is retired once that login stops.'
      );
      void ctx.retireMls(stopping);
      return;
    }
    cb.log('[LOGOUT] Signed out with no live session on this device - nothing to stop.');
    // BUT A CLIENT MAY STILL HOLD A STATE THAT WAS OPENED. The PIN gate's recovery opens the state
    // with the old PIN (`openLocalStateWithKey`) before its PIN change; when that change fails the
    // gate stays up with no session and no login in flight - and the opened manager and its key
    // installed. Retired like any account's client: destroyed now (nothing is being written), and
    // the native session ended in the chain the next sign-in waits on. With no client it ends only
    // the native session, which is then already empty.
    void ctx.retireMls(Promise.resolve());
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

/**
 * Ends the live session ON THIS DEVICE ONLY, because the MLS session under it is lost
 * (`reportMlsSessionLost`): the shell then reopens it at the PIN gate.
 *
 * **A LOST MLS SESSION IS A LOCAL FACT, NOT A STATUS - SO IT IS NEVER A SIGN-OUT.** Only a 401/403 may
 * end an account's session. `clearAuth` would revoke the session on the server (and the identity
 * provider's with it), clear the restore key, end the push registration and erase the shares - and an
 * offline user could not sign back in at all. Here the credential, the push registration and every
 * local store stay; what goes is what runs: the socket, the timers, the in-memory conversations and
 * the MLS client, retired WITHOUT a final checkpoint (`tearDownLiveSession('lost')`), and the native
 * session behind it. The unlock then reads the state as the disk holds it, through every gate.
 */
export function endLostSessionImpl(ctx: SessionContext, cb: ChatSessionCallbacks): void {
  // A LOGIN (OR A RECOVERY) IN FLIGHT IS STOPPED, as a sign-out stops it: it may already have raised
  // `isLoggedIn` (a rotation failing in its connection sync), and left running it went on to build a
  // client in the holder this retires, while the PIN gate's unlock could start a second login beside
  // its tail. Its abort carries the cause, its next stage check throws on it, and the client is
  // retired on its END - which the next login awaits (`whenMlsRetired`) before it opens anything.
  // The abort and not a generation of its own: the abort is already this flow's one stop signal,
  // and it also cancels the network waits a generation would leave the retirement waiting on.
  const stopping = loginInFlightSettled;
  if (stopping) {
    loginInFlightAbort?.abort('lost session' satisfies LoginStop);
    cb.log(
      '[SESSION] MLS session lost during a login - it is stopped; its client retires once it has.'
    );
  }
  if (!ctx.isLoggedIn()) {
    if (stopping) {
      void ctx.retireMls(stopping, 'lost session');
      return;
    }
    cb.log('[SESSION] MLS session lost with no live session on this device - nothing to stop.');
    return;
  }
  try {
    ctx.ensureMls().pauseSocket();
  } catch (e) {
    cb.log(`[SESSION] Could not release the socket - frames may still arrive: ${String(e)}`);
  }
  const nothingWritten = tearDownLiveSession(ctx, cb, 'lost');
  const retiredOn = stopping
    ? Promise.all([nothingWritten, stopping]).then(() => undefined)
    : nothingWritten;
  void ctx
    .retireMls(retiredOn, 'lost session')
    .then(() => cb.log('[SESSION] MLS client retired - the unlock opens the state afresh.'));
  ctx.setStorage(null);
  cb.log('[SESSION] Live session stopped on this device - the credential is kept.');
}
