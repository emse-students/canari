<script lang="ts">
  import { forgetPostComposerMedia } from '$lib/posts/postComposerDraft';
  import { takeKeyGroupPushJoins } from '$lib/utils/graine/keyGroupPushJoins';
  import { noteServerTime } from '$lib/utils/chat/serverClock';
  import { drainNseOutcomes } from '$lib/mobile/nseOutcomes';
  import { resolve } from '$app/paths';
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
  import { page } from '$app/state';
  import { navigating } from '$app/state';
  import { internalPath, loginAfterSessionExpiry } from '$lib/utils/internalPath';
  import { m } from '$lib/paraglide/messages';
  import { BiometricService } from '$lib/services/biometric';
  import { isBiometricPromptDue } from '$lib/services/biometricCadence';
  import {
    loadDeviceKey,
    isDeviceKeyPersistenceEnabled,
    setDeviceKeyPersistence,
  } from '$lib/utils/deviceKeyVault';
  import type { SessionExpiredOutcome } from '$lib/composables/session/sessionTypes';
  import { endExpiredSession } from '$lib/composables/session/endExpiredSession';
  import { setMlsSessionLostHandler, type MlsSessionLoss } from '$lib/mls-client/mlsSessionLoss';
  import { reopenAtPinGate } from '$lib/composables/session/reopenAtPinGate';
  import { isBiometricPromptDismissed } from '$lib/composables/session/sessionBiometrics';
  import {
    isRecoverableWithOldPin,
    withholdsResetForUnreadKey,
    isVaultRefusal,
    type LoginErrorCode,
    provesLocalStateExists,
    provesOtherAccountState,
  } from '$lib/composables/session/loginErrors';
  import { forgetPinSaltAhead } from '$lib/composables/session/pinSaltAhead';
  import {
    getToken,
    clearAuth,
    setSessionExpiredHandler,
    setSignOutHandler,
    isRefreshCredentialProvenDead,
    leaveSignedOut,
  } from '$lib/stores/auth';
  import { currentUserId } from '$lib/stores/user';
  import { sessionAnsweredFor } from '$lib/stores/sessionAnswer.svelte';
  import {
    noteUnlockNeedsMember,
    noteUnlockUnattended,
    unlockUnattendedFor,
  } from '$lib/stores/unlockPath.svelte';
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
  import type { ChatMessage, MessageBatchOrigin } from '$lib/types';
  import PinModal from '$lib/components/auth/PinModal.svelte';
  import ChangePinModal from '$lib/components/auth/ChangePinModal.svelte';
  import BiometricBottomSheet from '$lib/components/auth/BiometricBottomSheet.svelte';
  import BiometricEnrollSheet from '$lib/components/auth/BiometricEnrollSheet.svelte';
  import { biometricPrompt } from '$lib/stores/biometricPrompt.svelte';
  import CallOverlay from '$lib/components/chat/CallOverlay.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { connectivity } from '$lib/stores/connectivity.svelte';
  import {
    departureToDecide,
    isOwnLeave,
    removalOutcome,
    salonGrants,
  } from '$lib/utils/chat/memberRemoval';
  import {
    commitDepartureIfElected,
    commitReleasedDepartureIfElected,
    forgetDeferredRemovals,
  } from '$lib/utils/graine/departureCommitter';
  import { forgetRevokedLeafAnswers } from '$lib/utils/graine/rosterReconcile';
  import { isReadingConversationNow } from '$lib/utils/chat/arrivalRuntime';
  import type { ConversationContext } from '$lib/composables/useConversations.svelte';
  import type {
    ListingRetryTrigger,
    WorkspacePurgeContext,
  } from '$lib/composables/useChannelWorkspaces.svelte';
  import type { MessagingContext } from '$lib/composables/useMessaging.svelte';
  import { MlsSessionVacantError, type BulkIngestPhase } from '$lib/mls-client';
  import type { IStorage, StoredMessage } from '$lib/db';
  import { deliveryUrl } from '$lib/utils/apiUrl';
  import { firstPinSetupFromDevice } from '$lib/utils/pinFirstSetup';
  import { consumeFcmCache } from '$lib/utils/chat/fcmCache';
  import type { PushPlaceholder } from '$lib/utils/chat/fcmCache';
  import { dateBackgroundSentRow, reconcileOutboxSent } from '$lib/utils/chat/outboxMirror';
  import { consumeNativeReadWatermarks } from '$lib/utils/chat/readWatermarkCache';
  import { forgetSalonReadMark } from '$lib/utils/chat/salonReadMarkQueue';
  import {
    refreshAppVersionCheck,
    shouldBlockSessionUnlock,
  } from '$lib/stores/appVersionCheck.svelte';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { isTauriRuntime } from '$lib/utils/openExternal';
  import { LocalizedError, localizedMessage } from '$lib/utils/localizedError';
  import { isMobileTauriRuntime } from '$lib/utils/appVersion';
  import { createPausableInterval } from '$lib/utils/backgroundPausableInterval';
  import { buildConversationRow } from '$lib/utils/chat/conversations';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import { resolveCallPeers } from '$lib/utils/chat/callPeers';
  import { callView } from '$lib/stores/callView.svelte';
  import { notifNav } from '$lib/stores/notifNav.svelte';
  import {
    openNotificationTarget,
    resolveConversationKey,
  } from '$lib/utils/chat/openConversationFromId';
  import {
    chatDeepLinkRoute,
    landingAfterRefresh,
    landingRecovery,
    landingStep,
    openInvitedChannel,
  } from '$lib/utils/chat/notificationRouting';
  import {
    CHANNEL_CONVERSATION_PREFIX,
    isChannelConversationId,
  } from '$lib/utils/chat/channelCrypto';
  import { setGraineRepairListener } from '$lib/utils/graine/runtime';
  import { channelService } from '$lib/services/ChannelService';
  import {
    drainNativePendingCallAccept,
    listenForNativeCallAccept,
  } from '$lib/stores/pendingCallAccept';
  import IncomingShareHost from './IncomingShareHost.svelte';
  import { warnIfSiblingDeviceInCall } from '$lib/utils/callPresence';
  import { callsAvailableAnswered } from '$lib/utils/callsAvailability';
  import { mergeFcmMessagesAndAnnounce } from '$lib/utils/chat/fcmMemoryMerge';
  import { subscribeTabMessageUpdates } from '$lib/mls-client/tabMessageSync';
  import { flushActiveMlsStateEncrypted } from '$lib/mls-client/mlsStatePersisterRegistry';
  import { insertMessageOrdered } from '$lib/utils/chat/messageOrder';
  import { mergeAnnouncedMessage } from '$lib/utils/chat/salonEcho';
  import { forgetDeliveredSalonSend } from '$lib/utils/chat/messaging';
  import { ACCOUNT_KEY, keystoreAlias } from '$lib/utils/accountLocalKeys';

  /** Who is on the other end of the call - from the CALL's conversation, never the one on screen. */
  let callRemoteParticipants = $derived.by(() => {
    const service = globalSession.callService;
    if (!service || globalSession.callState === 'idle') return [];
    return resolveCallPeers({
      userId: globalSession.userId || currentUserId() || '',
      callGroupId: service.currentGroupId,
      conversations: globalConvs.conversations.values(),
      incomingCallerId: service.incomingCallerId,
      nameOf: getUserDisplayNameSync,
    });
  });

  // The PIN lock sits under the call's rung: while it is up, a call is the banner it covers.
  $effect(() => callView.setLocked(showPinModal));

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
   * The LANDING (`notifNav.landing`, one per tap) we have already routed for. Plain (non-reactive)
   * so updating it never re-triggers the effect; it only dedupes the one-shot navigation per
   * landing. It is an identity, not the target id: a second tap on the SAME conversation, from
   * another page, carries the same id and was answered `await-arrival` for ever.
   */
  let lastRoutedLanding = -1;

  /**
   * Pending channel target we already refetched the sidebar for. A just-accepted invitation (card
   * or link) names a channel that is not in the loaded list yet, and `openNotificationTarget`
   * refuses a channel it cannot find - so without one refresh the arrival selects nothing and the
   * join looks like it did nothing. Guarded per target so a genuinely unknown channel (revoked
   * access, deleted community) cannot loop on the endpoint.
   */
  let refreshedWorkspacesForTarget: string | null = null;

  /**
   * Lands the deep-link target: routes to the view that can show it, then selects it.
   *
   * Owns the landing for the whole app - `MainChatPage` deliberately does not duplicate it, since
   * both read the same `globalConvs`/`globalChannels` singletons.
   *
   * The target is held until it is actually displayed, and this effect re-runs on every mutation
   * of the conversations map, so a selection dropped by the IndexedDB restore or by a community
   * prune is re-asserted instead of being lost. It stays idle once the target is on screen, or a
   * plain incoming message would re-select it and refetch its history.
   */
  $effect(() => {
    const id = notifNav.pending;
    const landing = notifNav.landing;
    if (!id) return;
    // THE LANDING NO LONGER WAITS FOR THE SESSION TO ROUTE (F1, 2026-10-12). Routing draws no
    // plaintext - `/chat` without a session is the opaque "connecting" panel, and behind the PIN
    // the gate covers it - so the target's page is reached as soon as the link is parsed, on the
    // strength of a signed-in user on this device, instead of ~0.9 s (vault) to ~2.8 s (PIN) later
    // behind `MLS ready`. What is SELECTED before the session is only what the local preview drew.
    const sessionUp = globalSession.isLoggedIn;
    if (!sessionUp && !currentUserId()) return;
    // Route to the view that can show this target once per pending id. hooks.client.ts also routes,
    // but on a cold start that goto can fire before the SvelteKit router is ready and silently
    // no-op, leaving the user on the home feed. This effect runs post-mount (router ready) and
    // re-runs as login completes / conversations load, so it reliably reaches the right route and
    // selects the target. Community channels live under /communities, DMs/groups under /chat.
    // THE SELECTION WAITS FOR THE ARRIVAL, AND THE BACK BUTTON IS WHAT SAYS SO - the reasoning, and
    // the handset measurement behind it, are on {@link landingStep}. `$page` is read rather than
    // `window.location` because it is REACTIVE: that is what re-runs this effect when the route
    // lands, instead of leaving it waiting for the conversations map to mutate again.
    const targetRoute = chatDeepLinkRoute(id);
    const step = landingStep({
      arrived: page.url.pathname === targetRoute,
      routeAlreadyRequested: lastRoutedLanding === landing,
    });
    if (step !== 'await-arrival') lastRoutedLanding = landing;
    if (step === 'route') {
      appendLog(`[notifNav] routing to ${targetRoute} for pending conversation ${id}`);
      void goto(resolve(targetRoute));
    }
    if (step !== 'select') return;
    // The route is reached: whatever waited for the landing to LEAVE (the feed's first draw) may go.
    notifNav.markArrived();
    const displayedKey = resolveConversationKey(globalConvs.conversations, id);
    // BEFORE THE SESSION, ONLY THE PREVIEW IS SHOWN, AND IT IS SHOWN WITHOUT ACTING: no history
    // request, no read mark, no member load - see `previewSelect`. The real selection runs below
    // the moment the session is up, over the same row.
    const previewed = globalConvs.landingPreviewKey;
    if (!sessionUp) {
      if (displayedKey !== null && displayedKey === previewed) {
        globalConvs.previewSelect(displayedKey);
      }
      return;
    }
    // The session owns the map now: the previewed row stops being a preview, and is selected for
    // real once - which is the only case where "already on screen" must not end the landing.
    if (previewed !== null) globalConvs.endLandingPreview();
    // Already on screen: the landing is done and must stay idle until the target is lost. The
    // selection is a map key and the target is a group id, so they are only ever equal for a
    // channel - matched raw, a landed DM never looked landed, and every mutation of the map
    // re-selected it and re-requested its history.
    if (
      displayedKey !== null &&
      globalConvs.selectedContact === displayedKey &&
      previewed !== displayedKey
    ) {
      return;
    }

    if (
      openNotificationTarget(
        globalConvs,
        convCtx(),
        id,
        (channelId) => (globalChannels.selectedChannelConversationId = channelId)
      )
    ) {
      return;
    }
    const recovery = landingRecovery({
      isChannel: isChannelConversationId(id),
      alreadyRefreshed: refreshedWorkspacesForTarget === id,
      conversationSourcesSettled: globalConvs.conversationSourcesSettled,
      workspacesLoading: globalChannels.isLoadingWorkspaces,
    });
    if (recovery === 'wait') return;
    if (recovery === 'abandon') {
      appendLog(`[notifNav] conversation ${id} not on this device - abandoning`);
      notifNav.clear();
      return;
    }

    // Unresolved channel: refetch the communities once, then let this effect re-run on the
    // resulting conversation update and select it.
    refreshedWorkspacesForTarget = id;
    appendLog(`[notifNav] channel ${id} unknown - refreshing communities before selecting`);
    void globalChannels.loadChannelWorkspacesFromBackend(channelsCtx()).then((refreshRan) => {
      if (notifNav.pending !== id) return;
      const loadError = globalChannels.workspacesLoadError;
      const outcome = landingAfterRefresh({
        refreshRan,
        targetLoaded: globalConvs.conversations.has(id),
        refreshFailed: loadError !== null,
      });
      // Our refetch never ran, or ran and failed: allow one more once it settles. On a failure the
      // online/foreground listener reloads on its own, and this effect re-runs on the result.
      if (outcome === 'retry') {
        refreshedWorkspacesForTarget = null;
        if (loadError)
          appendLog(`[notifNav] channel ${id} refresh failed (${loadError}) - holding`);
      }
      if (outcome !== 'abandon') return;
      appendLog(`[notifNav] channel ${id} still unknown after refresh - abandoning`);
      notifNav.clear();
    });
  });

  /**
   * A preview exists only to show the landing's target. If the reader leaves the landing before
   * the session is up (Back out of the thread, another tab), the row comes off the screen: left in
   * place it would be a conversation list of one, open to taps that would act with no session.
   *
   * A SECOND notification tapped before the session is up is the same case: the landing now names
   * another conversation, and the preview drawn for the first one would stay selected under it -
   * the reader would see, and type into, a thread they did not open. The preview is keyed by the
   * landing target it was drawn for (`previewLandingTarget` stores `notifNav.pending`), so any other
   * pending target, or none, ends it.
   */
  $effect(() => {
    const previewed = globalConvs.landingPreviewKey;
    if (previewed === null || globalSession.isLoggedIn) return;
    const pending = notifNav.pending;
    if (pending === previewed) return;
    untrack(() =>
      globalConvs.discardLandingPreview(
        pending === null
          ? 'the landing was left before the session came up'
          : `another landing (${pending.slice(0, 8)}) replaced it before the session came up`,
        globalMessaging.messageReactions,
        appendLog
      )
    );
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
  /**
   * The local state of this install is PROVEN to be another account's (`device_holds_other_account`:
   * the vaulted key opened `mls.bin` and its credential named someone else). While it holds, the gate
   * offers NO reset - `handlePinReset` -> `resetDeviceAsFresh` -> `removeMlsState` deletes the one
   * `mls.bin` of the install, the other account's state with it - and says why instead. This
   * account stays locked out on this phone, which is the safe outcome: nothing of the other
   * account is ever deleted from this one's session. Cleared by a sign-out, by a session expiry and
   * by a session.
   */
  let deviceHoldsOtherAccount = $state(false);
  /**
   * The last unlock could not READ the hardware-held key (`hardware_key_unreadable`): it may still
   * exist, so the gate withholds the reset - which would erase data a retry opens - and says why. Set
   * and cleared by every failed unlock (`applyPinFailure`), and cleared with the other flag.
   */
  let keyReadRefused = $state(false);
  $effect(() => {
    if (globalSession.isLoggedIn) deviceHoldsOtherAccount = false;
  });
  $effect(() => {
    if (globalSession.isLoggedIn) keyReadRefused = false;
  });
  let pinLoading = $state(false);
  /** The PIN typed on the gate, bound to `PinModal` so a refusal can empty it (`refusePinAttempt`). */
  let pinEntry = $state('');
  let pinStep = $state('');
  let biometricConfigured = $state(false);
  // "Stay signed in" opt-in (browser only): persists the PIN vault across browser restarts.
  // Offered on the PIN modal; initialised from the stored preference so it reflects a prior choice.
  // Disabled once biometrics are configured, because the saved PIN would never be used (the
  // biometric flow takes over at the next launch).
  let showStaySignedIn = $derived(!biometricConfigured);
  let pinStaySignedIn = $state(isDeviceKeyPersistenceEnabled());

  // Post-login biometric enrolment offer sheet (Tauri only)
  let showBiometricEnrollSheet = $state(false);
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
   *
   * Branches on the machine-readable {@link LoginErrorCode}, never on the message: the
   * message is localized, so a regex over it stops matching as soon as the locale changes.
   */
  async function evaluateRecoverable(uid: string, code: LoginErrorCode | undefined) {
    if (!uid || !code || !isRecoverableWithOldPin(code)) {
      canRecoverPin = false;
      return;
    }
    try {
      const { hasMlsState } = await import('$lib/utils/hex');
      canRecoverPin = await hasMlsState(uid);
    } catch {
      canRecoverPin = false;
    }
  }

  /**
   * WHAT A FAILED UNLOCK CHANGES ABOUT THE MODAL, in the one place all three attempts pass through.
   *
   * A FIRST SETUP CANNOT FAIL ON A STATE IT DOES NOT HAVE. `isFirstPinSetup` is a SERVER fact -
   * no `PinVerifier` row for this account - and `local_state_unopenable` is a LOCAL one, so the
   * two can be true at once and the modal had no reading of that pair. It took the server's:
   * `isFirstSetup` relabels the gate "Premiere connexion", and it is also what hides BOTH exits
   * the error names - the old-PIN recovery and the reset. The reader was then told that only a
   * reset restores access, on a screen carrying no reset. Measured on W2, 2026-09-21.
   *
   * THE PATHS DISAGREED, WHICH IS THE PROOF. `onSavedPinFailed` has always cleared the flag; the
   * two interactive handlers never did, and they are the ones a person reaches by typing. One
   * implementation now, branching on the typed code and never on the message.
   */
  function applyPinFailure(uid: string, code: LoginErrorCode | undefined) {
    if (code === 'account_deleted') {
      // An account deleted from this device: nothing to retry and nothing to recover. No salt for a
      // next try (the account exists nowhere to ask it of) and no state lookup - only the recovery
      // a previous failure may have offered is withdrawn.
      canRecoverPin = false;
      appendLog('[PIN] No salt and no recovery asked - this account was deleted from this device.');
      return;
    }
    if (code && provesLocalStateExists(code)) isFirstPinSetup = false;
    keyReadRefused = withholdsResetForUnreadKey(code);
    // A TYPED PIN CAN MEET ANOTHER ACCOUNT'S STATE TOO, not only a saved unlock: `mls.owner` names
    // that account when this one's key does not open `mls.bin`. Read on every path, or the keypad
    // path offered the reset the saved-unlock path withheld.
    noteOtherAccountState(code);
    void evaluateRecoverable(uid, code);
    askSaltForNextTry(code);
  }

  /**
   * Withholds the reset when the failure PROVES this install's state is another account's
   * (`provesOtherAccountState`), whichever path met it - the saved unlock or the keypad.
   */
  function noteOtherAccountState(code: LoginErrorCode | undefined) {
    if (provesOtherAccountState(code)) {
      deviceHoldsOtherAccount = true;
      appendLog(
        "[MLS] This install's MLS state is another account's - the reset is withheld at the gate."
      );
    }
  }

  /**
   * The last submit consumed its salt; the next one gets its own, asked while the person retypes.
   *
   * ONE PLACE FOR EVERY FAILED UNLOCK THAT LEAVES THE KEYPAD UP, which is why it is called from
   * `applyPinFailure`: the keypad's own wrong-PIN handler, the saved-PIN path and the biometric
   * button all pass through there. NOT after a revocation - the device has just been returned to a
   * fresh install, there is no session to ask the salt with, and the request could only fail.
   */
  function askSaltForNextTry(code: LoginErrorCode | undefined) {
    if (code === 'device_revoked') {
      appendLog('[PIN] No salt asked for a next try - the device was revoked and wiped.');
      return;
    }
    if (isFirstPinSetup) return;
    globalSession.prefetchPinSalt(appendLog);
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
        // The session reports its own refusal through `onLoginFailed`, already localized; the
        // literal that used to stand here was the one English sentence this modal could show. It
        // is a `LocalizedError` for the same reason: the catch below shows a `LocalizedError`'s
        // message and replaces every other one, so a bare `Error` here would lose this sentence.
        throw new LocalizedError(failMsg || m.auth_pin_recovery_login_failed());
      }
      showRecoverModal = false;
      showPinModal = false;
      canRecoverPin = false;
      pinError = '';
    } catch (e) {
      // `recoverPinImpl` throws a `LocalizedError` for each refusal the reader has to tell apart -
      // the old PIN, the new PIN, no local state, a server that would not answer. Anything else is
      // dev prose and the declared line stands in its place.
      recoverError = localizedMessage(e, m.auth_pin_recovery_failed());
      appendLog(`[PIN_RECOVER] failed: ${String(e)}`);
    } finally {
      recoverLoading = false;
      recoverProgress = null;
    }
  }

  let showBiometricSheet = $state(false);
  /** Lets startLoginFlow() know the user chose "use the PIN code" rather than biometrics on
   *  the BiometricBottomSheet. */
  let biometricCancelled = $state(false);

  function onBiometricSkip() {
    biometricCancelled = true;
    showBiometricSheet = false;
  }

  /**
   * Returns false when the encryption PIN must not be asked for at all.
   *
   * Two independent facts refuse it, and both are known BEFORE the keypad is mounted. The platform
   * gates - minimum version, maintenance - refuse an unlock the server would not honour. The dead
   * refresh credential refuses one the client cannot use: a correct PIN would unlock MLS state for
   * a session that is already over, and the user would be redirected to the login gate a second
   * later having typed a secret for nothing (measured on W1, 2026-08-28).
   *
   * Named for the question rather than for one of its two answers, because it is now both.
   *
   * SYNCHRONOUS ON PURPOSE: both facts are already in memory, and the signature is what keeps a
   * future caller from putting I/O back in front of the unlock.
   */
  function mayPromptForPin(): boolean {
    if (isRefreshCredentialProvenDead()) {
      appendLog('[platform] PIN prompt declined - refresh credential already proven dead.');
      return false;
    }
    // THE VERDICT IS ALREADY HERE, AND WAITING FOR A FRESHER ONE COST EVERY LAUNCH A ROUND TRIP.
    //
    // The probe below used to be awaited here. The store hydrates `lastCheck` from cached server
    // metadata synchronously at import, and the root layout fires a refresh on mount, so that wait
    // never produced the FIRST verdict - only a newer one - while `GET /api/version` sat in front
    // of the unlock. On a degraded link that is not a small cost: the probe carries a retry ladder of
    // 3 x 8 s timeouts plus backoff, so the fingerprint prompt could be held back ~26 s before
    // answering from exactly the cache consulted below (Pixel 6a, 2026-09-15).
    //
    // Nothing is weakened by reading it now. A verdict that BLOCKS still refuses the prompt here,
    // and a refresh that lands on a blocking answer afterwards is not lost: `PlatformGateOverlay`
    // is mounted in the root layout and derives from this same store, so it raises itself over
    // whatever the session has reached. The gate is the overlay; this call is the shortcut.
    void refreshAppVersionCheck();
    if (shouldBlockSessionUnlock(isGlobalAdmin())) {
      appendLog('[platform] MLS unlock blocked (maintenance or minimum version gate)');
      return false;
    }
    return true;
  }

  /**
   * The ONE place the keypad is put on screen. A keypad on screen means a PIN is owed, so the
   * unlock fact is set back to "needs the member" here and nowhere else: every caller that draws
   * the keypad also hides the community list and holds the pre-session listing (F1).
   */
  function showPinGate(reason: string): void {
    noteUnlockNeedsMember();
    appendLog(`[PIN] Keypad shown (${reason}) - the unlock is owed to the member`);
    showPinModal = true;
  }

  /**
   * Opens the PIN modal for the given user.
   *
   * THE GATE IS DRAWN ON THE LOCAL FACT WHEN THERE IS ONE. A device that enrolled this user is a
   * returning one, so the server's `pin-status` - which waited for the token refresh, then a round
   * trip, ~0.5 s of a cold start behind a notification - is asked only by a device that never did.
   * See {@link firstPinSetupFromDevice}.
   */
  async function openPinModal(uid: string, opts?: { deviceIdUnproven?: boolean }) {
    // A PIN is owed: the device is locked from here until the unlock, whatever page is shown (F1).
    noteUnlockNeedsMember();
    if (!mayPromptForPin()) return;
    globalSession.userId = uid;
    // A device id the attempt that just FAILED minted proves nothing about a PIN: a refused vault
    // resolves this account's id before the state refuses it, so it would read "returning" for an
    // account that has never chosen one, and draw the keypad without its confirmation step.
    const knownLocally = opts?.deviceIdUnproven ? null : firstPinSetupFromDevice(localStorage, uid);
    if (knownLocally !== null) {
      appendLog('[PIN] Gate drawn from the enrolled device id - no pin-status round trip');
      isFirstPinSetup = knownLocally;
    } else {
      isFirstPinSetup = await detectFirstPinSetup(uid);
    }
    // The salt does not depend on the PIN, so it is asked while the person types. A first setup
    // is excluded: on a user without a salt that GET is a write (see `prefetchPinSaltImpl`).
    if (!isFirstPinSetup) globalSession.prefetchPinSalt(appendLog);
    showPinGate('open');
  }

  /**
   * Called when the session is definitively dead (refresh cookie expired/revoked). Rather
   * than leave a "Session expired" message stuck in the PIN modal - which strands the user
   * with no clear action - close the modal, clear the auth state, and redirect straight to
   * the login page so they can sign in again.
   *
   * ONE DEAD SESSION IS ANSWERED DIFFERENTLY: one the server ended BECAUSE ITS OWNER REVOKED THIS
   * DEVICE (`revokedDeviceOfEndedSession`, latched from the refresh refusal, naming this device). That device
   * is returned to a fresh install - the same reset the `device_revoked` frame runs, joined if it is
   * already running - before the redirect. Read from the latch, not from whoever called: the
   * notifier, a login that met the dead session, and a late handler's replay all land here, and the
   * reset must not depend on which came first. Measured on DEV-2 (2026-10-25): the frame's check met
   * the dead session, read "not revoked", and this generic sign-out kept every local store.
   */
  async function handleSessionExpired(outcome?: SessionExpiredOutcome) {
    // RELEASING THIS CALLER IS NOT THE LOGOUT, AND DEDUPLICATING THEM TOGETHER SILENCED THE
    // TRIGGER. `_sessionExpiredHandled` answers "has a logout already run for this expiry" -
    // several observers reach the same verdict at once (the global notifier, the promotion path, a
    // login attempt) and one logout is enough. It was also, wrongly, gating the part that releases
    // whoever is waiting RIGHT NOW, and those two have different lifetimes: the first is true once
    // per expiry, the second is true again on every single submit.
    //
    // Measured on W1, 2026-08-28. The session had expired earlier, so the guard was already set.
    // A PIN submit then ran `loginImpl` -> `getToken()` -> `refresh()`, which is latched once a
    // 401 has proven the cookie dead, threw `SessionExpiredError`, and reached here - where this
    // function returned at the guard without touching the modal. `handlePinSubmit` clears its
    // watchdog on `onMlsReady` and `onLoginFailed` only, so nothing cleared it: ten seconds later
    // the spinner was unblocked with "Le deverrouillage prend plus de temps que prevu. Veuillez
    // reessayer." - an invented cause, and advice that can never work, since the latch is
    // permanent by design and only a fresh credential clears it. The client's own log said exactly
    // what had happened; the modal said something else.
    //
    // So the release is unconditional and runs first. Every line of it is idempotent.
    dismissAuthPrompts();
    pinError = '';
    // The refused account leaves with its session: kept, the flag withheld the reset from the NEXT
    // account's gate on this shell (the root layout outlives `/login`), which may be the owner's.
    deviceHoldsOtherAccount = false;
    keyReadRefused = false;
    _loginInProgress = false;
    globalSession.isLoginInProgress = false;

    if (_sessionExpiredHandled) {
      // NOT A SILENT RETURN. This is the branch that used to swallow the whole event, and the only
      // trace it can leave is this line.
      appendLog('[AUTH] Session expired again - the logout already ran; released the PIN modal.');
      return;
    }
    _sessionExpiredHandled = true;
    // The page the user was GOING to is read before `clearAuth` awaits: a deep link's navigation is
    // usually still in flight here (its `load` is what met the 401), and `navigating.to` is the
    // only place that target lives. A bare `/login` dropped a tapped post push (Mi 9T, 2026-10-08).
    const loginPath = loginAfterSessionExpiry(
      (navigating.to?.url ?? (typeof window === 'undefined' ? null : window.location)) as {
        pathname: string;
        search: string;
        hash: string;
      } | null
    );
    // A session the server ended BECAUSE ITS OWNER REVOKED THIS DEVICE resets the device first. The
    // account is the refused credential's: on a cold start no login has named it to the session yet.
    //
    // The sign-out is `endExpiredSession`'s decision: the revoked-device reset's own `clearAuth` counts.
    await endExpiredSession({
      outcome,
      settleRevocation: () =>
        globalSession.settleSessionEndByRevocation(
          sessionCb(),
          globalSession.userId || currentUserId() || ''
        ),
      signOut: clearAuth,
      loginPath,
      log: appendLog,
    });
    void goto(resolve(internalPath(loginPath)), { replace: true });
  }

  /**
   * A lost MLS session (`reportMlsSessionLost`): the live session ends on this device and the account
   * reopens at the PIN gate. NOT `handleSessionExpired`: nothing here is a 401/403, so nothing is
   * revoked, erased or signed out - see `reopenAtPinGate`.
   */
  async function handleMlsSessionLost(why: MlsSessionLoss) {
    await reopenAtPinGate({
      why,
      endLiveSession: () => globalSession.endLostSession(sessionCb()),
      releaseLoginFlow: () => {
        dismissAuthPrompts();
        pinError = '';
        _loginInProgress = false;
        globalSession.isLoginInProgress = false;
      },
      openPinGate: () => openPinModal(globalSession.userId || currentUserId() || ''),
      log: appendLog,
    });
  }

  /**
   * The device half of every sign-out, run by `clearAuth` before it drops the credential.
   *
   * TWO THINGS OUTLIVED A SIGN-OUT, AND TOGETHER THEY LOCKED THE NEXT SIGN-IN OUT (Mi 9T,
   * 2026-10-14, 2 of 2). The live session kept running - so the foreground resume after the sign-in
   * browser reconnected it before the OIDC callback had its token, met the dead credential and set
   * `isLoggedIn` false behind the callback's back - and `_loginInProgress`, which the login that
   * SUCCEEDED never releases, still said a login owned the flow. Every later trigger (`afterNavigate`,
   * the user-id effect) returned on it: no PIN gate, no vault unlock, "Connexion en cours..." for
   * four minutes, and only a relaunch recovered. Ending the session here removes the race; releasing
   * the latch here is what lets the next sign-in start, whatever ended the previous one.
   */
  function handleSignedOut() {
    noteUnlockNeedsMember();
    globalSession.endSession(sessionCb());
    // After the teardown, and whether or not there was a live session to tear down: the community
    // list of the leaving account goes, and a listing started on its token stops (F1/F2).
    globalChannels.forgetAccount(appendLog);
    // ...and so do its staged attachments and armed replies, keyed by ids the next account may share.
    globalMessaging.forgetAccount(appendLog);
    // ...and the media held by a closed new-post composer (`holdPostComposerMedia`).
    forgetPostComposerMedia();
    // ...and the salon grants seen, which order the next account's removals against nothing of theirs.
    salonGrants.clear();
    // ...and the revocation answers it was given, which the next account must ask for itself.
    forgetRevokedLeafAnswers();
    // ...and the removals this device deferred to an actor, which a release is matched against.
    forgetDeferredRemovals();
    _loginInProgress = false;
  }

  /**
   * The PIN gate's way out, and the ONE that destroys nothing.
   *
   * The gate stopped being dismissible on 2026-09-05 (see the comment on `PinModal.svelte`), which
   * makes an exit mandatory rather than optional: without one, a person who has forgotten their PIN
   * has only the destructive reset, and a modal that cannot be closed and offers nothing but "erase
   * my message history" is a softlock with a button on it.
   *
   * IT IS THE APP'S ORDINARY SIGN-OUT, deliberately - `clearAuth()` then `leaveSignedOut()` (which
   * also ends the MiConnect session), the same two lines the navbar's logout runs. `clearAuth` ends the session on the server, drops the access
   * token, the refresh credential and the persisted ACKs, and touches NOTHING that a PIN protects:
   * `mls.bin`, the message database and the device key vault are all still there afterwards. The
   * user asked for exactly this ("deconnecter seulement, garder l'etat"), and it is what makes the
   * exit safe to offer without a confirmation step.
   *
   * THE GATE COMES DOWN LAST, which is the opposite order to `handleSessionExpired` and for the
   * opposite reason. There, callers are blocked on a promise and the release is what unblocks them.
   * Here nobody is waiting: the person pressed a button, and taking the gate down before `clearAuth`
   * has come back would show them the app they are not allowed into for as long as the round trip
   * lasts. `PlatformGateOverlay` holds its own gate the same way, on the same argument.
   */
  async function handlePinSignOut() {
    deviceHoldsOtherAccount = false;
    keyReadRefused = false;
    appendLog('[AUTH] Sign-out from the PIN gate - ending the session, keeping the local state.');
    // A failure here is a failure to REVOKE, never a reason to strand the user on a gate they asked
    // to leave - and a swallowed one would leave nothing behind, so it is accused by name.
    await clearAuth().catch((e) => appendLog(`[AUTH] Sign-out: clearAuth failed - ${e}`));
    await leaveSignedOut();
    dismissAuthPrompts();
    pinError = '';
    _loginInProgress = false;
    globalSession.isLoginInProgress = false;
  }

  /**
   * Called when a stored PIN is rejected; resets state and shows the PIN modal again.
   *
   * Re-asking is only worth it while a session could still use the answer. A login that failed
   * BECAUSE the refresh credential is dead arrives here like any other rejection, and putting the
   * keypad back up then asks for a secret whose verification is already impossible - the same
   * defect `mayPromptForPin` exists to prevent, reached from the one path that does not go through
   * it. The latch is synchronous, so the check costs nothing and needs no await here.
   */
  function onSavedPinFailed(msg: string, code?: LoginErrorCode) {
    if (isRefreshCredentialProvenDead()) {
      appendLog('[platform] Stored PIN rejected on a dead session - not re-prompting.');
      showPinModal = false;
      return;
    }
    pinError = msg;
    // A REFUSED VAULT SAYS NOTHING ABOUT THIS ACCOUNT'S PIN - not even that it has one: the vault
    // was another account's, or an older build's that could not prove itself. So the gate is drawn
    // from the SERVER, never assumed "returning" - and not from the device id either, which the
    // refused attempt itself may have just minted (`openPinModal`).
    if (isVaultRefusal(code)) {
      noteOtherAccountState(code);
      appendLog('[VAULT] Saved unlock refused for this account - drawing its own PIN gate.');
      void openPinModal(globalSession.userId || currentUserId() || '', { deviceIdUnproven: true });
      return;
    }
    isFirstPinSetup = false;
    showPinGate('saved unlock failed');
    applyPinFailure(globalSession.userId || currentUserId() || '', code);
  }

  /**
   * Returns true only when the user has never registered a PIN (no PinVerifier row
   * server-side) - the genuine "first setup" case. This is the source of truth, unlike
   * a device-count check which wrongly reports "first setup" for a user whose devices
   * were all revoked/GC'd but who still has a registered PIN (picking a new PIN would
   * then fail the verifier with a confusing mismatch). Defaults to false on any
   * network/auth failure so the "first setup" wording is never shown by mistake.
   * Asked only by a device holding no enrolled device id ({@link openPinModal}).
   */
  async function detectFirstPinSetup(uid: string): Promise<boolean> {
    try {
      const token = await getToken();
      const res = await fetch(
        `${deliveryUrl()}/api/mls/security/pin-status/${encodeURIComponent(uid)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) return false;
      const { registered } = (await res.json()) as { registered: boolean };
      return !registered;
    } catch {
      return false;
    }
  }

  // Guard against concurrent login attempts (e.g. onMount + afterNavigate both firing).
  let _loginInProgress = false;
  // Guard against several observers reaching the "session is dead" verdict at once.
  let _sessionExpiredHandled = false;

  /** Closes PIN/biometric modals as soon as MLS unlocks; catch-up continues in the background. */
  function dismissAuthPrompts() {
    forgetPinSaltAhead('keypad closed', appendLog);
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
      deviceKeyB64: globalSession.deviceKeyB64,
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
      deviceKeyB64: globalSession.deviceKeyB64,
      authToken: globalSession.authToken,
      setAuthToken: (v: string) => {
        globalSession.authToken = v;
      },
      selectedContact: globalConvs.selectedContact,
      selectedNow: () => globalConvs.selectedContact,
      getSendError: () => globalConvs.sendError,
      setSendError: (v: string) => {
        globalConvs.sendError = v;
      },
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
      signalChannelRead: (channelId: string) => void channelService.markChannelRead(channelId),
    };
  }

  function channelsCtx() {
    return {
      conversations: globalConvs.conversations,
      saveConversation: (name: string) => globalConvs.saveConversation(name, convCtx()),
      deleteConversation: (name: string) =>
        globalSession.storage?.deleteConversation(name) ?? Promise.resolve(),
      storedSalonPageIds: () =>
        globalSession.storage?.getMessageConversationIds(CHANNEL_CONVERSATION_PREFIX) ??
        Promise.resolve([]),
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
  async function checkSiblingCallWarning() {
    // One /api/calls/sibling-status request fires per session start. While calls are held off - by
    // this build or by the server's kill switch - it could only ever report a legacy device, and it
    // would say so in a toast about a call this client cannot join: pure noise.
    // Awaited until /api/version has answered: at session start the switch reads `off` by default,
    // and skipping on that would silence the check for the whole session.
    if (!(await callsAvailableAnswered())) return;
    const deviceId = globalSession.myDeviceId;
    if (!deviceId || globalSession.callState !== 'idle') return;
    void warnIfSiblingDeviceInCall(deviceId);
  }

  /**
   * Erases a community from local state, then clears the chat panel if the conversation on
   * screen belonged to it. The channel ids have to be read BEFORE the purge, which is exactly
   * what makes this shared by the two ways a community can vanish under the user: an admin
   * deleted it, or an admin removed the user from it.
   * @param workspaceId Server id of the community leaving local state.
   * @param purge The event-specific handler doing the removal (it owns the log line).
   */
  async function dropCommunityLocally(
    workspaceId: string,
    purge: (ctx: WorkspacePurgeContext) => Promise<void>
  ) {
    const doomedChannelIds =
      globalChannels.channelWorkspaces
        .find((ws) => ws.workspaceDbId === workspaceId)
        ?.channels.map((ch) => ch.id) ?? [];
    await purge({
      conversations: globalConvs.conversations,
      deleteConversation: (id: string) =>
        globalSession.storage?.deleteConversation(id) ?? Promise.resolve(),
      invalidateChannelHistoryCache: globalConvs.invalidateChannelHistoryCache,
      log: appendLog,
    });
    if (globalConvs.selectedContact && doomedChannelIds.includes(globalConvs.selectedContact)) {
      globalConvs.selectedContact = null;
      globalConvs.sendError = '';
    }
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
      invalidateRestores: () => globalConvs.invalidateRestores(),
      forgetUnconfirmedSalonDraws: () => globalConvs.forgetUnconfirmedSalonDraws(),
      beginConversationSource: () => globalConvs.beginConversationSource(),
      endConversationSource: () => globalConvs.endConversationSource(),
      previewLandingTarget: (input: {
        storage: IStorage;
        deviceKeyB64: string;
        userId: string;
        storeOpenMs: number;
        owner: number;
        isCurrent: () => boolean;
      }) =>
        globalConvs.previewLandingTarget({
          ...input,
          messageReactions: globalMessaging.messageReactions,
          isSessionUp: () => globalSession.isLoggedIn,
          log: appendLog,
        }),
      discardLandingPreview: (reason: string, owner: number) =>
        globalConvs.discardLandingPreview(
          reason,
          globalMessaging.messageReactions,
          appendLog,
          owner
        ),
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
        contactName: string,
        origin: MessageBatchOrigin
      ) => globalMessaging.batchAddMessages(msgs, contactName, msgCtx(), origin),
      saveConversation: (name: string) => globalConvs.saveConversation(name, convCtx()),
      selectConversation: globalConvs.selectConversation,
      onChannelMemberJoined: (event: any) => {
        if (!event.channelId) return;
        const channelConversationId = `channel_${event.channelId}`;
        // READ BEFORE THE PLACEHOLDER IS MADE: a community this device has never seen is a join
        // in-session, and the event names ONE salon of it.
        const communityIsNew = globalChannels.isCommunityUnknownToEvent(event);
        const workspace = globalChannels.ensureWorkspaceForChannelEvent(event);
        const isPrivate = event.visibility === 'private';
        // The server's casing (`validateChannelName` keeps it), so a salon shows the same on a
        // device that heard of it live as on one that listed it after a reload.
        const channelName = event.channelName || 'canal';
        globalChannels.addChannelToWorkspace(workspace.id, {
          id: channelConversationId,
          name: channelName,
          isPrivate,
        });
        if (!globalConvs.conversations.has(channelConversationId)) {
          globalConvs.conversations.set(
            channelConversationId,
            buildConversationRow({
              id: channelConversationId,
              lifecycle: 'active',
              identity: {
                contactName: channelConversationId,
                displayName: channelName,
              },
              lastMessageAt: Date.now(), // creation moment, see groupCreation
            })
          );
        }
        // Without this the channel is registered but belongs to no community as far as the send
        // path is concerned, so the first message typed into it is refused until an app relaunch
        // runs the full workspace hydration. A private salon also enters its own distribution
        // group here, for the same reason and in the same window.
        if (communityIsNew) {
          // The listing a reload runs registers, enters and lists EVERY salon of the community this
          // member may read, this one included - so it replaces `registerJoinedChannel` here rather
          // than following it.
          void globalChannels.hydrateJoinedCommunity(channelsCtx());
        } else if (workspace.workspaceDbId) {
          void globalChannels
            .registerJoinedChannel(
              event.channelId,
              workspace.workspaceDbId,
              isPrivate,
              globalSession.ensureMls,
              appendLog
            )
            .catch((e) =>
              // `String(e)` rather than the usual ternary: this is a LOG, where the exception's own
              // words are the point, and the ternary is the exact shape `serverProse.test.ts` reads
              // as a site RENDERING them - a regex cannot tell one from the other.
              appendLog(
                `[GRAINE] could not prepare joined channel ${event.channelId}: ${String(e)}`
              )
            );
        }
        appendLog(`Joined channel ${event.channelId}`);

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
                // A join notice is not activity: the seed does not move for it.
              });
            } catch {
              // Non-blocking: system message is best-effort.
            }
          })();
        }
      },
      onChannelRemovalReleased: (event: {
        workspaceId: string;
        channelId: string;
        removedUserId: string;
        releasedBy: string;
        releasedByDevice: string;
      }) => {
        // The actor did not commit a Remove it claimed, and said so: elect for that one scope,
        // among everybody but the actor.
        void commitReleasedDepartureIfElected(
          channelService,
          {
            workspaceId: event.workspaceId,
            channelId: event.channelId,
            departedUserId: event.removedUserId,
            releasedByUserId: event.releasedBy,
            releasedByDeviceId: event.releasedByDevice,
          },
          appendLog
        );
      },
      onChannelMemberKicked: (event: any) => {
        const outcome = removalOutcome({
          localUserId: globalSession.userId,
          kickedUserId: event.kickedUserId,
          channelId: event.channelId,
          channelIsPrivate: event.channelIsPrivate,
        });
        if (outcome === 'ignore') {
          // Somebody else left or was removed. When the actor cannot commit it - a leave, or an
          // actor with no leaf in a key group - ONE elected remaining device does (`departureCommitter`).
          const departure = departureToDecide(event);
          if (departure) void commitDepartureIfElected(channelService, departure, appendLog);
          return;
        }

        if (outcome === 'community') {
          const communityName =
            globalChannels.channelWorkspaces.find((ws) => ws.workspaceDbId === event.workspaceId)
              ?.name ?? '';
          void dropCommunityLocally(event.workspaceId, (ctx) =>
            globalChannels.handleRemovedFromWorkspace(event, ctx)
          );
          showToast(m.channel_removed_from_community({ community: communityName }), 'info');
          return;
        }

        if (outcome === 'public-channel') {
          appendLog(
            `Removed from public channel #${event.channelName || event.channelId} - access retained`
          );
          return;
        }

        const channelConversationId = `channel_${event.channelId}`;
        globalConvs.invalidateChannelHistoryCache(channelConversationId);
        globalConvs.conversations.delete(channelConversationId);
        void globalSession.storage
          ?.deleteConversation(channelConversationId)
          .catch((e: unknown) =>
            appendLog(`[CHANNEL] stored copy of ${event.channelId} not deleted: ${String(e)}`)
          );
        globalChannels.removeChannelFromWorkspaces(channelConversationId);
        if (globalConvs.selectedContact === channelConversationId) {
          globalConvs.selectedContact = null;
          globalConvs.sendError = '';
        }
        if (globalChannels.selectedChannelConversationId === channelConversationId) {
          globalChannels.selectedChannelConversationId = '';
        }
        // A salon this user LEFT is announced to their own devices too (2026-10-27), so they drop
        // it; being told they were "removed" from it would be false, so a leave says nothing.
        const selfLeft = isOwnLeave(event, globalSession.userId);
        appendLog(`${selfLeft ? 'Left' : 'Removed from'} channel ${event.channelId}`);
        if (!selfLeft) {
          showToast(m.channel_removed_from_channel({ channel: event.channelName || '' }), 'info');
        }
      },
      onRolePermissionsChanged: (event: { roleId: string; permissions: string[] }) => {
        globalChannels.handleRolePermissionsChanged(event);
        appendLog(
          `[ROLE] ${event.roleId.slice(0, 8)} now grants ${event.permissions.length} permission(s)`
        );
      },
      onChannelUpdated: (event: { channelId: string; name?: string; viewerCanWrite?: boolean }) => {
        if (!event.channelId) return;
        const channelConversationId = `channel_${event.channelId}`;
        // ONE PASS FOR BOTH FACTS, and each applied only when the event carried it: a rename sends
        // no verdict about writing and an access change sends no name. `canWrite` is what the chat
        // view reads to decide whether to offer a composer at all, so this is the whole difference
        // between learning of a new rule now and learning of it on the next full load.
        if (event.name || typeof event.viewerCanWrite === 'boolean') {
          globalChannels.channelWorkspaces = globalChannels.channelWorkspaces.map((ws) => ({
            ...ws,
            channels: ws.channels.map((ch) =>
              ch.id === channelConversationId
                ? {
                    ...ch,
                    ...(event.name ? { name: event.name } : {}),
                    ...(typeof event.viewerCanWrite === 'boolean'
                      ? { canWrite: event.viewerCanWrite }
                      : {}),
                  }
                : ch
            ),
          }));
          appendLog(
            `[CHANNEL] #${event.name ?? event.channelId} updated - canWrite=${String(event.viewerCanWrite ?? 'unchanged')}`
          );
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
        // A mark still owed for it could only meet the server's 404 CHANNEL_NOT_FOUND.
        forgetSalonReadMark(globalSession.userId || currentUserId() || '', channelConversationId);
        void globalSession.storage
          ?.deleteConversation(channelConversationId)
          .catch((e: unknown) =>
            console.warn(
              `[CHANNEL] deleted salon ${event.channelId.slice(0, 8)} left its local row: ${String(e)}`
            )
          );
        globalChannels.removeChannelFromWorkspaces(channelConversationId);
        if (globalConvs.selectedContact === channelConversationId) {
          globalConvs.selectedContact = null;
          globalConvs.sendError = '';
        }
        if (globalChannels.selectedChannelConversationId === channelConversationId) {
          globalChannels.selectedChannelConversationId = '';
        }
      },
      onWorkspaceUpdated: (event: {
        workspaceId: string;
        imageMediaId?: string;
        channelsReordered?: boolean;
      }) => {
        globalChannels.handleWorkspaceUpdated(event);
        if (event.channelsReordered) {
          appendLog(`[CHANNEL_ORDER] community ${event.workspaceId.slice(0, 8)} rearranged`);
          globalChannels.refreshChannelOrder(event.workspaceId).catch((error: unknown) => {
            appendLog(
              `[CHANNEL_ORDER] re-read of ${event.workspaceId.slice(0, 8)} failed: ${String(error)}`
            );
          });
        }
      },
      onSalonUnreadCleared: () => {
        // One request for every salon, whichever community was cleared: the answer is per account.
        void globalChannels.refreshSalonUnread(channelsCtx(), 'community cleared on a device');
      },
      onWorkspaceRoleChanged: (event: {
        workspaceId: string;
        roleName: string;
        canManage: boolean;
        canManageChannels?: boolean;
        canModerate?: boolean;
        permissions: string[];
      }) => {
        globalChannels.handleWorkspaceRoleChanged(event);
        appendLog(
          `[WORKSPACE] my role in ${event.workspaceId.slice(0, 8)} is now "${event.roleName}" (canManage=${event.canManage} canManageChannels=${event.canManageChannels ?? 'unchanged'} canModerate=${event.canModerate ?? 'unchanged'})`
        );
      },
      onWorkspaceDeleted: (event: { workspaceId: string }) => {
        if (!event.workspaceId) return;
        void dropCommunityLocally(event.workspaceId, (ctx) =>
          globalChannels.handleWorkspaceDeleted(event, ctx)
        );
      },
      onChannelMessageDeleted: (event: { channelId: string; messageId: string }) => {
        globalChannels.handleChannelMessageDeleted(event, {
          conversations: globalConvs.conversations,
          invalidateChannelHistoryCache: globalConvs.invalidateChannelHistoryCache,
          log: appendLog,
        });
      },
      onReadStateAdvanced: (e: { conversationKey: string; senderId: string; at: number }) => {
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
        // A session that unlocked holds a live credential, so the expiry `handleSessionExpired`
        // deduplicated is over: the NEXT one must log out again. Never reset, the guard swallowed
        // every later expiry of the same process - no sign-out, no redirect, a dead session left up.
        _sessionExpiredHandled = false;
        dismissAuthPrompts();
        void checkSiblingCallWarning();
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
    void openInvitedChannel(channelId);
  }

  // ── Load channel workspaces on the ACCESS TOKEN, not on MLS ready (F2) ────
  // The listing is a REST call and needs the token alone; `isLoggedIn` flips only once the unlock
  // and MLS initialisation are through - 650 ms later on the Mi 9T at 1x, 1.9 s at 4x
  // (community-open-budget). The one step that needs MLS, the key group, awaits it on its own
  // (`whenMlsReady`). `isLoggedIn` stays a trigger: an offline unlock has a session and no token.
  // A DERIVED, so the flip of `isLoggedIn` after the token does not list a second time.
  // Before the session, ONLY for an unlock that prompts nobody: a device owing a PIN is locked, and
  // lists nothing until it is unlocked (`unlockPath.svelte.ts`).
  const listingMayStart = $derived(
    globalSession.isLoggedIn ||
      (sessionAnsweredFor() !== null &&
        sessionAnsweredFor() === currentUserId() &&
        unlockUnattendedFor() === currentUserId())
  );
  $effect(() => {
    if (!listingMayStart) return;
    untrack(() => {
      void globalChannels.loadChannelWorkspacesFromBackend(channelsCtx()).then((refreshRan) => {
        if (refreshRan && globalChannels.workspacesLoadError !== null) {
          appendLog(
            `[WORKSPACE-LOAD] post-login community load failed: ${globalChannels.workspacesLoadError}`
          );
          // No blocking UI: the online/foreground listener will retry automatically.
        }
      });
    });
  });

  // ── Live stream transitions: the salon copies held against it ─────────────
  // A salon in memory is current only while the socket that keeps it current has had no gap, so
  // the gap itself - a pause, a drop, a reconnect - is what marks it stale. See
  // `noteLiveStreamTransition`. The first reading is a baseline, not a transition.
  let lastLiveStreamUp: boolean | null = null;
  $effect(() => {
    const up = globalSession.isWsConnected;
    untrack(() => {
      const previous = lastLiveStreamUp;
      lastLiveStreamUp = up;
      if (previous === null || previous === up || !globalSession.isLoggedIn) return;
      void globalConvs.noteLiveStreamTransition(up, convCtx());
    });
  });

  // ── Online / foreground resume: retry a failed workspace load ─────────────
  onMount(() => {
    // A Graine repair lands minutes after the rows it repairs were rendered unreadable and dropped,
    // and nothing else would go back for them before the user next leaves and re-enters the salon.
    // Registered HERE because this is the layer holding both the seed layer and the conversations.
    setGraineRepairListener((channelIds) => {
      for (const channelId of channelIds) {
        const conversationId = `channel_${channelId}`;
        globalConvs.invalidateChannelHistoryCache(conversationId);
        void globalConvs.loadHistoryForConversation(conversationId, conversationId, convCtx());
      }
    });

    // THE RECONNECT, NOT THE BROWSER'S `online` ALONE: `connectivity.onReconnect` fires on `online`
    // AND when the server answers again after a transport failure - the one proof that a listing
    // which gave up on a dead link can now succeed. The decision (retry, or owe it to the listing in
    // flight) is the composable's: `retryFailedListing`.
    function handleReconnect(trigger: ListingRetryTrigger) {
      if (!globalSession.isLoggedIn) return;
      globalChannels.retryFailedListing(channelsCtx(), trigger);
    }

    function handleVisibility() {
      if (document.visibilityState !== 'visible') return;
      handleReconnect('foreground');
    }

    const stopReconnect = connectivity.onReconnect(() => handleReconnect('reconnect'));
    document.addEventListener('visibilitychange', handleVisibility);

    // The refresh endpoint is the only place that learns a session is dead, and it can learn it
    // from any caller - a background poll, a socket reconnect, a native auto-login. Wiring the
    // reaction once, here, is what makes the logout unmissable instead of depending on which path
    // happened to observe the 401 (WP-ANDROID-SESS-1).
    setSessionExpiredHandler(() => void handleSessionExpired());
    // A signed-in session whose MLS session is lost is NOT an expired one - that is a status, this a
    // local fact (`mlsSessionLoss.ts`) - so it ends on this device only and reopens at the PIN gate.
    setMlsSessionLostHandler((why) => void handleMlsSessionLost(why));
    // And every sign-out, whichever button ran `clearAuth`: see `handleSignedOut`.
    setSignOutHandler(handleSignedOut);

    return () => {
      stopReconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      setSessionExpiredHandler(null);
      setMlsSessionLostHandler(null);
      setSignOutHandler(null);
      setGraineRepairListener(null);
    };
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

      showBiometricEnrollSheet = true;
    });
  });

  /**
   * Consumes the native FCM cache and injects messages directly into reactive memory,
   * enabling immediate display without waiting for the next history poll (5s or foreground resume).
   */
  async function flushFcmCache(deviceKeyB64: string, storage: IStorage) {
    if (globalMessaging.isMessageCatchupActive) return;
    // A CONVERSATION SOURCE, exactly as at login: this pass is what turns a first message from a
    // new correspondent into a conversation, so a deep-link landing that ran while it was in
    // flight would read a map that is complete-looking and wrong. Resume is if anything the more
    // common case of the two - the app is backgrounded far more often than it is killed.
    globalConvs.beginConversationSource();
    try {
      // THE USER ID IS READ BEFORE THE CALL, NOT AFTER IT. It decides which member of a DM is the
      // PEER, so a placeholder built without it would name this device's own user as the
      // correspondent - and the guard that used to sit below only checked it once the rows were
      // already written.
      const selfId = globalSession.userId;
      if (!selfId) return;
      const injected = await consumeFcmCache(deviceKeyB64, storage, selfId).catch(() => ({
        messages: [] as StoredMessage[],
        placeholders: new Map<string, PushPlaceholder>(),
      }));
      if (injected.messages.length === 0) return;
      // The placeholders are what let a FIRST message from a new correspondent appear without a
      // restart - see `mergeFcmMessagesIntoConversations`. Each row it creates is ANNOUNCED, since
      // frames refused for lack of that row wait on it and nothing else is scheduled on a resume.
      mergeFcmMessagesAndAnnounce(
        injected.messages,
        globalConvs.conversations,
        selfId,
        injected.placeholders,
        (groupId) => globalSession.ensureMls().notifyConversationAvailable(groupId)
      );
    } finally {
      globalConvs.endConversationSource();
    }
  }

  /** Applies leader-tab message broadcasts to follower tab UI state. */
  function applyTabMessageEvent(event: import('$lib/mls-client/tabMessageSync').TabMessageEvent) {
    // A COMPOSED MESSAGE IS HANDLED BEFORE THE ROLE IS EVEN READ, because it is the one event on
    // this channel a FOLLOWER sends and the LEADER needs. Everything below it is the leader
    // relaying what it alone receives, which a leader must not apply to itself.
    if (event.type === 'own_message_composed') {
      const target = globalConvs.conversations.get(event.conversationId);
      if (!target) return;
      // Deduplicated on the id, which is what makes this safe to accept from anywhere: the row is
      // already in the shared IndexedDB outbox, so whichever copy arrives first is the same row.
      if (target.messages.some((m) => m.id === event.message.id)) return;
      globalConvs.conversations.set(event.conversationId, {
        ...target,
        messages: insertMessageOrdered(target.messages, event.message),
        ...(event.lastMessageAt !== undefined
          ? { lastMessageAt: Math.max(target.lastMessageAt ?? 0, event.lastMessageAt) }
          : {}),
        // `unreadCount` is deliberately untouched: an own message is never unread, and the sender
        // has nothing to say about what this tab has read.
      });
      return;
    }

    // A READ IS THE OTHER FACT A FOLLOWER MAY KNOW THAT A LEADER DOES NOT, and the leader must
    // apply it too: reading happens in whichever tab is open on the conversation, either role.
    // Applied only up to the watermark the reading tab saw, so a message that arrived in the gap
    // between the read and this broadcast keeps its unread state instead of being swallowed.
    if (event.type === 'conversation_read') {
      const target = globalConvs.conversations.get(event.conversationId);
      if (!target) return;
      if ((target.lastMessageAt ?? 0) <= event.readAt) {
        globalConvs.conversations.set(event.conversationId, { ...target, unreadCount: 0 });
      }
      return;
    }

    if (globalSession.isTabLeader) return;
    const convo = globalConvs.conversations.get(event.conversationId);
    if (!convo) return;
    // The leader counted this arrival against ITS selection. A follower tab that has the
    // conversation open is reading it, so taking the leader's count verbatim put a badge on an open
    // conversation that nothing cleared afterwards - the live path's `isConversationOpen` rule.
    const isOpenHere = isReadingConversationNow(event.conversationId, globalConvs.selectedContact);

    if (event.type === 'message_added') {
      // The leader relays a frame the SERVER dated: this tab, which receives none itself, notes it
      // like the leader did, so its own read marks are bounded the same (serverClock.ts).
      noteServerTime(globalSession.userId || currentUserId() || '', event.message.serverTimestamp);
      const merged = mergeAnnouncedMessage(convo.messages, event.message, event.clientMessageId);
      if (!merged) return;
      if (merged.settledEcho && event.clientMessageId) {
        // This tab composed it and the leader received the frame: the send is proven delivered.
        forgetDeliveredSalonSend(
          event.clientMessageId,
          globalSession.userId || currentUserId() || ''
        );
        console.debug(
          `[TAB-SYNC] own salon echo ${event.clientMessageId.slice(0, 8)}... settled by the leader as ${event.message.id.slice(0, 8)}...`
        );
      }
      globalConvs.conversations.set(event.conversationId, {
        ...convo,
        messages: merged.messages,
        ...(event.lastMessageAt !== undefined ? { lastMessageAt: event.lastMessageAt } : {}),
        unreadCount: isOpenHere ? 0 : event.unreadCount,
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
      ...(event.lastMessageAt !== undefined ? { lastMessageAt: event.lastMessageAt } : {}),
      unreadCount: isOpenHere ? 0 : event.unreadCount,
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
      if (!mayPromptForPin()) {
        globalSession.isLoginInProgress = false;
        return;
      }

      // ── TAURI (MOBILE) BRANCH ──
      if (isTauriRuntime()) {
        const savedUser = currentUserId();
        if (!savedUser) {
          globalSession.isLoginInProgress = false;
          return;
        }
        globalSession.userId = savedUser;

        // Step 1: check whether biometrics are CONFIGURED (user flag) — P1-A
        // NEVER query the keystore if the user disabled biometrics, even if a leftover key exists.
        let biometricAttempted = false;
        const isBiometricConfigured = await BiometricService.isConfigured();

        if (isBiometricConfigured) {
          const deviceKey = ACCOUNT_KEY.deviceId(savedUser);
          const storedDeviceId = localStorage.getItem(deviceKey);
          const hasExistingDevice = storedDeviceId !== null;

          if (hasExistingDevice) {
            const alias = keystoreAlias(savedUser, storedDeviceId);
            const keyPresent = await BiometricService.isKeyPresent(alias).catch(() => false);

            if (keyPresent) {
              biometricAttempted = true;
              biometricConfigured = true;
              biometricCancelled = false;
              // The cadence decides whether this launch raises the sheet at all. When it does not,
              // the key is read unattended and no sheet is shown - the in-app one included, which
              // would otherwise say "touch the sensor" for a read that asks nothing. A failure lands
              // on the PIN modal, whose "use biometrics" button always prompts.
              const promptDue = await isBiometricPromptDue();
              showBiometricSheet = promptDue;
              // A keystore read with no prompt due asks nobody: the unlock is unattended (F1).
              if (promptDue) noteUnlockNeedsMember();
              else noteUnlockUnattended(savedUser);

              // THE WINDOW THIS TIMER PROTECTED WAS ONE NOBODY COULD USE. A 250 ms sleep sat here
              // so a tap on the sheet's "use my PIN" could land before the OS prompt was raised -
              // but nobody reads a sheet and decides in a quarter of a second, so the delay was
              // paid by every cold launch and spent by none. Choosing the PIN once the OS prompt
              // is up works and always did: cancelling it is the documented route to the PIN modal
              // (see the catch in biometricLoginImpl), and it is the route real users already take.
              //
              // The check below stays - it costs nothing and answers a fact rather than a clock:
              // a skip that has ALREADY happened must not be overridden by a prompt.
              if (biometricCancelled) {
                showBiometricSheet = false;
              } else {
                // Same handover as the web branch below, and for the same reason: this function
                // raised isLoginInProgress for the +layout.ts guard, and loginImpl refuses to run
                // when that flag is set - it cannot tell our flag from a real concurrent login.
                // Left set, the automatic biometric attempt of every cold launch was swallowed
                // ("[LOGIN] Call ignored, a login already owns the flow"): the sheet appeared, no
                // OS prompt ever did, and the flow fell through to the PIN modal - where the same
                // tap on "use biometrics" worked, because line ~918 had cleared the flag by then.
                globalSession.isLoginInProgress = false;
                await globalSession.biometricLogin(
                  {
                    ...sessionCb(),
                    onLoginFailed: onSavedPinFailed,
                  },
                  { unattended: !promptDue }
                );
                dismissAuthPrompts();
              }
            }
          }
        }

        if (!globalSession.isLoggedIn) {
          // P2-A: no automatic fallback after a biometric failure. If biometrics were attempted
          // and failed or were cancelled, the user must enter their PIN explicitly — no
          // nativeStorageLogin.
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

          // Fallback: PIN modal. It keeps the "use fingerprint" button exactly when biometrics
          // were actually usable (configured AND a key present in the keystore), so a user who
          // cancelled or mistyped the prompt can retry it instead of being forced onto the PIN.
          // When no biometric is enrolled the button stays hidden - it could only fail again.
          biometricConfigured = biometricAttempted;
          globalSession.isLoginInProgress = false;
          await openPinModal(savedUser);
        }
        return;
      }

      // ── WEB BRANCH ──
      // THE VAULT IS READ FOR THE ACCOUNT SIGNING IN, never for "whoever left one": a key another
      // account left is not offered, and the unlabelled one of an older build is offered only to be
      // proven by the login (`loadDeviceKey`).
      const savedUser = currentUserId();
      const vaulted = savedUser ? await loadDeviceKey(savedUser) : null;
      if (savedUser && vaulted) {
        // Only a slot whose owner is proven unlocks without anyone: an unlabelled one may be
        // another account's, and its login is what proves it (F1).
        if (vaulted.ownerProven) noteUnlockUnattended(savedUser);
        globalSession.userId = savedUser;
        globalSession.deviceKeyB64 = vaulted.deviceKeyB64;
        // loginImpl checks isLoginInProgress itself and will bail if it's true.
        // Reset it here so loginImpl can set it and manage its own lifecycle.
        globalSession.isLoginInProgress = false;
        void globalSession.login(
          { ...sessionCb(), onLoginFailed: onSavedPinFailed },
          { vaultOwnerUnproven: !vaulted.ownerProven }
        );
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
    // WP-XP-5: an answer on the native ring (Android or CallKit) may predate this cold start - the
    // answer is what launched the app. Held now, it is joined from its own facts once the login's
    // socket has caught up; no invite is awaited (`pendingCallAccept.ts`).
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
    // native mls_foreground_heartbeat command is platform-agnostic, and holds the guard only while a
    // foreground manager is loaded (`heartbeat_foreground_guard`): at the PIN gate there is nothing
    // to protect, and a page iOS launched in the background believes itself visible.
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
        // CHECKPOINT FIRST, THEN RELEASE THE GUARD - the order is the whole point, not a nicety.
        // Releasing it is what lets a background JNI engine load `mls.bin` and advance the ratchet
        // from it; if the foreground's own advances have not landed yet, that engine starts from a
        // state already behind and re-issues generations this device has spent, which the peer
        // refuses as `SecretReuseError`. The guard would expire on its own after ~30s, so nothing
        // here is load-bearing on a clock: it only makes the handoff immediate AND ordered.
        void flushActiveMlsStateEncrypted()
          .catch((e) => {
            // Loud, and the release still happens: holding the guard on a failed flush would
            // strand background delivery entirely, which is a worse failure than the one above.
            console.error('[MLS] Checkpoint before backgrounding failed:', e);
          })
          .finally(() => invokeNative('pause_mls_foreground'));
        return;
      }
      if (document.visibilityState === 'visible' && !globalSession.isLoggedIn) {
        // A warm app still at its PIN gate: an answer given on the native ring meanwhile is held
        // now, and joined once the login's socket has caught up (`pendingCallAccept.ts`).
        void drainNativePendingCallAccept();
      }
      if (document.visibilityState === 'visible' && globalSession.isLoggedIn) {
        const { deviceKeyB64, storage } = globalSession;
        // Ordered resume sequence. C2 first: reload mls.bin into the warm engine BEFORE anything
        // processes, because a background join/send may have advanced it while we were away; the
        // stale warm state would otherwise clobber that advance on the next save (SecretReuse).
        // No-op off Android. Then reconcile outbox_sent BEFORE the flusher re-reads the queue (so
        // we don't re-send a message the background already delivered), then reconnect/flush.
        void (async () => {
          // WHAT THE SOCKET WAITS FOR ON A RESUME, step by step: a warm notification tap's reply is
          // held until this sequence reaches `resumeConnection` (~0.5 s on the Mi 9T, 2026-10-11),
          // and the total alone cannot say which step holds it.
          const resumeStart = performance.now();
          const steps: string[] = [];
          let stepStart = resumeStart;
          const stepDone = (name: string) => {
            const now = performance.now();
            steps.push(`${name} ${Math.round(now - stepStart)}`);
            stepStart = now;
          };
          try {
            await globalSession.ensureMls().reloadStateFromDisk();
          } catch (e) {
            if (!(e instanceof MlsSessionVacantError)) throw e;
            // The loss was reported and the session is reopening at the PIN gate: no later step of
            // this resume may run on it.
            appendLog(
              '[RESUME] Stopped - no native MLS session under this session; it reopens at the PIN gate.'
            );
            return;
          }
          stepDone('reload');
          // The push-join ledger is the warm process's too (channel-encryption section 26): taken
          // right after the reload, so a group joined while away is registered before the drain.
          await takeKeyGroupPushJoins(globalSession.ensureMls(), (line) => console.log(line));
          stepDone('key-group-joins');
          // The notification extension's outcomes while away (`nseOutcomes.ts`), not awaited.
          void drainNseOutcomes(appendLog);
          if (storage) {
            await reconcileOutboxSent(storage, {
              deviceKeyB64: globalSession.deviceKeyB64,
              userId: globalSession.userId,
              onDated: (id, receivedAt) =>
                dateBackgroundSentRow(globalConvs.conversations, id, receivedAt),
            }).catch((e) => appendLog(`[OUTBOX_MIRROR] Resume reconcile failed: ${String(e)}`));
          }
          stepDone('outbox');
          // WP-XP-5: the user may have answered the native ring while we were away. Held BEFORE the
          // reconnect, it is joined once that socket has caught up (`pendingCallAccept.ts`).
          await drainNativePendingCallAccept();
          stepDone('call');
          // WHAT THE SHADE DID WHILE WE WERE AWAY IS MERGED BEFORE THE SOCKET OPENS, in the order
          // login uses: the FCM cache first, then the shade's read watermarks recomputed over it.
          // The reconnect pulls every row still queued for this device, including one a reply from
          // the shade has already answered; `notifyInbound` can only leave that one silent if the
          // conversation row already says it was read. Until 2026-10-01 the watermarks were merged
          // at login only, so a resumed app re-announced it (Mi 9T).
          if (deviceKeyB64 && storage) await flushFcmCache(deviceKeyB64, storage);
          stepDone('fcm');
          const selfId = globalSession.userId;
          if (selfId) {
            await consumeNativeReadWatermarks(globalConvs.conversations, selfId, (key) =>
              globalConvs.saveConversation(key, convCtx())
            ).catch((e) => appendLog(`[READ_WATERMARK] Resume merge failed: ${String(e)}`));
          }
          stepDone('watermarks');
          // resumeConnection, NOT attemptReconnect: `pauseConnection` stopped the connection and
          // sync watchdogs on the way out, and only this seam re-arms them - so it must run even
          // when the socket survived the background, hence no isWsConnected guard here. Calling
          // attemptReconnect directly left a mobile client with no timer able to notice a later
          // dead socket, which is exactly what was measured on hardware (see resumeConnectionImpl).
          // The step timings ride on its `[LIFECYCLE] App in foreground` line.
          void globalSession.resumeConnection(
            sessionCb(),
            `resume prepared in ${Math.round(performance.now() - resumeStart)} ms: ${steps.join(', ')} ms`
          );
          void checkSiblingCallWarning();
        })();
      }
    };

    /**
     * The network coming back is evidence conditions changed, exactly like a foreground
     * transition - and it must reach the same seam.
     *
     * WHAT THIS BUYS IS LATENCY, NOT RECOVERY, and the distinction is the lesson of
     * WP-RECONNECT-1. The reconnect ladder used to stop after 20 attempts and wait for exactly
     * these two events to release it - which stranded for ever every client that can emit neither
     * (a desktop tab, foreground, unchanged network). The ladder no longer stops, so a client with
     * no lifecycle events at all still recovers on its own. This handler resets the backoff to its
     * first rung, turning "within 30 s" into "now" when there is real evidence the outage ended.
     *
     * `resumeConnection` is idempotent here: it resets the ladder, re-arms the watchdogs, and
     * returns immediately if the socket is already up.
     */
    const handleOnlineResume = () => {
      if (!globalSession.isLoggedIn) return;
      // The network coming back is not the app coming back: a paused connection stays closed until
      // the foreground, and lifting it here would reconnect a backgrounded app.
      if (globalSession.isConnectionPaused) {
        appendLog(
          '[LIFECYCLE] Network back online while paused - the foreground resume reconnects.'
        );
        return;
      }
      appendLog('[LIFECYCLE] Network back online - re-arming watchdogs and reconnecting...');
      void globalSession.resumeConnection(sessionCb());
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnlineResume);
    // The native side says an answer waits (`canari:call-accept`): a page that sees no
    // visibilitychange - iOS launched it in the background `visible` (1.5.2-alpha.2, K7/K8), or a
    // warm Android activity at the PIN gate - drains it here (`listenForNativeCallAccept`).
    const stopNativeCallAccept = listenForNativeCallAccept();

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
      window.removeEventListener('online', handleOnlineResume);
      stopNativeCallAccept();
      unsubscribeTabMessages();
      if (fcmPollTimer !== null) clearInterval(fcmPollTimer);
      clearInterval(gcTimer);
      stopForegroundHeartbeat?.();
    };
  });

  // ── Biometrics: post-login enrolment handlers ─────────────────────────────

  async function handleBiometricEnroll() {
    showBiometricEnrollSheet = false;
    await globalSession.enrollBiometric();
    // After a successful enrollment, refresh biometricConfigured for the next flow
    if (globalSession.isLoggedIn) {
      biometricConfigured = await BiometricService.isConfigured().catch(() => false);
    }
  }

  async function handleBiometricEnrollDismiss() {
    showBiometricEnrollSheet = false;
    await globalSession.dismissBiometricPrompt();
  }

  async function handleBiometricFromModal() {
    pinError = '';
    pinLoading = true;
    await globalSession.biometricLogin(
      sessionCb({
        onLoginFailed: (msg: string, code?: LoginErrorCode) => {
          pinError = msg;
          pinLoading = false;
          applyPinFailure(globalSession.userId || currentUserId() || '', code);
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

  /**
   * ONE PLACE FOR A KEYPAD ATTEMPT THAT WAS REFUSED, whatever refused it (wrong PIN, no server, a
   * login that returned without answering): the message, the spinner released, and the typed PIN
   * EMPTIED - kept, the next digits were appended to it (see `PinModal`'s `pin`).
   */
  function refusePinAttempt(msg: string) {
    pinError = msg;
    pinLoading = false;
    pinStep = '';
    pinEntry = '';
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

    /**
     * Whether the login ANSWERED - `onMlsReady` or `onLoginFailed`, whichever came first.
     *
     * THIS REPLACED A TEN-SECOND CLOCK, AND THE CLOCK WAS WRONG ON EVERY COLD START OF A REAL
     * PHONE. It called itself a "temporal safety net" for "an unexpected early return or a hung
     * network call" and, on expiry, told the user in red that the unlock had failed and to try
     * again. Measured on a Mi 9T on 2026-09-06, three times out of three: the watchdog fired at
     * 18:47:58 and the login succeeded at 18:48:10 - twelve seconds later, having spent them inside
     * one native call that decrypts a 19.9 MB `mls.bin` and emits nothing at all while it does. So
     * the clock could not distinguish "hung" from "working", and its guess manufactured the retry
     * that then hits `loginImpl`'s "a login already owns the flow" guard, which returns silently.
     *
     * The case it was written for is real and stays covered - but by a PROOF rather than a guess.
     * `login()` always settles; the only way a caller can be left waiting is for it to settle
     * without having answered, which is exactly what an early return looks like from here. That is
     * observable, so it is observed. A slow login is no longer a failed one, and a genuinely silent
     * return is reported as what it is instead of being timed.
     *
     * What this deliberately does NOT cover is a promise that never settles - a hung fetch. That is
     * a missing deadline on the REQUEST, where the fact lives; inventing a verdict here would be
     * the same mistake in a shorter form. Root cause of the twelve seconds:
     * `docs/wiki/backlog.md`, the 19.5 MB entry.
     */
    let answered = false;

    void globalSession
      .login(
        sessionCb({
          onMlsReady: () => {
            answered = true;
            clearTimeout(stepTimer);
          },
          onLoginFailed: (msg: string, code?: LoginErrorCode) => {
            answered = true;
            clearTimeout(stepTimer);
            refusePinAttempt(msg);
            applyPinFailure(globalSession.userId || currentUserId() || '', code);
          },
        })
      )
      .then(() => {
        // Settled with no answer: something returned early without resolving this caller's UI.
        // Nothing else can release the modal, and the message says what happened rather than
        // guessing why.
        if (answered || !pinLoading) return;
        clearTimeout(stepTimer);
        refusePinAttempt(m.auth_pin_no_result());
        _loginInProgress = false;
        appendLog('[PIN] login() returned without calling back - unblocking the PIN modal.');
      })
      .catch((e: unknown) => {
        // login() routes errors through onLoginFailed; this guards against a rejection
        // that escapes that path (e.g. before the internal try) leaving the spinner stuck.
        //
        // TWO KINDS REACH HERE AND ONLY THE THROW KNOWS WHICH. The login flow throws a
        // `LocalizedError` for the PIN calls it can name (`auth_pin_salt_unreachable`,
        // `auth_pin_check_unreachable`); anything else escaping is an exception nobody planned
        // for, whose message is English - and on THIS modal an English line reads exactly like
        // "your PIN is wrong".
        answered = true;
        clearTimeout(stepTimer);
        refusePinAttempt(localizedMessage(e, m.auth_pin_login_failed()));
        _loginInProgress = false;
        appendLog(`[PIN] login() rejected: ${String(e)}`);
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
    // The modal no longer offers it in this state; this is the second lock, on the act itself.
    if (deviceHoldsOtherAccount) {
      appendLog(
        "[PIN_RESET] REFUSED - this install's MLS state is another account's, and the reset deletes it."
      );
      pinError = m.auth_pin_reset_blocked_other_account();
      return;
    }
    if (keyReadRefused) {
      appendLog(
        '[PIN_RESET] REFUSED - the hardware-held key could not be read but may exist; a reset would erase data a retry opens.'
      );
      pinError = m.auth_pin_reset_withheld_key_unreadable();
      return;
    }
    pinError = '';
    pinLoading = true;
    pinStep = m.auth_pin_step_resetting();
    appendLog(`[PIN_RESET] Starting for userId=${uid.slice(0, 8)}…`);
    // The reset deletes the account's salt; one asked before it can only be stale.
    forgetPinSaltAhead('PIN reset', appendLog);
    try {
      const token = await getToken();
      const res = await fetch(`${deliveryUrl()}/api/mls/security/pin-reset`, {
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
      // Deliberately NOT gated on `mayPromptForPin`: the POST above carried a live access token, so
      // the credential is not dead, and the local MLS state is already wiped. Declining the keypad
      // here would strand the user mid-reset with nothing to unlock and no way to finish.
      showPinGate('PIN reset');
    } catch (e) {
      // The `Server-side PIN reset failed.` thrown above is a DEV line and used to be shown as it
      // stood - an English sentence on a French modal, and the only thing the reader was told.
      // It stays exactly as it is, in the log, where it is correct.
      pinError = m.auth_pin_reset_failed();
      appendLog(`[PIN_RESET] Failed: ${String(e)}`);
    } finally {
      pinLoading = false;
      pinStep = '';
    }
  }

  // Safety net for navigations that arrive before onMount's startLoginFlow completes
  // (e.g. the OIDC callback navigates to /posts while onMount already ran with uid=null).
  // Delegates to startLoginFlow which handles both mobile and web paths uniformly.
  afterNavigate(async ({ to, shallow, type }) => {
    // A SHALLOW navigation (SvelteKit 3 runs the lifecycle hooks for them too) is a tab or query
    // change on the same page: not a page the hook is about.
    if (shallow && type === 'goto') return;
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

    if (!mayPromptForPin()) {
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

<!-- Post-login biometric enrolment offer (Tauri only), shown once after the first PIN entry -->
<BiometricEnrollSheet
  open={showBiometricEnrollSheet}
  onEnroll={handleBiometricEnroll}
  onDismiss={handleBiometricEnrollDismiss}
/>

<!-- In-app companion to the OS biometric prompt: unlock at login, or enrolment confirmation.
     During enrolment no onSkip is passed - the OS prompt owns the interaction. -->
<BiometricBottomSheet
  open={showBiometricSheet || biometricPrompt.enrolling}
  variant={biometricPrompt.enrolling ? 'enroll' : 'unlock'}
  onSkip={biometricPrompt.enrolling ? undefined : onBiometricSkip}
/>

<!-- PIN modal (visible on all routes) -->
<PinModal
  open={showPinModal}
  onSubmit={handlePinSubmit}
  onClose={() => {
    forgetPinSaltAhead('keypad closed', appendLog);
    showPinModal = false;
    _loginInProgress = false;
    globalSession.isLoginInProgress = false;
  }}
  onSignOut={handlePinSignOut}
  onBiometricRequest={handleBiometricFromModal}
  showBiometricButton={biometricConfigured}
  {showStaySignedIn}
  bind:staySignedIn={pinStaySignedIn}
  externalError={pinError}
  bind:pin={pinEntry}
  isLoading={pinLoading}
  loadingStep={pinStep}
  isFirstSetup={isFirstPinSetup}
  onForgotPinReset={deviceHoldsOtherAccount || keyReadRefused ? undefined : handlePinReset}
  resetWithheldNotice={deviceHoldsOtherAccount
    ? m.auth_pin_reset_blocked_other_account()
    : keyReadRefused
      ? m.auth_pin_reset_withheld_key_unreadable()
      : ''}
  onRecoverPin={canRecoverPin ? handleOpenRecover : undefined}
/>

<!-- "Envoyer a...": where a share from another app goes (visible on all routes, after the PIN) -->
<IncomingShareHost />

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
  <CallOverlay callService={globalSession.callService} participants={callRemoteParticipants} />
{/if}
