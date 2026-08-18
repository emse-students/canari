import { parseDirectPeerFromName, resolveDirectPeerId } from '$lib/utils/chat/conversations';
import { decodeAppMessage } from '$lib/proto/codec';
import { appMsgToEnvelope, normalizeMessageId } from '$lib/utils/chat/messageUtils';
import { applyReaction } from '$lib/utils/chat/messageReactions';
import { requestReAdd, cancelReAdd, resetReAddCooldowns } from '$lib/utils/chat/recovery';
import {
  markEpochGap,
  clearEpochGap,
  resetEpochGapRegistry,
} from '$lib/utils/chat/epochGapRegistry';
import { attemptCommitReplay } from '$lib/utils/chat/commitReplay';
import { runExclusiveForGroup } from '$lib/utils/chat/groupMutationQueue';
import { handleSystemEvent } from './systemMessageHandler';
import { handleChannelEvent } from './channelEventHandler';
import { noteUnackedFrame } from './unackedFrames';
import { frameFingerprint, hasFrameBeenProcessed, noteFrameProcessed } from '../inboundFrameLedger';
import { reconcileGroup } from '$lib/utils/chat/historyReconcile';
import { hasHistoryFrameBeenConsumed, markHistoryFrameConsumed } from '$lib/utils/chat/history';
import type { IncomingDeliveryMeta } from '../incomingDelivery';
import { classifyIncomingDecryptError } from '../mlsDecryptError';
import { createMlsStatePersister } from '../mlsStatePersister';
import { installMlsStatePersisterLifecycle } from '../mlsStatePersisterLifecycle';
import { registerMlsStatePersister } from '../mlsStatePersisterRegistry';
import type { MessageHandlerDeps } from './deps';
export type { MessageHandlerDeps } from './deps';

/** Short-lived message buffered while waiting for a Welcome. */
type PendingMsg = { sender: string; content: Uint8Array };

/**
 * Recovery action a failing Welcome defers to AFTER releasing the MLS lock (the recovery seams
 * re-acquire the same non-reentrant mutex). `readd` = clean rejoin (externalJoin first);
 * `nomatch` carries the per-group failure count so the first detection republishes key material.
 */
type DeferredRecovery =
  | { kind: 'readd'; target: string }
  | { kind: 'nomatch'; target: string; failures: number };

/**
 * Consecutive `NoMatchingKeyPackage` failures allowed per group before escalating
 * from a simple welcome_request (inviter re-adds us) to a full recovery
 * (requestReAdd). Prevents the Welcome ↔ welcome_request livelock when the re-add
 * fails persistently (published KeyPackage orphaned from its local private key).
 */
const MAX_NOMATCH_KP_RETRIES = 3;

/**
 * How long a group may remain in an epoch gap (`msg_epoch > group_epoch`)
 * before escalating to a full recovery. Beyond this threshold, missing commits
 * will not return (purged from the server queue): we forget the forked state
 * and request a new Welcome to rejoin at the current epoch.
 */
const EPOCH_GAP_ESCALATION_MS = 30_000;

/** Per-terminal-group NoMatchingKeyPackage failure counter, used for escalation. */
const noMatchKpFailures = new Map<string, number>();

/**
 * Installs the MLS message handler.
 *
 * Simplified architecture (RFC 9420 + OpenMLS fork-resolution):
 * - Welcome -> processing + buffer replay
 * - Unknown group -> immediate welcome_request (seam) + buffer; cadence owned by the SYNC_WATCHDOG
 * - Known group -> decrypt -> display / requestReAdd if out-of-sync
 *
 * Invariants:
 * 1. Every message is ACKed exactly once.
 * 2. `requestReAdd` replaces every escalation (no Poison Pill, no counters).
 * 3. Recovery state (cooldowns) is in-memory only - reset on every session.
 */
export function setupMessageHandler(deps: MessageHandlerDeps): void {
  // No `userId` here any more: its only consumer at this scope was the state persister's config, and
  // the platform now owns where a checkpoint lands (`IMlsService.persistCheckpoint`). The handlers
  // further down re-destructure their own from `deps`.
  const { mlsService, deviceKeyB64, log } = deps;

  // Start from a clean epoch-gap registry: it is module-global (shared with the outbox) and must
  // not carry a stale entry over from a previous session.
  resetEpochGapRegistry();
  // Same rationale for the recovery cooldowns: a re-login must not inherit a stale throttle.
  resetReAddCooldowns();

  const statePersister = createMlsStatePersister({ mlsService, deviceKeyB64, log });
  registerMlsStatePersister(statePersister);
  installMlsStatePersisterLifecycle(statePersister);

  // The persister satisfies BulkIngestObserver (onBulkIngestStart/End): it defers the encrypted
  // MLS checkpoint to one flush per drain. The UI render buffer registers its own observer in
  // sessionAuth; the two are independent subscribers, no longer multiplexed over one hook.
  mlsService.addBulkIngestObserver(statePersister);

  // Buffer of commits that arrived before their Welcome, replayed once the Welcome lands. No
  // expiry timer: the SYNC_WATCHDOG owns the re-add cadence; the entry is dropped on Welcome, and
  // the same frames also stay server-side (handleUnknownGroup returns false) as a fallback.
  const pendingBuffer = new Map<string, { msgs: PendingMsg[] }>();

  // Per-group recovery timers - map shared with the connection layer
  // (connectionRecoveryTimers): only one timer armed per group regardless of source.
  const recoveryTimers = deps.recoveryTimers;

  // Shared callback for all out-of-sync cases.
  const onOutOfSync = async (groupId: string) => {
    log(`[PIPELINE] Out-of-sync for ${groupId.slice(0, 8)}… - requestReAdd`);
    await requestReAdd(groupId, deps, recoveryTimers);
  };

  /**
   * Starts a recovery WITHOUT blocking the caller, and says so when it settles.
   *
   * The message callback runs inside the inbound drain, and the drain's `isDraining` flag is only
   * lowered once the callback returns - so an `await` here that never settles stops EVERY later
   * inbound message, in silence, exactly as the hidden-tab deadlock did (WP-HIDDEN-1). Measured on
   * the device 2026-08-06: one `requestReAdd` that never returned left `Drain start` with no
   * `Drain complete`, and the next two messages were enqueued and never processed.
   *
   * Nothing was ever gained by waiting: the recovery's result is not read, and what it waits for -
   * a Welcome, an external join - lands long after this frame has been answered. The callback's job
   * is to decide ACK or no-ACK, not to see the repair through.
   */
  const startRecovery = (groupId: string): void => {
    void onOutOfSync(groupId).then(
      () => log(`[PIPELINE] Recovery attempt finished for ${groupId.slice(0, 8)}…`),
      (e) =>
        log(
          `[PIPELINE] Recovery attempt FAILED for ${groupId.slice(0, 8)}…: ${String(e).slice(0, 120)}`
        )
    );
  };

  // Channel events (channel membership, epoch_rejected, etc.)
  mlsService.onChannelEvent = (event) => {
    void handleChannelEvent(event, {
      conversations: deps.conversations,
      addMessageToChat: deps.addMessageToChat,
      onChannelMemberJoined: deps.onChannelMemberJoined,
      onChannelMemberKicked: deps.onChannelMemberKicked,
      onChannelUpdated: deps.onChannelUpdated,
      onChannelDeleted: deps.onChannelDeleted,
      onWorkspaceUpdated: deps.onWorkspaceUpdated,
      onWorkspaceDeleted: deps.onWorkspaceDeleted,
      onChannelMessageDeleted: deps.onChannelMessageDeleted,
      log,
      onOutOfSync,
    });
  };

  mlsService.onMessage(
    async (sender, content, groupId, isWelcome, ratchetTreeBytes, isCommit, deliveryMeta) => {
      const senderNorm = sender.toLowerCase();

      // ── Welcome ──────────────────────────────────────────────────────────────
      if (isWelcome) {
        return handleWelcome({
          sender: senderNorm,
          content,
          groupId,
          ratchetTreeBytes,
          deps,
          statePersister,
          pendingBuffer,
          recoveryTimers,
          startRecovery,
        });
      }

      if (!groupId) return true; // ACK without group - control frame

      // ── A community's Graine key-distribution group ───────────────────────
      // BEFORE both branches below, and that order is the point. This group carries channel seeds
      // and never a chat message, so it has no conversation: `handleKnownGroup` would look one up,
      // find nothing, and return WITHOUT acknowledging - redelivering every seed for ever while
      // reading none of them. `handleUnknownGroup` would ask for a Welcome nobody sends, this group
      // being joined by external commit.
      if (mlsService.isDistributionGroup(groupId)) {
        return mlsService.routeDistributionFrame(groupId, senderNorm, content);
      }

      // ── Unknown group (not in the local WASM) ─────────────────────────────
      const inGroup = mlsService.getLocalGroups().includes(groupId);
      if (!inGroup) {
        return handleUnknownGroup({
          sender: senderNorm,
          content,
          groupId,
          deps,
          pendingBuffer,
          startRecovery,
        });
      }

      // ── Groupe connu ─────────────────────────────────────────────────────
      return handleKnownGroup({
        sender: senderNorm,
        content,
        groupId,
        isCommit,
        deliveryMeta,
        deps,
        statePersister,
        startRecovery,
      });
    }
  );
}

// ── Internal handlers ────────────────────────────────────────────────────────

interface WelcomeArgs {
  sender: string;
  content: Uint8Array;
  groupId: string | undefined;
  ratchetTreeBytes: Uint8Array | undefined;
  deps: MessageHandlerDeps;
  statePersister: ReturnType<typeof createMlsStatePersister>;
  pendingBuffer: Map<string, { msgs: PendingMsg[] }>;
  recoveryTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Starts a recovery and returns immediately - never awaited, see `startRecovery`. */
  startRecovery: (groupId: string) => void;
}

/**
 * Processes a Welcome message - for a known or unknown group.
 *
 * Always ACKed: a failing Welcome cannot be reprocessed
 * (key package consumed). We request a re-invitation if needed.
 */
async function handleWelcome({
  sender,
  content,
  groupId,
  ratchetTreeBytes,
  deps,
  statePersister,
  pendingBuffer,
  recoveryTimers,
  startRecovery,
}: WelcomeArgs): Promise<boolean> {
  const {
    mlsService,
    userId,
    saveConversation,
    onGroupReady,
    log,
    batchAddMessages,
    addMessageToChat,
  } = deps;

  // The delivery envelope groupId IS the group (no successor chain anymore).
  const terminalId = groupId ?? '';
  const groupMeta = await mlsService.getGroupMeta(terminalId).catch(() => null);

  // Group deleted server-side - do not join a dead group.
  if (groupMeta?.deletedAt) {
    log(`[WELCOME] ${terminalId.slice(0, 8)}… deleted server-side - Welcome ignored`);
    cancelReAdd(terminalId, recoveryTimers);
    return true;
  }

  // Welcome redelivered for a group we already hold locally (typically a server requeue
  // after an app restart: the original Welcome re-enters the pending queue).
  // Attempting to (re)join would fail with NoMatchingKeyPackage - the Welcome's
  // KeyPackage was consumed at the initial join, and OpenMLS validates the key BEFORE
  // detecting GroupAlreadyExists - which would trigger a welcome_request, causing a kick +
  // re-add by the inviter. That re-add advances the epoch past us, forking us
  // permanently (group_epoch frozen < msg_epoch). We therefore treat the Welcome as idempotent.
  if (mlsService.getLocalGroups().includes(terminalId)) {
    cancelReAdd(terminalId, recoveryTimers);
    noMatchKpFailures.delete(terminalId);
    const convo = deps.conversations.get(terminalId);
    if (convo && convo.lifecycle !== 'active') {
      deps.conversations.set(terminalId, { ...convo, lifecycle: 'active' });
      await saveConversation(terminalId).catch(() => {});
    }
    // Server-side promotion of the membership to 'active' - REQUIRED even on this idempotent path.
    // Real case: a device that joins the group in the BACKGROUND (Welcome via FCM/JNI) does not go
    // through the normal join path below (which calls updateInvitationStatus). When it returns to
    // the foreground the Welcome is redelivered but the group is already local -> we land here.
    // Without this call its dm_device_group_memberships row stays 'pending', so recipient
    // resolution (status='active') EXCLUDES it: it never receives messages in realtime or by push
    // (only through the history catch-up on reload). Fire-and-forget, idempotent.
    void mlsService
      .updateInvitationStatus(mlsService.getDeviceId(), userId, terminalId, 'active')
      .catch(() => {});
    onGroupReady?.(terminalId);
    log(
      `[WELCOME] ${terminalId.slice(0, 8)}… already held - redelivered Welcome ignored (idempotent)`
    );
    return true;
  }

  // Critical WASM section under the MLS lock. The recovery checks above run outside the lock
  // (pure network); only this contiguous WASM block (processWelcome → replay) must be exclusive.
  // The drain does not auto-lock Welcomes (see MlsPerGroupScheduler.drain), which
  // avoids holding the mutex during the network preamble and blocking catch-up.
  //
  // On failure, recovery (externalJoin / welcome_request / republish) MUST run OUTSIDE this lock:
  // those seams re-acquire the same NON-reentrant MLS mutex and would deadlock if invoked from
  // within it (cf. MlsPerGroupScheduler.acquireMlsLock). The locked catch only CLASSIFIES the
  // failure into `deferredRecovery`; it is executed once the lock is released. [[recovery-outside-lock]]
  const deferredRecovery = await mlsService.runUnderMlsLock<DeferredRecovery | null>(async () => {
    try {
      // processWelcome returns the effective MLS groupId (may differ from the delivery envelope).
      // Fall back to the envelope groupId if WASM returns undefined (should not happen).
      const joinedGroupId =
        (await mlsService.processWelcome(content, ratchetTreeBytes)) ?? groupId ?? '';

      // FIX 1 — Add the conversation to the map early, to avoid the race between the Welcome
      // (which adds the group to WASM) and the arrival of system messages
      // (channel_key_distribution) that need handleKnownGroup to find the conversation.
      if (!deps.conversations.has(joinedGroupId)) {
        const isDirectByPattern = joinedGroupId.includes('::');
        const directPeerId = isDirectByPattern
          ? (parseDirectPeerFromName(joinedGroupId, userId) ?? '')
          : '';
        const displayName = directPeerId || 'Groupe';
        deps.conversations.set(joinedGroupId, {
          id: joinedGroupId,
          contactName: displayName,
          name: displayName,
          messages: [],
          lifecycle: 'pending',
          mlsStateHex: null,
          conversationType: isDirectByPattern ? 'direct' : 'group',
          ...(isDirectByPattern && directPeerId ? { directPeerId } : {}),
        });
        saveConversation(joinedGroupId).catch(() => {});
      }

      // FIX 4 — Drain the orphan messages that arrived before the conversation was in the map
      // (channel_key_distribution / Welcome race).
      deps.drainOrphanMessages?.(joinedGroupId);

      // Drop the pending buffer for this group; cancel any recovery bookkeeping (cooldown + timer).
      const buf = pendingBuffer.get(joinedGroupId);
      if (buf) pendingBuffer.delete(joinedGroupId);
      cancelReAdd(joinedGroupId, recoveryTimers);
      noMatchKpFailures.delete(joinedGroupId); // Welcome processed - reset NoMatchingKeyPackage escalation

      // Persist immediately after Welcome (epoch initialised).
      statePersister.persistNow();

      // A stray in-memory duplicate for the same DM peer (independent group created concurrently)
      // is reconciled elsewhere: upsertConversation (below) merges the Map entry, and
      // mergeDirectConversationDuplicates merges the IndexedDB rows on the next login. We do not
      // delete any IndexedDB row here - that would erase accumulated messages before they are
      // migrated, causing visible loss until the history bundle arrives.

      // Server-side registration (idempotent - safety net if the inviter has not yet
      // called registerMember for this userId, e.g. race in inviteMembers).
      // Results unused: fire-and-forget to avoid holding the MLS lock during
      // two network round-trips (the group is already joined locally).
      void mlsService.registerMember(joinedGroupId, userId).catch(() => {});
      void mlsService
        .updateInvitationStatus(mlsService.getDeviceId(), userId, joinedGroupId, 'active')
        .catch(() => {});

      // groupMeta already fetched above - no second HTTP call.
      // H3: under the per-group lock so it does not interleave with a concurrent operation on the
      // same group (in-memory message overwrite).
      await runExclusiveForGroup(joinedGroupId, () =>
        upsertConversation(joinedGroupId, groupMeta, sender, userId, deps)
      );

      // Replay buffered messages (commits that arrived before the Welcome).
      if (buf?.msgs.length) {
        for (const msg of buf.msgs) {
          try {
            const decBytes = await mlsService.processIncomingMessage(joinedGroupId, msg.content);
            if (decBytes) {
              const appMsg = decodeAppMessage(decBytes);
              if (appMsg) {
                const envelope = appMsgToEnvelope(appMsg);
                if (envelope) {
                  if (batchAddMessages) {
                    await batchAddMessages(
                      [{ senderId: msg.sender, content: envelope.content, ...envelope.options }],
                      joinedGroupId
                    );
                  } else {
                    await addMessageToChat(
                      msg.sender,
                      envelope.content,
                      joinedGroupId,
                      envelope.options
                    );
                  }
                } else if (appMsg.system) {
                  // FIX 2 — Replay the system messages buffered before the Welcome
                  const event = appMsg.system.event ?? '';
                  let data: any = {};
                  try {
                    data = appMsg.system.data ? JSON.parse(appMsg.system.data) : {};
                  } catch {
                    /* noop */
                  }
                  const convo = deps.conversations.get(joinedGroupId);
                  if (convo) {
                    await handleSystemEvent(event, data, {
                      ...deps,
                      convo,
                      convoKey: joinedGroupId,
                      senderNorm: msg.sender,
                      persistMlsStateNow: () => statePersister.persistNow(),
                      deliveryMeta: undefined,
                    });
                  }
                }
              }
            }
          } catch {
            /* ignore replay errors */
          }
        }
        statePersister.persistNow();
      }

      // History: delegated to onWelcomeProcessed (after reinject) to avoid blocking
      // the queue under the MLS lock (createDecryptSession re-acquires the same mutex).
      onGroupReady?.(joinedGroupId);
      log(`[WELCOME] Group ${joinedGroupId.slice(0, 8)}… ready`);
      return null;
    } catch (e) {
      // Classify only - recovery is deferred to AFTER the lock (see note above the lock).
      const err = String(e);
      const target = terminalId || (groupId ?? '');
      if (err.includes('GroupAlreadyExists')) {
        // process_welcome threw BEFORE the insert: the OpenMLS group state exists in the
        // storage provider but NOT in memory (otherwise the "already held" guard would
        // have caught it). Marking it "ready" would be wrong - the group is not truly
        // joined and would stay stuck. Purge storage now (forgetGroup clears both memory and
        // storage - a WASM op, safe under the lock); the clean rejoin is deferred below.
        noMatchKpFailures.delete(target);
        if (!target) return null;
        log(`[WELCOME] GroupAlreadyExists pour ${target.slice(0, 8)}… - forget storage + re-join`);
        mlsService.forgetGroup(target);
        statePersister.persistNow();
        return { kind: 'readd', target };
      }
      if (err.includes('NoMatchingKeyPackage')) {
        // Our published KeyPackage is orphaned from its local private key: the inviter re-added us
        // with a KeyPackage we cannot honour. Recovery (deferred below) prefers externalJoin - a
        // peer-independent self-rejoin against the server-stored GroupInfo - over looping on peer
        // re-adds that keep hitting this same failure and eventually get suspended peer-side.
        const failures = (noMatchKpFailures.get(target) ?? 0) + 1;
        noMatchKpFailures.set(target, failures);
        return target ? { kind: 'nomatch', target, failures } : null;
      }
      if (err.includes('CannotDecryptOwnMessage')) {
        // Welcome addressed to another device - ignore.
        log(`[WELCOME] CannotDecryptOwnMessage pour ${groupId?.slice(0, 8)}… - ACK silencieux`);
        return null;
      }
      log(`[WELCOME] Erreur traitement ${groupId?.slice(0, 8)}…: ${err.slice(0, 150)}`);
      return null;
    }
  });

  // ── Recovery, OUTSIDE the MLS lock ──────────────────────────────────────────────────────────
  // requestReAdd prefers externalJoin (self-service rejoin via the server-stored GroupInfo: no
  // peer, no fresh KeyPackage exchange) and only falls back to welcome_request when no GroupInfo
  // exists. Driving it here - immediately, on the first failure - lets a device self-heal without
  // waiting for the SYNC_WATCHDOG cadence or for a peer whose anti-livelock guard may have already
  // suspended re-adds (cf. handleWelcomeRequest MAX_READD_ATTEMPTS). [[recovery-outside-lock]]
  if (deferredRecovery) {
    const rec = deferredRecovery;
    if (rec.kind === 'nomatch') {
      // First detection: republish fresh key material so a fallback welcome_request re-add can
      // succeed (republishKeyMaterial debounces internally); subsequent failures skip it.
      if (rec.failures === 1) {
        log(
          `[WELCOME] NoMatchingKeyPackage pour ${rec.target.slice(0, 8)}… - republish + self-heal (externalJoin/welcome_request)`
        );
        await mlsService.republishKeyMaterial(deps.deviceKeyB64).catch(() => {});
      } else {
        log(
          `[WELCOME] NoMatchingKeyPackage #${rec.failures} pour ${rec.target.slice(0, 8)}… - self-heal (externalJoin/welcome_request)`
        );
      }
      // Reset the counter past the budget so a later desync can republish afresh.
      if (rec.failures > MAX_NOMATCH_KP_RETRIES) noMatchKpFailures.delete(rec.target);
    }
    // Not awaited: this also runs inside the inbound drain (see `startRecovery`).
    startRecovery(rec.target);
  }

  return true; // Always ACKed
}

interface UnknownGroupArgs {
  sender: string;
  content: Uint8Array;
  groupId: string;
  deps: MessageHandlerDeps;
  pendingBuffer: Map<string, { msgs: PendingMsg[] }>;
  /** Starts a recovery and returns immediately - never awaited, see `startRecovery`. */
  startRecovery: (groupId: string) => void;
}

/**
 * Buffers a commit received for an unknown group (Welcome not yet received).
 *
 * On the FIRST frame for the group, fires one immediate recovery attempt through the single seam
 * `requestReAdd` (external join / welcome_request + marks the group not-ready in the persistent
 * registry). No private timer: the SYNC_WATCHDOG owns the re-add cadence from there.
 * Returns `false` to keep the message in the server queue (replay possible).
 */
async function handleUnknownGroup({
  sender,
  content,
  groupId,
  deps,
  pendingBuffer,
  startRecovery,
}: UnknownGroupArgs): Promise<boolean> {
  const { log } = deps;

  let buf = pendingBuffer.get(groupId);
  if (!buf) {
    // Unknown group: one immediate recovery attempt through the seam, then buffer. The
    // watchdog takes over the cadence (the group is now in the not-ready registry). NOT awaited -
    // this runs inside the inbound drain, and an attempt that never settles would stop every later
    // message (see `startRecovery`).
    startRecovery(groupId);
    buf = { msgs: [] };
    pendingBuffer.set(groupId, buf);
    log(`[BUFFER] welcome_request sent for unknown group ${groupId.slice(0, 8)}…`);
  }

  if (buf.msgs.length < 20) buf.msgs.push({ sender, content });

  noteUnackedFrame(groupId, 'unknown-group');
  return false; // Keep in queue for replay when the Welcome arrives
}

interface KnownGroupArgs {
  sender: string;
  content: Uint8Array;
  groupId: string;
  isCommit: boolean | undefined;
  deliveryMeta: IncomingDeliveryMeta | undefined;
  deps: MessageHandlerDeps;
  statePersister: ReturnType<typeof createMlsStatePersister>;
  /** Starts a recovery and returns immediately - never awaited, see `startRecovery`. */
  startRecovery: (groupId: string) => void;
}

/**
 * Decrypts and dispatches a message for a known group.
 *
 * Always ACKed: if decryption fails, we request a re-add
 * rather than keeping the message in the queue indefinitely.
 */
async function handleKnownGroup({
  sender,
  content,
  groupId,
  isCommit,
  deliveryMeta,
  deps,
  statePersister,
  startRecovery,
}: KnownGroupArgs): Promise<boolean> {
  const {
    mlsService,
    conversations,
    messageReactions,
    storage,
    deviceKeyB64,
    userId,
    addMessageToChat,
    onCallSignal,
    log,
  } = deps;

  const convoKey = groupId;
  const convo = conversations.get(convoKey);
  if (!convo) {
    log(`[MLS] Message for absent conversation ${convoKey.slice(0, 8)}… - retry after restore`);
    noteUnackedFrame(groupId, 'absent-conversation');
    return false;
  }

  const fingerprint = frameFingerprint(content);

  /**
   * A frame MLS will never decrypt here, whatever we do locally - and the two situations that
   * produce one are opposites: the same frame delivered twice (benign, drop it), or a frame this
   * device has never read (a real message, lost). The frame's own bytes tell them apart, and
   * nothing else can: neither cause is visible in the error.
   *
   * Two errors arrive here and they are unreadable at opposite ends. `SecretReuseError` is a
   * generation already spent, so the sender's ratchet went backwards (WP-LOSS-1, WP-MULTITAB-1).
   * A past-epoch application frame is an epoch whose secrets are gone, which is what a re-joined
   * group has for everything sent before the join. The DIAGNOSIS differs, the policy does not.
   *
   * TWO LEDGERS ARE CONSULTED BECAUSE THIS DEVICE CONSUMES GENERATIONS FROM TWO PLACES, and asking
   * only one of them is what WP-FALSELOSS-2 was. The in-memory ring answers for frames delivered
   * live in THIS session; the durable set answers for everything else - the archive replay, which
   * decrypts the same rows and used to leave no trace live delivery could read, and any earlier
   * session. Neither subsumes the other: the ring holds 200 frames per group and dies with the page,
   * the durable set is capped at 5 000 and survives it.
   */
  const handleUnreadableFrame = (reason: string, diagnosis: string): void => {
    const seenLive = hasFrameBeenProcessed(groupId, fingerprint);
    // Named separately from `seenLive` so the log says WHICH path had already read this frame. A
    // duplicate is normal in both cases and a defect in neither, but "the replay got here first" and
    // "the server delivered it twice" are different facts about the system, and a line that merges
    // them sends the next reader to the wrong place.
    const seenReplay = !seenLive && hasHistoryFrameBeenConsumed(userId, groupId, fingerprint);
    if (seenLive || seenReplay) {
      log(
        `[MLS] Duplicate delivery for ${convoKey.slice(0, 8)}… - silent ACK (${reason}, already read by ${seenLive ? 'live delivery' : 'the archive replay'}, frame ${fingerprint})`
      );
      return;
    }
    // Deliberately NOT onOutOfSync: the plaintext is unrecoverable here whatever we do locally, and
    // a re-add would destroy a valid membership to fix nothing. The sender is the only party that
    // can still produce this message at a generation we have not consumed.
    /**
     * THE FINGERPRINT IS PART OF THE REPORT, not a debugging extra.
     *
     * This line names a spent generation, and it cannot on its own distinguish the two things that
     * produce one: a frame whose bytes some path here consumed without recording it (a ledger gap,
     * ours to fix), or two DIFFERENT ciphertexts genuinely sent at the same generation (the sender's
     * ratchet rewound, theirs). The generation number appears in the WASM line above and is the same
     * in both, so the only discriminator is whether the bytes match a frame already seen - and until
     * this fingerprint was printed, answering that needed a live console tail on the right browser at
     * the right second. It cost exactly that on 2026-08-14, at generation 559, and the tail is not a
     * thing a user or a later reader can go back and take.
     *
     * Paired with the same fingerprint on the duplicate line above, a plain log read now settles it:
     * the same value on both means a ledger gap, two different values at one generation means reuse.
     */
    log(
      `[MLS] LOST frame for ${convoKey.slice(0, 8)}… from ${sender}: ${diagnosis} (${reason}, frame ${fingerprint})`
    );
    // ONE repair, and it is the id-addressed one. There used to be a narrow rung first - ask the
    // sender to re-send the last two minutes - and it was deleted rather than tuned: it could not
    // name what it wanted (the frame never decrypted, so its id was never seen), so it asked for a
    // time WINDOW, which is a broadcast; and its only mode of success was the sender burning past
    // our high-water mark while answering, i.e. recovery by exhaustion. The diff dominates it
    // strictly: we send what we HOLD, the peer computes what we lack and names it from its durable
    // store, and re-encrypts it at the current generation. See `historyManifest.ts`.
    //
    // Nothing here is rate-limited by a clock, and nothing here records anything durable either.
    // A marker used to be written at this point, and it was the wrong witness for the question it
    // was asked: it recorded "this group is missing history" and was read as "have I already
    // asked", so the first lost frame in a group that had ever been broken found it already set and
    // this path never solicited again (measured on prod 2026-08-10: twelve `LOST frame` lines,
    // zero solicitations). `reconcileGroup` coalesces a burst instead, which is the only thing that
    // was ever needed here - a replay giving up on forty frames of one conversation asks once.
    log(`[MLS] Frames are being lost in ${convoKey.slice(0, 8)}… - reconciling this conversation`);
    void reconcileGroup(mlsService, groupId, log);
  };

  /**
   * This device has spent the frame's ratchet generation: record it in BOTH ledgers.
   *
   * They answer different questions over different lifetimes, and using either one for the other's
   * question is how this seam broke. `noteFrameProcessed` is the in-memory ring that tells a double
   * delivery from a real loss within seconds, and it dies with the page. The durable mark is what
   * stops the archive replay - minutes or days later, across reloads - from walking this same frame,
   * failing on a generation we just consumed, and calling a message we are displaying a loss.
   *
   * Both call sites below reach here, including the one with no application payload: a commit
   * consumes its generation exactly like a message does, and the replay would trip on it the same
   * way.
   */
  const noteConsumed = (): void => {
    noteFrameProcessed(groupId, fingerprint);
    markHistoryFrameConsumed(userId, groupId, fingerprint);
  };

  try {
    const decrypted = await mlsService.processIncomingMessage(groupId, content);

    // Persist: immediate for commits (epoch advanced), deferred for application messages.
    if (isCommit) {
      // Only a commit truly advances the epoch and resolves a gap → cancel escalation.
      // An application message that decrypts (typically a peer on the SAME stale branch
      // as a forked device) does NOT catch up the divergent branch: resetting the timer
      // here would permanently prevent the forget+re-welcome escalation that fixes the fork (H7).
      clearEpochGap(groupId);
      statePersister.persistNow();
    } else {
      statePersister.scheduleDeferred();
    }

    if (decrypted === null) {
      // `null` means "no application payload", and `mls-core` is the only thing entitled to say it:
      // a structural commit, a stale commit another device already applied, or a frame whose
      // generation is older than the kept ratchet window. None of the three has a plaintext.
      //
      // A consumed generation is NOT in that list any more, and that is what deleted `wasmLogShim`
      // (2026-08-10). The shim monkey-patched `window.wasm_bindings_log` and set a flag when a WASM
      // line CONTAINED `SecretReuseError`, because `mls-core` used to answer `Ok(None)` there and
      // the diagnosis reached no caller otherwise. `mls-core` now surfaces that error (see
      // `same_epoch_ratchet.rs`), so this branch is reached through the `catch` below instead - and
      // branching on the TEXT of a log line was never a contract, it was a leak. Measured on the
      // HEAL run of 2026-08-10: eleven arrivals through the thrown error, ZERO through the flag.
      log(`[MLS] No application payload for ${convoKey.slice(0, 8)}… - commit or dropped frame`);
      noteConsumed();
      return true;
    }

    noteConsumed();
    const msg = decodeAppMessage(decrypted);
    if (!msg) {
      log(`[MLS] Undecodable payload for ${convoKey.slice(0, 8)}… - ACK`);
      return true;
    }

    if (msg.text || msg.reply || msg.media) {
      const envelope = appMsgToEnvelope(msg, deliveryMeta?.queuedCreatedAt);
      if (envelope) {
        const stableId =
          normalizeMessageId(msg.messageId) ?? normalizeMessageId(deliveryMeta?.queuedMessageId);
        if (stableId) envelope.options.messageId = stableId;
        log(`[MLS] Message decrypted for ${convoKey.slice(0, 8)}… → addMessageToChat`);
        await addMessageToChat(sender, envelope.content, convoKey, {
          ...envelope.options,
          serverTimestamp: deliveryMeta?.queuedCreatedAt,
        });
      } else {
        log(`[MLS] Empty envelope for ${convoKey.slice(0, 8)}… - nothing to display`);
      }
    } else if (msg.reaction) {
      const msgId = msg.reaction.messageId ?? '';
      const emoji = msg.reaction.emoji ?? '';
      const reactions = messageReactions.get(msgId) || [];
      // Both legs arrive here: `removed` says which. A frame from before the field existed carries
      // false, which is what it meant - it could only ever place a reaction.
      // `at` is the sender's clock; an undated frame reads as 0 and loses to anything dated.
      const updated = applyReaction(
        reactions,
        sender,
        emoji,
        Number(msg.reaction.at ?? 0),
        msg.reaction.removed === true
      );
      if (updated) {
        messageReactions.set(msgId, updated);
        const c = conversations.get(convoKey);
        if (c) {
          const idx = c.messages.findIndex((m) => m.id === msgId);
          if (idx !== -1) {
            const next = [...c.messages];
            next[idx] = { ...next[idx], reactions: updated };
            conversations.set(convoKey, { ...c, messages: next });
            if (storage) {
              // A reaction changes the reactions. Writing the whole row here used to clear the
              // delete/edit flags, so reacting to an edited message resurrected the original body
              // on the next reload.
              await storage
                .updateMessage(next[idx].id, { reactions: updated }, deviceKeyB64)
                .catch(() => {});
            }
          }
        }
      }
    } else if (msg.call) {
      onCallSignal?.(sender, groupId, msg.call);
    } else if (msg.system) {
      const event = msg.system.event ?? '';
      let data: any = {};
      try {
        data = msg.system.data ? JSON.parse(msg.system.data) : {};
      } catch {
        /* noop */
      }
      await handleSystemEvent(event, data, {
        ...deps,
        convo: conversations.get(convoKey) ?? convo,
        convoKey,
        senderNorm: sender,
        persistMlsStateNow: () => statePersister.persistNow(),
        deliveryMeta,
      });
    }

    return true;
  } catch (e) {
    const err = String(e);
    const kind = classifyIncomingDecryptError(e);

    if (kind === 'own-message') return true;
    if (kind === 'oom') {
      deps.onMlsFatalError?.('oom');
      return true;
    }
    if (kind === 'epoch-gap') {
      // Tauri: message buffered in SQLite (`GAP_QUEUED`). Web WASM: direct error
      // `epoch gap [msg_epoch=…, group_epoch=…]`: our local epoch is behind the sender's.
      const now = Date.now();
      const since = markEpochGap(groupId);

      // Rung 1 (non-destructive): fetch the ordered commits we missed from the server commit-log
      // and re-apply them so our epoch catches up - no state loss, no re-Welcome. This is the
      // common case (we simply missed a commit while offline / between frames).
      try {
        const replay = await attemptCommitReplay(mlsService, groupId, log);
        if (replay.healed) {
          clearEpochGap(groupId);
          statePersister.persistNow();
          return true;
        }
      } catch (e) {
        log(`[GAP] replay error for ${groupId.slice(0, 8)}…: ${String(e).slice(0, 80)}`);
      }

      // Rung 2 (destructive, fallback): only once the gap has persisted past the threshold AND
      // rung-1 could not catch us up (commits pruned below the retained floor, or a commit failed
      // to apply). Forget the frozen state and request a new Welcome: since the group is no longer
      // local, the re-Welcome is honoured (not ignored as idempotent) and we rejoin at the current
      // epoch; message history is backfilled by the history bundle.
      if (now - since > EPOCH_GAP_ESCALATION_MS) {
        clearEpochGap(groupId);
        log(
          `[GAP] ${groupId.slice(0, 8)}… frozen behind >${EPOCH_GAP_ESCALATION_MS / 1000}s and rung-1 replay failed - forget + welcome_request`
        );
        mlsService.forgetGroup(groupId);
        statePersister.persistNow();
        startRecovery(groupId); // forget done → re-Welcome honoured (group no longer local)
      }
      return true;
    }

    // The frame's generation is further ahead in the sender's ratchet than OpenMLS will derive
    // forward, i.e. this device missed a long run of that sender's frames - which is what an
    // undrainable pending queue produces (WP-PENDING-1). Nothing local recovers the plaintext, and
    // nothing local recovers the STREAM either: every later frame this sender emits in this epoch
    // fails identically, so unlike `secret-reuse` the group is genuinely broken for us and a
    // re-Welcome is the cure rather than collateral damage. Forget first, or the Welcome is ignored
    // as idempotent (the group is still local); the history bundle backfills what was missed.
    if (kind === 'generation-gap') {
      log(
        `[MLS] LOST frame for ${convoKey.slice(0, 8)}… from ${sender}: generation too far ahead of our sender ratchet - we missed too many of their frames to catch up (${err.slice(0, 100)})`
      );
      clearEpochGap(groupId);
      mlsService.forgetGroup(groupId);
      statePersister.persistNow();
      startRecovery(groupId);
      return true;
    }

    // The generation is consumed. Either a double delivery (real-time publish + queue/FCM), which
    // is benign and ACKed, or a message lost to a rewound sender - which is not, and is signalled.
    // Never onOutOfSync either way: the group is healthy and a re-add would destroy a valid
    // membership for a message no local recovery can bring back.
    if (kind === 'secret-reuse') {
      handleUnreadableFrame(
        'SecretReuseError',
        "generation consumed but this frame was never processed - the sender's ratchet rewound"
      );
      return true;
    }

    // An application frame from an epoch we are already PAST, whose secrets we no longer hold -
    // which is what a group re-joined since carries for everything sent before the join. Same
    // policy as a consumed generation and for the same reason: no local recovery brings the
    // plaintext back, the group itself is healthy so a re-add would destroy a valid membership for
    // nothing, and the peer's durable store is the only place the message still exists.
    //
    // This used to be invisible. `mls-core` answered `Ok(None)` for it, i.e. "no application
    // payload", which is also what a commit echo answers - so a lost message and a routine
    // handshake printed the same line and this whole ladder was unreachable from a value saying
    // nothing had failed (measured on prod 2026-08-11, HEAL-W2).
    if (kind === 'past-epoch-application') {
      handleUnreadableFrame(
        'past epoch application frame',
        'sent in an epoch whose secrets this device no longer holds - most likely before it re-joined'
      );
      return true;
    }

    // Any other failure (`wrong-epoch`, `unknown`) → out-of-sync → requestReAdd + ACK
    log(`[MLS] Decryption error for ${convoKey.slice(0, 8)}…: ${err.slice(0, 100)} → re-add`);
    startRecovery(groupId);
    return true;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates or updates the local conversation after a Welcome.
 * Determines whether it is a DM (isGroup=false or name "alice::bob") or a group.
 */
async function upsertConversation(
  joinedGroupId: string,
  gData: { name?: string; isGroup?: boolean } | null,
  senderNorm: string,
  userId: string,
  deps: MessageHandlerDeps
): Promise<void> {
  const { conversations, saveConversation } = deps;

  const groupName = gData?.name ?? senderNorm;
  const isGroupFromApi: boolean | null = typeof gData?.isGroup === 'boolean' ? gData.isGroup : null;

  const peerFromName = parseDirectPeerFromName(groupName, userId);

  let isDirect = false;
  let directPeerId = '';

  if (isGroupFromApi === false) {
    isDirect = true;
    const candidate = peerFromName ?? (senderNorm !== userId ? senderNorm : '');
    directPeerId = candidate;
  } else if (isGroupFromApi === null && peerFromName) {
    isDirect = true;
    directPeerId = peerFromName;
  }

  // Guard against DM with oneself (missing metadata + sender === self, or a malformed
  // self-only group name). Try the migrated convo's known peer first, then the authoritative
  // MLS roster; only give up (treat as group) when the peer truly cannot be resolved.
  if (isDirect && (!directPeerId || directPeerId === userId.toLowerCase())) {
    const migrated = conversations.get(joinedGroupId);
    const existing = (migrated?.directPeerId ?? migrated?.contactName ?? '').toLowerCase();
    if (existing && existing !== userId.toLowerCase()) {
      directPeerId = existing;
    } else {
      const fromRoster = await resolveDirectPeerId(
        deps.mlsService,
        joinedGroupId,
        groupName,
        userId,
        deps.log
      );
      if (fromRoster) {
        directPeerId = fromRoster;
      } else {
        isDirect = false;
        directPeerId = '';
      }
    }
  }

  // Find an existing conversation matching this DM.
  let newConvoKey = joinedGroupId;
  let matchedExisting = false;

  if (isDirect) {
    const existingDirect = Array.from(conversations.entries()).find(([, c]) => {
      if ((c.conversationType ?? 'group') !== 'direct') return false;
      return (c.directPeerId ?? c.contactName).toLowerCase() === directPeerId;
    });
    if (existingDirect) {
      newConvoKey = existingDirect[0];
      matchedExisting = true;
    }
  } else if (conversations.has(joinedGroupId)) {
    matchedExisting = true;
  }

  const displayName = isDirect ? directPeerId : groupName;

  if (matchedExisting) {
    const existing = conversations.get(newConvoKey)!;
    // Re-join via Welcome: we are again a real member, so clear any `deletedRemotely`
    // mark set by discovery (group deleted/excluded OR false positive from a snapshot race).
    // Without this the conversation would stay locked with its "deleted" banner
    // even though we just got re-added (rule: re-add => same conversation, active).
    const updated = {
      ...existing,
      id: joinedGroupId,
      name: displayName,
      lifecycle: 'active' as const,
    };
    if (newConvoKey !== joinedGroupId) {
      // Same DM peer under a different groupId (an independent duplicate group): re-key the
      // conversation onto the group we just joined.
      conversations.delete(newConvoKey);
      newConvoKey = joinedGroupId;

      // Persist in-memory messages to the new group's IndexedDB.
      // Without this, loadHistoryForConversation (which reads from the new groupId's IndexedDB)
      // would overwrite the in-memory list with an empty array, making messages disappear
      // until the next login where mergeDirectConversationDuplicates migrates them properly.
      const msgs = existing.messages ?? [];
      if (deps.storage && msgs.length > 0) {
        const toSave = msgs
          .filter((m) => m.id && m.status !== 'sending')
          .map((m) => ({
            id: m.id,
            conversationId: joinedGroupId,
            senderId: m.senderId,
            content: m.content,
            timestamp: m.timestamp instanceof Date ? m.timestamp.getTime() : Number(m.timestamp),
            reactions: m.reactions,
            isDeleted: m.isDeleted,
            isEdited: m.isEdited,
            serverTimestamp: m.serverTimestamp,
          }));
        if (toSave.length > 0) {
          await deps.storage.saveMessages(toSave, deps.deviceKeyB64).catch(() => {});
          deps.log(
            `[WELCOME] ${toSave.length} message(s) from ${existing.id.slice(0, 8)}… persisted in ${joinedGroupId.slice(0, 8)}… (re-keyed)`
          );
        }
      }
    }
    conversations.set(newConvoKey, updated);
  } else {
    conversations.set(newConvoKey, {
      id: joinedGroupId,
      contactName: displayName,
      name: displayName,
      messages: [],
      lifecycle: 'active',
      mlsStateHex: null,
      conversationType: isDirect ? 'direct' : 'group',
      ...(isDirect ? { directPeerId } : {}),
    });
  }

  await saveConversation(newConvoKey).catch(() => {});

  // Effective re-add: lift any per-user server-side dismiss so the conversation also
  // reappears on the user's OTHER devices (re-add rule). Best-effort.
  void deps.mlsService.undismissGroup(joinedGroupId).catch(() => {});
}
