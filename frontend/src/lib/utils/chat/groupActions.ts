import { DELIVERY, addressedHistoryAnswer } from '$lib/mls-client/frameDelivery';
import { AddressedUnsupportedError } from '$lib/mls-client/mlsDeliveryApi';
import { persistMlsStructuralCheckpoint } from '$lib/mls-client/mlsStatePersisterRegistry';
import type { IMlsService } from '$lib/mlsService';
import type { IStorage, StoredMessage } from '$lib/db';
import type { ReadWatermarks } from '$lib/types';
import type { Conversation } from '$lib/types';
import { encodeAppMessage, mkSystem } from '$lib/proto/codec';
import { pinEntries } from '$lib/stores/pinStore.svelte';
import { buildUserGroupSyncIndex, isGroupEligibleForMlsRecovery } from './groupSyncEligibility';
import { dropGroupState } from './dropGroupState';
import { forgetGroupReconciliation } from './historyReconcile';
import { clearGroupNotReady } from './notReadyRegistry';
import { historyRangeStart, isWithinHistoryRange } from './historyWindow';
import { cachedHistoryStateKey } from './historyStateKey';
import { sendVisibleNotice, type OwnNotice } from './visibleNotices';
import { readerHistorySelection } from './historyEntitlement';
import { mintHistoryRequestId, noteHistoryAsk } from './historyAddressing';
import { treeHoldsUser, userIdOfLeaf } from '$lib/mls-client/leafIdentity';
import {
  buildHistoryDigest,
  chunkIds,
  type HistoryDigest,
  type HistoryEntry,
} from './historyManifest';
import { holdsGroupState } from './groupUsability';
import { groupSkippedByReason, type SkippedDevice } from '$lib/mls-client/skippedKeyPackage';
import { isDeviceTrustRefusal } from '$lib/mls-client/deviceTrust';
import { rebuildableRefusal } from '$lib/mls-client/CommitRefusedError';
import {
  CommitOutcomeUnknownError,
  FollowerTabCommitError,
} from '$lib/mls-client/commitSubmission';
import { readConfirmedTree } from './confirmedTree';
import { anyHistoryWithheldIn, historyWithheldFrom } from './historyWithheld';
import { getTabLeadership } from '$lib/mls-client/tabLeader';
import { MemberRemovalNotCommittedError } from './memberRemovalError';

/**
 * The trust refusals this session already reported, as `deviceId|reason` - a sweep re-derives the
 * same refusal at every pass, and an error repeated at each one is a line its reader learns to skip.
 */
const reportedSkippedRefusals = new Set<string>();

/** Test seam: forgets which skipped-package refusals were already reported. */
export function resetReportedSkippedRefusals(): void {
  reportedSkippedRefusals.clear();
}

/**
 * Reports (log + `console.warn`) devices skipped by `addMembersBulk` because their KeyPackage
 * was invalid/unreadable. Without this, a skipped device would vanish silently: never invited,
 * never retried. Last-resort vs one-time is NOT knowable here (the `LastResort` extension is
 * unreadable until a package validates); the server's `[KP] one-time pool EMPTY` line is its witness.
 * The remedy (republish a fresh KeyPackage then re-add) is deferred;
 * here we at least ensure visibility. [[C5]]
 *
 * @param tag Log prefix of the caller (e.g. `[ADD]`, `[SYNC]`, `[GROUP]`, `[REBOOT]`).
 */
export function warnSkippedKeyPackages(
  skipped: readonly SkippedDevice[],
  groupId: string,
  tag: string,
  log: (msg: string) => void
): void {
  if (skipped.length === 0) return;
  // ONE LINE PER CAUSE: an expired package (wait for its owner to reconnect) and a bad signature
  // (a defect) want opposite fixes, and a count collapsed them.
  for (const { reason, deviceIds } of groupSkippedByReason(skipped)) {
    // A REFUSED IDENTITY OR KEY IS NOT A STALE PACKAGE: republishing cannot lift it, because the
    // package named another device or a key this device never pinned for it (`deviceTrust.ts`).
    if (isDeviceTrustRefusal(reason)) {
      // Said once per device and reason per session; a repeat goes to `debug`.
      const fresh = deviceIds.filter((id) => !reportedSkippedRefusals.has(`${id}|${reason}`));
      if (fresh.length === 0) {
        console.debug(
          `${tag}[TRUST] KeyPackage ${reason} again for ${deviceIds.join(', ')} on ${groupId} (already reported)`
        );
        continue;
      }
      for (const id of fresh) reportedSkippedRefusals.add(`${id}|${reason}`);
      log(
        `${tag} ${fresh.length} device(s) REFUSED (${reason}): ${fresh.join(', ')} - not invited; nothing proves the package is that device's.`
      );
      console.error(
        `${tag}[TRUST] KeyPackage ${reason} for ${fresh.length} device(s) on ${groupId}:`,
        fresh
      );
      continue;
    }
    log(
      `${tag} ${deviceIds.length} device(s) skipped (KeyPackage ${reason}): ${deviceIds.join(', ')} - not invited, republish a fresh KeyPackage.`
    );
    console.warn(
      `${tag}[C5] KeyPackage ${reason} for ${deviceIds.length} device(s) on ${groupId}:`,
      deviceIds
    );
  }
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
      if (!owner) {
        // A DEVICE THAT GOT INTO THE COMMIT AND WILL NEVER GET ITS WELCOME, and it used to leave
        // NOTHING behind. The commit has already moved the epoch for everyone, so this device is in
        // the ratchet tree; without a Welcome it can decrypt nothing, and its owner is never added
        // to `delivered`, so `registerMember` never runs for them either - a member the group thinks
        // it has and who holds no key material. The only trace was arithmetic: `[SYNC]
        // bulk.addedDeviceIds` listing N ids and `[OK] Added ... (M user(s) delivered)` with M
        // short, and nobody subtracts two numbers in a log. Every swallowed branch logs.
        log(`${tag} no owner known for ${did} - added to the commit, Welcome NOT sent`);
        return;
      }
      try {
        await mlsService.sendWelcome(welcome, owner, groupId, did, bulk.ratchetTree);
        delivered.add(owner);
        log(`${tag} Welcome -> ${owner}:${did} OK`);
      } catch (e) {
        log(`${tag} Welcome failed -> ${owner}:${did}: ${String(e)}`);
        console.warn(`${tag} sendWelcome failed for ${owner}:${did}:`, e);
      }
    })
  );
  return delivered;
}

/**
 * The users holding an ACTIVE device row in a group - who the delivery service ROUTES to, deduplicated
 * (a user can have multiple devices). Not who is in the group: see {@link fetchGroupRoster}.
 */
export async function fetchUniqueGroupMembers(mlsService: IMlsService, groupId: string) {
  const members = await mlsService.getGroupMembers(groupId);
  return [...new Set(members.map((m) => m.userId))];
}

/**
 * The people IN a group: its user-level roster (`dm_group_members`), less the seats an invitation
 * link opened that no member has admitted yet. What every surface listing members shows (the group
 * panel, its count, the mention picker, a call's avatars).
 *
 * WHY NOT THE ACTIVE DEVICE ROWS ({@link fetchUniqueGroupMembers}): an Add's commit writes its
 * newcomers' device rows `pending`, and only the NEWCOMER's own client turns them `active`, when it
 * opens its Welcome - on its clock, possibly days later. Read right after the Add, that list held
 * whichever invitee happened to be quick, and the panel then offered no way to remove the others.
 * The roster is written by the adder ITSELF (`registerMember`, awaited before the Add returns), and
 * cut first by every removal and every departure, so it is current the moment either gesture ends.
 */
export async function fetchGroupRoster(
  mlsService: Pick<IMlsService, 'getGroupUserMembers'>,
  groupId: string,
  opts?: { fresh?: boolean }
): Promise<string[]> {
  const rows = await mlsService.getGroupUserMembers(groupId, opts);
  return [...new Set(rows.filter((r) => r.awaitingAdmission !== true).map((r) => r.userId))];
}

/**
 * Deletes an MLS group:
 *  1. Broadcasts "groupDeleted" to all members BEFORE server deletion.
 *  2. Deletes the group server-side (DB + Redis).
 *  3. Forgets the local MLS state.
 *
 * Order 1->2 is critical: deleteGroupOnServer hard-deletes dm_group_members, stripping
 * the server of all routing info. A message sent afterwards would be lost.
 *
 * THE SERVER STEP'S FAILURE LEAVES THIS FUNCTION, and step 2 is the reason DEL-10 kept failing
 * after the mechanism built to fix it shipped. `exitGroupAndCleanup` writes down the owed exit,
 * calls this, and classifies what comes back - a status is an ANSWER, a transport failure is not -
 * and this `try/catch` had already turned "there was no server" into "done", so the classifier
 * never ran and the row it wrote was cleared by the happy path one line later. Measured on prod
 * 2026-08-27: the DELETE left the device, nothing answered it, no `[EXIT]` line was ever logged,
 * both reconnects replayed nothing, and `dm_groups` still held the group as live.
 *
 * The local steps still run unconditionally - a user who cannot leave a group because the network
 * is down would be worse than any of this - so the failure is HELD and rethrown after them rather
 * than aborting them. The only caller owns the decision about what it means.
 */
export async function deleteGroupAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  userId: string;
  deviceKeyB64: string;
  log?: (msg: string) => void;
}): Promise<void> {
  const { mlsService, groupId, userId, log } = params;

  // 1. Notify peers via MLS BEFORE server deletion, and AWAIT ITS ACCEPTANCE (`sendMessage` resolves
  // on the delivery service's answer, not on a queue write). Encryption requires WASM state (group
  // must be local), and routing requires dm_group_members (group must be on server). A failure is
  // lost rather than sent later, for the reason `leaveGroupAndBroadcast` gives: the peers then learn
  // the deletion from the server (a 410 on their next send, the group gone from their next pull).
  if (holdsGroupState(mlsService, groupId)) {
    try {
      // No row of our own: this device drops the conversation below, and our other devices
      // purge it on this frame - no device of ours holds the notice (`sendVisibleNotice`).
      await sendVisibleNotice(mlsService, groupId, 'groupDeleted', { deletedBy: userId });
    } catch (e) {
      const line = `[DELETE] groupDeleted notice for ${groupId.slice(0, 8)}… NOT delivered - deleting without it: ${String(e).slice(0, 120)}`;
      console.warn(line);
      log?.(line);
    }
  }

  // 2. Delete on server. HELD, NEVER SWALLOWED - see this function's doc. A wrapper object rather
  // than a sentinel value, because "no failure" and "a falsy error" must not be the same state.
  let serverExitFailure: { error: unknown } | null = null;
  try {
    await mlsService.deleteGroupOnServer(groupId);
  } catch (e) {
    serverExitFailure = { error: e };
  }

  // 3. Drop the local state - after sending the message (encryption requires MLS state). Without
  // this, the group stays in the deleter's WASM state and keeps appearing in getLocalGroups(),
  // triggering phantom recovery attempts. The checkpoint is awaited, because the caller is told the
  // conversation is gone and a reload must not bring it back.
  await dropGroupState(mlsService, groupId, { reason: 'deleted here', checkpoint: 'awaited', log });

  // 4. Forget any outstanding reconciliation state for this conversation - per-conversation state
  // may not outlive the conversation, and the group we have just deleted cannot answer anything.
  // NOT part of the drop: every other drop keeps the conversation and expects to re-join it.
  forgetGroupReconciliation(groupId);

  // AND ONLY NOW. Every local step above has run, so the caller gets the failure with the purge
  // already done - which is what lets it keep the owed exit without keeping the conversation.
  if (serverExitFailure) throw serverExitFailure.error;
}

/**
 * Renames the group on the server, then broadcasts a "groupRenamed" system message to all members so
 * their UIs update, and writes this device's own notice under the frame's id (`sendVisibleNotice`).
 */
export async function renameGroupAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  newName: string;
  userId: string;
  deviceKeyB64: string;
  /** Where this device writes its own copy of the notice. */
  ownNotice: Omit<OwnNotice, 'actor'>;
}) {
  const { mlsService, groupId, newName, userId, deviceKeyB64, ownNotice } = params;
  await mlsService.renameGroup(groupId, newName);

  // Broadcast the rename notification - best-effort: the local rename is
  // already committed to the server; if the MLS message fails, peers will
  // still see the new name when they next fetch group metadata.
  try {
    await sendVisibleNotice(
      mlsService,
      groupId,
      'groupRenamed',
      { newName },
      { ...ownNotice, actor: userId }
    );
  } catch (e) {
    console.warn(
      `[GROUP] groupRenamed notice for ${groupId.slice(0, 8)}… NOT delivered - the rename stands, the members read it from the group metadata: ${String(e).slice(0, 120)}`
    );
  }
  await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64);
}

/**
 * Sets the group avatar on the server, then broadcasts a "groupImageChanged" system message to all
 * members so their UIs update, and writes this device's own notice under the frame's id. Pass
 * mediaId=null to remove the photo.
 */
export async function setGroupImageAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  mediaId: string | null;
  userId: string;
  deviceKeyB64: string;
  /** Where this device writes its own copy of the notice. */
  ownNotice: Omit<OwnNotice, 'actor'>;
}) {
  const { mlsService, groupId, mediaId, userId, deviceKeyB64, ownNotice } = params;
  await mlsService.setGroupImage(groupId, mediaId);

  // Broadcast the photo change - best-effort: the change is already committed to
  // the server; if the MLS message fails, peers will still see the new photo when
  // they next fetch group metadata via getUserGroups.
  try {
    await sendVisibleNotice(
      mlsService,
      groupId,
      'groupImageChanged',
      { imageMediaId: mediaId },
      { ...ownNotice, actor: userId }
    );
  } catch (e) {
    console.warn(
      `[GROUP] groupImageChanged notice for ${groupId.slice(0, 8)}… NOT delivered - the photo stands, the members read it from the group metadata: ${String(e).slice(0, 120)}`
    );
  }
  await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64);
}

/**
 * Sends an MLS system message to notify a membership change, and resolves once the delivery service
 * has ACCEPTED it - `sendMessage` awaits the `POST /api/mls/send` answer itself, it is not the
 * durable outbox. That is what lets a leave end the membership right after it: the notice is on the
 * server, routed to the members, before the server step that would refuse it.
 *
 * Best-effort, and never silent: a failure is logged and the caller goes on, because a membership
 * change the user asked for must not wait on a notice. Never call after `forgetGroup`.
 */
async function notifyMembershipChange(
  mlsService: IMlsService,
  groupId: string,
  event: 'memberLeft' | 'memberRemoved',
  payload: Record<string, string>,
  log?: (msg: string) => void,
  ownNotice?: OwnNotice
): Promise<void> {
  try {
    await sendVisibleNotice(mlsService, groupId, event, payload, ownNotice);
  } catch (e) {
    const line = `[GROUP] ${event} notice for ${groupId.slice(0, 8)}… NOT delivered, and not sent later - the members see the roster change without it: ${String(e).slice(0, 120)}`;
    console.warn(line);
    log?.(line);
  }
}

/**
 * Removes a member from the MLS group (admin action):
 *  1. Ends the membership on the server (dm_group_members + dm_device_group_memberships, and the
 *     membership interval that makes the removal hold against a later re-add).
 *  2. MLS remove commit - removes the leaf from the tree and advances the epoch for all, REBUILT on
 *     the epoch that beat it when it loses the race (see below).
 *  3. Broadcasts `memberRemoved` to remaining members.
 *
 * **THE SERVER RECORD COMES FIRST, AND A FAILURE THERE ABORTS THE REMOVAL** (user, 2026-10-14: a
 * Remove holds against a later re-add). The record used to be written LAST and best-effort: a
 * failed call left one log line, no exclusion window, and a later re-add was served the whole gap.
 * The window opens on the safe side: it starts BEFORE the commit, so nothing sent between the two can
 * later be served to the member as if they had still been in. And the order is what gates DELIVERY:
 * the record deletes the member's device rows, so no application frame reaches them from that
 * instant, while the server's parting hint (`group:parting`) still queues them the Remove commit
 * that names them. Committing first would leave the removed devices on the fan-out for as long as the
 * record took - or for good if it then failed - with a tree that says they are out.
 *
 * **A LOST RACE IS REBUILT, NOT LEFT TO A SWEEP** (CC-2, 1.4.1 dev campaign, 2026-10-25). Another
 * commit can take the epoch between the record and this commit - an Add, a leaf refresh, another
 * holder's collector - and the gate refuses ours. It used to reach the caller as a logged
 * `CommitRefusedError`: the member off the roster and still in the tree, the person who asked told
 * nothing, and `removeStrayLeaves` finishing the job at some holder's next connection. Now a refusal
 * whose catch-up MOVED the epoch (or an overtaken seat claim, each one an eviction) is staged again
 * on the tree that won - {@link rebuildableRefusal}, the one rule an admission follows too - so the
 * loop ends on a proof, never on a count.
 *
 * **"OUT" IS READ FROM THE TREE, AFTER ANY FAILURE, AND ONLY ONCE THE TREE IS CONFIRMED CURRENT.**
 * Two Removes of one person (CC-3) rarely end in a refusal: the loser waits for the MLS lock while
 * the winner's Remove is applied under it, and then its STAGE fails - openmls finds no leaf
 * (`NoSuchMember`, an untyped error from the platform). So every failure of the commit except an
 * unknown outcome asks the tree again ({@link memberStanding}), and a tree without the member
 * resolves `already-out`, quietly. That answer is trusted only at the server's epoch: a tree behind
 * an Add that re-admitted the member would say "out" of a member still in, so it is caught up first,
 * and a tree that cannot be confirmed is `tree-unconfirmed`, never "out".
 *
 * Every other ending throws {@link MemberRemovalNotCommittedError}, so the caller can say so; the
 * collector still completes it from durable state (roster against tree).
 *
 * **THE `memberRemoved` NOTICE FOLLOWS THE RECORD** (decided 2026-10-25): sent on `committed` AND when
 * the record landed but the commit did not - safe, because the record already cut the removed
 * device's rows - and NOT on `already-out`. So a collector's removal leaves no line, and two gestures
 * can both send one: a `concurrent_commit` that moved nothing is surfaced, not rebuilt, and there may
 * have been no winner at all - a duplicate line is accepted. On an unknown outcome the notice is still
 * attempted: the send settles the kept commit first and is refused only if it is still unanswered
 * (history-reconciliation, "The removal order").
 *
 * **A FOLLOWER TAB IS REFUSED BEFORE THE RECORD**: it may not commit (`FollowerTabCommitError`), and
 * learning that from the commit, after the record, was the half-removal itself.
 */
export async function removeMemberAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  memberId: string;
  userId: string;
  deviceKeyB64: string;
  /** Where this device writes its own copy of the notice. */
  ownNotice: Omit<OwnNotice, 'actor'>;
}): Promise<MemberRemovalOutcome> {
  const { mlsService, groupId, memberId, userId, deviceKeyB64, ownNotice } = params;
  const short = groupId.slice(0, 8);
  // Every `memberRemoved` this device sends, it also holds, under the frame's id
  // (`sendVisibleNotice`) - on `committed` and on a record that landed uncommitted, never on
  // `already-out`, which sends nothing.
  const announce = () =>
    notifyMembershipChange(
      mlsService,
      groupId,
      'memberRemoved',
      { targetUser: memberId },
      undefined,
      { ...ownNotice, actor: userId }
    );

  // 0. Known from leadership, a fact here - never learnt from a commit refused after the record.
  if (getTabLeadership() === 'follower') {
    console.warn(`[REMOVE_MEMBER] ${short}… removal asked of a follower tab - nothing recorded`);
    throw new FollowerTabCommitError(groupId);
  }

  // 1. The server record. Propagates: a removal the server did not record is not a removal yet.
  try {
    await mlsService.removeMemberFromServer(groupId, memberId);
  } catch (e) {
    console.warn(
      `[REMOVE_MEMBER] Server refused or missed the removal in ${short}… - nothing committed, the removal is not done: ${String(e).slice(0, 120)}`
    );
    throw e;
  }

  // 2. MLS remove commit, rebuilt on the epoch that beat it (see above).
  let outcome: MemberRemovalOutcome;
  try {
    outcome = await commitMemberRemoval(mlsService, groupId, memberId, userId);
  } catch (e) {
    // The record stands, so its notice goes (see above), and the caller is told.
    if (e instanceof MemberRemovalNotCommittedError) {
      await announce();
      await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64);
    }
    throw e;
  }

  // 3. Notify remaining members - only when THIS commit removed them (see above) - and write our
  // own notice under the frame's id.
  if (outcome === 'committed') await announce();

  await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64);
  return outcome;
}

/**
 * How a removal the server recorded ended in the tree - both are a COMPLETE removal:
 * - `committed`: this device's Remove commit took the member's leaves out;
 * - `already-out`: the tree, confirmed at the server's epoch, held no leaf of theirs - another
 *   commit (a concurrent Remove of the same person, a holder's collector) removed them, or they
 *   never held one. Not a failure, and never reported as one: a lost race whose goal the winner
 *   reached.
 */
export type MemberRemovalOutcome = 'committed' | 'already-out';

/**
 * Commits the Remove of every leaf of `memberId` in `groupId`, for the reasons
 * {@link removeMemberAndBroadcast} gives.
 *
 * @param actingUserId - this device's user, for the catch-up that confirms a tree current.
 * @returns `committed` when this commit removed them, `already-out` when the confirmed tree holds no
 *   leaf of theirs - before the commit, or after any failure of it.
 * @throws {@link MemberRemovalNotCommittedError} for every other ending.
 */
async function commitMemberRemoval(
  mlsService: IMlsService,
  groupId: string,
  memberId: string,
  actingUserId: string
): Promise<MemberRemovalOutcome> {
  const short = groupId.slice(0, 8);
  const who = memberId.slice(0, 8);
  const standing = () => memberStanding(mlsService, groupId, memberId, actingUserId);
  for (;;) {
    const before = await standing();
    if (before === 'out') {
      console.log(
        `[REMOVE_MEMBER] ${short}… ${who} holds no leaf at epoch ${mlsService.getEpoch(groupId)} - nothing to commit`
      );
      return 'already-out';
    }
    if (before === 'unconfirmed') {
      console.warn(
        `[REMOVE_MEMBER] ${short}… the tree could not be confirmed before the Remove of ${who} - recorded, NOT committed`
      );
      throw new MemberRemovalNotCommittedError(groupId, memberId, 'tree-unconfirmed', before);
    }
    try {
      await mlsService.removeMember(groupId, [memberId]);
      console.log(
        `[REMOVE_MEMBER] ${short}… ${who} removed from the tree, now epoch ${mlsService.getEpoch(groupId)}`
      );
      return 'committed';
    } catch (e) {
      // AN UNKNOWN OUTCOME IS NOT READ FROM THE TREE: the stage is kept and a later settle decides
      // it, so "holds a leaf" now says nothing about whether this very commit lands.
      if (e instanceof CommitOutcomeUnknownError) {
        console.warn(
          `[REMOVE_MEMBER] ${short}… the Remove of ${who} has an unknown outcome - recorded, settled later`
        );
        throw new MemberRemovalNotCommittedError(groupId, memberId, 'commit-not-landed', e);
      }
      const rebuild = rebuildableRefusal(e, mlsService.getEpoch(groupId));
      if (rebuild !== null) {
        console.log(
          `[REMOVE_MEMBER] ${short}… the Remove of ${who} was refused (${rebuild}, now epoch ${mlsService.getEpoch(groupId)}) - re-reading the tree`
        );
        continue;
      }
      // ANY OTHER FAILURE ASKS THE TREE (see `removeMemberAndBroadcast`): a stage that found no leaf
      // and a refusal by the SAME removal both end here with the member already out.
      const after = await standing();
      if (after === 'out') {
        console.log(
          `[REMOVE_MEMBER] ${short}… the Remove of ${who} did not go (${String(e).slice(0, 80)}), and ${who} already holds no leaf - another commit removed them`
        );
        return 'already-out';
      }
      console.warn(
        `[REMOVE_MEMBER] ${short}… the Remove of ${who} did not land and cannot be rebuilt (${String(e).slice(0, 120)}; ${after}) - recorded, NOT committed`
      );
      throw new MemberRemovalNotCommittedError(
        groupId,
        memberId,
        after === 'unconfirmed' ? 'tree-unconfirmed' : 'commit-not-landed',
        e
      );
    }
  }
}

/**
 * What this device's tree says of `memberId`: `holds` a leaf, `out` - confirmed at the server's
 * epoch - or `unconfirmed`. A tree that holds the member needs no confirmation: the commit that
 * follows is decided by the gate. One that does NOT is trusted only once confirmed current, under the
 * MLS lock ({@link readConfirmedTree}, the one helper an Add's device filter uses too).
 */
async function memberStanding(
  mlsService: IMlsService,
  groupId: string,
  memberId: string,
  actingUserId: string
): Promise<'holds' | 'out' | 'unconfirmed'> {
  const reading = await readConfirmedTree(
    mlsService,
    groupId,
    actingUserId,
    '[REMOVE_MEMBER]',
    (identities) => treeHoldsUser(identities, memberId)
  );
  if (reading.status === 'unconfirmed') return 'unconfirmed';
  return treeHoldsUser(reading.identities, memberId) ? 'holds' : 'out';
}

/**
 * Leaves an MLS group (self-removal by the member):
 *  1. Broadcasts `memberLeft` to other members (before any deletion -
 *     WASM state must be valid to encrypt the message).
 *  2. Removes from the server registry (dm_group_members + dm_device_group_memberships).
 *  3. Forgets the group locally to avoid leaving an orphan leaf in
 *     getLocalGroups() that would trigger phantom recovery attempts.
 *
 * Unlike `removeMemberAndBroadcast`, this function generates no MLS remove commit, and it cannot:
 * a departing member is exactly the party that may not commit its own eviction. So the leaf stays
 * in every remaining member's tree - holding key material for a conversation its owner has walked
 * out of - and only a REMAINING member can collect it. `removeStrayLeaves` is that collector, run
 * by every holder on every connection off the same loop as the stale-base repair; the server-side
 * half below is immediate and needs no client.
 *
 * STEP 2'S FAILURE LEAVES THIS FUNCTION TOO - the same seam as `deleteGroupAndBroadcast`, which
 * carries the reasoning. The local exit is unconditional and completes first; whether the server
 * performed its half is `exitGroupAndCleanup`'s to classify, and only it can decide whether the
 * device still owes one.
 *
 * **STEP 2 WAITS FOR THE NOTICE'S DELIVERY, NOT ITS WRITE** - `notifyMembershipChange` resolves on
 * the delivery service's acceptance, so the notice is routed before the membership ends. The 403 the
 * GRP-6 row recorded on 2026-10-22 was NOT this notice: it was another entry of the same group in
 * the durable outbox (a read watermark queued as the leaver closed the conversation), which
 * `exitGroupAndCleanup` now settles (sends, or withdraws what cannot go) before calling this.
 *
 * **A NOTICE THAT FAILS IS LOST, NOT SENT LATER, AND THE LEAVE GOES ON.** It cannot be queued: a
 * frame needs this device's MLS state and its membership, and step 3 and step 2 remove exactly those -
 * the outbox would hold a frame no flush can ever send. Holding the leave until the notice goes would
 * keep a user in a group they asked to leave for as long as the network is down, which the exit
 * forbids (see `deleteGroupAndBroadcast`). What the others lose is the visible "X left" line only:
 * the roster stops naming the leaver at once (the server half, replayed by the owed exit when it
 * failed too), and `removeStrayLeaves` collects the leaf on a remaining member's next connection.
 */
export async function leaveGroupAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  userId: string;
  deviceKeyB64: string;
  log?: (msg: string) => void;
}): Promise<void> {
  const { mlsService, groupId, userId, log } = params;

  // 1. Notify BEFORE server deletion (WASM must be intact to encrypt), and AWAIT ITS ACCEPTANCE:
  // the server step below ends the membership, and a frame posted after it is refused. No row of
  // our own: none of our devices draws our own departure (`sendVisibleNotice`).
  // A failure is logged there and the leave goes on - see this function's doc for why it is lost.
  await notifyMembershipChange(mlsService, groupId, 'memberLeft', { userId }, log);

  // 2. Clean the server registry. HELD AND RETHROWN BELOW, for the reason
  // `deleteGroupAndBroadcast` documents at length: this bare catch was the same defect with no log
  // at all, so a leave that met no server was indistinguishable from one the server confirmed.
  let serverExitFailure: { error: unknown } | null = null;
  try {
    await mlsService.removeMemberFromServer(groupId, userId);
  } catch (e) {
    serverExitFailure = { error: e };
  }

  // 3. Drop the local state. Awaited, for the reason `deleteGroupAndBroadcast` gives: the user has
  // been told they left, and a reload must not put them back in a group they can no longer read.
  await dropGroupState(mlsService, groupId, { reason: 'left by us', checkpoint: 'awaited', log });

  // The local exit is complete either way; whether the SERVER performed its half is the caller's
  // to classify, and a 403/404 is one of the answers it reads as done.
  if (serverExitFailure) throw serverExitFailure.error;
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
    await persistMlsStructuralCheckpoint({ mlsService });
  } catch (e) {
    log?.(`[MLS] saveState failed after mutation: ${String(e)}`);
  }
}

/**
 * Drops one group from the in-memory WASM/OpenMLS state when the server no longer lists it.
 *
 * THE TREE AND THE DISTRIBUTION REGISTRATION GO TOGETHER, OR THE PREDICATE OUTLIVES THE GROUP.
 * A bare `forgetGroup` leaves the group's entry in `knownDistributionGroups`, which then answers
 * "this carries seeds" about state this device no longer holds - and the reconciliation sweep,
 * which spares a seed carrier by design, would spare that entry on every later load for ever.
 * `forgetDistributionGroupById` drops the pair, and for a group registered as nothing it is exactly
 * a {@link dropGroupState} with the same held-check in front of it.
 *
 * @returns true when the group was dropped. The MLS state is already durable by then - the drop
 *   checkpoints - so this answers "did anything change", not "is a save owed".
 */
export async function forgetMlsGroupIfPresent(
  mlsService: IMlsService,
  groupId: string,
  log?: (msg: string) => void
): Promise<boolean> {
  try {
    if (!(await mlsService.forgetDistributionGroupById(groupId))) return false;
    log?.(`[MLS] forgetGroup ${groupId} (absent from server)`);
    return true;
  } catch (e) {
    log?.(`[MLS] forgetGroup failed for ${groupId}: ${String(e)}`);
    return false;
  }
}

/**
 * Removes a sidebar / IndexedDB conversation row only (no MLS mutation).
 * Safe to call even when WASM no longer knows the groupId.
 *
 * `userId` names the account whose recovery marker goes with the row: see the comment on
 * `clearGroupNotReady` below.
 */
export async function purgeLocalConversationRecord(params: {
  conversations: Map<string, Conversation>;
  contactKey: string;
  groupId: string;
  userId: string;
  deleteConversation?: (key: string) => Promise<void>;
  log?: (msg: string) => void;
}): Promise<void> {
  const { conversations, contactKey, groupId, userId, deleteConversation, log } = params;
  localStorage.removeItem(`discovery_pending:${groupId}`);
  // Same reason as the `discovery_pending` key above, and the same lifetime: per-conversation local
  // state may not outlive the conversation. This one was user-visible when it did.
  forgetGroupReconciliation(groupId);
  // THE RECOVERY MARKER IS THE IDENTITY OF EVERY LATER RE-ADD, AND IT DIES WITH THE ROW (ADM-2,
  // 2026-10-25). The SYNC_WATCHDOG enumerates the not-ready registry, which is persisted, so a
  // marker written while an invitation-link ask waited survived discovery removing the declined
  // ask: the next pass - after a reload, 27 s later - re-created the placeholder, tried an external
  // join the server refused (403) and left the conversation listed as `removed`. Every caller of
  // this function drops the row because the server no longer lists this account in the group, so no
  // recovery is owed for it. The in-memory cooldown (`lastReAddAt`) is a throttle, schedules
  // nothing, and stays.
  clearGroupNotReady(userId, groupId);
  if (deleteConversation) {
    // Best-effort, never silent: a row left in the local store comes back at the next restore.
    await deleteConversation(contactKey).catch((e: unknown) =>
      log?.(
        `[UI] Local conversation ${groupId} dropped from memory, but its stored row could not be deleted: ${String(e).slice(0, 120)}`
      )
    );
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
  const mlsChanged = await forgetMlsGroupIfPresent(mlsService, groupId, log);
  if (mlsChanged) {
    await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);
  }
  await purgeLocalConversationRecord({ ...uiParams, groupId, userId, log });
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
    // The authors' own signatures, so the reader takes the message, the edit and the deletion from
    // their authors rather than from this relayer (history-reconciliation, authorship). A deleted
    // message relays its signed tombstone and never its original bytes.
    ...(m.authorship && !m.isDeleted ? { authorship: m.authorship } : {}),
    ...(m.editProof && !m.isDeleted ? { editProof: m.editProof } : {}),
    ...(m.deleteProof ? { deleteProof: m.deleteProof } : {}),
    // A row this device holds only as unverified is relayed as such. Without it the reader would
    // take the row on THIS device's word - as its author's own, when it names this device's user -
    // and one relay hop would erase the mark (`relayerVouches` in restoredAuthorship.ts). Not the
    // bundle-level `vouched` flag retired below: this one is per row and says less, not more.
    ...(m.restoredUnverified ? { authorUnproven: true } : {}),
  };
}

/**
 * Builds one `history_bundle` frame.
 *
 * **WHY EVERY BUNDLE CARRIES A `to`.** `to` is the requester's `digestIdentity` - user AND device,
 * because a user with three devices must be able to solicit from one of them and be answered on that
 * one. Since step A the frame is also ROUTED to that device alone (`recipientDevices`, see
 * {@link sendBundleChunks}); `to` stays in the payload because MLS still encrypts it for the whole
 * group, and an older server still broadcasts it. Neither is a secrecy boundary.
 *
 * **`requestId`, `last` and `join` are what the receiver checks an ADDRESSED answer against**
 * (`historyAddressing.ts`): the ask it answers (absent on the inviter's push, which `join` names),
 * and the chunk that closes that ask.
 *
 * The ratchet cost of addressing - a non-recipient skips the sender's generations - is bounded by
 * `maximum_forward_distance` (2 000) over CONSECUTIVE addressed frames, i.e. one answer of 400 000
 * messages (docs/wiki/protocols/history-answer-addressing.md).
 *
 * There is no `vouched` flag any more, and its absence is the point. It existed to tell a durable
 * marker whether it might be discharged - "I compared my whole store and you are complete" as
 * opposed to "our stores merely look the same". Nothing carries a marker now: the comparison is
 * re-run on the next connection, so an answer no longer has to certify anything about the future.
 */
function bundleFrame(
  messages: unknown[],
  to: string,
  opts: { state?: ConversationHistoryState; answer?: BundleAnswer; last?: boolean } = {}
): Uint8Array {
  const { state, answer, last } = opts;
  return encodeAppMessage(
    mkSystem(
      'history_bundle',
      JSON.stringify({
        messages,
        to,
        ...(answer?.requestId ? { requestId: answer.requestId } : {}),
        ...(answer?.join ? { join: true } : {}),
        ...(last ? { last: true } : {}),
        // The conversation's own state - read watermarks and the shared history floor. A handful of
        // numbers, sent whole with every frame because both merges are `max` and therefore free to
        // repeat. Sending them once would make their delivery depend on which chunk survived.
        ...(state?.readWatermarks ? { readWatermarks: state.readWatermarks } : {}),
        ...(state?.historyFloor ? { floor: state.historyFloor } : {}),
        // Restated by every chunk like the two above, and for the same reason: sending it once
        // would make it depend on which chunk survived. Merged per entry on `at`, so repeating it
        // is free in exactly the way a `max` is.
        ...(state?.pins?.length ? { pins: state.pins } : {}),
      })
    )
  );
}

/**
 * Which ask a bundle answers: the asker's `requestId`, or `join` for the inviter's push, which nobody
 * asked an id for - the receiver's own admission solicited it (`historyAddressing.ts`).
 */
type BundleAnswer = { requestId?: string; join?: boolean };

/** What a conversation carries beyond its messages, and what every bundle restates. */
type ConversationHistoryState = {
  readWatermarks?: ReadWatermarks;
  historyFloor?: number;
  /**
   * The pin register - every message this conversation has pinned OR unpinned, with its date.
   *
   * A pin is CONVERSATION state, like the watermarks beside it, and it belongs here for the same
   * reason the edit time does on a message: the `pin` frame that created it ages out of the
   * server's retention window while the pin itself does not, so a device that arrives later can
   * replay every frame it is entitled to and still never learn the message is pinned.
   *
   * **The unpins travel too, and that is what makes the merge symmetric.** Sending only what is
   * currently pinned would let a device holding a stale pin keep it for ever: the answerer's
   * `unpin` is precisely the entry its snapshot omits, so there would be nothing to beat it with.
   */
  pins?: Array<{ id: string; pinned: boolean; at: number }>;
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
    // The pin register is not on the row: it is device-local state keyed by the same group id,
    // which is precisely why it needed carrying at all.
    const pins = pinEntries(groupId);
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
  // Not even the state-only frame (its floor and watermarks) goes to a withheld device.
  if (await historyWithheldAfterSettling(groupId, to, mlsService, log)) {
    log(
      `[HISTORY_BUNDLE] ${to} entered ${groupId.slice(0, 8)}... unvouched - no history pushed to it until a member vouches for it`
    );
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
  // A group with no messages can still have read state, a floor and pins worth handing over - and
  // so can one whose every message was withheld, or whose exclusion windows could not be read: the
  // invitee has no conversation row yet, and this frame is what gives it one. It carries no message.
  // ADDRESSED like the rest of the push when the server routes it (step A), and closing the `join`
  // ask; broadcast when the windows could not be read, since nothing then says which - exactly the
  // frame this was before step A, and it carries no message.
  const sendStateOnly = async (why: string, addressed: boolean): Promise<void> => {
    if (
      !addressed &&
      (await anyHistoryWithheldIn(groupId, () => mlsService.getGroupMemberIdentities(groupId)))
    ) {
      log(
        `[HISTORY_BUNDLE] Not broadcasting the state-only frame in ${groupId.slice(0, 8)}... - a device there is withheld (${why})`
      );
      return;
    }
    const bytes = bundleFrame([], to, { state, answer: { join: true }, last: true });
    try {
      await mlsService.sendMessage(
        groupId,
        bytes,
        undefined,
        addressed ? addressedHistoryAnswer(to) : DELIVERY.transport
      );
      log(
        `[HISTORY_BUNDLE] Empty bundle sent for ${groupId.slice(0, 8)}… (${why})${addressed ? `, addressed to ${to}` : ''}`
      );
    } catch (e) {
      if (e instanceof AddressedUnsupportedError) {
        log(
          `[HISTORY_BUNDLE] ${to} cannot be addressed in ${groupId.slice(0, 8)}… (offline, or a session of it predates addressed answers) - pushing it nothing`
        );
        return;
      }
      log(`[HISTORY_BUNDLE] Empty bundle send error: ${String(e).slice(0, 120)}`);
    }
  };
  if (messages.length === 0) {
    // No chunk will read the windows, so the one read that decides how this frame is routed is here.
    const mode = await readerHistorySelection(
      groupId,
      [],
      { mlsService, log },
      userIdOfLeaf(to),
      true
    );
    await sendStateOnly('group has no history', mode?.mode === 'addressed');
    return;
  }

  // ADDRESSED TO THE INVITEE AND FILTERED ON THEIR OWN WINDOWS (step A; user, 2026-10-21: a new
  // member of a group conversation reads nothing from before their arrival). The push is sent
  // to the invitee's device alone and carries that reader's own span. A 1:1 has no span (the server's
  // rule).
  const outcome = await sendBundleChunks(
    groupId,
    messages,
    { mlsService, log },
    { chunkSize, to, state, answer: { join: true }, push: true }
  );
  if (outcome.kind === 'refused') return;
  if (outcome.kind === 'unreadable') {
    await sendStateOnly('exclusion windows unreadable - no message carried', false);
    return;
  }
  if (outcome.kind === 'withheld-all') {
    await sendStateOnly('every message withheld', outcome.addressed);
    return;
  }
  log(`[HISTORY_BUNDLE] Full history sent: ${outcome.count} of ${messages.length} message(s)`);
}

/**
 * Whether `to` is withheld in `groupId`, read only AFTER every device event already merged has been
 * decided (`settleDeviceEvents`): an answer scheduled in the drain that carried an unvouched entry
 * must not read the record before that entry wrote it. A settle that fails is logged and the record
 * read as it stands.
 */
async function historyWithheldAfterSettling(
  groupId: string,
  to: string,
  mlsService: IMlsService,
  log: (msg: string) => void
): Promise<boolean> {
  try {
    await mlsService.settleDeviceEvents('history answer');
  } catch (e) {
    log(
      `[HISTORY_BUNDLE] device events not settled before answering in ${groupId.slice(0, 8)}...: ${String(e).slice(0, 120)}`
    );
  }
  return historyWithheldFrom(groupId, to);
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
 *
 * **AND IT IS WHERE ENTITLEMENT IS APPLIED** (user, 2026-10-14 and 2026-10-21): every selection passes
 * through {@link readerHistorySelection} before a frame is built, so no answer path - full, diff or
 * scrollback - can carry a message sent while its reader was out of the group, or before they arrived.
 *
 * **AND WHERE IT IS ADDRESSED** (step A, docs/wiki/protocols/history-answer-addressing.md): when the
 * server routes addressed answers, every chunk goes to `to` alone (`recipientDevices`) and is filtered
 * on that reader's windows. An addressed answer that names no ask (`requestId`, or `join` on the
 * push) is not sent - the receiver would refuse it, and the sender's ratchet would have spent a
 * generation every other member skips for nothing. A device the server cannot address (a session of
 * it predates the capability) is sent nothing: an addressed answer is never turned into a broadcast.
 *
 * @returns the {@link BundleOutcome} - whether anything could be sent, and how much was.
 */
async function sendBundleChunks(
  groupId: string,
  selection: StoredMessage[],
  { mlsService, log }: HistorySendDeps,
  {
    chunkSize,
    to,
    state,
    answer,
    push = false,
  }: {
    chunkSize: number;
    to: string;
    state?: ConversationHistoryState;
    /** The ask this answers - see {@link BundleAnswer}. */
    answer?: BundleAnswer;
    /** The inviter's push - its legacy broadcast form adds the reader's span to the union. */
    push?: boolean;
  }
): Promise<BundleOutcome> {
  // HISTORY IS WITHHELD FROM AN UNVERIFIED DEVICE (`historyWithheld.ts`): whatever the answer path,
  // nothing from before is given to a device that let itself in until a member vouches for it.
  if (await historyWithheldAfterSettling(groupId, to, mlsService, log)) {
    log(
      `[HISTORY_BUNDLE] ${to} entered ${groupId.slice(0, 8)}... unvouched - no history answered to it until a member vouches for it`
    );
    return { kind: 'refused' };
  }
  // THE WINDOWS ARE READ AGAIN FOR EVERY CHUNK. A long answer spans seconds of network, and a
  // member re-added in the meantime decrypts every chunk sealed after their add commit - so the
  // windows that filter a chunk are the ones in force when THAT chunk leaves, never the ones read
  // when the answer began. Concurrent reads of one group share one request (`joinInFlight`).
  const reader = userIdOfLeaf(to);
  const totalChunks = Math.ceil(selection.length / chunkSize);
  let sent = 0;
  let read = false;
  let addressed = false;
  for (let i = 0; i < selection.length; i += chunkSize) {
    const chunkNo = Math.floor(i / chunkSize) + 1;
    const chosen = await readerHistorySelection(
      groupId,
      selection.slice(i, i + chunkSize),
      { mlsService, log },
      reader,
      push
    );
    if (chosen === null) {
      if (!read) return { kind: 'unreadable' };
      log(
        `[HISTORY_BUNDLE] Chunk ${chunkNo}/${totalChunks} not sent - exclusion windows unreadable; stopping after ${sent} message(s)`
      );
      return { kind: 'sent', count: sent };
    }
    read = true;
    addressed = chosen.mode === 'addressed';
    // A BROADCAST IS READ BY EVERY LEAF, a withheld device's included (`historyWithheld.ts`): while
    // one is withheld here, an answer that cannot be addressed is not sent at all.
    if (
      !addressed &&
      (await anyHistoryWithheldIn(groupId, () => mlsService.getGroupMemberIdentities(groupId)))
    ) {
      log(
        `[HISTORY_BUNDLE] Not broadcasting history in ${groupId.slice(0, 8)}... - a device there is withheld, and a broadcast would reach it`
      );
      return sent === 0 ? { kind: 'refused' } : { kind: 'sent', count: sent };
    }
    if (addressed && !answer?.requestId && !answer?.join) {
      log(
        `[HISTORY_BUNDLE] Not answering ${to} in ${groupId.slice(0, 8)}… - its ask carries no request id (an older client), and an addressed answer to no ask is refused`
      );
      return { kind: 'refused' };
    }
    if (chosen.kept.length === 0) continue;
    const payload = chosen.kept.map(serializeForBundle);
    const last = i + chunkSize >= selection.length;
    const bytes = bundleFrame(payload, to, { state, answer, last });
    try {
      await mlsService.sendMessage(
        groupId,
        bytes,
        undefined,
        addressed ? addressedHistoryAnswer(to) : DELIVERY.transport
      );
      sent += payload.length;
      log(
        `[HISTORY_BUNDLE] Chunk ${chunkNo}/${totalChunks} - ${payload.length} msg → ${groupId.slice(0, 8)}…${addressed ? ` (addressed to ${to})` : ' (broadcast)'}`
      );
    } catch (e) {
      if (e instanceof AddressedUnsupportedError) {
        log(
          `[HISTORY_BUNDLE] ${to} cannot be addressed in ${groupId.slice(0, 8)}… (offline, or a session of it predates addressed answers) - answering nothing rather than broadcasting`
        );
        return sent === 0 ? { kind: 'refused' } : { kind: 'sent', count: sent };
      }
      log(`[HISTORY_BUNDLE] Chunk send error ${chunkNo}: ${String(e)}`);
      return { kind: 'sent', count: sent };
    }
  }
  if (sent === 0) {
    log(
      `[HISTORY_BUNDLE] Every message selected for ${groupId.slice(0, 8)}… was withheld - no message sent`
    );
    return { kind: 'withheld-all', addressed };
  }
  return { kind: 'sent', count: sent };
}

/**
 * What {@link sendBundleChunks} did: no window could be read (nothing sent), every message was
 * withheld (nothing sent; `addressed` says how the last read said to route), the reader could not be answered at all (an addressed answer to no ask,
 * or a device the server cannot address - nothing sent, and nothing must be sent in its place), or
 * `count` messages went out before the end or the first failed chunk.
 */
type BundleOutcome =
  | { kind: 'unreadable' }
  | { kind: 'withheld-all'; addressed: boolean }
  | { kind: 'refused' }
  | { kind: 'sent'; count: number };

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
 * The first leg of a reconciliation: the state key - or, when this device holds NOTHING for the
 * group, its digest straight away.
 *
 * WHY THE DIGEST FIRST FOR AN EMPTY STORE. Its state key can only be answered two ways: an equally
 * empty peer stays silent, and every other peer answers "describe yourself"
 * (`history_digest_request`), to which this device sends the digest it could have sent at once.
 * The digest of an empty store is as small as a key, and a responder answers a digest probe
 * directly (`handleHistoryRequest`, its last branch, since `v0.14.0`), so the exchange is ONE round
 * trip instead of two. That is the common shape after a sign-in: the device rejoins every group with
 * nothing stored, and each extra leg arrived as its own drain and its own full checkpoint (Mi 9T,
 * 2026-10-13: ~4 checkpoints per rejoined group, 247 in 432 s).
 *
 * A store that holds anything keeps the state key: there, agreement is likely and costs one frame
 * where a digest costs a walk on both sides. A count that cannot be read is not "empty", so it also
 * keeps the state key, which reads the store itself and says so when it cannot.
 *
 * @returns what the leg it chose returned - `false` when nothing went out.
 */
export async function sendHistoryProbe(
  groupId: string,
  from: string,
  deps: HistoryStoreDeps
): Promise<boolean> {
  const { storage, log } = deps;
  let held: number | null = null;
  if (storage) {
    try {
      held = await storage.countMessages(groupId);
    } catch (e) {
      log(
        `[HISTORY_STATE] Could not count ${groupId.slice(0, 8)}…: ${String(e).slice(0, 120)} - describing it by its state key`
      );
    }
  }
  if (held === 0) return sendHistoryDigest(groupId, from, deps);
  return sendHistoryStateKey(groupId, from, deps);
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
 * Tells the asker where this device's completeness BEGINS, when that is later than the instant it
 * asked from.
 *
 * **This is the fact that makes "the answer was shorter than I asked for" decidable.** A phone
 * asking from five years back and a browser keeping ninety days will produce a clipped answer every
 * single time, by construction and not by fault. Without this frame the asker sees only an absence,
 * and an absence cannot be told apart from "the conversation has no more history" - so it either
 * believes itself complete, or re-asks the same peer for ever. Neither terminates on anything.
 *
 * The responder KNOWS its own window. Making the asker discover it by failing is exactly the shape
 * the durable rule forbids, so the discriminator is carried from where it is already known.
 *
 * **Sent LAST and only when narrower.** Last, because MLS orders one sender's frames: everything the
 * responder could give has already been sent when this lands, so it reads as *"that is all, and I am
 * complete only from here"*. Only when narrower, because silence must keep meaning *"I cover what
 * you asked"* - two devices of the same platform are the common case and must still cost one frame.
 */
export async function sendHistoryCoverage(
  groupId: string,
  answer: { from: string; to: string; since: number; coveredFrom: number },
  { mlsService, log }: HistorySendDeps
): Promise<void> {
  const bytes = encodeAppMessage(mkSystem('history_coverage', JSON.stringify({ ...answer })));
  try {
    await mlsService.sendMessage(groupId, bytes, undefined, DELIVERY.transport);
    log(
      `[HISTORY_COVERAGE] Told ${answer.to} we are complete only from ${new Date(answer.coveredFrom).toISOString()} in ${groupId.slice(0, 8)}…`
    );
  } catch (e) {
    // Losing this leaves the asker believing the answer covered its window - which is the state this
    // frame exists to end - so it is never swallowed silently.
    log(
      `[HISTORY_COVERAGE] Could not state our coverage to ${answer.to} for ${groupId.slice(0, 8)}…: ${String(e).slice(0, 120)}`
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
  // The ask is recorded BEFORE it leaves, under the id the frame carries: an addressed answer is
  // accepted only against it (`historyAddressing.ts`), and it can arrive before the send resolves.
  const requestId = mintHistoryRequestId();
  noteHistoryAsk(groupId, requestId, {
    kind: 'range',
    since: request.since,
    before: request.before,
    askedAt: Date.now(),
  });
  const bytes = encodeAppMessage(
    mkSystem('history_range', JSON.stringify({ ...request, requestId }))
  );
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
  // Recorded before it leaves - see `sendHistoryRangeRequest`. The answer to a digest is the diff
  // the responder computes, bounded by the `since` stated here.
  const requestId = mintHistoryRequestId();
  noteHistoryAsk(groupId, requestId, { kind: 'digest', since, askedAt: Date.now() });
  const bytes = encodeAppMessage(
    mkSystem('history_digest', JSON.stringify({ from, digest, since, requestId }))
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
    // One ask per frame, each bounded by exactly what it names - see `sendHistoryRangeRequest`.
    const requestId = mintHistoryRequestId();
    noteHistoryAsk(groupId, requestId, {
      kind: 'pull',
      since,
      ids: (payload.ids as string[] | undefined) ?? [],
      prefixes: (payload.prefixes as string[] | undefined) ?? [],
      depth: payload.depth as number | undefined,
      askedAt: Date.now(),
    });
    const bytes = encodeAppMessage(
      mkSystem('history_pull', JSON.stringify({ ...payload, requestId }))
    );
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
 * **`since` is required, and has no default.** It used to fall back to 0 - answer in full - so that
 * an ask stating no window still got served. Nothing reaches this without one: every ask carries it,
 * and the one path that genuinely has no window to state pushes {@link sendFullHistoryBundle}
 * instead, which is a different function. A default here could therefore only ever have hidden a
 * malformed frame, and `0` is a legitimate window, so it hid it as a normal answer.
 */
export async function sendHistoryBundleForIds(
  groupId: string,
  ids: readonly string[],
  deps: HistoryStoreDeps,
  opts: {
    to: string;
    chunkSize?: number;
    since: number;
    /** The `requestId` of the ask this answers - echoed so the asker can accept it addressed. */
    requestId?: string;
  }
): Promise<void> {
  const { storage, mlsService, log } = deps;
  const { to, chunkSize = 200, since, requestId } = opts;
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
  const outcome = await sendBundleChunks(
    groupId,
    selected,
    { mlsService, log },
    { chunkSize, to, state, answer: { requestId } }
  );
  if (outcome.kind !== 'sent') return;
  log(
    `[HISTORY_BUNDLE] Diff sent for ${groupId.slice(0, 8)}…: ${outcome.count} of ${wanted.size} requested message(s)`
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
  opts: {
    to: string;
    before: number;
    limit: number;
    since?: number;
    /** The `requestId` of the range ask this answers. */
    requestId?: string;
  }
): Promise<void> {
  const { storage, mlsService, log } = deps;
  const { to, before, limit, since = 0, requestId } = opts;
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
  const outcome = await sendBundleChunks(
    groupId,
    page,
    { mlsService, log },
    { chunkSize: 200, to, state, answer: { requestId } }
  );
  if (outcome.kind !== 'sent') return;
  log(
    `[HISTORY_RANGE] Sent ${outcome.count} of ${inRange.length} message(s) older than ${new Date(before).toISOString()} for ${groupId.slice(0, 8)}…`
  );
}

export type { HistoryDigest };
