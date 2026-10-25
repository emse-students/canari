import type { IMlsService } from '$lib/mlsService';
import type { JoinDeclineOutcome } from '$lib/mls-client/mlsDeliveryApi';
import type { Conversation } from '$lib/types';
import { treeHoldsUser } from '$lib/mls-client/leafIdentity';
import type { AnsweredJoinAsk, BulkAdditionOutcome } from './groupCreation';
import type { JoinAnswerResult, JoinRequest } from './joinRequests.svelte';

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
  mlsService: Pick<IMlsService, 'getGroupMemberIdentities' | 'declineJoinRequest'>;
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
 * ADMITS the person: the member's own Add, built and signed by this device - the one way a new
 * person enters a conversation (`automaticAdmission` in `actions.ts`). Done only when the Add's
 * commit put a device of theirs in the tree (`BulkAdditionOutcome.added`), or when another member's
 * Add already had.
 */
export async function admitJoinRequest(
  request: JoinRequest,
  deps: JoinAnswerDeps
): Promise<JoinAnswerResult> {
  const convo = groupOf(request, deps.conversations);
  if (typeof convo === 'string') return { done: false, reason: convo };
  if ((await holdsALeaf(request, deps)) === true) {
    deps.log(
      `[JOIN_REQUEST] ${request.userId} already holds a leaf in ${request.groupId.slice(0, 8)}... - admitted by another member's Add`
    );
    return { done: true };
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
