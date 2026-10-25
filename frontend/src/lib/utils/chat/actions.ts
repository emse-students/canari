import { exportBackup, importBackup } from '$lib/backup';
import { formatRecoveryCode } from '$lib/crypto/backupRecoveryCode';
import {
  clearBackupOwedAfterKeyMove,
  deviceRecoveryCode,
  keepDeviceRecoveryCode,
  type RecoveryCodeOrigin,
} from '$lib/crypto/deviceRecoveryCode';
import { fromHex, saveMlsState, hasMlsState, exportMlsStateAsHex } from '$lib/utils/hex';
import type { IStorage } from '$lib/db';
import type { IMlsService } from '$lib/mlsService';
import type { Conversation } from '$lib/types';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import {
  sendFullHistoryBundle,
  sendHistoryDigestRequest,
  sendHistoryRangeBundle,
  historyStateKeyFor,
  persistMlsStateAfterMutation,
  purgeLocalConversationRecord,
  isGroupActiveOnServer,
} from '$lib/utils/chat/groupActions';
import {
  awaitProbe,
  digestIdentity,
  DIGEST_TTL_MS,
  noteDigestSolicited,
} from '$lib/utils/chat/historyDigestRendezvous';
import { answerHistoryDigest, stateOurCoverage } from '$lib/utils/chat/historyDiffAnswer';
import { pendingGroupExitIds } from '$lib/utils/chat/pendingGroupExits';
import { welcomeSentAt } from '$lib/utils/chat/welcomeSent';
import { ensureConversationForServerGroup } from '$lib/utils/chat/serverGroupConversation';
import { retireConversation } from '$lib/utils/chat/conversations';
import {
  refusalIsTemporary,
  refusalRetiresInvitation,
  type DeviceKeyPackage,
} from '$lib/mls-client/deviceKeyPackage';
import {
  classifyServerStatus,
  decideAbsentGroupFate,
  isDistributionGroupMeta,
  type GroupServerStatus,
} from '$lib/utils/chat/groupLifecycle';
import {
  forgetGroupsAbsentFromServer,
  readGroupSweepSnapshot,
  type AbsentGroupVerdicts,
} from '$lib/utils/chat/groupSweep';
import { saveBlobAs } from '$lib/utils/fileDownload';
import { holdsGroupState } from '$lib/utils/chat/groupUsability';
import { isCommitRaceRefusal } from '$lib/mls-client/CommitRefusedError';
import { AddAbortedError, rebuildOnRace } from './commitRace';
import { readConfirmedTree, type TreeReading } from './confirmedTree';
import { sameDeviceIdentity, treeHoldsDevice, treeHoldsUser } from '$lib/mls-client/leafIdentity';
import {
  DeviceTrustRefusedError,
  isDeviceTrustRefusal,
  reportDeviceTrustRefusal,
  verdictAdmits,
} from '$lib/mls-client/deviceTrust';
import type { PendingInvitationRow } from '$lib/mls-client/mlsDeliveryApi';
import {
  isRefusedDevice,
  recordRefusedDevice,
  reportRefusedDeviceSkipped,
} from '$lib/mls-client/refusedDevices';
import { isNeverAdmitted, syncAdmissionFlags } from './admissionState';

/**
 * A device asking to join, as an AUTOMATIC Add has to see it - the approval a member gives to bring
 * a new person in, raised with {@link handleWelcomeRequest} and {@link processPendingInvitations}.
 */
export interface JoinApprovalRequest {
  groupId: string;
  requesterUserId: string;
  requesterDeviceId: string;
  /**
   * The ask's identity, the id of the seat its link wrote, as the server row or frame raising it
   * named it (`askId`): an ask the server settled is never raised again (`joinRequests.svelte.ts`).
   */
  askId?: string;
}

/**
 * Whether an AUTOMATIC Add may bring `userId`'s device into `groupId`, read from OUR tree.
 *
 * Both automatic adders act on what the delivery service says - a `pending` row, a roster row, a
 * relayed `welcome_request` - and a delivery service under hostile control writes all three. What it
 * cannot write is this device's ratchet tree. So the one question deciding an Add nobody asked for
 * is answered there: a user who already holds a leaf is a member, and this is their new or
 * recovering device (`member-device`); a user who holds none is a new person (`newcomer`), and
 * bringing a new person in is a member's gesture - `inviteMembersToGroup`, or approving the join -
 * never a reaction to a server row.
 *
 * `unreadable`: the tree could not be read, which proves no membership, so the caller adds nothing
 * and asks no one - another member, or the next sweep, answers.
 *
 * `confirmed` hands it a reading of the tree CONFIRMED at the server's epoch
 * ({@link readConfirmedTree}) instead of the local one: a tree behind a Remove still holds the
 * removed person, and an Add decided on it re-admits someone a member just took out. A reading that
 * could not be confirmed is `unreadable`.
 */
type AutomaticAdmission = 'member-device' | 'newcomer' | 'unreadable';

async function automaticAdmission(deps: {
  mlsService: Pick<IMlsService, 'getGroupMemberIdentities'>;
  groupId: string;
  userId: string;
  /** The caller's log tag, so the line reads in the sequence it belongs to. */
  tag: string;
  log: (message: string) => void;
  confirmed?: TreeReading;
}): Promise<AutomaticAdmission> {
  const { mlsService, groupId, userId, tag, log, confirmed } = deps;
  if (confirmed !== undefined) {
    if (confirmed.status === 'unconfirmed') {
      log(
        `${tag} Tree of ${groupId.slice(0, 8)}... not confirmed at the server's epoch, cannot say whether ${userId} is a member - nothing added`
      );
      return 'unreadable';
    }
    return treeHoldsUser(confirmed.identities, userId) ? 'member-device' : 'newcomer';
  }
  try {
    const identities = await mlsService.getGroupMemberIdentities(groupId);
    return treeHoldsUser(identities, userId) ? 'member-device' : 'newcomer';
  } catch (e) {
    log(
      `${tag} Tree of ${groupId.slice(0, 8)}... unreadable, cannot say whether ${userId} is a member - nothing added: ${String(e).slice(0, 100)}`
    );
    return 'unreadable';
  }
}

/** What every automatic Add of one group rests on, as one read of the server gives it. */
interface PendingAddFacts {
  /** The tree, confirmed at the server's epoch - or not. */
  tree: TreeReading;
  /** The pending rows the server still holds, or why they could not be read. */
  rows: PendingInvitationRow[] | { unreadable: string };
}

/**
 * Reads {@link PendingAddFacts} for one attempt of one row's Add.
 *
 * THE TREE IS READ ONCE PER PASS OF A GROUP, not once per row (round 3 of #2416): confirming it costs
 * a commit-log read under the global MLS lock, and every row of a group is judged against the same
 * tree until an epoch moves. A pass is an epoch: an Add (or the commit that beat it) moves it and the
 * next row reads afresh; a REBUILD always reads afresh (`fresh`), since an overtaken seat claim
 * rebuilds without moving it.
 *
 * THE PENDING LIST IS READ ON EVERY ATTEMPT, never cached (round 4): a removal deletes the pending row
 * BEFORE its commit lands, so that deletion moves no epoch - a list kept for the pass would tell row
 * B, staged after row A, that a device being removed is "still pending", and re-admit it.
 */
function pendingAddFactsOf(deps: {
  mlsService: IMlsService;
  groupId: string;
  userId: string;
  myDeviceId: string;
}): (fresh: boolean) => Promise<PendingAddFacts> {
  const { mlsService, groupId, userId, myDeviceId } = deps;
  let pass: { epoch: number; tree: Promise<TreeReading> } | null = null;
  return async (fresh) => {
    const epoch = mlsService.getEpoch(groupId);
    if (fresh || pass === null || pass.epoch !== epoch) {
      // Always confirmed: the one read serves every row, whichever user each names.
      pass = {
        epoch,
        tree: readConfirmedTree(mlsService, groupId, userId, '[PENDING]', () => false),
      };
    }
    const tree = await pass.tree;
    const rows = await mlsService
      .getPendingInvitations(userId, myDeviceId)
      .catch((e: unknown) => ({ unreadable: String(e).slice(0, 100) }));
    return { tree, rows };
  };
}

/**
 * What an automatic Add of a pending device rests on, re-checked in EVERY pass of its Add
 * (`rebuildOnRace`) - the commit that won a race may be the Remove of the very person:
 * - the user is still a MEMBER, read from the tree confirmed at the server's epoch
 *   ({@link automaticAdmission} on the confirmed reading) - a removed person is a new person again,
 *   and only a member's gesture brings one in;
 * - the pending row is still on the server - a removal deletes it, and an Add answering a row that
 *   is gone answers nobody.
 *
 * Read by {@link pendingAddFactsOf}: the tree once per pass of the group, the list on every attempt.
 *
 * @throws {@link AddAbortedError} when either no longer holds, or cannot be read: nothing is staged
 *   and nothing registered.
 */
async function confirmPendingAddPremise(deps: {
  mlsService: IMlsService;
  groupId: string;
  inv: PendingInvitationRow;
  facts: PendingAddFacts;
  log: (message: string) => void;
}): Promise<void> {
  const { mlsService, groupId, inv, facts, log } = deps;
  const admission = await automaticAdmission({
    mlsService,
    groupId,
    userId: inv.userId,
    tag: '[PENDING]',
    log,
    confirmed: facts.tree,
  });
  if (admission === 'unreadable') {
    throw new AddAbortedError(groupId, 'tree-unconfirmed', `membership of ${inv.userId} unknown`);
  }
  if (admission === 'newcomer') {
    throw new AddAbortedError(
      groupId,
      'not-a-member-device',
      `${inv.userId} holds no leaf at the server's epoch`
    );
  }
  if (!Array.isArray(facts.rows)) {
    throw new AddAbortedError(groupId, 'premise-unreadable', facts.rows.unreadable);
  }
  const stillPending = facts.rows.some(
    (r) =>
      r.groupId === groupId &&
      r.userId === inv.userId &&
      r.deviceId === inv.deviceId &&
      r.status === 'pending'
  );
  if (!stillPending) {
    throw new AddAbortedError(
      groupId,
      'invitation-withdrawn',
      `the pending row of ${inv.deviceId} is gone from the server`
    );
  }
}

/**
 * Puts a NEW PERSON's ask to this device's member ("X asks to join") - ONLY FOR A GROUP
 * CONVERSATION, read off its conversation row.
 *
 * The ask's two answers are a group's: Add is `inviteMembersToGroup`, which only a group takes, and
 * Decline removes the person's roster row. Raised for anything else they are wrong on both counts:
 * a 1:1 conversation's `pending` rows are written for every group of a registering user, DMs
 * included, so a peer holding no leaf there raised an ask whose Add always failed and whose Decline
 * deleted the peer's own roster row of the DM. A key group has no conversation row at all - its
 * members enter by external commit, entitled by their community. And a row not loaded yet answers
 * nothing: the next sweep asks again, once the row is there.
 *
 * In none of those is the new person added either: an automatic Add never brings one in.
 *
 * AND ONLY FOR AN ASK THE SERVER HOLDS (`isAsk`, the row's `awaitingAdmission`): a person absent
 * from the tree whose seat is not an invitation link's ask - a member's invite between its roster
 * write and its Add, a seat written before the rule, a member whose leaves were removed - asked
 * nobody anything, and a Decline would find nothing to withdraw (`not-awaiting`). Such a person is
 * brought in by a member's own invite, never by an ask raised in their name.
 */
function askAMemberToAdmit(
  conversations: ReadonlyMap<string, Conversation>,
  request: JoinApprovalRequest,
  isAsk: boolean | undefined,
  tag: string,
  log: (message: string) => void,
  onJoinApprovalRequested: ((request: JoinApprovalRequest) => void) | undefined
): boolean {
  const short = request.groupId.slice(0, 8);
  if (isAsk !== true) {
    log(
      `${tag} ${request.requesterUserId} has no leaf in ${short}... - not added, and nobody is asked: ` +
        `their seat is not an invitation-link ask (a member's invite in flight, or a seat older than the rule)`
    );
    return false;
  }
  const convo = conversations.get(request.groupId);
  const kind = convo ? (convo.conversationType ?? 'group') : null;
  if (kind !== 'group') {
    log(
      `${tag} ${request.requesterUserId} has no leaf in ${short}... - not added, and nobody is asked: ` +
        `${kind === null ? 'no conversation row is loaded for it' : `a ${kind} conversation`} takes no join ask`
    );
    return false;
  }
  log(
    `${tag} ${request.requesterUserId} has no leaf in ${short}... - a new person is not added automatically, a member's approval is asked`
  );
  onJoinApprovalRequested?.(request);
  return true;
}

/** An ask as the server announces it to every online admitted member (`group.join_ask`). */
export interface AnnouncedJoinAsk {
  groupId: string;
  /** The ask's identity, the id of the seat its link wrote. */
  askId: string;
  requesterUserId: string;
  requesterDeviceIds: string[];
}

/**
 * Raises the ask the server ANNOUNCED to every online admitted member (`group.join_ask`), so a member
 * sees it live rather than at its next pending-invitation sweep - any admitted member may answer.
 *
 * The announcement is the server's word that the seat is an invitation-link ask, as the `pending`
 * rows and the roster are ({@link askAMemberToAdmit}'s `isAsk`). What it cannot say is whether the
 * person already holds a leaf, which is read from THIS device's tree - a person a member already
 * added is not asked about. It adds nobody: this is the human-visible ask, and only a member's Add
 * brings the person in. One entry per (group, person) in the store, so the elected member's
 * `welcome_request` and the sweep raising the same ask make one entry; and an ask the server already
 * settled (`askId`) is not raised however late this lands.
 */
export async function raiseAnnouncedJoinAsk(params: {
  mlsService: Pick<IMlsService, 'getGroupMemberIdentities'>;
  conversations: ReadonlyMap<string, Conversation>;
  ask: AnnouncedJoinAsk;
  log: (msg: string) => void;
  onJoinApprovalRequested?: (request: JoinApprovalRequest) => void;
}): Promise<void> {
  const { mlsService, conversations, ask, log, onJoinApprovalRequested } = params;
  const admission = await automaticAdmission({
    mlsService,
    groupId: ask.groupId,
    userId: ask.requesterUserId,
    tag: '[JOIN_ASK]',
    log,
  });
  if (admission === 'unreadable') return;
  if (admission === 'member-device') {
    log(
      `[JOIN_ASK] ${ask.requesterUserId} already holds a leaf in ${ask.groupId.slice(0, 8)}... - a member's Add came first, nothing to ask`
    );
    return;
  }
  const [first, ...others] = ask.requesterDeviceIds;
  if (first === undefined) {
    log(`[JOIN_ASK] the ask of ${ask.requesterUserId} names no device - nothing to raise`);
    return;
  }
  const request = { groupId: ask.groupId, requesterUserId: ask.requesterUserId, askId: ask.askId };
  const asked = askAMemberToAdmit(
    conversations,
    { ...request, requesterDeviceId: first },
    true,
    '[JOIN_ASK]',
    log,
    onJoinApprovalRequested
  );
  // The person's other devices join the same entry; the decision above was the person's, not theirs.
  if (asked) {
    for (const deviceId of others) {
      onJoinApprovalRequested?.({ ...request, requesterDeviceId: deviceId });
    }
  }
}

/**
 * Whether `userId:deviceId`'s leaf is in OUR copy of `groupId`'s ratchet tree.
 *
 * THE TREE IS THE AUTHORITY ON WHO IS IN A GROUP, and the two callers of this used to ask the
 * delivery service instead - `getGroupMembers`, which is the ROUTING table. `member_identities`'
 * own Rustdoc names that exact misuse: "a reconciliation deciding whether a leaf still belongs
 * must read this, never the routing table", and both callers are precisely such a reconciliation.
 *
 * The two answers diverge on the case both callers exist to handle. A device fresh-start clears
 * its routing rows while the tree stays full, so the routing table reports "not a member" of a
 * leaf that is sitting right there. The Add then goes out, OpenMLS declines the duplicate leaf,
 * and the caller learns by failing what the tree could have told it for free - which is the
 * `[RUST::WARN] Skipping KeyPackage already a member of the group` the campaign saw on GRP-5
 * (2026-08-23) and GRP-3 (2026-08-24), both times looking like a 1-in-5 flake. It is also a
 * network round-trip on a question whose answer is local, durable and already loaded.
 *
 * THREE ANSWERS, NOT TWO, for the same reason as {@link readLocalMembership}. `null` is "we cannot
 * say": this device does not hold the group, so the tree that would answer does not exist here.
 * Neither caller may read that as "not a leaf" without saying so out loud, so the branch logs -
 * under the CALLER's tag, because which decision it was about to inform is the useful part.
 */
async function leafIsInLocalTree(deps: {
  mlsService: Pick<IMlsService, 'getGroupMemberIdentities'>;
  groupId: string;
  userId: string;
  deviceId: string;
  /** The caller's log tag, so the line reads in the sequence it belongs to. */
  tag: string;
  log: (message: string) => void;
}): Promise<boolean | null> {
  const { mlsService, groupId, userId, deviceId, tag, log } = deps;
  try {
    const identities = await mlsService.getGroupMemberIdentities(groupId);
    // The WHOLE identity, never a bare device id: leaves are `userId:deviceId`, so a suffix or
    // substring test would let one id answer for another's. Compared under the ONE canonical
    // identity Rust binds and pins by, so a leaf Rust takes for this device is never read as absent
    // here - that would send an Add Rust then refuses.
    return treeHoldsDevice(identities, userId, deviceId);
  } catch (e) {
    log(
      `${tag} Tree of ${groupId.slice(0, 8)}... unreadable, cannot say whether ${deviceId.slice(0, 12)}... is a leaf: ${String(e).slice(0, 100)}`
    );
    return null;
  }
}

/**
 * Confirms to the server that an invitation is fulfilled because the device's leaf is already in our
 * tree - the vouch the server endpoint authorises ("adds no new authority"). Best-effort: a failure
 * leaves the row pending and the next sync says so again.
 */
function vouchInvitationFulfilled(
  mlsService: Pick<IMlsService, 'updateInvitationStatus'>,
  inv: { userId: string; deviceId: string },
  groupId: string,
  log: (message: string) => void
): void {
  mlsService
    .updateInvitationStatus(inv.deviceId, inv.userId, groupId, 'active')
    .catch((e: unknown) =>
      log(
        `[PENDING] ${inv.deviceId} in tree for ${groupId} but the vouch failed: ${String(e).slice(0, 120)}`
      )
    );
}

/**
 * Whose leaf carries the key an Add of `userId:deviceId` was refused as a DUPLICATE of.
 *
 * The refusal says the key is in the tree, never whose leaf holds it, and a tree that merely
 * CONTAINS this identity does not say the duplicate is its leaf: assuming so would vouch for, or
 * replace, a device on another device's key. So the tree is asked for the leaf carrying the
 * package's key (`leafHoldingKeyOf`), and only that leaf being this identity's makes it ours.
 *
 * - `this`: the key is this identity's own leaf - the invitation is fulfilled, or the leaf is
 *   repaired in ONE commit.
 * - `another`: another identity's leaf carries it - nothing is vouched, replaced or removed.
 * - `nowhere`: no leaf carries it any more (the tree moved since the refusal), and `unreadable`: the
 *   tree or the package could not be read - a destructive action is never taken on doubt.
 */
type DuplicateKeyHolder =
  | { kind: 'this' }
  | { kind: 'another'; holder: string }
  | { kind: 'nowhere' }
  | { kind: 'unreadable' };

async function duplicateKeyHolder(deps: {
  mlsService: Pick<IMlsService, 'leafHoldingKeyOf'>;
  groupId: string;
  keyPackage: Uint8Array;
  userId: string;
  deviceId: string;
  /** The caller's log tag, so the line reads in the sequence it belongs to. */
  tag: string;
  log: (message: string) => void;
}): Promise<DuplicateKeyHolder> {
  const { mlsService, groupId, keyPackage, userId, deviceId, tag, log } = deps;
  try {
    const holder = await mlsService.leafHoldingKeyOf(groupId, keyPackage);
    if (holder === null) return { kind: 'nowhere' };
    return sameDeviceIdentity(holder, `${userId}:${deviceId}`)
      ? { kind: 'this' }
      : { kind: 'another', holder };
  } catch (e) {
    log(
      `${tag} Cannot say whose leaf holds the duplicate key of ${deviceId.slice(0, 12)}... in ${groupId.slice(0, 8)}...: ${String(e).slice(0, 100)}`
    );
    return { kind: 'unreadable' };
  }
}

/**
 * Says why an Add refused as a duplicate signature key is NOT repaired here, from the holder lookup
 * that decided it ({@link duplicateKeyHolder}).
 *
 * A duplicate under the SAME identity is repaired by replacing that identity in one commit (or, for
 * a pending invitation, is already fulfilled). Here the key sits on ANOTHER identity's leaf, which no
 * legitimate flow produces - a device that changes id starts from a fresh state and a fresh key - so
 * that is an ERROR line of its own, and nothing is vouched, replaced or removed: the leaf holding it
 * is not this request's to touch. `nowhere` and `unreadable` are doubt, said at WARN, and the next
 * request decides.
 */
function reportDuplicateKeyNotRepaired(
  tag: string,
  groupId: string,
  identity: string,
  found: DuplicateKeyHolder
): void {
  if (found.kind === 'another') {
    console.error(
      `${tag} DUPLICATE KEY HELD BY ANOTHER DEVICE: the package for ${sanitizeLogIdentity(identity)} carries the key of ${sanitizeLogIdentity(found.holder)}'s leaf in ${groupId.slice(0, 8)}... - not vouched, not replaced, nothing removed`
    );
    return;
  }
  const why = {
    this: 'it is still its own leaf after a refused replace',
    nowhere: 'no leaf carries it now',
    unreadable: 'its holder is unreadable',
  }[found.kind];
  console.warn(
    `${tag} Duplicate signature key for ${sanitizeLogIdentity(identity)} in ${groupId.slice(0, 8)}... and ${why} - nothing removed, the next request decides`
  );
}

/** Shortens `userId:deviceId` for a log line the way the other lines of these paths do. */
function sanitizeLogIdentity(identity: string): string {
  const [user = '', device = ''] = identity.split(':');
  return `${user.slice(0, 8)}:${device.slice(0, 12)}`;
}

/**
 * Process pending device-group invitations.
 *
 * New paradigm: ANY online device of ANY group member can add a pending device.
 * This eliminates deadlocks - the first device to reconnect handles all pending
 * invitations for groups it belongs to.
 *
 * Flow:
 * 1. Fetch all pending invitations from server (devices waiting to join groups this device is in)
 * 2. For each pending device, acquire add-lock → addMember → sendWelcome → update status
 * 3. On WrongEpoch: check if someone else already handled it → skip
 *
 * @returns whether the sweep read the server's pending rows - `false` when it could not, so a
 *   caller settling what the sweep raised (`settleSweptJoinRequests`) settles nothing.
 */
export async function processPendingInvitations(params: {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  deviceKeyB64: string;
  conversations: Map<string, Conversation>;
  /**
   * The single recovery seam (`requestReAdd`), injected the way the outbox takes it.
   *
   * THIS PASS CAN DISCOVER THAT **THIS** DEVICE HOLDS NO STATE, and it used to answer that with a
   * bare `sendWelcomeRequest`: no self-service external join - the PRIMARY path, and the only one
   * that needs nobody online - no `readWelcomeOwed` (so it could race a member's in-flight Add into
   * the duplicate leaf that GRP-4 named), and no throttle, on a pass that runs on every connection.
   * It is a callback rather than an import because `RecoveryDeps` carries selection and persistence
   * hooks this function has no business knowing about.
   */
  requestReAdd: (groupId: string) => Promise<void>;
  log: (msg: string) => void;
  /**
   * A pending device whose USER holds no leaf in our tree is a new person, never added from a server
   * row (`automaticAdmission`): this asks a member to approve the join instead. The row is left as
   * it is - the approval, or the next sweep, is what answers it.
   */
  onJoinApprovalRequested?: (request: JoinApprovalRequest) => void;
}): Promise<boolean> {
  const {
    mlsService,
    storage,
    userId,
    deviceKeyB64,
    conversations,
    requestReAdd,
    log,
    onJoinApprovalRequested,
  } = params;

  const myDeviceId = mlsService.getDeviceId();

  // 1. Fetch pending invitations for groups where this device is a full member
  let pendingInvitations: PendingInvitationRow[];
  try {
    pendingInvitations = await mlsService.getPendingInvitations(userId, myDeviceId);
  } catch (e) {
    log(`[PENDING] Error fetching pending invitations: ${e}`);
    return false;
  }

  if (pendingInvitations.length === 0) return true;

  log(`[PENDING] ${pendingInvitations.length} pending invitation(s) to process`);

  // Group by groupId for sequential processing per group (avoids epoch races within a group)
  const byGroup = new Map<string, typeof pendingInvitations>();
  for (const inv of pendingInvitations) {
    const list = byGroup.get(inv.groupId) ?? [];
    list.push(inv);
    byGroup.set(inv.groupId, list);
  }

  let totalWelcomes = 0;

  for (const [groupId, invitations] of byGroup) {
    // "Ready to invite" = conversation active AND group present in local WASM.
    // After a recovery forgetGroup, the conversation stays active but the group
    // has left WASM: calling addMember would loop on "Group not found". We fall into the
    // not-ready branch (recovery welcome_request already in flight).
    const readyForInvites =
      conversations.get(groupId)?.lifecycle === 'active' && holdsGroupState(mlsService, groupId);
    if (!readyForInvites) {
      // Group not ready locally. If completely absent (not even an active:false placeholder),
      // send a welcome_request. A placeholder indicates the Welcome may already be in transit
      // from the queue - do not resend.
      const isAbsent = !conversations.has(groupId);
      if (isAbsent) {
        const active = await isGroupActiveOnServer(mlsService, userId, groupId);
        if (active === false) {
          log(`[PENDING] Group ${groupId} deleted or absent from server - cleaning up invitations`);
          for (const inv of invitations) {
            mlsService.deleteDeviceMembership(inv.userId, inv.deviceId, groupId).catch(() => {});
          }
        } else {
          // Group present on server but absent from local WASM -> the recovery seam, which decides
          // between joining ourselves and asking a member. The SYNC_WATCHDOG keeps re-driving it
          // until the group is back, and the seam owns all the pacing.
          requestReAdd(groupId).catch((e: unknown) =>
            log(`[PENDING] Group ${groupId} recovery request failed: ${String(e).slice(0, 120)}`)
          );
          log(`[PENDING] Group ${groupId} absent locally -> recovery requested`);
        }
      } else {
        log(`[PENDING] Group ${groupId}: local conversation not ready - skip`);
      }
      continue;
    }

    // Acquire distributed lock to prevent concurrent Add commits (the server's ADD_LOCK_TTL_SEC
    // covers the worst case mobile: bulk add + Argon2 + commit + Welcomes, H1).
    const lockAcquired = await mlsService.acquireAddLock(groupId).catch(() => false);
    if (!lockAcquired) {
      log(`[PENDING] Group ${groupId}: lock held by another device - skip`);
      continue;
    }

    try {
      // ── Add pending devices ───────────────────────────────────────────────
      // Only 'pending' status exists now (stale removed - RFC 9420).
      const currentPending = invitations.filter((inv) => inv.status === 'pending');
      // The server state every Add of this group is judged against, read once per pass.
      const pendingAddFacts = pendingAddFactsOf({ mlsService, groupId, userId, myDeviceId });

      for (const inv of currentPending) {
        const admission = await automaticAdmission({
          mlsService,
          groupId,
          userId: inv.userId,
          tag: '[PENDING]',
          log,
        });
        if (admission === 'unreadable') continue;
        if (admission === 'newcomer') {
          askAMemberToAdmit(
            conversations,
            {
              groupId,
              requesterUserId: inv.userId,
              requesterDeviceId: inv.deviceId,
              ...(inv.askId ? { askId: inv.askId } : {}),
            },
            inv.awaitingAdmission,
            '[PENDING]',
            log,
            onJoinApprovalRequested
          );
          continue;
        }
        // A DEVICE THIS ONE REFUSED FOR A CHANGED KEY IS NOT FETCHED AGAIN: every package it has
        // carries the same key, so a fetch would only spend one. The row stays (it is this member's
        // judgement), and the line names who can lift it (`refusedDevices.ts`).
        if (
          await isRefusedDevice(
            { userId, deviceId: myDeviceId },
            inv.userId,
            inv.deviceId,
            mlsService
          )
        ) {
          reportRefusedDeviceSkipped('[PENDING]', groupId, inv.userId, inv.deviceId);
          continue;
        }
        // The package the Add is built from, kept for the catch: a duplicate key is attributed by
        // asking which leaf carries THIS package's key (`duplicateKeyHolder`).
        let packageAdded: Uint8Array | null = null;
        try {
          // Fetch fresh KeyPackage for the pending device. fetchUserDevices only returns
          // devices active within the last 30 days; fall back to fetchDeviceKeyPackage for
          // older ones.
          // Best-effort (`.catch(() => [])`) : a network error here must not short-circuit
          // the fetchDeviceKeyPackage fallback below (empty list => try the fallback).
          const devices = await mlsService.fetchUserDevices(inv.userId).catch(() => []);
          let targetDevice: DeviceKeyPackage | undefined = devices.find(
            (d) => d.deviceId === inv.deviceId
          );
          if (!targetDevice) {
            const answer = await mlsService.fetchDeviceKeyPackage(inv.userId, inv.deviceId);

            // NOTHING WAS ESTABLISHED, SO NOTHING IS RETIRED. A status code is an answer and a
            // transport failure is not - and this seam read both as "the device was deregistered"
            // and DELETED the pending membership on it. One bad minute on one endpoint could
            // retire an invitation that was perfectly valid. The row stays; the next sweep asks
            // again, which is what a retry is for.
            if (answer.kind === 'unanswered') {
              log(
                `[PENDING] Device ${inv.deviceId}: the server did not answer (${answer.detail}) - ` +
                  `invitation kept, next sweep retries`
              );
              continue;
            }

            // A REASON THIS BUILD CANNOT JUDGE RETIRES NOTHING. Retiring is destructive, so only
            // the allowlisted refusals do it; an `unrecognized` one keeps the row and the next
            // sweep asks again (the delivery client warned once about the unknown reason itself).
            if (answer.kind === 'none' && !refusalRetiresInvitation(answer.reason)) {
              log(
                `[PENDING] Device ${inv.deviceId}: refusal (${answer.reason}) this build cannot judge - ` +
                  `invitation kept, next sweep retries`
              );
              continue;
            }

            if (answer.kind === 'none') {
              // AND WHEN IT DID ANSWER, THE ANSWER NAMES ITS CAUSE. All three retire the row -
              // this device cannot be added right now and asking again this boot cannot change
              // that - but `expired` comes BACK on its own: the device mints a fresh package on
              // its next connection and `registerDevice` re-creates this very membership for every
              // group its owner is in. Reporting that as "deregistered" is what made a temporary
              // condition read as a permanent one in every log that recorded it.
              log(
                refusalIsTemporary(answer.reason)
                  ? `[PENDING] Device ${inv.deviceId} has no usable KeyPackage (${answer.reason}) ` +
                      `-> cleanup; it returns by itself when it next connects`
                  : `[PENDING] Device ${inv.deviceId} cannot be added (${answer.reason}) -> cleanup`
              );
              mlsService.deleteDeviceMembership(inv.userId, inv.deviceId, groupId).catch(() => {});
              continue;
            }

            targetDevice = answer.device;
            log(`[PENDING] KeyPackage retrieved via fallback for ${inv.deviceId} (> 30 days)`);
          }

          // Idempotence: if the device's leaf is already in the MLS tree, the invitation is
          // fulfilled - SKIP regardless of server status. Never kick here.
          //
          // An offline device will join via its already-queued Welcome when it reconnects;
          // a device that has truly lost its state will itself emit a welcome_request
          // (signal-driven path, with anti-livelock limiter in handleWelcomeRequest).
          // Proactively kicking a valid leaf is purely harmful: it inflates the epoch on
          // every sync, invalidates the queued Welcome (device receives a stale Welcome
          // -> re-welcome_request -> churn) and resends the history bundle for nothing. This
          // was the cause of repeated kick+re-add cycles on every reconnect for offline peer
          // devices (status stuck at 'pending' because they never confirm 'active').
          // Read the TREE, not the routing table - see `leafIsInLocalTree`. `=== true` because a
          // tree we could not read is not a "no": it falls through to the Add exactly as the
          // swallowed catch here used to, but says so first.
          const alreadyALeaf = await leafIsInLocalTree({
            mlsService,
            groupId,
            userId: inv.userId,
            deviceId: inv.deviceId,
            tag: '[PENDING]',
            log,
          });
          if (alreadyALeaf === true) {
            // AND THE ROW IS RETIRED, NOT JUST SKIPPED. Skipping answered this sync and left the
            // `pending` row exactly as it found it, so every member of the group re-derived the
            // same answer on every sync, for ever: production held 104 pending rows across 47
            // groups on 2026-09-15, 98 of them older than a day and 19 thirteen days old, and one
            // client's own startup trace spent 25 of its 31 invitations printing this line.
            //
            // The server has authorised this vouch since the endpoint was written - its docblock
            // says a member confirming a fulfilled invitation "adds no new authority; it only
            // stops getPendingInvitations from re-serving a device provably already in the tree
            // every sync" - and no caller was ever written for it. The authority argument holds
            // here specifically: this same local tree read is ALREADY trusted for the more
            // dangerous decision, which is not to Add. Vouching risks nothing the skip does not.
            //
            // Best-effort and re-driven: a failure leaves the row pending and the next sync says
            // this again, which is exactly today's behaviour.
            vouchInvitationFulfilled(mlsService, inv, groupId, log);
            log(
              `[PENDING] ${inv.deviceId} already in tree for ${groupId} - invitation fulfilled, vouching`
            );
            continue;
          }

          // One staged transaction (C7-A): stage the Add, validate the epoch server-side, then
          // merge + broadcast on accept (excluding the inviter self and the newly-welcomed device)
          // or roll back on reject. A rejected commit throws WITHOUT advancing the local epoch (no
          // fork) and is handled by the outer catch as a benign retryable failure; the Welcome is
          // only sent once the commit is accepted. [[C7]]
          //
          // A LOST RACE IS REBUILT ON PROVEN PROGRESS (`rebuildOnRace`, the rule every gesture
          // shares): the refusal's catch-up moved the epoch, so the Add is staged again on the tree
          // that won. One that proved nothing reaches the catch below, and the row stays pending.
          // EVERY PASS RE-CHECKS THE PREMISE FIRST (`confirmPendingAddPremise`): the commit that won
          // may be the Remove of this very person, and a rebuild must never re-admit them.
          packageAdded = targetDevice.keyPackage;
          const device = targetDevice;
          const result = await rebuildOnRace(
            mlsService,
            groupId,
            `the pending Add of ${inv.deviceId}`,
            async (attempt) => {
              await confirmPendingAddPremise({
                mlsService,
                groupId,
                inv,
                facts: await pendingAddFacts(attempt > 0),
                log,
              });
              return mlsService.addMember(
                groupId,
                { keyPackage: device.keyPackage, userId: inv.userId, deviceId: inv.deviceId },
                [`${inv.userId}:${inv.deviceId}`]
              );
            },
            log
          );

          // Register member on server (upsert GroupMember row), keeping server state up to date.
          await mlsService.registerMember(groupId, inv.userId);

          // Send the Welcome + post-merge ratchet tree to the newly added device.
          if (result.welcome) {
            await mlsService.sendWelcome(
              result.welcome,
              inv.userId,
              groupId,
              inv.deviceId,
              result.ratchetTree
            );
            totalWelcomes++;
            log(`[PENDING] Welcome → ${inv.deviceId} (user: ${inv.userId}) for ${groupId}`);
          }

          // Save MLS state after the merged commit (crash-safety).
          await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);

          // The new member has joined at our epoch via the Welcome; send the full history bundle
          // (APPLICATION MESSAGES, not a commit, so it does not go through validateCommit). [[C8]]
          await sendFullHistoryBundle(groupId, {
            storage,
            deviceKeyB64,
            mlsService,
            log,
            to: digestIdentity(inv.userId, inv.deviceId),
          }).catch((e) =>
            log(`[HISTORY_BUNDLE] History send error to ${inv.userId}: ${String(e)}`)
          );
        } catch (e) {
          // A REFUSED KEY IS NOT A RETRYABLE FAILURE AND RETIRES NOTHING: the package names
          // another device, or this device's key changed with nothing to prove it. The row stays,
          // because the refusal is this member's judgement and not a fact about the device.
          if (e instanceof DeviceTrustRefusedError) {
            reportDeviceTrustRefusal('[PENDING]', groupId, e);
            await recordRefusedDevice({ userId, deviceId: myDeviceId }, e, mlsService);
            continue;
          }
          // THE PREMISE WENT BEFORE ANY STAGE: nothing committed, nothing registered, no history.
          // The row is left as the server holds it - the next sweep reads it again, or finds it gone.
          if (e instanceof AddAbortedError) {
            log(
              `[PENDING] Add of ${inv.deviceId} to ${groupId.slice(0, 8)}... abandoned before its stage (${e.why}) - nothing committed`
            );
            continue;
          }
          const errStr = String(e);

          // Device already a member: invitation fulfilled (its leaf is already in our MLS tree).
          // Promote the invitation to active so the server stops re-serving this stale pending
          // row on every sync (root cause of the repeated "already a member" reprocessing every
          // login). Best-effort; on failure it is simply retried next cycle. Do not kick.
          if (errStr.includes('ALREADY_MEMBER')) {
            void mlsService
              .updateInvitationStatus(inv.deviceId, inv.userId, inv.groupId, 'active')
              .catch(() => {});
            log(
              `[PENDING] ${inv.deviceId} already a member of ${groupId.slice(0, 8)}... - invitation fulfilled, marked active`
            );
            continue;
          }

          if (errStr.includes('DuplicateSignatur')) {
            log(`[PENDING] ${inv.deviceId} already in MLS tree of ${groupId}`);
            // NOTHING IS KICKED, AND NO COMMIT IS MADE. The tree is asked WHOSE leaf carries the
            // package's key: this identity's, and the invitation is fulfilled - the `alreadyALeaf`
            // case above, which never repairs a valid leaf (a device that really lost its state asks
            // by welcome_request, and that path replaces it in ONE commit). Any other leaf, and
            // there is nothing this invitation may vouch for or remove.
            const found: DuplicateKeyHolder = packageAdded
              ? await duplicateKeyHolder({
                  mlsService,
                  groupId,
                  keyPackage: packageAdded,
                  userId: inv.userId,
                  deviceId: inv.deviceId,
                  tag: '[PENDING]',
                  log,
                })
              : { kind: 'unreadable' };
            if (found.kind === 'this') {
              vouchInvitationFulfilled(mlsService, inv, groupId, log);
            } else {
              reportDuplicateKeyNotRepaired(
                '[PENDING]',
                groupId,
                `${inv.userId}:${inv.deviceId}`,
                found
              );
            }
          } else if (
            // The server's refusal is TYPED (`isCommitRaceRefusal`: `epoch_mismatch` AND
            // `concurrent_commit`, one race seen at two instants - CC-4 lost an Add to the second);
            // `WrongEpoch` is openmls's own error, raised inside the WASM engine with no type
            // crossing that boundary.
            isCommitRaceRefusal(e) ||
            errStr.includes('WrongEpoch')
          ) {
            // Transient concurrent race (gap 1): another device committed simultaneously.
            // Check if the invitation is already fulfilled; otherwise let the next cycle retry
            // (the missing commit arrives via the queue and we catch up on our own).
            log(`[PENDING] WrongEpoch for ${inv.deviceId} in ${groupId} - checking...`);
            try {
              const memberships = await mlsService.getDeviceMemberships(inv.userId, inv.deviceId);
              const m = memberships.find((x) => x.groupId === groupId);
              if (m?.status === 'active') {
                log(`[PENDING] ${inv.deviceId} already active - skip`);
                continue;
              }
            } catch (statusErr) {
              // The status read is what would have told us the invitation was already fulfilled;
              // without it the WrongEpoch below is reported as non-recoverable and retried next
              // cycle, which is correct but indistinguishable from a genuinely stuck add unless
              // the reason the check never ran is said out loud.
              log(
                `[PENDING] Membership status of ${inv.deviceId} unreadable: ${String(statusErr).slice(0, 100)}`
              );
            }
            // Say what THIS branch knows, which is the WrongEpoch race its own comment describes:
            // the epoch moved under the Add, the invitation is still pending, the next sweep
            // retries. It called itself "Non-recoverable error" and was neither - and a line that
            // overstates its severity teaches its reader to discount the tag, which `[PENDING]`
            // cannot afford across eighteen lines. The raw error text is dropped with the name: it
            // was what carried this line into the classifier's generic `epoch` rule, so a rule can
            // now be anchored and exact instead of depending on how long an error string was.
            log(
              `[PENDING] Epoch moved under the Add for ${inv.deviceId} in ${groupId} - invitation still pending, next sweep retries`
            );
          } else {
            log(`[PENDING] Add error for ${inv.deviceId} to ${groupId}: ${errStr.slice(0, 100)}`);
          }
        }
      }
    } finally {
      await mlsService.releaseAddLock(groupId).catch(() => {});
    }
  }

  if (totalWelcomes > 0) {
    log(`[PENDING] ${totalWelcomes} Welcome(s) sent.`);
  }
  return true;
}

/**
 * Force re-processing of pending device invitations.
 * Clears any stale local MLS autosave so the next reload starts fresh.
 */
export function forceSyncReset(_userId: string, log: (msg: string) => void) {
  log(`[SYNC] Forced reset. Reload the page to restart pending invitation processing.`);
}

/**
 * Discovers missing groups.
 *
 * Creates local placeholders for server groups absent from the client
 * (Welcome lost, new device, etc.) and immediately drops local groups
 * absent from the server (when the server list was successfully fetched).
 *
 * IMPORTANT: the unique identifier is the pair (userId, deviceId).
 * A given userId can have multiple devices - never use userId alone
 * to identify a participant or a leaf node.
 */
export async function discoverMissingGroups(params: {
  mlsService: IMlsService;
  userId: string;
  deviceKeyB64: string;
  conversations: Map<string, Conversation>;
  saveConversation?: (key: string) => Promise<void>;
  deleteConversation?: (key: string) => Promise<void>;
  log: (msg: string) => void;
  /** Optional: IndexedDB access to verify messages have been migrated before purge. */
  storage?: IStorage | null;
  /**
   * The answers the connection sync of THIS pass already had about absent local groups, so the
   * key-distribution groups are not asked about twice per connection ({@link AbsentGroupVerdicts}).
   * Absent when discovery is a pass of its own (the 35 s and 70 s retries), which asks afresh.
   */
  verdicts?: AbsentGroupVerdicts;
}) {
  const {
    mlsService,
    userId,
    deviceKeyB64,
    conversations,
    saveConversation,
    deleteConversation,
    log,
  } = params;

  // ── Phase 1: Create placeholders for server groups not present locally ────

  // THE LOCAL SET AND THE SERVER LIST COME FROM ONE SEAM, in the one order that is sound, with one
  // verdict on whether absence from the list may be believed. Both were written out here and in
  // `initializeConnection`, and the two copies disagreed on four points - including the guard that
  // refuses an empty list, which this side did not have. See `groupSweep.ts`.
  const snapshot = await readGroupSweepSnapshot(mlsService, userId, log);
  const uniqueServerGroups = snapshot.serverGroups;

  // Active groups only: exclude soft-deleted tombstones (kept server-side for the 90-day
  // recovery window but never re-created as local placeholders).
  const activeServerGroups = uniqueServerGroups.filter((g) => !g.deletedAt);

  // ── Orphan cleanup (server membership = source of truth) ─────────────────
  // Phase 1 - MLS WASM: drop OpenMLS trees for groupIds absent from the server.
  // Phase 2 - UI/IndexedDB: drop conversation rows (may exist without WASM state).
  // Only when getUserGroups succeeded (never purge on transient network errors).
  if (snapshot.fetchOk) {
    const serverGroupIds = snapshot.serverGroupIds;
    // Groups dismissed by THIS user (manual deletion/leave on one device): must be purged
    // on ALL their devices (rules 3 & 5), not shown with the banner.
    // Best-effort (`[]` on error -> never purge on doubt; `getDismissedGroups` logs the failure).
    //
    // NOT CONSULTED BY THE PLACEHOLDER LOOP BELOW, AND THAT IS CONSISTENT RATHER THAN A GAP: that
    // loop only builds rows for groups the server still lists this user in, and "dismissed AND a
    // member" is the RE-INVITE case, which this loop answers by lifting the dismiss and KEEPING the
    // conversation. A device with no row ends in the same state as one with a row.
    const dismissedGroupIds = new Set(await mlsService.getDismissedGroups());

    if (await forgetGroupsAbsentFromServer(mlsService, snapshot, log, params.verdicts)) {
      await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);
    }

    // ONE LINE PER SWEEP for the groups whose status went unanswered: a down service, a gateway
    // error or a captive portal answers every group alike, and a line per group was that one fact
    // repeated (`getGroupServerStatus` keeps the per-group status at debug).
    const unansweredStatus: string[] = [];
    for (const [key, convo] of conversations.entries()) {
      if (isChannelConversationId(key)) continue;

      // Dismissed by the user (manual deletion/leave on another device). Two cases:
      //  - no longer an active member -> PURGE (rules 3 & 5), no banner. Top priority.
      //  - active member again (RE-INVITE since) -> dismiss is stale: lift it
      //    server-side and keep the conversation (re-add rule). Do NOT purge here,
      //    or we would delete a group we just re-joined.
      if (dismissedGroupIds.has(convo.id)) {
        if (!serverGroupIds.has(convo.id)) {
          log(`[DISCOVERY] UI group "${convo.id}" dismissed by user - removing`);
          await purgeLocalConversationRecord({
            conversations,
            contactKey: key,
            groupId: convo.id,
            deleteConversation,
            log,
          });
          continue;
        }
        log(
          `[DISCOVERY] "${convo.name || convo.id}" dismissed but we are a member again - dismiss lifted`
        );
        void mlsService.undismissGroup(convo.id).catch((e: unknown) => {
          log(
            `[DISCOVERY] undismissGroup(${convo.id}) failed - other devices keep purging it: ${String(e)}`
          );
        });
        // Let normal processing continue (active group).
      }

      if (!serverGroupIds.has(convo.id)) {
        // A NEVER-ADMITTED CONVERSATION THE SERVER NO LONGER LISTS was an ask that ended without an
        // admission - a member declined it, or it expired. This device was never in it, so there is
        // no past to keep and no exclusion to explain: the row goes. Only on a list that may be
        // believed, the guard every destructive reading of absence takes (`groupSweep.ts`).
        if (isNeverAdmitted(convo)) {
          if (!snapshot.absenceIsEvidence) {
            log(
              `[DISCOVERY] never-admitted "${convo.id}" absent from the list, kept - ${snapshot.unusableReason}`
            );
            continue;
          }
          log(
            `[DISCOVERY] never-admitted "${convo.id}" is no longer listed - the ask was declined or expired - removing`
          );
          await purgeLocalConversationRecord({
            conversations,
            contactKey: key,
            groupId: convo.id,
            deleteConversation,
            log,
          });
          continue;
        }
        // Fate decision centralised in `decideAbsentGroupFate` (single source shared with
        // other reconcilers). We only query the server for genuinely undecided cases: a conv
        // already `deletedRemotely` short-circuits without a network call.
        let serverStatus: GroupServerStatus = { kind: 'unknown' };
        if (convo.lifecycle !== 'removed') {
          serverStatus = classifyServerStatus(await mlsService.getGroupServerStatus(convo.id));
        }

        // THE KIND OF GROUP IS DECIDED BEFORE ITS ROSTER IS ASKED FOR, from the row already in hand.
        // A key-distribution group has no conversation roster: the server refuses
        // `user-members` on it with a 403, and asking anyway printed that refusal at every boot of a
        // device holding such a row - a question whose answer the status read above already carried.
        if (
          (serverStatus.kind === 'active' || serverStatus.kind === 'tombstone') &&
          isDistributionGroupMeta(serverStatus.meta)
        ) {
          mlsService.noteDistributionGroup(convo.id);
          log(
            `[DISCOVERY] UI group "${convo.name || convo.id}" is a Graine distribution group - removing conversation row`
          );
          await purgeLocalConversationRecord({
            conversations,
            contactKey: key,
            groupId: convo.id,
            deleteConversation,
            log,
          });
          continue;
        }

        // Anti-race: only re-validate our actual membership on a LIVE conversation group absent
        // from our getUserGroups snapshot (which may be stale for a group just created/joined).
        let isStillUserMember: boolean | null = null;
        if (serverStatus.kind === 'active') {
          const userMembers = await mlsService.getGroupUserMembers(convo.id).catch(() => null);
          isStillUserMember =
            userMembers === null ? null : userMembers.some((m) => m.userId === userId);
        }

        const fate = decideAbsentGroupFate({
          lifecycle: convo.lifecycle,
          serverStatus,
          isStillUserMember,
        });
        const label = convo.id;

        if (fate.action === 'purge') {
          log(`[DISCOVERY] UI group "${label}" - ${fate.reason} - removing`);
          await purgeLocalConversationRecord({
            conversations,
            contactKey: key,
            groupId: convo.id,
            deleteConversation,
            log,
          });
          continue;
        }
        if (fate.action === 'markRemoved') {
          await retireConversation({
            conversations,
            key,
            groupId: convo.id,
            saveConversation,
          });
          log(`[DISCOVERY] UI group "${label}" ${fate.reason} - marked removed`);
          continue;
        }
        // keep
        if (serverStatus.kind === 'unknown' && convo.lifecycle !== 'removed') {
          unansweredStatus.push(label.slice(0, 8));
          continue;
        }
        log(`[DISCOVERY] UI group "${label}" kept - ${fate.reason}`);
        continue;
      }
    }
    if (unansweredStatus.length > 0) {
      log(
        `[DISCOVERY] ${unansweredStatus.length} group(s) kept - server status unanswered, nothing purged: ${unansweredStatus.join(', ')}`
      );
    }
  }

  // Include both ready and placeholder conversations to avoid recreating
  // the same pending entry on each login. Only active groups get placeholders
  // (soft-deleted tombstones are skipped via activeServerGroups above).
  const localGroupIds = new Set([...conversations.values()].map((c) => c.id));

  // Read ONCE for the whole sweep and handed to the seam below, which owns the guard: a group this
  // device has already decided to leave is not "missing locally", it is on its way out
  // ({@link ensureConversationForServerGroup}). The question is per group, the round trip is not.
  const owedExits = await pendingGroupExitIds(params.storage);
  const missing = activeServerGroups.filter((g) => !localGroupIds.has(g.groupId));

  if (missing.length > 0) {
    log(
      `[DISCOVERY] ${missing.length} server group(s) missing locally: ${missing.map((g) => g.name || g.groupId).join(', ')}`
    );
  }

  // ONE construction, shared with the recovery seam that joins a group. This loop used to build the
  // row itself, and the external-commit join took its row from HERE - two sweeps over the same
  // server list, each doing half the job, with no order between them.
  //
  // EVERY ACTIVE GROUP, NOT ONLY THE MISSING ONES, AND THAT IS THE WHOLE OF A DEFECT MEASURED ON
  // 2026-09-15. This loop ran over `missing`, so the seam only ever saw groups with NO local row -
  // for which it CREATES one, already correctly named. Its `existed` branch, and the label repair
  // #693 put there, were therefore unreachable from the sweep that is supposed to run them: a
  // device whose stored label was wrong had it silently corrected by the block below instead, which
  // logged nothing. Measured by writing a wrong label straight into a device's store and reloading
  // it with an observer attached: the label came back right, six other `[DISCOVERY]` lines were
  // captured in the same window, and not one of them was the repair. Two mechanisms for one job,
  // the reachable one mute and the one that speaks dead.
  //
  // The `existed` branch is a map scan and nothing else - no round trip, no MLS - so running it for
  // every group costs a pass over a list this function has already fetched.
  for (const g of activeServerGroups) {
    await ensureConversationForServerGroup(g, {
      mlsService,
      userId,
      conversations,
      saveConversation,
      owedExits,
      log,
    });
  }

  // Whether each row is an invitation-link ask no member has answered, as the list says of THIS
  // device's seat: the sidebar reads it as waiting rather than established, and the sweep above
  // removes such a row once the list stops naming it.
  for (const key of syncAdmissionFlags(conversations, activeServerGroups)) {
    const state = conversations.get(key)?.awaitingAdmission
      ? 'awaits a member admission'
      : 'no longer awaits a member';
    log(`[DISCOVERY] "${key}" ${state}`);
    if (saveConversation) {
      await saveConversation(key).catch((e) =>
        log(`[WARN] Admission state persistence failed for ${key}: ${String(e)}`)
      );
    }
  }

  // ── Seed the group AVATAR from the server (source of truth) ───────────
  // Re-seeded from getUserGroups on every discovery so a device that missed the one-shot
  // `groupImageChanged` MLS message (stuck in SYNC, offline, or joined late) still converges on the
  // authoritative photo. Live changes still arrive via the MLS system message; this is the durable
  // fallback. THE NAME IS NO LONGER SEEDED HERE - `repairGroupLabel` owns it, one seam, and it says
  // so in the log. Groups only, for the reason that function gives: a DM's server name is the
  // canonical `self::peer` KEY, not a label.
  for (const g of activeServerGroups) {
    if (!g.isGroup) continue;
    const convo = conversations.get(g.groupId);
    if (!convo) continue;
    const nextImage = g.imageMediaId ?? null;
    if ((convo.imageMediaId ?? null) !== nextImage) {
      conversations.set(g.groupId, { ...convo, imageMediaId: nextImage });
      // Persisted, so the next start draws it from the local row rather than waiting for this list.
      if (saveConversation) {
        await saveConversation(g.groupId).catch((e) =>
          log(`[WARN] Group photo persistence failed for ${g.groupId}: ${String(e)}`)
        );
      }
    }
  }
}

/**
 * Exports the user's full backup (conversations + messages + MLS state) as a `.canari` file. In Tauri
 * opens a folder picker; in the browser triggers an anchor download.
 *
 * The file is sealed under THIS DEVICE'S recovery code (`deviceRecoveryCode.ts`): the same code for
 * every backup the device exports, generated at the first one and kept sealed under the device key.
 * It is returned with where it came from, so the surface says whether it is the code the user already
 * holds. `null` when the save was cancelled: a code for a file that does not exist is neither shown
 * nor kept.
 */
export async function exportUserBackup(params: {
  storage: IStorage;
  userId: string;
  deviceKeyB64: string;
  myDeviceId: string;
  log: (msg: string) => void;
}): Promise<{ recoveryCode: string; codeOrigin: RecoveryCodeOrigin } | null> {
  const { storage, userId, deviceKeyB64, myDeviceId, log } = params;
  const mlsStateHex = await exportMlsStateAsHex(userId);
  const code = await deviceRecoveryCode(userId, deviceKeyB64, log);
  const blob = await exportBackup(
    storage,
    userId,
    deviceKeyB64,
    myDeviceId,
    mlsStateHex,
    code.bytes
  );
  const date = new Date().toISOString().split('T')[0];
  const filename = `canari-backup-${userId}-${date}.canari`;

  // One path for both runtimes: `saveBlobAs` owns the split, because an anchor download is a
  // no-op inside the Tauri WebView (no download handler on either mobile platform) and a
  // directory picker is not something Android's SAF offers in the first place.
  const saved = await saveBlobAs(
    new Blob([blob.buffer as ArrayBuffer], { type: 'application/octet-stream' }),
    filename
  );
  log(saved ? `[OK] Backup exported: ${filename}` : '[..] Backup export cancelled');
  if (!saved) return null;
  await keepDeviceRecoveryCode(userId, code, deviceKeyB64);
  clearBackupOwedAfterKeyMove(userId);
  return { recoveryCode: formatRecoveryCode(code.bytes), codeOrigin: code.origin };
}

/** Imports a `.canari` backup file: decrypts conversations/messages, restores the MLS state if this is the same device, then reloads the conversation list. */
export async function importUserBackup(params: {
  file: File;
  /** The code shown at export; required for a v3 file. */
  recoveryCode?: string;
  deviceKeyB64: string;
  storage: IStorage;
  myDeviceId: string;
  userId: string;
  log: (msg: string) => void;
  reloadConversations: () => Promise<void>;
  clearConversations: () => void;
}): Promise<{ conversations: number; messages: number; isSameDevice: boolean }> {
  const {
    file,
    recoveryCode,
    deviceKeyB64,
    storage,
    myDeviceId,
    userId,
    log,
    reloadConversations,
    clearConversations,
  } = params;

  const arrayBuffer = await file.arrayBuffer();
  const {
    data: backup,
    isSameDevice,
    mlsStateUsable,
  } = await importBackup(
    new Uint8Array(arrayBuffer),
    deviceKeyB64,
    storage,
    myDeviceId,
    recoveryCode
  );

  if (isSameDevice) {
    const existingMlsState = await hasMlsState(userId);
    if (backup.mlsState && !existingMlsState && !mlsStateUsable) {
      log('MLS state in the backup is sealed under another key - not restored.');
    } else if (backup.mlsState && !existingMlsState) {
      await saveMlsState(userId, fromHex(backup.mlsState));
      log('MLS state restored (same device).');
    } else if (existingMlsState) {
      log('Local MLS state preserved (device already active).');
    }
  } else {
    log(
      '[WARNING] New device detected. Conversations are imported as read-only. ' +
        'Reconnect the exporting device to trigger automatic group invitation.'
    );
  }

  clearConversations();
  await reloadConversations();

  log(
    `[OK] Backup imported: ${backup.conversations.length} conversation(s), ` +
      `${backup.messages.length} message(s).`
  );

  // Returned rather than only logged: the caller has to be able to TELL the user what happened,
  // and the counts and the device verdict are the only facts the sentence needs.
  return {
    conversations: backup.conversations.length,
    messages: backup.messages.length,
    isSameDevice,
  };
}

// In-process guard: prevents the same tab from handling two welcome_requests
// for the same group concurrently (e.g. rapid retries arriving before the
// first one finishes).  Cross-device races are handled by acquireAddLock below.
const welcomeRequestInProgress = new Set<string>();

/** Re-add attempts keyed by `${groupId}:${requesterDeviceId}` within the sliding window. */
const reAddAttempts = new Map<string, { count: number; first: number }>();

/** Maximum re-add attempts for the same device within the window before suspending. */
const MAX_READD_ATTEMPTS = 3;

/** Sliding window duration for the re-add anti-livelock guard. */
const READD_WINDOW_MS = 3 * 60_000;

/**
 * Cooldown after which a freshly-invited device is presumed "still joining".
 * While it runs, further welcome_requests from that device are ignored: its leaf is fresh,
 * not stale, and kicking it would cause UseAfterEviction on send. Must cover Welcome
 * decryption + history bundle ingestion (several seconds).
 */
const WELCOME_COOLDOWN_MS = 30_000;

/**
 * Handles a welcome_request received from a device that wants to join a group.
 *
 * Nominal case: addMember -> sendWelcome -> sendCommit.
 *
 * "Leaf already present" case: if the device was previously in the group
 * (stale, crash, etc.), its leaf node is still in the MLS tree but its
 * local state is lost. In this case:
 *   1. removeMemberDevice (kick the stale leaf)
 *   2. kickStaleDevice (reset server membership to pending)
 *   3. addMember with a fresh KeyPackage -> sendWelcome -> sendCommit
 *
 * IMPORTANT: the unique identifier is (userId, deviceId), not userId alone.
 *
 * Security: refuses to re-add a requester absent from dm_group_members (a removed user).
 * The gateway authenticates the sender but does not check their membership before relaying.
 */
export async function handleWelcomeRequest(params: {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  deviceKeyB64: string;
  conversations: Map<string, Conversation>;
  log: (msg: string) => void;
  requesterUserId: string;
  requesterDeviceId: string;
  groupId: string;
  /** Called when the terminal group exists but is not ready yet (Welcome in transit). */
  onNotReady?: (terminalGroupId: string) => void;
  /**
   * A requester whose USER holds no leaf in our tree is a new person, never added on a relayed
   * request (`automaticAdmission`): this asks a member to approve the join instead.
   */
  onJoinApprovalRequested?: (request: JoinApprovalRequest) => void;
}) {
  const {
    mlsService,
    storage,
    userId,
    deviceKeyB64,
    conversations,
    log,
    requesterUserId,
    requesterDeviceId,
    groupId: requestedGroupId,
    onNotReady,
    onJoinApprovalRequested,
  } = params;

  // Anti-self guard: the gateway broadcasts welcome_requests to ALL devices of the user,
  // including the sender. A device must never handle its own request: it would add itself
  // to the MLS tree and kick its own leaf (self-eviction), leaving the group it just created.
  if (requesterUserId === userId && requesterDeviceId === mlsService.getDeviceId()) {
    log(`[WELCOME_REQ] Request from self (${requesterDeviceId.slice(0, 12)}...) - ignored`);
    return;
  }

  const terminalId = requestedGroupId;
  const terminalMeta = await mlsService.getGroupMeta(requestedGroupId).catch(() => null);

  // Group not found on server.
  if (!terminalMeta) {
    log(`[WELCOME_REQ] Group ${requestedGroupId.slice(0, 8)}... not found - refusing`);
    return;
  }

  // Group is deleted - refuse to invite into a dead group.
  if (terminalMeta.deletedAt) {
    log(`[WELCOME_REQ] Group ${requestedGroupId.slice(0, 8)}... deleted - refusing`);
    return;
  }

  const groupId = terminalId;

  // ── Membership guard (security) ─────────────────────────────────────────────
  // The gateway authenticates the sender (no spoofing) but relays the request without checking
  // membership; we must therefore refuse here to re-add a REMOVED user. The source of truth is
  // dm_group_members (user-level): a removed user no longer has a row, whereas a legitimate
  // invited/pending user has one BEFORE emitting any welcome_request (addGroupMember /
  // acceptGroupInvite create it first). We cannot gate on group:members / the MLS tree: the very
  // purpose of a welcome_request is to serve someone absent from routing (lost WASM state).
  // Fail-closed: if the list is unavailable (network), refuse - the requester retries (60s cadence)
  // and another peer can honor it. Never re-add on doubt.
  const userMembers = await mlsService.getGroupUserMembers(groupId).catch(() => null);
  if (userMembers === null) {
    log(
      `[WELCOME_REQ] Members of ${groupId.slice(0, 8)}… unavailable - refused (requester will retry)`
    );
    return;
  }
  if (!userMembers.some((m) => m.userId === requesterUserId)) {
    log(
      `[WELCOME_REQ] ${requesterUserId} not a member of ${groupId.slice(0, 8)}… (removed) - re-add refused`
    );
    return;
  }

  // Defence in depth: verify we have a ready conversation for this terminal group.
  // If this device is not yet in the terminal group (Welcome in transit or initial sync
  // not complete), signal via onNotReady so the caller defers and retries.
  if (conversations.get(groupId)?.lifecycle !== 'active') {
    log(`[WELCOME_REQ] No ready conversation for ${groupId.slice(0, 8)}... - deferring`);
    onNotReady?.(groupId);
    return;
  }

  // ── Admission guard (security) ──────────────────────────────────────────────
  // The roster guard above reads the server, and so does everything that brought this request
  // here. Whether the requester is a MEMBER is read from our own tree: a new person is brought in by
  // a member's gesture, never by a relayed request (`automaticAdmission`).
  const admission = await automaticAdmission({
    mlsService,
    groupId,
    userId: requesterUserId,
    tag: '[WELCOME_REQ]',
    log,
  });
  if (admission === 'unreadable') return;
  if (admission === 'newcomer') {
    const seat = userMembers.find((m) => m.userId === requesterUserId);
    askAMemberToAdmit(
      conversations,
      {
        groupId,
        requesterUserId,
        requesterDeviceId,
        ...(seat?.askId ? { askId: seat.askId } : {}),
      },
      seat?.awaitingAdmission,
      '[WELCOME_REQ]',
      log,
      onJoinApprovalRequested
    );
    return;
  }

  // Guard in-process: prevents two concurrent handles for the same group
  // in the same tab (rapid retries arrive before the first one finishes)
  if (welcomeRequestInProgress.has(groupId)) {
    log(`[WELCOME_REQ] Already in progress for ${groupId} - skip`);
    return;
  }
  welcomeRequestInProgress.add(groupId);

  // Acquire the distributed lock to prevent races with
  // processPendingInvitations on another device of the same group (default TTL, cf. H1)
  const lockAcquired = await mlsService.acquireAddLock(groupId).catch(() => false);
  if (!lockAcquired) {
    log(`[WELCOME_REQ] Lock busy for ${groupId} - another device in progress, skip`);
    welcomeRequestInProgress.delete(groupId);
    return;
  }

  // The package the Add or the replace is built from, kept for the catch: a duplicate key is
  // attributed by asking which leaf carries THIS package's key (`duplicateKeyHolder`).
  let packageSent: Uint8Array | null = null;
  try {
    const attemptKey = `${groupId}:${requesterDeviceId}`;
    const now = Date.now();

    // Post-Welcome cooldown: if we sent a Welcome to this device recently, it is almost
    // certainly still processing it (decryption + history bundle take several seconds).
    // Kicking now would evict a freshly-added leaf -> the invitee falls into
    // UseAfterEviction on send. Let it finish joining. WHICHEVER PATH SENT IT - a creation fan-out,
    // a pending invitation or an admission as much as an earlier welcome_request (`welcomeSent`).
    const lastWelcome = welcomeSentAt(groupId, requesterDeviceId);
    if (lastWelcome && now - lastWelcome < WELCOME_COOLDOWN_MS) {
      log(
        `[WELCOME_REQ] ${requesterDeviceId.slice(0, 12)}... Welcome sent ${Math.round((now - lastWelcome) / 1000)}s ago - still joining, skip`
      );
      return;
    }

    // A requester this device refused for a changed key is not fetched again, and is told by the
    // line what lifts it (`refusedDevices.ts`). Before the anti-livelock count: it is not an attempt.
    const ownDevice = { userId, deviceId: mlsService.getDeviceId() };
    if (await isRefusedDevice(ownDevice, requesterUserId, requesterDeviceId, mlsService)) {
      reportRefusedDeviceSkipped('[WELCOME_REQ]', groupId, requesterUserId, requesterDeviceId);
      return;
    }

    // Anti-livelock guard: limits repeated re-adds of the same device within a sliding
    // window. If the invitee loops (their published KeyPackages are orphaned from their
    // private key -> NoMatchingKeyPackage client-side), re-adding is pointless and would
    // saturate the server (Welcome + history bundle each round). The fix is client-side
    // (republish); here we simply stop looping.
    const prev = reAddAttempts.get(attemptKey);
    const attempt = prev && now - prev.first < READD_WINDOW_MS ? prev : { count: 0, first: now };
    attempt.count += 1;
    reAddAttempts.set(attemptKey, attempt);
    if (attempt.count > MAX_READD_ATTEMPTS) {
      log(
        `[WELCOME_REQ] ${requesterDeviceId.slice(0, 12)}... re-added ${attempt.count - 1}x in vain on ${groupId.slice(0, 8)}... - re-add suspended (fix needed client-side)`
      );
      return;
    }

    // Fetch a fresh KeyPackage for the requesting device.
    // If absent: the device has not yet published its KP -> cannot invite it.
    // Causality is guaranteed upstream: syncConnectionAfterWsOpen does not send a
    // welcome_request until generateKeyPackage has succeeded.
    // Best-effort: a network error must not short-circuit the fetchDeviceKeyPackage fallback.
    const devices = await mlsService.fetchUserDevices(requesterUserId).catch(() => []);
    let targetDevice: DeviceKeyPackage | undefined = devices.find(
      (d) => d.deviceId === requesterDeviceId
    );
    if (!targetDevice) {
      // fetchUserDevices applies a 30-day cutoff: the requesting device may be absent
      // (old device reconnecting). Retry via fetchDeviceKeyPackage, which has no cutoff -
      // same fallback as processPendingInvitations. Without this, a valid but out-of-window
      // device stays stuck (silent abandon, no re-add possible).
      const answer = await mlsService.fetchDeviceKeyPackage(requesterUserId, requesterDeviceId);
      if (answer.kind !== 'package') {
        // Aborting either way - this path never retires anything - but the line says WHICH, because
        // "the server was unreachable" and "this device has nothing usable" send a reader looking
        // in two different places, and they were one sentence until 2026-09-16.
        log(
          answer.kind === 'unanswered'
            ? `[WELCOME_REQ] No KeyPackage answer for ${requesterDeviceId} (${answer.detail}) - aborting`
            : `[WELCOME_REQ] No KeyPackage for ${requesterDeviceId} (${answer.reason}) - aborting`
        );
        return;
      }
      targetDevice = answer.device;
      log(`[WELCOME_REQ] KeyPackage retrieved via fallback for ${requesterDeviceId} (> 30 days)`);
    }

    // ── Check if the device's leaf is already in the MLS tree ────────────
    // Do not check status='active' here: sendWelcome marks the device active
    // optimistically before the phone processes the Welcome. If the device loses its
    // WASM state (restart, fresh-install, NoMatchingKeyPackage), it resends a
    // welcome_request while already marked 'active' server-side.
    // -> always replace (remove + add, ONE commit) when the leaf is present in the tree.
    // Read the TREE, not the routing table - see `leafIsInLocalTree`. This decides a REMOVAL, and the
    // Rustdoc on `member_identities` is explicit that a decision to remove a leaf reads the tree.
    // `=== true` keeps the old fall-through: on an unreadable tree the Add is still attempted.
    const leafPresent = await leafIsInLocalTree({
      mlsService,
      groupId,
      userId: requesterUserId,
      deviceId: requesterDeviceId,
      tag: '[WELCOME_REQ]',
      log,
    });
    if (leafPresent === true) {
      // THE REPLACEMENT IS VETTED BEFORE THE LEAF IT REPLACES IS REMOVED. A device that lost its
      // state comes back under the same id with a NEW signature key, and nothing proves that key
      // is the device's (the old one went with the state): the replace would refuse it, so it is
      // refused here, with its typed cause, and nothing is staged.
      const verdict = await mlsService.vetKeyPackage(
        targetDevice.keyPackage,
        requesterUserId,
        requesterDeviceId
      );
      if (!verdictAdmits(verdict)) {
        if (isDeviceTrustRefusal(verdict)) {
          const refusal = new DeviceTrustRefusedError(verdict, requesterUserId, requesterDeviceId);
          reportDeviceTrustRefusal('[WELCOME_REQ]', groupId, refusal);
          await recordRefusedDevice(ownDevice, refusal, mlsService);
        } else {
          log(
            `[WELCOME_REQ] KeyPackage for ${requesterDeviceId.slice(0, 12)}... refused (${verdict}) - no kick, no re-add`
          );
        }
        return;
      }
      // WHICH OF THE TWO CAUSES THIS REPAIRS, said from where it is already known: a Welcome this
      // session sent to the device long enough ago to be past the cooldown means the device lost
      // or failed to process it; none sent here means the leaf came from another path or session.
      log(
        `[WELCOME_REQ] ${requesterDeviceId.slice(0, 12)}... leaf in MLS tree - remove + re-add in one commit (` +
          (lastWelcome
            ? `last Welcome sent here ${Math.round((now - lastWelcome) / 1000)}s ago`
            : 'no Welcome sent from here this session') +
          ')'
      );
    }

    // ── Add (or replace) the device in the MLS group (staged transaction, C7-A) ─────
    // Stage, validate the epoch server-side, then merge + broadcast on accept (excluding the inviter
    // self and the invitee) or roll back on reject. A rejected commit throws WITHOUT advancing the
    // local epoch (no fork) and is handled by the outer catch as a retryable failure; the Welcome is
    // only sent once the commit is accepted. [[C7]]
    //
    // A LEAF STILL IN THE TREE IS REPLACED IN ONE COMMIT, never kicked then re-added: no epoch has
    // the device out of the tree, so the repair is no departure (`removalEpochs`) and the server
    // cannot steer an honest member into a two-commit shape that would read as one.
    const invitee = {
      keyPackage: targetDevice.keyPackage,
      userId: requesterUserId,
      deviceId: requesterDeviceId,
    };
    packageSent = invitee.keyPackage;
    const exclude = [`${requesterUserId}:${requesterDeviceId}`];
    let result: { welcome?: Uint8Array; ratchetTree?: Uint8Array };
    if (leafPresent === true) {
      result = await mlsService.replaceMember(groupId, invitee, exclude);
    } else {
      try {
        result = await mlsService.addMember(groupId, invitee, exclude);
      } catch (e) {
        // A DUPLICATE SIGNATURE KEY: the Add met a leaf already carrying this key. The tree is
        // asked WHOSE leaf carries it. This identity's (the first read was unreadable, or the leaf
        // arrived since), and it is the repair above, in ONE commit - never a kick and a re-add,
        // which left the device out of the group for an epoch. Any other leaf, and nothing is
        // replaced or removed (`reportDuplicateKeyNotRepaired`).
        if (!String(e).includes('DuplicateSignatur')) throw e;
        const found = await duplicateKeyHolder({
          mlsService,
          groupId,
          keyPackage: invitee.keyPackage,
          userId: requesterUserId,
          deviceId: requesterDeviceId,
          tag: '[WELCOME_REQ]',
          log,
        });
        if (found.kind !== 'this') {
          reportDuplicateKeyNotRepaired('[WELCOME_REQ]', groupId, exclude[0], found);
          return;
        }
        log(
          `[WELCOME_REQ] ${requesterDeviceId.slice(0, 12)}... leaf in MLS tree - remove + re-add in one commit (found by a duplicate key)`
        );
        result = await mlsService.replaceMember(groupId, invitee, exclude);
      }
    }
    await mlsService.registerMember(groupId, requesterUserId);

    // Send the Welcome + post-merge ratchet tree to the requesting device.
    if (result.welcome) {
      await mlsService.sendWelcome(
        result.welcome,
        requesterUserId,
        groupId,
        requesterDeviceId,
        result.ratchetTree
      );
      log(`[WELCOME_REQ] Welcome -> ${requesterUserId}:${requesterDeviceId} for ${groupId}`);
    }

    // Save MLS state after the merged commit (crash-safety).
    await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);

    // Send the full history to the new member. These are APPLICATION MESSAGES (not a commit, do not
    // go through validateCommit): the recipient has already joined via the Welcome (same epoch as
    // us). The bundle arrives after the Welcome client-side (order guaranteed by MLS) and reads
    // IndexedDB. [[C8]]
    await sendFullHistoryBundle(groupId, {
      storage,
      deviceKeyB64,
      mlsService,
      log,
      to: digestIdentity(requesterUserId, requesterDeviceId),
    }).catch((e) => log(`[HISTORY_BUNDLE] History send error to ${requesterUserId}: ${String(e)}`));
  } catch (e) {
    if (e instanceof DeviceTrustRefusedError) {
      reportDeviceTrustRefusal('[WELCOME_REQ]', groupId, e);
      await recordRefusedDevice({ userId, deviceId: mlsService.getDeviceId() }, e, mlsService);
      return;
    }
    const errStr = String(e);

    if (errStr.includes('ALREADY_MEMBER')) {
      // Device already a member: request fulfilled (will join via queued Welcome).
      log(
        `[WELCOME_REQ] ${requesterDeviceId} already a member of ${groupId.slice(0, 8)}... - skip`
      );
    } else if (errStr.includes('DuplicateSignatur')) {
      // Reached only from a REPLACE: it removed every leaf of this identity in the same commit, so a
      // leaf still carrying the key is another identity's - named from the tree, not assumed.
      const found: DuplicateKeyHolder = packageSent
        ? await duplicateKeyHolder({
            mlsService,
            groupId,
            keyPackage: packageSent,
            userId: requesterUserId,
            deviceId: requesterDeviceId,
            tag: '[WELCOME_REQ]',
            log,
          })
        : { kind: 'unreadable' };
      reportDuplicateKeyNotRepaired(
        '[WELCOME_REQ]',
        groupId,
        `${requesterUserId}:${requesterDeviceId}`,
        found
      );
    } else {
      log(`[WELCOME_REQ] Error for ${requesterDeviceId}: ${errStr.slice(0, 100)}`);
    }
  } finally {
    await mlsService.releaseAddLock(groupId).catch(() => {});
    welcomeRequestInProgress.delete(groupId);
  }
}

/**
 * How long the elected responder waits for the MLS half of a solicitation.
 *
 * The two halves travel by different transports - the election over the WebSocket, the probe inside
 * MLS - and nothing orders them, so the responder has to wait for an EVENT rather than guess a
 * delay. The bound on that wait is the one duration a probe already has: beyond `DIGEST_TTL_MS` it
 * describes a store that has moved and would be refused anyway.
 *
 * Reaching it is not a tuning question. It means the MLS frame never arrived, and the answer to that
 * is silence: the requester asks again on its next edge, which costs one small frame, where
 * answering a device that named nothing means dumping a whole store on a peer that may need none of
 * it. That fallback is what this rework removed.
 */
const HISTORY_PROBE_WAIT_MS = DIGEST_TTL_MS;

/**
 * Handles an incoming history_request: a device asks whether it holds the same history as us, and
 * for whatever it turns out to be missing. We are already co-members (it is in the MLS tree), so we
 * only resend messages re-encrypted at the current epoch - no re-add, no commit. Guarded to active
 * members holding the group locally; the delivery service already picks a single online responder,
 * so no throttle is needed here.
 *
 * **THE ANSWER DEPENDS ON WHICH PROBE ARRIVES**, and there are three:
 *
 * - `state` - a 64-bit key over the asker's window. We compute ours over the SAME window and, when
 *   they match, say NOTHING AT ALL. That is the common case on every connection of every device,
 *   and it costs one frame and no store read on either side. When they differ we ask for a digest
 *   and the exchange continues below;
 * - `digest` - the hierarchical manifest, either as the second leg of the above or from a device
 *   that went straight to it. We diff it against our store and send what it lacks;
 * - `range` - scrollback, a bounded page below what the asker holds.
 *
 * **We answer from a settled store.** `waitForMessageQueueIdle` is awaited first because an
 * external-commit self-join lands the requester one epoch ahead of a peer that has not yet applied
 * its commit, and a bundle re-encrypted at the old epoch is undecryptable to it and wasted. The
 * requester used to compensate with a 2.5 s pause before asking - a delay standing in for an
 * ordering neither side could observe. The ordering IS observable, on this side, and this is it.
 *
 * Because the diff is symmetric, the same exchange also tells US what the requester has and we do
 * not, so one solicitation repairs both devices instead of pushing history one way.
 */
export async function handleHistoryRequest(params: {
  mlsService: IMlsService;
  storage: IStorage | null;
  deviceKeyB64: string;
  conversations: Map<string, Conversation>;
  log: (msg: string) => void;
  requesterUserId: string;
  /** The requesting DEVICE - a user with several devices must be answered on the right one. */
  requesterDeviceId: string;
  /** OUR user id - the responder's, not the requester's. */
  selfUserId: string;
  groupId: string;
  /** Overridable for tests only. */
  probeWaitMs?: number;
}): Promise<void> {
  const {
    mlsService,
    storage,
    deviceKeyB64,
    conversations,
    log,
    requesterUserId,
    requesterDeviceId,
    selfUserId,
    groupId,
    probeWaitMs = HISTORY_PROBE_WAIT_MS,
  } = params;
  const short = groupId.slice(0, 8);
  if (!holdsGroupState(mlsService, groupId)) {
    log(`[HISTORY_REQ] ${short}... not local - cannot serve history, skip`);
    return;
  }
  if (conversations.get(groupId)?.lifecycle !== 'active') {
    log(`[HISTORY_REQ] ${short}... not active locally - skip`);
    return;
  }

  const deps = { storage, deviceKeyB64, mlsService, log };
  const requesterIdentity = digestIdentity(requesterUserId, requesterDeviceId);
  const selfIdentity = digestIdentity(selfUserId, mlsService.getDeviceId());

  // WHEN THE ELECTION REACHED US, taken before any await. Every probe older than this belongs to an
  // earlier ask - this device stores every probe it can decrypt, elected or not - and answering with
  // one would compare against a state key up to `DIGEST_TTL_MS` old. See `awaitProbe`.
  //
  // The asker ORDERS the two - `reconcileGroup` awaits the election's HTTP response before sending
  // the probe, and the server publishes the election before answering that request - so a probe for
  // THIS ask should postdate this line. `awaitProbe` treats that as a preference and not a rule: if
  // the order is ever broken it waits, then uses the older probe anyway rather than going silent.
  const electedAt = Date.now();

  // Answer from a settled store, not from one still being written - see the note above.
  // `null`: this leg is already deferred past the drain by `answerAfterMailboxDrained` and owns no
  // catch-up session, so a session open on this group belongs to somebody else and will close.
  await mlsService.waitForMessageQueueIdle('history request answer', null).catch(() => {});

  let probe = await awaitProbe(groupId, requesterIdentity, probeWaitMs, electedAt);
  if (!probe) {
    log(`[HISTORY_REQ] no probe from ${requesterIdentity} for ${short}... - nothing to answer`);
    return;
  }

  /**
   * Our coverage, stated to this asker - the shared one bound to this exchange.
   *
   * Awaited at every point this device ANSWERS and at none where it stays silent, which is what
   * makes it read as the end of an answer rather than as one.
   */
  const ourCoverage = (since: number): Promise<void> =>
    stateOurCoverage({ groupId, selfIdentity, requesterIdentity, since, deps });

  if (probe.kind === 'range') {
    await sendHistoryRangeBundle(groupId, deps, {
      to: requesterIdentity,
      before: probe.before,
      limit: probe.limit,
      since: probe.since,
      requestId: probe.requestId,
    }).catch((e) => log(`[HISTORY_RANGE] Answer failed for ${short}...: ${String(e)}`));
    await ourCoverage(probe.since);
    return;
  }

  if (probe.kind === 'state') {
    // OUR key over THE ASKER'S window. Computing it over our own would compare two different
    // questions and never match, which is why `since` is stated by the asker and obeyed here.
    const ourKey = await historyStateKeyFor(groupId, probe.since, deps);
    if (ourKey === null) {
      // A read that FAILED proves nothing about the group. Staying silent lets the requester ask
      // another member on its next edge.
      log(`[HISTORY_REQ] ${short}... store unreadable - staying silent so another member answers`);
      return;
    }
    if (ourKey === probe.key) {
      log(
        `[HISTORY_REQ] ${short}... same state as ${requesterIdentity} (${ourKey}) - nothing to do`
      );
      // AGREEMENT IS NOT COMPLETENESS, and this is the one case where nothing else would say so. Two
      // devices can hold exactly the same messages over the asker's window and both be missing the
      // years below OUR window - the key is computed over what each store holds, so it agrees
      // happily. Stating our coverage here is what lets the asker go and ask a member with a longer
      // memory instead of reading a match as "I am complete".
      await ourCoverage(probe.since);
      return;
    }

    // Same rule for the second leg, dated from OUR request rather than from the election: a digest
    // that predates the request cannot be an answer to it.
    // THE SECOND LEG DOES NOT WAIT, AND THERE IS NOTHING LEFT FOR IT TO WAIT FOR.
    //
    // It used to send this request and then block on `awaitProbe` for `DIGEST_TTL_MS`, ending the
    // exchange if the digest was late. That deadline cost three messages permanently on 2026-09-05:
    // the asker answers only once its own mailbox has drained, and a device that has just rejoined
    // an account is applying every group's external join at once - 67 s against a 60 s wait.
    //
    // The digest needs no continuation because it needs no memory: it carries the manifest and the
    // window, our store carries the rest. So the solicitation is recorded and this leg ENDS. The
    // frame is answered wherever it lands, by `systemMessageHandler` - one road instead of two, and
    // no line claiming an exchange failed while the repair was still on its way. On a device joining
    // twenty-five groups the old wait produced nine such lines per enrolment and repaired every one
    // of them seconds later.
    //
    // NOTHING IS LOGGED HERE. `[HISTORY_STATE] Keys differ ... asked <them> to describe` is written
    // one branch above by this same device, and the outcome arrives as `diff with <them>: N to send`
    // - one ask, one answer, per group. A third line saying the ask was made was pure duplication,
    // and on a device joining twenty-nine groups it was twenty-nine of them.
    noteDigestSolicited(groupId, requesterIdentity);
    await sendHistoryDigestRequest(groupId, { from: selfIdentity, to: requesterIdentity }, deps);
    return;
  }

  const { digest, since, requestId } = probe;
  await answerHistoryDigest({
    groupId,
    requesterIdentity,
    selfIdentity,
    digest,
    since,
    requestId,
    deps,
  });
}
