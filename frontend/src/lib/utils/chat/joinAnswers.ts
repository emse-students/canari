import type { IMlsService } from '$lib/mlsService';
import type { JoinDeclineOutcome } from '$lib/mls-client/mlsDeliveryApi';
import type { Conversation } from '$lib/types';
import { treeHoldsUser } from '$lib/mls-client/leafIdentity';
import type { TreeReading } from './confirmedTree';
import type { AnsweredJoinAsk, BulkAdditionOutcome, BulkAdditionRefusal } from './groupCreation';
import type { JoinAnswerResult, JoinRefusalKind, JoinRequest } from './joinRequests.svelte';

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
  /**
   * The group's tree read at the server's epoch (`readConfirmedTree`), with that epoch: the proof a
   * Decline of a seat that is not an invitation-link ask carries ({@link declineJoinRequest}).
   */
  confirmedTree: (groupId: string) => Promise<TreeReading>;
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
    const kind = refusalKindOf(outcome.reason);
    return {
      done: false,
      reason: `the Add did not happen (${outcome.reason})`,
      ...(kind ? { kind } : {}),
    };
  }
  if (!outcome.addedUsers.includes(request.userId.toLowerCase())) {
    return { done: false, reason: 'the Add admitted none of their devices' };
  }
  return { done: true };
}

/**
 * The refusals of an Add that mean ANOTHER MEMBER is the cause ({@link JoinRefusalKind}): the
 * group's add lock is held (an ANSWERED refusal - no answer at all is a failure), or the Add was
 * abandoned because the person was declined or removed meanwhile. A lost commit race is neither: it
 * proves no one answered this ask. A
 * typed switch on the refusal, never a read of its text.
 */
function refusalKindOf(reason: BulkAdditionRefusal): JoinRefusalKind | undefined {
  switch (reason) {
    case 'add-lock-busy':
      return 'busy';
    case 'removed-meanwhile':
      return 'raced';
    default:
      return undefined;
  }
}

/** What each answer of the server to a Decline means, as the log line says it - one line each. */
const DECLINE_OUTCOME_LINE: Record<JoinDeclineOutcome, string> = {
  withdrawn: 'declined - their seat is withdrawn',
  'already-admitted': "not declined - another member's Add admitted them first",
  // Answered to a Decline that carried no tree epoch: a link ask whose flag was lifted with no trace
  // of an Add. With an epoch it is never this server's answer - see {@link serverCannotRemove}.
  'not-awaiting':
    'not declined - their seat is not an invitation-link ask, and no tree epoch proved them absent',
  removed: 'declined - their seat, not an invitation-link ask, is removed',
  'epoch-moved': 'not declined - a commit landed since the tree was read',
  gone: '- the ask was already answered or expired',
};

/**
 * Whether the server answered a Decline that CARRIED a tree epoch as a server older than the field
 * does: `not-awaiting` or `already-admitted` for a seat that is not a link ask. A server that reads
 * the epoch answers such a seat `removed` or `epoch-moved` only, so either answer means this server
 * cannot remove the seat - the card would come back at every sweep, and no Decline would ever end it.
 */
function serverCannotRemove(outcome: JoinDeclineOutcome, treeEpoch: number | undefined): boolean {
  return treeEpoch !== undefined && (outcome === 'not-awaiting' || outcome === 'already-admitted');
}

/**
 * DECLINES the ask: the server takes the person's seat away (`declineJoinRequest`), which is what
 * stops the ask from coming back. There is no leaf to remove - the person holds none - so no commit
 * is made.
 *
 * AN INVITATION-LINK ASK (it carries `askId`) is withdrawn under the group's seat lock ONLY while the
 * seat still awaits a member: a person another member's Add admitted first - an epoch this device
 * may not have processed yet, so its own tree cannot say - is answered `already-admitted` and left
 * whole, never half-removed (seat gone, leaf in the tree). The ask then ends WITHOUT a decline
 * (`settled: 'already-in'`): the member is never told they refused someone who is in.
 *
 * A SEAT THAT IS NOT AN ASK (no `askId`: a person whose leaves are all gone while their seat stands)
 * holds no flag a commit lifts, so the Decline carries the PROOF instead: the epoch of a tree
 * confirmed at the server's epoch in which the person holds no leaf. The server removes the seat
 * only while the group is still at that epoch (`removed`), and touches nothing once a commit landed
 * since (`epoch-moved`): the tree is then read again and the Decline sent ONCE more, and a second
 * `epoch-moved` is `raced` - the conversation moved under the tap, nothing broke. A tree that cannot
 * be confirmed proves nothing, so nothing is sent; one that holds the person says they came back in
 * meanwhile - a Decline is never a Remove, and the ask ends without one (`settled: 'already-in'`).
 * A server that answers as one older than the epoch is `unsupported`, accused at ERROR.
 *
 * Every other outcome answers the ask; a refusal of the server is not done.
 */
export async function declineJoinRequest(
  request: JoinRequest,
  deps: JoinAnswerDeps
): Promise<JoinAnswerResult> {
  const convo = groupOf(request, deps.conversations);
  if (typeof convo === 'string') return { done: false, reason: convo };
  const short = request.groupId.slice(0, 8);
  // Two attempts at most: a commit landing between the reading and the server's lock is a race of
  // this tap, read again once; a group committing faster than a tap can answer is `raced`.
  for (let attempt = 0; attempt < 2; attempt++) {
    let treeEpoch: number | undefined;
    if (request.askId === undefined) {
      const tree = await deps.confirmedTree(request.groupId);
      if (tree.status === 'unconfirmed') {
        return {
          done: false,
          reason: "the tree is not confirmed at the server's epoch, so it proves no absence",
        };
      }
      if (treeHoldsUser(tree.identities, request.userId)) {
        deps.log(
          `[JOIN_REQUEST] ${request.userId} holds a leaf in ${short}... at epoch ${tree.epoch} - they came back in meanwhile, and a Decline is no Remove: the ask ends, nothing declined`
        );
        return { done: true, settled: 'already-in' };
      }
      treeEpoch = tree.epoch;
    }
    let outcome: JoinDeclineOutcome;
    try {
      outcome = await deps.mlsService.declineJoinRequest(
        request.groupId,
        request.userId,
        treeEpoch
      );
    } catch (e) {
      return { done: false, reason: `the server refused the decline: ${String(e).slice(0, 120)}` };
    }
    if (serverCannotRemove(outcome, treeEpoch)) {
      console.error(
        `[JOIN_REQUEST] decline of ${request.userId} in ${short}... carried tree epoch ${treeEpoch} and was answered '${outcome}' - a server older than the epoch, which cannot remove a seat that is not an ask; nothing declined`
      );
      return {
        done: false,
        reason: `the server cannot remove a seat that is not an ask (answered ${outcome})`,
        kind: 'unsupported',
      };
    }
    deps.log(`[JOIN_REQUEST] ${request.userId} ${DECLINE_OUTCOME_LINE[outcome]}`);
    if (outcome === 'already-admitted') return { done: true, settled: 'already-in' };
    if (outcome !== 'epoch-moved') return { done: true };
  }
  return {
    done: false,
    reason: 'a commit landed between the tree reading and the decline, twice',
    kind: 'raced',
  };
}
