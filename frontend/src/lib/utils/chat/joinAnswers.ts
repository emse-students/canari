import type { IMlsService } from '$lib/mlsService';
import type { JoinDeclineOutcome } from '$lib/mls-client/mlsDeliveryApi';
import type { Conversation } from '$lib/types';
import { treeHoldsUser } from '$lib/mls-client/leafIdentity';
import type { AnsweredJoinAsk, BulkAdditionOutcome } from './groupCreation';
import type { JoinAnswerResult, JoinRequest } from './joinRequests.svelte';
import { approveMemberDevice, declineMemberDevice } from './memberDeviceAnswers';

/**
 * A MEMBER'S TWO ANSWERS TO "X ASKS TO JOIN" (`joinRequests.svelte.ts`), each saying whether it
 * really happened ({@link JoinAnswerResult}) so the ask leaves the screen only when it did.
 *
 * Both are a GROUP conversation's answers and refuse anything else: Add is the group invite, and
 * Decline withdraws a seat - run on a 1:1 conversation it deleted the peer's own row of the DM. The
 * ask may have been answered meanwhile by another member: Add reads THIS device's tree first (a
 * person who already holds a leaf is admitted, nothing to Add), and Decline is guarded by the server
 * itself, which never withdraws the seat of somebody a member's Add admitted - that is a Remove.
 *
 * docs/wiki/protocols/mls-protocol.md, "Who admits a new person".
 */
export interface JoinAnswerDeps {
  mlsService: Pick<
    IMlsService,
    'getGroupMemberIdentities' | 'getGroupRosterAtGeneration' | 'declineJoinRequest'
  >;
  conversations: ReadonlyMap<string, Conversation>;
  /**
   * The member's own Add (`inviteMembersToGroup`), which returns what it did and never throws.
   * `answering` is the ask it answers: the Add goes ahead only while that very ask is still open.
   */
  invite: (
    userIds: string[],
    conversation: Conversation,
    answering?: AnsweredJoinAsk
  ) => Promise<BulkAdditionOutcome>;
  /**
   * Runs the stray collector (`removeStrayLeaves`) on one group, now: true when a Remove landed. A
   * leaf whose holder has no admitted seat is taken out before the member's Add brings them in.
   */
  collectStrayLeaves: (groupId: string) => Promise<boolean>;
  log: (message: string) => void;
}

/** The group conversation `request` is about, or why there is none to answer in. */
function groupOf(
  request: JoinRequest,
  conversations: ReadonlyMap<string, Conversation>
): Conversation | string {
  const convo = conversations.get(request.groupId);
  if (!convo) return 'no conversation row is loaded for the group';
  const kind = convo.conversationType ?? 'group';
  return kind === 'group' ? convo : `a ${kind} conversation takes no join ask`;
}

/** Whether the requester already holds a leaf in this device's tree; `null` when unreadable. */
async function holdsALeaf(request: JoinRequest, deps: JoinAnswerDeps): Promise<boolean | null> {
  try {
    return treeHoldsUser(
      await deps.mlsService.getGroupMemberIdentities(request.groupId),
      request.userId
    );
  } catch (e) {
    deps.log(
      `[JOIN_REQUEST] tree of ${request.groupId.slice(0, 8)}... unreadable: ${String(e).slice(0, 100)}`
    );
    return null;
  }
}

/**
 * The requester's seat on the server: `admitted`, still `awaiting` a member, `absent`, or `null`
 * when the roster could not be read.
 */
async function seatOf(
  request: JoinRequest,
  deps: JoinAnswerDeps
): Promise<'admitted' | 'awaiting' | 'absent' | null> {
  try {
    const { members } = await deps.mlsService.getGroupRosterAtGeneration(request.groupId);
    const row = members.find((m) => m.userId.toLowerCase() === request.userId.toLowerCase());
    if (!row) return 'absent';
    return row.awaitingAdmission === true ? 'awaiting' : 'admitted';
  } catch (e) {
    deps.log(
      `[JOIN_REQUEST] roster of ${request.groupId.slice(0, 8)}... unreadable: ${String(e).slice(0, 100)}`
    );
    return null;
  }
}

/**
 * ADMITS the person: the member's own Add, built and signed by this device - the one way a new
 * person enters a conversation (`automaticAdmission` in `actions.ts`). Done only when the Add's
 * commit put a device of theirs in the tree (`BulkAdditionOutcome.added`), or when another member's
 * Add already had.
 *
 * A LEAF IS NOT AN ADMISSION: only the seat the server holds says another member's Add admitted
 * them. A leaf held under a seat still awaiting (or no seat) is taken out by the stray collector
 * first, then the member's Add is built - never answered "done" on the leaf alone, which left the
 * seat awaiting with nobody to lift it.
 */
export async function admitJoinRequest(
  request: JoinRequest,
  deps: JoinAnswerDeps
): Promise<JoinAnswerResult> {
  if (request.kind === 'device') return admitUnseenDevice(request, deps);
  const convo = groupOf(request, deps.conversations);
  if (typeof convo === 'string') return { done: false, reason: convo };
  if ((await holdsALeaf(request, deps)) === true) {
    const seat = await seatOf(request, deps);
    if (seat === 'admitted') {
      deps.log(
        `[JOIN_REQUEST] ${request.userId} already holds a leaf in ${request.groupId.slice(0, 8)}... - admitted by another member's Add`
      );
      return { done: true };
    }
    if (seat === null) return { done: false, reason: 'their seat could not be read' };
    deps.log(
      `[JOIN_REQUEST] ${request.userId} holds a leaf in ${request.groupId.slice(0, 8)}... under a seat that is ${seat === 'awaiting' ? 'still awaiting' : 'gone'} - removing it before the Add`
    );
    if (!(await deps.collectStrayLeaves(request.groupId))) {
      return {
        done: false,
        reason: 'a leaf of theirs that holds no admitted seat is not removed yet',
      };
    }
  }
  // An ask with an identity is answered AS that ask: a Decline or a newer ask since it was raised
  // makes this Add stop before its stage (`rosterPremise`), never admit over the Decline.
  const outcome = await deps.invite(
    [request.userId],
    convo,
    request.askId !== undefined ? { userId: request.userId, askId: request.askId } : undefined
  );
  if (outcome.kind === 'not-added') {
    return { done: false, reason: `the Add did not happen (${outcome.reason})` };
  }
  if (!outcome.addedUsers.includes(request.userId.toLowerCase())) {
    return { done: false, reason: 'the Add admitted none of their devices' };
  }
  return { done: true };
}

/** What each answer of the server to a Decline means, as the log line says it - one line each. */
const DECLINE_OUTCOME_LINE: Record<JoinDeclineOutcome, string> = {
  withdrawn: 'declined - their seat is withdrawn',
  'already-admitted': "not declined - another member's Add admitted them first",
  // Never raised as an ask by a current client (`askAMemberToAdmit` asks only for a seat the server
  // holds as one); reached when the seat changed between the ask and the answer.
  'not-awaiting':
    'not declined - their seat is not an invitation-link ask, so there is nothing to withdraw',
  gone: '- the ask was already answered or expired',
};

/**
 * DECLINES the ask: the server withdraws the person's seat (`declineJoinRequest`), which is what
 * stops the ask from coming back. There is no leaf to remove - nobody added one - so no commit is
 * made. The server decides it under the group's seat lock and ONLY while the seat still awaits a
 * member: a person another member's Add admitted first - an epoch this device may not have processed
 * yet, so its own tree cannot say - is answered `already-admitted` and left whole, never half-removed
 * (seat gone, leaf in the tree). Every outcome answers the ask; a refusal of the server is not done.
 */
export async function declineJoinRequest(
  request: JoinRequest,
  deps: JoinAnswerDeps
): Promise<JoinAnswerResult> {
  if (request.kind === 'device') {
    // About this DEVICE in this conversation alone: the person stays a member, their seat and other
    // devices untouched. Undone from the toast the banner shows (`undoMemberDeviceDecline`).
    const [deviceId] = request.deviceIds;
    if (deviceId === undefined) return { done: false, reason: 'the ask names no device' };
    declineMemberDevice(request.groupId, request.userId, deviceId);
    return { done: true };
  }
  const convo = groupOf(request, deps.conversations);
  if (typeof convo === 'string') return { done: false, reason: convo };
  let outcome: JoinDeclineOutcome;
  try {
    outcome = await deps.mlsService.declineJoinRequest(request.groupId, request.userId);
  } catch (e) {
    return { done: false, reason: `the server refused the decline: ${String(e).slice(0, 120)}` };
  }
  deps.log(`[JOIN_REQUEST] ${request.userId} ${DECLINE_OUTCOME_LINE[outcome]}`);
  return { done: true };
}

/**
 * ADMITS ONE device this device never saw, of a user already in the conversation (`kind: 'device'`):
 * the member's approval is recorded for that DEVICE under the key fingerprint the entry showed, and
 * the pending-invitation sweep - started, not awaited - adds it: the same Add every member device
 * gets, in every conversation this device shares with its owner, refused for a package under another
 * key (`memberDeviceAnswers.ts`). Done once the approval is recorded; a sweep that cannot add the
 * device now says why in its log. An entry with no fingerprint, or naming several devices, binds
 * nothing and is refused.
 */
function admitUnseenDevice(request: JoinRequest, deps: JoinAnswerDeps): JoinAnswerResult {
  const [deviceId, ...others] = request.deviceIds;
  if (deviceId === undefined || others.length > 0 || !request.keyFingerprint) {
    console.error(
      `[JOIN_REQUEST] a device ask of ${request.userId} in ${request.groupId.slice(0, 8)}... names ${request.deviceIds.length} device(s) and ${request.keyFingerprint ? 'a key' : 'no key'} - not approved`
    );
    return { done: false, reason: 'the ask does not name exactly one device under one key' };
  }
  approveMemberDevice(request.userId, deviceId, request.keyFingerprint);
  deps.log(
    `[JOIN_REQUEST] unseen device ${deviceId.slice(0, 12)}... of ${request.userId} approved in ${request.groupId.slice(0, 8)}... - the sweep adds it`
  );
  return { done: true };
}
