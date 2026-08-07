import { persistMlsStructuralCheckpoint } from '$lib/mls-client/mlsStatePersisterRegistry';
import type { IMlsService } from '$lib/mlsService';
import type { IStorage, StoredMessage } from '$lib/db';
import type { Conversation } from '$lib/types';
import { encodeAppMessage, mkSystem } from '$lib/proto/codec';
import { buildUserGroupSyncIndex, isGroupEligibleForMlsRecovery } from './groupSyncEligibility';
import { isAwaitingHistory } from './awaitingHistoryRegistry';
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

  // 4. Persist MLS state (forgetGroup modified the WASM tree)
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
 */
export async function persistMlsStateAfterMutation(
  mlsService: IMlsService,
  userId: string,
  deviceKeyB64: string,
  log?: (msg: string) => void
): Promise<void> {
  try {
    await persistMlsStructuralCheckpoint({ mlsService, deviceKeyB64, userId });
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
 * Includes all metadata (reactions, read receipts, isDeleted, isEdited, secondary timestamps)
 * so the recipient gets the complete state and can sort messages stably after a group migration.
 */
function serializeForBundle(m: StoredMessage) {
  return {
    id: m.id,
    senderId: m.senderId,
    content: m.content,
    timestamp: typeof m.timestamp === 'number' ? m.timestamp : Number(m.timestamp),
    ...(m.reactions?.length ? { reactions: m.reactions } : {}),
    ...(m.readBy?.length ? { readBy: m.readBy } : {}),
    ...(m.isDeleted ? { isDeleted: true } : {}),
    ...(m.isEdited ? { isEdited: true } : {}),
    // Secondary timestamps: needed for stable post-migration sorting and for correctly
    // displaying the first read-receipt date.
    ...(m.readAt ? { readAt: m.readAt } : {}),
    ...(m.serverTimestamp ? { serverTimestamp: m.serverTimestamp } : {}),
  };
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
 * **An empty group is answered, not ignored.** Returning silently made "there is no history" and
 * "nobody answered" the same signal to the requester, so every join of a brand-new conversation
 * timed out into `pending-offline`, showed the offline banner and kept its durable awaiting-history
 * marker - re-soliciting on every reconnect for the 30 days of the give-up horizon. An empty bundle
 * closes that loop (the receiver clears the marker before it even reads `messages`). It is only sent
 * when our emptiness is authoritative: see {@link isAwaitingHistory}.
 */
export async function sendFullHistoryBundle(
  groupId: string,
  deps: {
    storage: IStorage | null;
    deviceKeyB64: string;
    mlsService: IMlsService;
    log: (msg: string) => void;
    /** OUR user id, for the authoritative-emptiness check. Not the requester's. */
    selfUserId: string;
  },
  chunkSize = 200
): Promise<void> {
  const { storage, deviceKeyB64, mlsService, log, selfUserId } = deps;
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
  if (messages.length === 0) {
    if (isAwaitingHistory(selfUserId, groupId)) {
      log(
        `[HISTORY_BUNDLE] Empty and still awaiting history ourselves for ${groupId.slice(0, 8)}… - staying silent`
      );
      return;
    }
    const bytes = encodeAppMessage(mkSystem('history_bundle', JSON.stringify({ messages: [] })));
    try {
      await mlsService.sendMessage(groupId, bytes, undefined, true);
      log(`[HISTORY_BUNDLE] Empty bundle sent for ${groupId.slice(0, 8)}… (group has no history)`);
    } catch (e) {
      log(`[HISTORY_BUNDLE] Empty bundle send error: ${String(e).slice(0, 120)}`);
    }
    return;
  }

  await sendBundleChunks(groupId, messages, { mlsService, log }, chunkSize);
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
  chunkSize: number
): Promise<void> {
  const totalChunks = Math.ceil(messages.length / chunkSize);
  for (let i = 0; i < messages.length; i += chunkSize) {
    const payload = messages.slice(i, i + chunkSize).map(serializeForBundle);
    const bytes = encodeAppMessage(
      mkSystem('history_bundle', JSON.stringify({ messages: payload }))
    );
    try {
      await mlsService.sendMessage(groupId, bytes, undefined, true);
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
  { storage, deviceKeyB64, log }: HistoryStoreDeps
): Promise<HistoryEntry[] | null> {
  if (!storage) return null;
  try {
    const messages = await storage.getMessages(groupId, deviceKeyB64);
    return messages.map((m) => ({
      id: m.id,
      timestamp: typeof m.timestamp === 'number' ? m.timestamp : Number(m.timestamp),
    }));
  } catch (e) {
    log(
      `[HISTORY_DIGEST] Store read failed for ${groupId.slice(0, 8)}…: ${String(e).slice(0, 120)}`
    );
    return null;
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
 */
export async function sendHistoryDigest(
  groupId: string,
  from: string,
  deps: HistoryStoreDeps
): Promise<boolean> {
  const { mlsService, log } = deps;
  const entries = await readHistoryEntries(groupId, deps);
  if (entries === null) {
    log(`[HISTORY_DIGEST] Cannot describe ${groupId.slice(0, 8)}… - no readable store`);
    return false;
  }

  const digest = await buildHistoryDigest(entries);
  const summary =
    digest.mode === 'ids' ? `${digest.ids.length} id(s)` : `${digest.buckets.length} month(s)`;
  const bytes = encodeAppMessage(mkSystem('history_digest', JSON.stringify({ from, digest })));
  try {
    await mlsService.sendMessage(groupId, bytes, undefined, true);
    log(`[HISTORY_DIGEST] Sent for ${groupId.slice(0, 8)}… - ${digest.mode} mode, ${summary}`);
    return true;
  } catch (e) {
    log(`[HISTORY_DIGEST] Send failed for ${groupId.slice(0, 8)}…: ${String(e).slice(0, 120)}`);
    return false;
  }
}

/**
 * Asks one specific device for the messages this one is missing, by id or - when the digest could
 * only resolve to the month - by month.
 *
 * Split across several frames because a diff is unbounded (a device back after a month away can be
 * short thousands of messages) while an MLS application message is not.
 */
export async function sendHistoryPull(
  groupId: string,
  request: { from: string; to: string; ids?: readonly string[]; months?: readonly string[] },
  { mlsService, log }: HistorySendDeps
): Promise<void> {
  const { from, to, ids, months } = request;
  const frames: Array<Record<string, unknown>> =
    ids && ids.length > 0
      ? chunkIds(ids).map((batch) => ({ from, to, ids: batch }))
      : months && months.length > 0
        ? [{ from, to, months: [...months] }]
        : [];

  if (frames.length === 0) return;

  for (const payload of frames) {
    const bytes = encodeAppMessage(mkSystem('history_pull', JSON.stringify(payload)));
    try {
      await mlsService.sendMessage(groupId, bytes, undefined, true);
    } catch (e) {
      log(`[HISTORY_PULL] Send failed for ${groupId.slice(0, 8)}…: ${String(e).slice(0, 120)}`);
      return;
    }
  }
  log(
    `[HISTORY_PULL] Asked ${to} for ${ids?.length ?? 0} id(s) / ${months?.length ?? 0} month(s) in ${groupId.slice(0, 8)}… (${frames.length} frame(s))`
  );
}

/**
 * Sends only the messages named by `ids`, which is what a diff resolves to.
 *
 * `announceComplete` decides what an EMPTY selection means, and the two answers are not
 * interchangeable:
 *
 * - `true` - we compared our whole store against the peer's digest and it is missing nothing. That
 *   deserves an empty bundle, because "you are complete" and "nobody answered" must not be the same
 *   signal: conflating them leaves a device that is already up to date showing the offline banner
 *   and re-soliciting on every reconnect for the whole 30-day give-up horizon.
 * - `false` - we were asked for specific messages and hold none of them. Saying "complete" there
 *   would end the peer's solicitation on the word of a device that was only ever asked about a
 *   subset, when another member may well hold what it wants. Stay silent and let it retry.
 */
export async function sendHistoryBundleForIds(
  groupId: string,
  ids: readonly string[],
  deps: HistoryStoreDeps,
  opts: { announceComplete: boolean; chunkSize?: number }
): Promise<void> {
  const { storage, deviceKeyB64, mlsService, log } = deps;
  const { announceComplete, chunkSize = 200 } = opts;
  if (!storage) {
    log(`[HISTORY_BUNDLE] No storage - cannot serve ${groupId.slice(0, 8)}…`);
    return;
  }

  const wanted = new Set(ids);
  let selected: StoredMessage[] = [];
  if (wanted.size > 0) {
    try {
      selected = (await storage.getMessages(groupId, deviceKeyB64)).filter((m) => wanted.has(m.id));
    } catch (e) {
      // A read that FAILED proves nothing about the group: stay silent so the requester retries
      // against another member rather than concluding it is already complete.
      log(`[HISTORY_BUNDLE] Read failed for ${groupId.slice(0, 8)}…: ${String(e).slice(0, 120)}`);
      return;
    }
  }

  if (selected.length === 0) {
    if (!announceComplete) {
      log(
        `[HISTORY_BUNDLE] Hold none of the ${wanted.size} message(s) asked for in ${groupId.slice(0, 8)}… - staying silent so another member can answer`
      );
      return;
    }
    const bytes = encodeAppMessage(mkSystem('history_bundle', JSON.stringify({ messages: [] })));
    try {
      await mlsService.sendMessage(groupId, bytes, undefined, true);
      log(`[HISTORY_BUNDLE] Nothing to add for ${groupId.slice(0, 8)}… - empty bundle sent`);
    } catch (e) {
      log(`[HISTORY_BUNDLE] Empty bundle send error: ${String(e).slice(0, 120)}`);
    }
    return;
  }

  await sendBundleChunks(groupId, selected, { mlsService, log }, chunkSize);
  log(
    `[HISTORY_BUNDLE] Diff sent for ${groupId.slice(0, 8)}…: ${selected.length} of ${wanted.size} requested message(s)`
  );
}

export type { HistoryDigest };
