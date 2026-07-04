import { persistMlsStructuralCheckpoint } from '$lib/mls-client/mlsStatePersisterRegistry';
import type { IMlsService } from '$lib/mlsService';
import type { IStorage, StoredMessage } from '$lib/db';
import type { Conversation } from '$lib/types';
import { encodeAppMessage, mkSystem } from '$lib/proto/codec';
import { buildUserGroupSyncIndex, isGroupEligibleForMlsRecovery } from './groupSyncEligibility';

/**
 * Reports (log + `console.warn`) devices skipped by `addMembersBulk` because their KeyPackage
 * was invalid/unreadable. Without this, a skipped device would vanish silently: never invited,
 * never retried. The remedy (republish a fresh KeyPackage then re-add/reboot) is deferred;
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

/** Returns the deduplicated list of userId strings that are members of a group (a user can have multiple devices). */
export async function fetchUniqueGroupMembers(mlsService: IMlsService, groupId: string) {
  const members = await mlsService.getGroupMembers(groupId);
  return [...new Set(members.map((m) => m.userId))];
}

/**
 * Detects a rejected-commit error indicating the local MLS state is forked BEHIND the server
 * (the sent epoch is strictly less than the server `activeEpoch`).
 *
 * Recognised format (legacy `server epoch:.., sent:..` marker; retained for the successor/fork
 * recovery machinery pending its Phase 4 retirement):
 *   `Commit rejected: epoch_mismatch (server epoch: 23, sent: 7)`
 *
 * Returns `{ serverEpoch, sentEpoch }` if the device is behind, or `null`
 * (different error type, or server epoch <= sent epoch).
 */
export function parseForkedEpoch(err: unknown): { serverEpoch: number; sentEpoch: number } | null {
  const m = String(err).match(/server epoch:\s*(\d+),\s*sent:\s*(\d+)/);
  if (!m) return null;
  const serverEpoch = Number(m[1]);
  const sentEpoch = Number(m[2]);
  if (!Number.isFinite(serverEpoch) || !Number.isFinite(sentEpoch)) return null;
  if (serverEpoch <= sentEpoch) return null;
  return { serverEpoch, sentEpoch };
}

/**
 * Returns true if the rejected-commit error indicates THIS device forked by already merging its
 * own commit (SEND path: add/remove/kick followed by `sendCommit`). A single epoch gap suffices:
 * we lost a concurrent commit race, already advanced locally to N+1 on a divergent branch, and
 * the winning commit (N -> N+1 on the other branch) will be dropped as same-epoch benign (cf.
 * mls-core process_incoming) -> never adopted -> permanent fork. The only remedy is forget +
 * re-Welcome to adopt the winning branch. [[C7]]
 *
 * NOT to be confused with a receiver one epoch behind (which catches up on its own when the
 * missing commit arrives via the queue): here the local epoch has already been merged by OUR
 * commit. Since `parseForkedEpoch` returns non-null only for `serverEpoch > sentEpoch`, any
 * `epoch_mismatch` received AFTER a local merge (send path) is by definition a fork.
 */
export function isSenderForkError(err: unknown): boolean {
  return parseForkedEpoch(err) !== null;
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
  pin: string;
  log?: (msg: string) => void;
}): Promise<void> {
  const { mlsService, groupId, userId, pin, log } = params;

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
  await persistMlsStateAfterMutation(mlsService, userId, pin, log);
}

/** Renames the group on the server, then broadcasts a "groupRenamed" system message to all members so their UIs update. */
export async function renameGroupAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  newName: string;
  userId: string;
  pin: string;
}) {
  const { mlsService, groupId, newName, userId, pin } = params;
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
  await persistMlsStateAfterMutation(mlsService, userId, pin);
}

/** Sets the group avatar on the server, then broadcasts a "groupImageChanged" system message to all members so their UIs update. Pass mediaId=null to remove the photo. */
export async function setGroupImageAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  mediaId: string | null;
  userId: string;
  pin: string;
}) {
  const { mlsService, groupId, mediaId, userId, pin } = params;
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
  await persistMlsStateAfterMutation(mlsService, userId, pin);
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
  pin: string;
}) {
  const { mlsService, groupId, memberId, userId, pin } = params;

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

  await persistMlsStateAfterMutation(mlsService, userId, pin);
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
  pin: string;
}): Promise<void> {
  const { mlsService, groupId, userId, pin } = params;

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

  await persistMlsStateAfterMutation(mlsService, userId, pin);
}

/**
 * Persists the WASM MLS blob to encrypted storage after forgetGroup / commits.
 * Without this, IndexedDB still holds a stale OpenMLS tree on next reload.
 */
export async function persistMlsStateAfterMutation(
  mlsService: IMlsService,
  userId: string,
  pin: string,
  log?: (msg: string) => void
): Promise<void> {
  try {
    await persistMlsStructuralCheckpoint({ mlsService, pin, userId });
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
  pin: string;
  contactKey: string;
  groupId: string;
  deleteConversation?: (key: string) => Promise<void>;
  log?: (msg: string) => void;
}): Promise<void> {
  const { mlsService, userId, pin, groupId, log, ...uiParams } = params;
  const mlsChanged = forgetMlsGroupIfPresent(mlsService, groupId, log);
  if (mlsChanged) {
    await persistMlsStateAfterMutation(mlsService, userId, pin, log);
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
  pin: string;
  log: (msg: string) => void;
}): Promise<void> {
  const { mlsService, groupId, targetUserId, targetDeviceId, userId, pin, log } = params;

  log(`[MLS] DuplicateSignature: kicking stale leaf for ${targetDeviceId.slice(0, 12)}...`);
  await kickStaleLeaf(groupId, targetUserId, targetDeviceId, mlsService, log);
  await persistMlsStateAfterMutation(mlsService, userId, pin, log);
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
  // The remove generates a commit applied LOCALLY then validated server-side. If the server
  // rejects it for epoch_mismatch (OUR state is forked), the error must NOT be swallowed:
  // the commit already advanced the local epoch and retrying would only deepen the fork
  // (kick/re-add storm). We surface the error so the caller triggers recovery (forget +
  // welcome_request). We escalate at a gap of 1 (`isSenderForkError`): here the local epoch
  // has already been merged, so even a gap of 1 is a real concurrent fork, not a simple
  // receiver lag. Other errors (leaf already absent, etc.) remain best-effort. [[C7]]
  try {
    await mlsService.removeMemberDevice(groupId, [deviceIdentity]);
  } catch (e) {
    if (isSenderForkError(e)) throw e;
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
 * Use cases:
 *  - New member invitation (handleWelcomeRequest, processPendingInvitations):
 *    the bundle arrives after the Welcome, guaranteed in-order by MLS.
 *  - CAS-won reboot: sent after inviteMembers so re-invited members get the history
 *    migrated from the dead group.
 *  - joinSuccessor: redistributes the freshly-migrated history to the successor creator
 *    who had an empty bundle (device with no local history at reboot time).
 *  - resumePendingCasBundles: resent at startup if the device crashed between writing
 *    the `cas_winner:{G}` key and deleting it.
 *
 * The recipient deduplicates messages by `id` on receipt - multiple calls are idempotent.
 * Stops at the first chunk error to avoid spamming the network.
 */
export async function sendFullHistoryBundle(
  groupId: string,
  deps: {
    storage: IStorage | null;
    pin: string;
    mlsService: IMlsService;
    log: (msg: string) => void;
  },
  chunkSize = 200
): Promise<void> {
  const { storage, pin, mlsService, log } = deps;
  if (!storage) return;

  let messages: StoredMessage[];
  try {
    messages = await storage.getMessages(groupId, pin);
  } catch {
    return;
  }
  if (messages.length === 0) return;

  const totalChunks = Math.ceil(messages.length / chunkSize);
  for (let i = 0; i < messages.length; i += chunkSize) {
    const chunk = messages.slice(i, i + chunkSize);
    const payload = chunk.map(serializeForBundle);
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
  log(`[HISTORY_BUNDLE] Full history sent: ${messages.length} message(s)`);
}
