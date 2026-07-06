import { parseDirectPeerFromName, resolveDirectPeerId } from '$lib/utils/chat/conversations';
import { decodeAppMessage } from '$lib/proto/codec';
import { appMsgToEnvelope, normalizeMessageId } from '$lib/utils/chat/messageUtils';
import { addMessageReaction } from '$lib/utils/chat/messageReactions';
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
import {
  installWasmDuplicateDeliveryLogInterceptor,
  resetWasmDuplicateDeliveryFlag,
  consumeWasmDuplicateDeliveryFlag,
} from '../wasmLogShim';
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
 * Installe le handler de messages MLS.
 *
 * Simplified architecture (RFC 9420 + OpenMLS fork-resolution):
 * - Welcome → traitement + replay du buffer
 * - Groupe inconnu → welcome_request immediat (seam) + buffer ; cadence owned by the SYNC_WATCHDOG
 * - Known group → decrypt → display / requestReAdd if out-of-sync
 *
 * Invariants :
 * 1. Every message is ACKed exactly once.
 * 2. `requestReAdd` remplace toute escalade (pas de Poison Pill, pas de compteurs).
 * 3. Recovery state (cooldowns) is in-memory only - reset on every session.
 */
export function setupMessageHandler(deps: MessageHandlerDeps): void {
  const { mlsService, pin, userId, log } = deps;

  // Repartir d'un registre de gap d'epoch vierge : ce registre est module-global (partage
  // avec l'outbox) et ne doit pas conserver d'entree perimee d'une session precedente.
  resetEpochGapRegistry();
  // Same rationale for the recovery cooldowns: a re-login must not inherit a stale throttle.
  resetReAddCooldowns();

  installWasmDuplicateDeliveryLogInterceptor();

  const statePersister = createMlsStatePersister({ mlsService, pin, userId, log });
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
        });
      }

      if (!groupId) return true; // ACK without group - control frame

      // ── Groupe inconnu (pas dans le WASM local) ───────────────────────────
      const inGroup = mlsService.getLocalGroups().includes(groupId);
      if (!inGroup) {
        return handleUnknownGroup({
          sender: senderNorm,
          content,
          groupId,
          deps,
          pendingBuffer,
          recoveryTimers,
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
        onOutOfSync,
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
    // Promotion serveur de la membership en 'active' - INDISPENSABLE meme sur ce chemin idempotent.
    // Cas reel : un device qui rejoint le groupe en ARRIERE-PLAN (Welcome via FCM/JNI) ne passe
    // pas par le chemin de join normal ci-dessous (qui appelle updateInvitationStatus). Quand il
    // revient au premier plan, le Welcome est redelivre mais le groupe est deja local -> on tombe
    // ici. Sans cet appel, sa ligne dm_device_group_memberships reste 'pending', donc la resolution
    // des destinataires (status='active') l'EXCLUT : il ne recoit jamais les messages en temps reel
    // ni en push (seulement via le rattrapage d'historique au reload). Fire-and-forget, idempotent.
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
  await mlsService.runUnderMlsLock(async () => {
    try {
      // processWelcome returns the effective MLS groupId (may differ from the delivery envelope).
      // Fall back to the envelope groupId if WASM returns undefined (should not happen).
      const joinedGroupId =
        (await mlsService.processWelcome(content, ratchetTreeBytes)) ?? groupId ?? '';

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
    } catch (e) {
      const err = String(e);
      if (err.includes('GroupAlreadyExists')) {
        // process_welcome threw BEFORE the insert: the OpenMLS group state exists in the
        // storage provider but NOT in memory (otherwise the "already held" guard would
        // have caught it). Marking it "ready" would be wrong - the group is not truly
        // joined and would stay stuck. Purge storage (forgetGroup now clears both
        // memory and storage) then request a clean Welcome, honoured without a storage collision.
        const target = terminalId || (groupId ?? '');
        noMatchKpFailures.delete(target);
        if (target) {
          log(
            `[WELCOME] GroupAlreadyExists pour ${target.slice(0, 8)}… - forget storage + re-Welcome`
          );
          mlsService.forgetGroup(target);
          statePersister.persistNow();
          await requestReAdd(target, deps, recoveryTimers);
        }
      } else if (err.includes('NoMatchingKeyPackage')) {
        // Our published KeyPackages no longer match our local private keys:
        // the inviter is re-adding us with a KeyPackage we cannot honour.
        const target = terminalId || (groupId ?? '');
        const failures = (noMatchKpFailures.get(target) ?? 0) + 1;
        noMatchKpFailures.set(target, failures);

        if (failures > MAX_NOMATCH_KP_RETRIES) {
          // Re-add persistently failing → full recovery instead of looping.
          log(
            `[WELCOME] NoMatchingKeyPackage #${failures} pour ${target.slice(0, 8)}… - escalade requestReAdd`
          );
          noMatchKpFailures.delete(target);
          if (target) await requestReAdd(target, deps, recoveryTimers);
        } else {
          // First detection: republish fresh key material so the inviter's next
          // re-add uses a KeyPackage we can honour.
          // republishKeyMaterial debounces rapid successive calls internally.
          if (failures === 1) {
            log(
              `[WELCOME] NoMatchingKeyPackage pour ${target.slice(0, 8)}… - republication KeyPackages + welcome_request`
            );
            await mlsService.republishKeyMaterial(deps.pin).catch(() => {});
          } else {
            log(
              `[WELCOME] NoMatchingKeyPackage #${failures} pour ${target.slice(0, 8)}… - welcome_request`
            );
          }
          if (target) await mlsService.sendWelcomeRequest(target).catch(() => {});
        }
      } else if (err.includes('CannotDecryptOwnMessage')) {
        // Welcome addressed to another device - ignore.
        log(`[WELCOME] CannotDecryptOwnMessage pour ${groupId?.slice(0, 8)}… - ACK silencieux`);
      } else {
        log(`[WELCOME] Erreur traitement ${groupId?.slice(0, 8)}…: ${err.slice(0, 150)}`);
      }
    }
  });

  return true; // Always ACKed
}

interface UnknownGroupArgs {
  sender: string;
  content: Uint8Array;
  groupId: string;
  deps: MessageHandlerDeps;
  pendingBuffer: Map<string, { msgs: PendingMsg[] }>;
  recoveryTimers: Map<string, ReturnType<typeof setTimeout>>;
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
  recoveryTimers,
}: UnknownGroupArgs): Promise<boolean> {
  const { log } = deps;

  let buf = pendingBuffer.get(groupId);
  if (!buf) {
    // Unknown group: one immediate recovery attempt through the seam, then buffer. The
    // watchdog takes over the cadence (the group is now in the not-ready registry).
    await requestReAdd(groupId, deps, recoveryTimers);
    buf = { msgs: [] };
    pendingBuffer.set(groupId, buf);
    log(`[BUFFER] welcome_request sent for unknown group ${groupId.slice(0, 8)}…`);
  }

  if (buf.msgs.length < 20) buf.msgs.push({ sender, content });

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
  onOutOfSync: (groupId: string) => Promise<void>;
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
  onOutOfSync,
}: KnownGroupArgs): Promise<boolean> {
  const {
    mlsService,
    conversations,
    messageReactions,
    storage,
    pin,
    addMessageToChat,
    onCallSignal,
    log,
  } = deps;

  const convoKey = groupId;
  const convo = conversations.get(convoKey);
  if (!convo) {
    log(`[MLS] Message for absent conversation ${convoKey.slice(0, 8)}… - retry after restore`);
    return false;
  }

  try {
    resetWasmDuplicateDeliveryFlag();
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
      // null can be a structural commit (add/remove) or a legitimate duplicate
      if (consumeWasmDuplicateDeliveryFlag()) {
        log(`[MLS] Duplicate for ${convoKey.slice(0, 8)}… - silent ACK`);
      } else {
        log(`[MLS] Structural commit for ${convoKey.slice(0, 8)}… - no application payload`);
      }
      return true;
    }

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
      const updated = addMessageReaction(reactions, sender, emoji);
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
              const t = next[idx];
              await storage
                .saveMessage(
                  {
                    id: t.id,
                    conversationId: convoKey,
                    senderId: t.senderId,
                    content: t.content,
                    timestamp: t.timestamp.getTime(),
                    readBy: t.readBy,
                    reactions: updated,
                  },
                  pin
                )
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
        await onOutOfSync(groupId); // forget done → re-Welcome honoured (group no longer local)
      }
      return true;
    }

    // Double delivery (real-time publish + queue/FCM): the message has already been
    // decrypted and its ratchet secret consumed/deleted. The group is healthy -
    // do NOT trigger onOutOfSync (which would destroy a valid membership via a
    // spurious recovery). Simply ACK the duplicate.
    if (kind === 'secret-reuse') {
      log(`[MLS] SecretReuseError (doublon) pour ${convoKey.slice(0, 8)}… - ACK silencieux`);
      return true;
    }

    // Any other failure (`wrong-epoch`, `unknown`) → out-of-sync → requestReAdd + ACK
    log(`[MLS] Decryption error for ${convoKey.slice(0, 8)}…: ${err.slice(0, 100)} → re-add`);
    await onOutOfSync(groupId);
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
            readBy: m.readBy,
            reactions: m.reactions,
            isDeleted: m.isDeleted,
            isEdited: m.isEdited,
            readAt: m.readAt,
            serverTimestamp: m.serverTimestamp,
          }));
        if (toSave.length > 0) {
          await deps.storage.saveMessages(toSave, deps.pin).catch(() => {});
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
