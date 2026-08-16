import { DELIVERY } from '$lib/mls-client/frameDelivery';
import { persistMlsStructuralCheckpoint } from '$lib/mls-client/mlsStatePersisterRegistry';
import type { IMlsService } from '$lib/mlsService';
import type { IStorage, StoredMessage } from '$lib/db';
import type { ReadWatermarks } from '$lib/types';
import type { Conversation } from '$lib/types';
import { encodeAppMessage, mkSystem } from '$lib/proto/codec';
import { pinnedMessageIds } from '$lib/stores/pinStore.svelte';
import { buildUserGroupSyncIndex, isGroupEligibleForMlsRecovery } from './groupSyncEligibility';
import { forgetGroupReconciliation } from './historyReconcile';
import { historyRangeStart, isWithinHistoryRange } from './historyWindow';
import { cachedHistoryStateKey } from './historyStateKey';
import {
  buildHistoryDigest,
  chunkIds,
  type HistoryDigest,
  type HistoryEntry,
} from './historyManifest';

/**
 * Reports (log + `console.warn`) devices skipped by `addMembersBulk` because their KeyPackage
 * was invalid/unreadable. Without this, a skipped device would vanish silently: never invited,
 * never retried. The remedy (republish a fresh KeyPackage then re-add) is deferred;
 * here we at least ensure visibility. [[C5]]
 *
 * @param tag Log prefix of the caller (e.g. `[ADD]`, `[SYNC]`, `[GROUP]`, `[REBOOT]`).
 */
export function warnSkippedKeyPackages(
  skippedDeviceIds: string[],
  groupId: string,
  tag: string,
  log: (msg: string) => void
): void {
  if (skippedDeviceIds.length === 0) return;
  log(
    `${tag} ${skippedDeviceIds.length} device(s) skipped (invalid KeyPackage): ${skippedDeviceIds.join(', ')} - not invited, republish a fresh KeyPackage.`
  );
  console.warn(
    `${tag}[C5] Invalid KeyPackage for ${skippedDeviceIds.length} device(s) on ${groupId}:`,
    skippedDeviceIds
  );
}

/**
 * Delivers a Welcome to every added device in parallel. Each delivery is an independent
 * HTTP call carrying the same Welcome blob, so ordering is irrelevant for MLS - only the
 * preceding bulk commit must stay unique. Failures are logged per device without
 * aborting the remaining deliveries.
 *
 * @param ownerOf Resolves the owner userId of a device; devices without an owner are skipped.
 * @returns The set of owner userIds with at least one successfully delivered device.
 */
export async function deliverWelcomes(params: {
  mlsService: IMlsService;
  groupId: string;
  bulk: { welcome?: Uint8Array; ratchetTree?: Uint8Array; addedDeviceIds: string[] };
  ownerOf: (deviceId: string) => string | undefined;
  tag: string;
  log: (msg: string) => void;
}): Promise<Set<string>> {
  const { mlsService, groupId, bulk, ownerOf, tag, log } = params;
  const delivered = new Set<string>();
  if (!bulk.welcome) {
    log(`${tag} addMembersBulk returned no welcome (${bulk.addedDeviceIds.length} device(s))`);
    console.warn(`${tag} addMembersBulk returned no welcome`);
    return delivered;
  }
  const welcome = bulk.welcome;
  await Promise.all(
    bulk.addedDeviceIds.map(async (did) => {
      const owner = ownerOf(did);
      if (!owner) return;
      try {
        await mlsService.sendWelcome(welcome, owner, groupId, did, bulk.ratchetTree);
        delivered.add(owner);
        log(`${tag} Welcome -> ${owner}:${did} OK`);
      } catch (e) {
        log(
          `${tag} Welcome failed -> ${owner}:${did}: ${e instanceof Error ? e.message : String(e)}`
        );
        console.warn(
          `${tag} sendWelcome failed for ${owner}:${did}:`,
          e instanceof Error ? e.message : e
        );
      }
    })
  );
  return delivered;
}

/** Returns the deduplicated list of userId strings that are members of a group (a user can have multiple devices). */
export async function fetchUniqueGroupMembers(mlsService: IMlsService, groupId: string) {
  const members = await mlsService.getGroupMembers(groupId);
  return [...new Set(members.map((m) => m.userId))];
}

/**
 * Deletes an MLS group:
 *  1. Broadcasts "groupDeleted" to all members BEFORE server deletion.
 *  2. Deletes the group server-side (DB + Redis).
 *  3. Forgets the local MLS state.
 *
 * Order 1->2 is critical: deleteGroupOnServer hard-deletes dm_group_members, stripping
 * the server of all routing info. A message sent afterwards would be lost.
 */
export async function deleteGroupAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  userId: string;
  deviceKeyB64: string;
  log?: (msg: string) => void;
}): Promise<void> {
  const { mlsService, groupId, userId, deviceKeyB64, log } = params;

  // 1. Notify peers via MLS BEFORE server deletion.
  // Encryption requires WASM state (group must be local),
  // and routing requires dm_group_members (group must be on server).
  if (mlsService.getLocalGroups().includes(groupId)) {
    try {
      const controlMsg = encodeAppMessage(
        mkSystem('groupDeleted', JSON.stringify({ deletedBy: userId }))
      );
      await mlsService.sendMessage(groupId, controlMsg);
    } catch {
      // Non-blocking: peers will discover the deletion on their next pull
    }
  }

  // 2. Delete on server.
  try {
    const serverDeleted = await mlsService.deleteGroupOnServer(groupId);
    if (!serverDeleted) {
      log?.(`[DELETE] Group ${groupId.slice(0, 8)}... not found on server (already deleted?)`);
    }
  } catch (e) {
    log?.(`[DELETE] Server deletion error for ${groupId.slice(0, 8)}...: ${String(e)}`);
    console.error('[DELETE] deleteGroupOnServer failed:', e);
  }

  // 3. Forget the group locally - after sending the message (encryption requires MLS state).
  // Without this, the group stays in the deleter's WASM state and keeps appearing
  // in getLocalGroups(), triggering phantom recovery attempts.
  try {
    mlsService.forgetGroup(groupId);
  } catch {
    /* non-blocking */
  }

  // 4. Forget any outstanding reconciliation state for this conversation - per-conversation state
  // may not outlive the conversation, and the group we have just deleted cannot answer anything.
  forgetGroupReconciliation(groupId);

  // 5. Persist MLS state (forgetGroup modified the WASM tree)
  await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);
}

/** Renames the group on the server, then broadcasts a "groupRenamed" system message to all members so their UIs update. */
export async function renameGroupAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  newName: string;
  userId: string;
  deviceKeyB64: string;
}) {
  const { mlsService, groupId, newName, userId, deviceKeyB64 } = params;
  await mlsService.renameGroup(groupId, newName);

  // Broadcast the rename notification - best-effort: the local rename is
  // already committed to the server; if the MLS message fails, peers will
  // still see the new name when they next fetch group metadata.
  try {
    const controlMsg = encodeAppMessage(mkSystem('groupRenamed', JSON.stringify({ newName })));
    await mlsService.sendMessage(groupId, controlMsg);
  } catch {
    // Non-blocking: rename already applied server-side
  }
  await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64);
}

/** Sets the group avatar on the server, then broadcasts a "groupImageChanged" system message to all members so their UIs update. Pass mediaId=null to remove the photo. */
export async function setGroupImageAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  mediaId: string | null;
  userId: string;
  deviceKeyB64: string;
}) {
  const { mlsService, groupId, mediaId, userId, deviceKeyB64 } = params;
  await mlsService.setGroupImage(groupId, mediaId);

  // Broadcast the photo change - best-effort: the change is already committed to
  // the server; if the MLS message fails, peers will still see the new photo when
  // they next fetch group metadata via getUserGroups.
  try {
    const controlMsg = encodeAppMessage(
      mkSystem('groupImageChanged', JSON.stringify({ imageMediaId: mediaId }))
    );
    await mlsService.sendMessage(groupId, controlMsg);
  } catch {
    // Non-blocking: image already applied server-side
  }
  await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64);
}

/**
 * Sends an MLS system message to notify a membership change.
 *
 * Always best-effort: if the send fails peers will discover the change on their next
 * `getUserGroups` call. Never call after `forgetGroup`.
 */
async function notifyMembershipChange(
  mlsService: IMlsService,
  groupId: string,
  event: 'memberLeft' | 'memberRemoved',
  payload: Record<string, string>
): Promise<void> {
  try {
    await mlsService.sendMessage(
      groupId,
      encodeAppMessage(mkSystem(event, JSON.stringify(payload)))
    );
  } catch {
    /* non-blocking */
  }
}

/**
 * Removes a member from the MLS group (admin action):
 *  1. MLS remove commit - removes the leaf from the tree and advances the epoch for all.
 *  2. Broadcasts `memberRemoved` to remaining members.
 *  3. Cleans the server registry (dm_group_members + dm_device_group_memberships).
 */
export async function removeMemberAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  memberId: string;
  userId: string;
  deviceKeyB64: string;
}) {
  const { mlsService, groupId, memberId, userId, deviceKeyB64 } = params;

  // 1. MLS remove commit: removes the member's leaf for all remaining members.
  await mlsService.removeMember(groupId, [memberId]);

  // 2. Notify remaining members.
  await notifyMembershipChange(mlsService, groupId, 'memberRemoved', { targetUser: memberId });

  // 3. Clean the server registry. Best-effort: the MLS commit is authoritative.
  try {
    await mlsService.removeMemberFromServer(groupId, memberId);
  } catch {
    /* non-blocking */
  }

  await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64);
}

/**
 * Leaves an MLS group (self-removal by the member):
 *  1. Broadcasts `memberLeft` to other members (before any deletion -
 *     WASM state must be valid to encrypt the message).
 *  2. Removes from the server registry (dm_group_members + dm_device_group_memberships).
 *  3. Forgets the group locally to avoid leaving an orphan leaf in
 *     getLocalGroups() that would trigger phantom recovery attempts.
 *
 * Unlike `removeMemberAndBroadcast`, this function does not generate an MLS remove commit:
 * the member's leaf remains in others' trees until the next commit, but they no longer
 * receive messages (server-side).
 */
export async function leaveGroupAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  userId: string;
  deviceKeyB64: string;
}): Promise<void> {
  const { mlsService, groupId, userId, deviceKeyB64 } = params;

  // 1. Notify BEFORE server deletion (WASM must be intact to encrypt).
  await notifyMembershipChange(mlsService, groupId, 'memberLeft', { userId });

  // 2. Clean the server registry.
  try {
    await mlsService.removeMemberFromServer(groupId, userId);
  } catch {
    /* non-blocking */
  }

  // 3. Forget the local WASM state.
  try {
    mlsService.forgetGroup(groupId);
  } catch {
    /* non-blocking */
  }

  await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64);
}

/**
 * Persists the WASM MLS blob to encrypted storage after forgetGroup / commits.
 * Without this, IndexedDB still holds a stale OpenMLS tree on next reload.
 *
 * `_userId` is no longer needed - the platform owns where its checkpoint goes
 * (`IMlsService.persistCheckpoint`) - and is kept only because nineteen call sites pass it
 * positionally. Drop it, and them, in a commit that changes nothing else.
 */
export async function persistMlsStateAfterMutation(
  mlsService: IMlsService,
  _userId: string,
  deviceKeyB64: string,
  log?: (msg: string) => void
): Promise<void> {
  try {
    await persistMlsStructuralCheckpoint({ mlsService, deviceKeyB64 });
  } catch (e) {
    log?.(`[MLS] saveState failed after mutation: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Drops one group from the in-memory WASM/OpenMLS state when the server no longer lists it.
 * @returns true when forgetGroup was applied (caller should persist MLS state).
 */
export function forgetMlsGroupIfPresent(
  mlsService: IMlsService,
  groupId: string,
  log?: (msg: string) => void
): boolean {
  if (!mlsService.getLocalGroups().includes(groupId)) {
    return false;
  }
  try {
    mlsService.forgetGroup(groupId, 0);
    log?.(`[MLS] forgetGroup ${groupId} (absent from server)`);
    return true;
  } catch (e) {
    log?.(`[MLS] forgetGroup failed for ${groupId}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Removes a sidebar / IndexedDB conversation row only (no MLS mutation).
 * Safe to call even when WASM no longer knows the groupId.
 */
export async function purgeLocalConversationRecord(params: {
  conversations: Map<string, Conversation>;
  contactKey: string;
  groupId: string;
  deleteConversation?: (key: string) => Promise<void>;
  log?: (msg: string) => void;
}): Promise<void> {
  const { conversations, contactKey, groupId, deleteConversation, log } = params;
  localStorage.removeItem(`discovery_pending:${groupId}`);
  // Same reason as the `discovery_pending` key above, and the same lifetime: per-conversation local
  // state may not outlive the conversation. This one was user-visible when it did.
  forgetGroupReconciliation(groupId);
  if (deleteConversation) {
    await deleteConversation(contactKey).catch(() => {});
  }
  conversations.delete(contactKey);
  log?.(`[UI] Local conversation removed (${groupId})`);
}

/**
 * Full orphan cleanup: MLS state first (authoritative), then UI/IndexedDB row.
 */
export async function purgeOrphanGroup(params: {
  conversations: Map<string, Conversation>;
  mlsService: IMlsService;
  userId: string;
  deviceKeyB64: string;
  contactKey: string;
  groupId: string;
  deleteConversation?: (key: string) => Promise<void>;
  log?: (msg: string) => void;
}): Promise<void> {
  const { mlsService, userId, deviceKeyB64, groupId, log, ...uiParams } = params;
  const mlsChanged = forgetMlsGroupIfPresent(mlsService, groupId, log);
  if (mlsChanged) {
    await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);
  }
  await purgeLocalConversationRecord({ ...uiParams, groupId, log });
}

/** Returns whether the group is still active for this user on the server (null = unknown). */
export async function isGroupActiveOnServer(
  mlsService: IMlsService,
  userId: string,
  groupId: string
): Promise<boolean | null> {
  try {
    const groups = await mlsService.getUserGroups(userId);
    return isGroupEligibleForMlsRecovery(groupId, buildUserGroupSyncIndex(groups));
  } catch {
    return null;
  }
}

/**
 * Unified handler for a `DuplicateSignature` error raised by `addMember`:
 * the device's old KeyPackage is still in the MLS tree (local state lost).
 * Kicks the stale leaf and resets the status to pending so the device can
 * resend a `welcome_request` with a fresh KeyPackage.
 *
 * Do not check status='active' to decide whether to skip: `sendWelcome` marks
 * the device active optimistically before it processes the Welcome. A device
 * that has lost its state will always be 'active' server-side.
 */
export async function handleDuplicateLeafError(params: {
  mlsService: IMlsService;
  groupId: string;
  targetUserId: string;
  targetDeviceId: string;
  userId: string;
  deviceKeyB64: string;
  log: (msg: string) => void;
}): Promise<void> {
  const { mlsService, groupId, targetUserId, targetDeviceId, userId, deviceKeyB64, log } = params;

  log(`[MLS] DuplicateSignature: kicking stale leaf for ${targetDeviceId.slice(0, 12)}...`);
  await kickStaleLeaf(groupId, targetUserId, targetDeviceId, mlsService, log);
  await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);
}

/**
 * Silently removes the stale leaf of a device from the MLS tree (best-effort).
 * Wraps removeMemberDevice + kickStaleDevice to avoid duplication.
 */
export async function kickStaleLeaf(
  groupId: string,
  targetUserId: string,
  targetDeviceId: string,
  mlsService: IMlsService,
  log: (msg: string) => void
): Promise<void> {
  const deviceIdentity = `${targetUserId}:${targetDeviceId}`;
  // The remove is staged then validated server-side (runCommitTransaction): a server rejection
  // clears the staged commit without advancing the local epoch, so there is no fork to surface -
  // the remove is genuinely best-effort. Rung-1 replay heals any lag on the next sync. Other
  // errors (leaf already absent, etc.) are equally best-effort.
  try {
    await mlsService.removeMemberDevice(groupId, [deviceIdentity]);
  } catch {
    /* best-effort: no fork possible under the staged-commit regime */
  }
  await mlsService.kickStaleDevice(targetDeviceId, targetUserId, groupId).catch(() => {});
  log(`[KICK] Stale leaf ${targetUserId}:${targetDeviceId} removed from ${groupId}`);
}

/**
 * Serialises a `StoredMessage` for transport in a `history_bundle`.
 *
 * Includes all metadata (reactions, isDeleted, isEdited, secondary timestamp) so the recipient gets
 * the complete state and can sort messages stably after a group migration. Read state is NOT here:
 * it belongs to the conversation, and travels once per bundle rather than once per message.
 */
function serializeForBundle(m: StoredMessage) {
  return {
    id: m.id,
    senderId: m.senderId,
    content: m.content,
    timestamp: typeof m.timestamp === 'number' ? m.timestamp : Number(m.timestamp),
    ...(m.reactions?.length ? { reactions: m.reactions } : {}),
    ...(m.isDeleted ? { isDeleted: true } : {}),
    ...(m.isEdited ? { isEdited: true } : {}),
    // The edit TIME travels with the edit flag. Sending one without the other left a device
    // restored from a bundle showing "edited" with no time, permanently - there is no second
    // source for it, since the sender's own edit is never echoed back over MLS.
    ...(m.editedAt ? { editedAt: m.editedAt } : {}),
    // Secondary timestamp: needed for stable post-migration sorting.
    ...(m.serverTimestamp ? { serverTimestamp: m.serverTimestamp } : {}),
  };
}

/**
 * Builds one `history_bundle` frame.
 *
 * **WHY EVERY BUNDLE CARRIES A `to`.** The frame is an MLS group broadcast - there is no such thing
 * as a private send here - so every member of the conversation receives an answer meant for ONE
 * device. `to` is the requester's `digestIdentity` - user AND device, because a user with three
 * devices must be able to solicit from one of them and be answered on that one. Addressing is the
 * ONLY thing it does: it is not a secrecy boundary and must never be read as one.
 *
 * It is deliberately not the `recipients` field of `POST /send`: MLS re-encrypts per recipient set,
 * and narrowing the set on an application message burns the sender ratchet budget
 * (`sender_ratchet_config` is (2000, 2000)) into a generation gap the other members can never close.
 *
 * There is no `vouched` flag any more, and its absence is the point. It existed to tell a durable
 * marker whether it might be discharged - "I compared my whole store and you are complete" as
 * opposed to "our stores merely look the same". Nothing carries a marker now: the comparison is
 * re-run on the next connection, so an answer no longer has to certify anything about the future.
 */
function bundleFrame(
  messages: unknown[],
  to: string,
  opts: { state?: ConversationHistoryState } = {}
): Uint8Array {
  const { state } = opts;
  return encodeAppMessage(
    mkSystem(
      'history_bundle',
      JSON.stringify({
        messages,
        to,
        // The conversation's own state - read watermarks and the shared history floor. A handful of
        // numbers, sent whole with every frame because both merges are `max` and therefore free to
        // repeat. Sending them once would make their delivery depend on which chunk survived.
        ...(state?.readWatermarks ? { readWatermarks: state.readWatermarks } : {}),
        ...(state?.historyFloor ? { floor: state.historyFloor } : {}),
        // Restated by every chunk like the two above, and for the same reason: sending it once
        // would make it depend on which chunk survived. Adopted only by a device holding none.
        ...(state?.pins?.length ? { pins: state.pins } : {}),
      })
    )
  );
}

/** What a conversation carries beyond its messages, and what every bundle restates. */
type ConversationHistoryState = {
  readWatermarks?: ReadWatermarks;
  historyFloor?: number;
  /**
   * The pinned message ids, as a set rather than the events that built it.
   *
   * A pin is CONVERSATION state, like the watermarks beside it, and it belongs here for the same
   * reason the edit time does on a message: the `pin` frame that created it ages out of the
   * server's retention window while the pin itself does not, so a device that arrives later can
   * replay every frame it is entitled to and still never learn the message is pinned.
   */
  pins?: string[];
};

/**
 * The conversation-level state stored for `groupId`, read from its row rather than its messages.
 *
 * Returns an empty state when there is none or the read fails - a bundle carrying neither is a
 * perfectly ordinary bundle, and the receiver's own values are left where they were.
 */
async function storedConversationState(
  groupId: string,
  storage: IStorage
): Promise<ConversationHistoryState> {
  try {
    // ONE row, by key. This used to read every conversation and filter in JS, which is invisible on
    // a single call and quadratic in `reconcileAllGroups` - one whole-table read per group, on every
    // connection, even when the state key itself was cached and read nothing.
    const row = await storage.getConversation(groupId);
    // The pinned set is not on the row: it is device-local state keyed by the same group id, which
    // is precisely why it needed carrying at all.
    const pins = pinnedMessageIds(groupId);
    return {
      readWatermarks: row?.readWatermarks,
      historyFloor: row?.historyFloor,
      ...(pins.length > 0 ? { pins } : {}),
    };
  } catch (e) {
    // The empty state is deliberate (see the docstring) but it must not be SILENT: an unreadable row
    // and a conversation with no floor produce the same answer here, and the caller then asks over a
    // wider window without anything saying why. This branch is all a failed read leaves behind.
    console.warn(
      `[HISTORY_WINDOW] conversation row unreadable for ${groupId.slice(0, 8)}… - asking over the bare window: ${String(e).slice(0, 120)}`
    );
    return {};
  }
}

/**
 * The instant THIS device asks from for `groupId` - the later of the conversation's shared floor and
 * its own retention window.
 *
 * Every frame this device sends as an ASKER states this value, and no answerer ever recomputes it:
 * the window slides, so two devices deriving it a second apart disagree by whatever was sent in
 * between. One exchange must use one number, and the asker is the only side entitled to say which.
 *
 * A store that cannot be read yields the bare window rather than throwing. That is the conservative
 * answer in the only direction that matters here: an absent floor asks for MORE than a known one
 * would, so the worst case is a few messages nobody needed - never a message nobody asked for.
 */
export async function historyRangeStartFor(
  groupId: string,
  storage: IStorage | null
): Promise<number> {
  if (!storage) return historyRangeStart(undefined);
  const { historyFloor } = await storedConversationState(groupId, storage);
  return historyRangeStart(historyFloor);
}

/**
 * Sends the full local history of `groupId` to active group members, encrypted under the
 * current MLS epoch, in chunks of `chunkSize` messages (default 200).
 *
 * Used on new member invitation (handleWelcomeRequest, processPendingInvitations): the bundle
 * arrives after the Welcome, guaranteed in-order by MLS.
 *
 * The recipient deduplicates messages by `id` on receipt - multiple calls are idempotent.
 * Stops at the first chunk error to avoid spamming the network.
 *
 * **An empty group is answered, not ignored**, and this is the one path where an empty bundle still
 * earns its frame: the receiver is a member being INVITED, so it has no conversation row yet, and
 * the bundle is what hands it the shared floor and the read watermarks. Everywhere else an empty
 * selection is simply not sent - see {@link sendHistoryBundleForIds}.
 */
export async function sendFullHistoryBundle(
  groupId: string,
  deps: {
    storage: IStorage | null;
    deviceKeyB64: string;
    mlsService: IMlsService;
    log: (msg: string) => void;
    /** The device that asked, as `digestIdentity` spells it - see {@link bundleFrame}. */
    to: string;
  },
  chunkSize = 200
): Promise<void> {
  const { storage, deviceKeyB64, mlsService, log, to } = deps;
  if (!storage) {
    log(`[HISTORY_BUNDLE] No storage - cannot serve ${groupId.slice(0, 8)}…`);
    return;
  }

  let messages: StoredMessage[];
  try {
    messages = await storage.getMessages(groupId, deviceKeyB64);
  } catch (e) {
    // A read that FAILED proves nothing about the group: stay silent so the requester retries
    // against another member rather than concluding the history is empty.
    log(`[HISTORY_BUNDLE] Read failed for ${groupId.slice(0, 8)}…: ${String(e).slice(0, 120)}`);
    return;
  }
  const state = await storedConversationState(groupId, storage);
  if (messages.length === 0) {
    // A group with no messages can still have read state and a floor worth handing over.
    const bytes = bundleFrame([], to, { state });
    try {
      await mlsService.sendMessage(groupId, bytes, undefined, DELIVERY.transport);
      log(`[HISTORY_BUNDLE] Empty bundle sent for ${groupId.slice(0, 8)}… (group has no history)`);
    } catch (e) {
      log(`[HISTORY_BUNDLE] Empty bundle send error: ${String(e).slice(0, 120)}`);
    }
    return;
  }

  await sendBundleChunks(groupId, messages, { mlsService, log }, { chunkSize, to, state });
  log(`[HISTORY_BUNDLE] Full history sent: ${messages.length} message(s)`);
}

/** Shared deps of every history control frame: the group send and somewhere to say what happened. */
type HistorySendDeps = { mlsService: IMlsService; log: (msg: string) => void };

/** Everything a device needs to read its own store before it can describe or answer a diff. */
export type HistoryStoreDeps = HistorySendDeps & {
  storage: IStorage | null;
  deviceKeyB64: string;
};

/**
 * Chunks `messages` into `history_bundle` frames and sends them, stopping at the first failure.
 *
 * Shared by the full bundle and the id-filtered one so a change to the wire shape cannot reach one
 * path and miss the other - the two differ only in WHICH messages they were handed.
 */
async function sendBundleChunks(
  groupId: string,
  messages: StoredMessage[],
  { mlsService, log }: HistorySendDeps,
  { chunkSize, to, state }: { chunkSize: number; to: string; state?: ConversationHistoryState }
): Promise<void> {
  const totalChunks = Math.ceil(messages.length / chunkSize);
  for (let i = 0; i < messages.length; i += chunkSize) {
    const payload = messages.slice(i, i + chunkSize).map(serializeForBundle);
    const bytes = bundleFrame(payload, to, { state });
    try {
      await mlsService.sendMessage(groupId, bytes, undefined, DELIVERY.transport);
      log(
        `[HISTORY_BUNDLE] Chunk ${Math.floor(i / chunkSize) + 1}/${totalChunks} - ${payload.length} msg → ${groupId.slice(0, 8)}…`
      );
    } catch (e) {
      log(`[HISTORY_BUNDLE] Chunk send error ${Math.floor(i / chunkSize) + 1}: ${String(e)}`);
      return;
    }
  }
}

/**
 * Reads the local store for `groupId` as manifest entries - an id and the instant that buckets it.
 *
 * Returns `null` when the store is unreadable, which is NOT the same as an empty conversation: an
 * empty store is a fact worth telling a peer, a failed read is a claim we are not entitled to make.
 */
export async function readHistoryEntries(
  groupId: string,
  deps: HistoryStoreDeps
): Promise<HistoryEntry[] | null> {
  const messages = await readHistoryMessages(groupId, deps);
  if (messages === null) return null;
  return messages.map((m) => ({
    id: m.id,
    timestamp: typeof m.timestamp === 'number' ? m.timestamp : Number(m.timestamp),
  }));
}

/**
 * Reads the whole local store for `groupId`, or `null` when it cannot be read.
 *
 * The distinction {@link readHistoryEntries} rests on, kept in one place: an empty store is a fact
 * worth telling a peer, a failed read is a claim we are not entitled to make. Exposed separately
 * because the reconciliation needs the MESSAGES, not just their ids and dates - a state key covers
 * deletions, edits and reactions, none of which a manifest entry carries - and reading the store
 * twice for one exchange is the cost this whole mechanism exists to avoid.
 */
export async function readHistoryMessages(
  groupId: string,
  { storage, deviceKeyB64, log }: HistoryStoreDeps
): Promise<StoredMessage[] | null> {
  if (!storage) return null;
  try {
    return await storage.getMessages(groupId, deviceKeyB64);
  } catch (e) {
    log(
      `[HISTORY_DIGEST] Store read failed for ${groupId.slice(0, 8)}…: ${String(e).slice(0, 120)}`
    );
    return null;
  }
}

/**
 * The state key for `groupId` over this device's own window, reading the store only on a cache miss.
 *
 * Both sides of the comparison go through here: the asker to say what it holds, the responder to
 * check whether it agrees. That is what makes the common case free - two devices that agree exchange
 * one small frame and neither opens its store.
 */
export async function historyStateKeyFor(
  groupId: string,
  since: number,
  deps: HistoryStoreDeps
): Promise<string | null> {
  return cachedHistoryStateKey(groupId, since, () => readHistoryMessages(groupId, deps));
}

/**
 * Tells the elected responder what this device holds, in 16 characters, and asks whether it agrees.
 *
 * The FIRST leg of every reconciliation and usually the only one. A digest describes a store in
 * proportion to its size and costs a walk on both sides; this costs one frame, one conversation row
 * for the window, and - on a cache hit - no read of the MESSAGES at all. Only when the two keys
 * differ is a digest worth exchanging - see `handleHistoryRequest`, which asks for one at that point
 * and not before.
 *
 * Like the digest it rides inside MLS and never over the WebSocket: what a device holds is metadata
 * the server does not have and must not learn.
 *
 * @returns `false` when nothing went out - an unreadable store, or a send that failed. The caller
 *          treats that as "this group was not reconciled", never as "we agree".
 */
export async function sendHistoryStateKey(
  groupId: string,
  from: string,
  deps: HistoryStoreDeps
): Promise<boolean> {
  const { mlsService, log, storage } = deps;
  const since = await historyRangeStartFor(groupId, storage);
  const key = await historyStateKeyFor(groupId, since, deps);
  if (key === null) {
    log(`[HISTORY_STATE] Cannot describe ${groupId.slice(0, 8)}… - no readable store`);
    return false;
  }

  const bytes = encodeAppMessage(mkSystem('history_state', JSON.stringify({ from, key, since })));
  try {
    await mlsService.sendMessage(groupId, bytes, undefined, DELIVERY.transport);
    log(
      `[HISTORY_STATE] Sent for ${groupId.slice(0, 8)}… - ${key}, from ${new Date(since).toISOString()}`
    );
    return true;
  } catch (e) {
    log(`[HISTORY_STATE] Send failed for ${groupId.slice(0, 8)}…: ${String(e).slice(0, 120)}`);
    return false;
  }
}

/**
 * The responder's answer to a state key that did NOT match: *"we differ - describe yourself
 * properly."*
 *
 * It is addressed at the asking device rather than broadcast, for the same reason every other leg
 * is: building a digest is the expensive half of this mechanism, and only one device was elected to
 * do it. The asker answers with `sendHistoryDigest`, which lands on the SAME rendezvous - the second
 * probe of one solicitation, not a new one.
 */
export async function sendHistoryDigestRequest(
  groupId: string,
  request: { from: string; to: string },
  { mlsService, log }: HistorySendDeps
): Promise<void> {
  const bytes = encodeAppMessage(
    mkSystem('history_digest_request', JSON.stringify({ ...request }))
  );
  try {
    await mlsService.sendMessage(groupId, bytes, undefined, DELIVERY.transport);
    log(
      `[HISTORY_STATE] Keys differ for ${groupId.slice(0, 8)}… - asked ${request.to} to describe`
    );
  } catch (e) {
    log(
      `[HISTORY_STATE] Could not ask ${request.to} to describe ${groupId.slice(0, 8)}…: ${String(e).slice(0, 120)}`
    );
  }
}

/**
 * Asks the elected responder for a bounded slice of history OLDER than anything this device holds -
 * the scrollback, driven by a reader rather than by a connection.
 *
 * It states `before` (we hold nothing older than this) and `limit` (how much we will take at once),
 * so the answer is bounded whatever the conversation's size. `since` is stated too and is what stops
 * the ask from reaching below the shared floor.
 *
 * A range is a third kind of probe on the same rendezvous rather than a mechanism of its own,
 * because it is the same question asked at a different boundary - and it must go through the same
 * election, or every member would answer one reader's scroll.
 */
export async function sendHistoryRangeRequest(
  groupId: string,
  request: { from: string; before: number; limit: number; since: number },
  { mlsService, log }: HistorySendDeps
): Promise<boolean> {
  const bytes = encodeAppMessage(mkSystem('history_range', JSON.stringify({ ...request })));
  try {
    await mlsService.sendMessage(groupId, bytes, undefined, DELIVERY.transport);
    log(
      `[HISTORY_RANGE] Asked for up to ${request.limit} message(s) before ${new Date(request.before).toISOString()} in ${groupId.slice(0, 8)}…`
    );
    return true;
  } catch (e) {
    log(`[HISTORY_RANGE] Send failed for ${groupId.slice(0, 8)}…: ${String(e).slice(0, 120)}`);
    return false;
  }
}

/**
 * Broadcasts what this device holds for `groupId`, so whichever member the server elects can answer
 * with the DIFFERENCE instead of its entire store.
 *
 * `from` is carried in the payload because an MLS application message identifies its sender by USER
 * and this exchange is addressed per DEVICE - a user with three devices must be able to solicit from
 * one of them without the other two being answered in its place. The receiver checks the claimed
 * user id against the authenticated MLS sender, so the only thing a device can lie about is which of
 * its OWNER's devices it is.
 *
 * It rides inside MLS, never over the WebSocket: the ids of the messages a device kept are metadata
 * the server does not hold today and must not learn.
 *
 * **The digest says what we HAVE; `since` says what we WANT, and they are not the same set.** The
 * digest is deliberately NOT clipped: a device holding messages below its own window can still serve
 * them to a peer whose window reaches further back, and describing them truthfully is what lets it.
 * `since` bounds the ANSWER only.
 */
export async function sendHistoryDigest(
  groupId: string,
  from: string,
  deps: HistoryStoreDeps
): Promise<boolean> {
  const { mlsService, log, storage } = deps;
  const entries = await readHistoryEntries(groupId, deps);
  if (entries === null) {
    log(`[HISTORY_DIGEST] Cannot describe ${groupId.slice(0, 8)}… - no readable store`);
    return false;
  }

  const digest = await buildHistoryDigest(entries);
  const since = await historyRangeStartFor(groupId, storage);
  const summary =
    digest.mode === 'ids'
      ? `${digest.ids.length} id(s)`
      : `${digest.ranges.length} slice(s) at depth ${digest.depth}`;
  const bytes = encodeAppMessage(
    mkSystem('history_digest', JSON.stringify({ from, digest, since }))
  );
  try {
    await mlsService.sendMessage(groupId, bytes, undefined, DELIVERY.transport);
    log(
      `[HISTORY_DIGEST] Sent for ${groupId.slice(0, 8)}… - ${digest.mode} mode, ${summary}, asking from ${new Date(since).toISOString()}`
    );
    return true;
  } catch (e) {
    log(`[HISTORY_DIGEST] Send failed for ${groupId.slice(0, 8)}…: ${String(e).slice(0, 120)}`);
    return false;
  }
}

/**
 * Asks one specific device for the messages this one is missing, by id or - when the digest could
 * only resolve to a slice of the id space - by slice.
 *
 * `depth` travels with the prefixes and is not optional for them: a prefix means nothing without the
 * depth it was computed at, and the answering device must re-slice its own store at exactly that
 * depth rather than at the one its own size would pick (see `diffHistoryDigest`).
 *
 * Split across several frames because a diff is unbounded (a device back after a month away can be
 * short thousands of messages) while an MLS application message is not.
 *
 * A pull is an ASK, so it states `since` exactly as a digest does - and it must state its OWN, never
 * the one that arrived on the digest it is answering. The two devices have different windows: a
 * phone diffing against a browser's digest asks back for five years, and reusing the browser's
 * ninety days would silently cap the phone at the shortest window in the conversation.
 */
export async function sendHistoryPull(
  groupId: string,
  request: {
    from: string;
    to: string;
    ids?: readonly string[];
    prefixes?: readonly string[];
    depth?: number;
    /** Where OUR window opens. Anything the answerer holds below it is not wanted. */
    since: number;
  },
  { mlsService, log }: HistorySendDeps
): Promise<void> {
  const { from, to, ids, prefixes, depth, since } = request;
  const frames: Array<Record<string, unknown>> =
    ids && ids.length > 0
      ? chunkIds(ids).map((batch) => ({ from, to, ids: batch, since }))
      : prefixes && prefixes.length > 0 && depth
        ? [{ from, to, prefixes: [...prefixes], depth, since }]
        : [];

  if (frames.length === 0) return;

  for (const payload of frames) {
    const bytes = encodeAppMessage(mkSystem('history_pull', JSON.stringify(payload)));
    try {
      await mlsService.sendMessage(groupId, bytes, undefined, DELIVERY.transport);
    } catch (e) {
      log(`[HISTORY_PULL] Send failed for ${groupId.slice(0, 8)}…: ${String(e).slice(0, 120)}`);
      return;
    }
  }
  log(
    `[HISTORY_PULL] Asked ${to} for ${ids?.length ?? 0} id(s) / ${prefixes?.length ?? 0} slice(s) in ${groupId.slice(0, 8)}… (${frames.length} frame(s))`
  );
}

/**
 * Sends only the messages named by `ids`, which is what a diff resolves to.
 *
 * `to` addresses the answer at the device that asked; see {@link bundleFrame}.
 *
 * **An empty selection sends nothing at all**, and that is a simplification the state key paid for.
 * An empty bundle used to be an ANSWER - "I compared my whole store and you are missing nothing" -
 * because a durable marker on the other side needed something authoritative to discharge it. There
 * is no marker: a device that receives nothing simply holds what it held, and the comparison runs
 * again on the next connection. So the three-way `emptyMeans` and the `vouched` flag it put on the
 * wire are both gone, along with the deadlock they existed to work around (two peers each entitled
 * to answer, neither able to vouch).
 *
 * **This is where the asker's window is honoured, and the only place it can be.** The clip is by
 * timestamp, and an id list carries no timestamps - only the device HOLDING a message knows when it
 * was sent. So an asker states `since` and the answerer drops what falls below it here, once, rather
 * than every caller filtering an id list it cannot date.
 *
 * `since` defaults to 0, which answers in full. That is what a path with no window to state means:
 * the bundle pushed to a member being invited was asked for by nobody. Over-answering costs
 * bandwidth; under-answering loses messages.
 */
export async function sendHistoryBundleForIds(
  groupId: string,
  ids: readonly string[],
  deps: HistoryStoreDeps,
  opts: { to: string; chunkSize?: number; since?: number }
): Promise<void> {
  const { storage, mlsService, log } = deps;
  const { to, chunkSize = 200, since = 0 } = opts;
  if (!storage) {
    log(`[HISTORY_BUNDLE] No storage - cannot serve ${groupId.slice(0, 8)}…`);
    return;
  }

  const wanted = new Set(ids);
  if (wanted.size === 0) return;

  const held = await readHistoryMessages(groupId, deps);
  if (held === null) {
    // A read that FAILED proves nothing about the group: stay silent so the requester retries
    // against another member rather than concluding it is already complete.
    return;
  }
  const matching = held.filter((m) => wanted.has(m.id));
  const selected = matching.filter((m) => isWithinHistoryRange(Number(m.timestamp), since));
  const clipped = matching.length - selected.length;
  if (clipped > 0) {
    log(
      `[HISTORY_BUNDLE] Held ${clipped} message(s) below the asker's window for ${groupId.slice(0, 8)}… - not sent`
    );
  }

  if (selected.length === 0) {
    log(
      `[HISTORY_BUNDLE] Nothing to add for ${groupId.slice(0, 8)}… - saying nothing, the comparison runs again on the next connection`
    );
    return;
  }

  const state = await storedConversationState(groupId, storage);
  await sendBundleChunks(groupId, selected, { mlsService, log }, { chunkSize, to, state });
  log(
    `[HISTORY_BUNDLE] Diff sent for ${groupId.slice(0, 8)}…: ${selected.length} of ${wanted.size} requested message(s)`
  );
}

/**
 * Answers a scrollback ask: the newest messages strictly OLDER than `before`, at most `limit` of
 * them, never below `since`.
 *
 * Bounded from both ends on purpose, which is what makes it usable on a conversation of any size: a
 * reader scrolling up asks again when it reaches the top of what arrived, so the cost is paid one
 * page at a time by the person actually reading, rather than as one unbounded answer that has to be
 * chunked and freezes the list when it lands.
 *
 * NEWEST-first selection, oldest-first delivery: the page a reader wants is the one immediately
 * before what they can already see, and the messages inside it must still arrive in reading order.
 */
export async function sendHistoryRangeBundle(
  groupId: string,
  deps: HistoryStoreDeps,
  opts: { to: string; before: number; limit: number; since?: number }
): Promise<void> {
  const { storage, mlsService, log } = deps;
  const { to, before, limit, since = 0 } = opts;
  if (!storage) {
    log(`[HISTORY_RANGE] No storage - cannot serve ${groupId.slice(0, 8)}…`);
    return;
  }

  const held = await readHistoryMessages(groupId, deps);
  if (held === null) return;

  const inRange = held.filter((m) => {
    const at = Number(m.timestamp);
    // An undated message cannot be placed in a range, and a scrollback is entirely about placement:
    // including it would put it at an arbitrary point of the reader's list on one device only.
    if (!Number.isFinite(at)) return false;
    return at < before && at >= since;
  });
  if (inRange.length === 0) {
    log(
      `[HISTORY_RANGE] Hold nothing before that point in ${groupId.slice(0, 8)}… - staying silent`
    );
    return;
  }

  const page = inRange.slice(-Math.max(1, limit));
  const state = await storedConversationState(groupId, storage);
  await sendBundleChunks(groupId, page, { mlsService, log }, { chunkSize: 200, to, state });
  log(
    `[HISTORY_RANGE] Sent ${page.length} of ${inRange.length} message(s) older than ${new Date(before).toISOString()} for ${groupId.slice(0, 8)}…`
  );
}

export type { HistoryDigest };
