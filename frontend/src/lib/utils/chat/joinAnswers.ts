import type { IMlsService } from '$lib/mlsService';
import type { Conversation } from '$lib/types';
import { treeHoldsUser } from '$lib/mls-client/leafIdentity';
import type { BulkAdditionOutcome } from './groupCreation';
import type { JoinAnswerResult, JoinRequest } from './joinRequests.svelte';

/**
 * A MEMBER'S TWO ANSWERS TO "X ASKS TO JOIN" (`joinRequests.svelte.ts`), each saying whether it
 * really happened ({@link JoinAnswerResult}) so the ask leaves the screen only when it did.
 *
 * Both are a GROUP conversation's answers and refuse anything else: Add is the group invite, and
 * Decline removes a roster row - run on a 1:1 conversation it deleted the peer's own row of the DM.
 * Both read THIS device's tree first, because the ask may have been answered meanwhile by another
 * member: a person who already holds a leaf is admitted (nothing to Add), and is never "declined" by
 * deleting the roster row of somebody who is in the tree - that is a Remove, a different gesture.
 *
 * docs/wiki/protocols/mls-protocol.md, "Who admits a new person".
 */
export interface JoinAnswerDeps {
  mlsService: Pick<IMlsService, 'getGroupMemberIdentities' | 'removeMemberFromServer'>;
  conversations: ReadonlyMap<string, Conversation>;
  /** The member's own Add (`inviteMembersToGroup`), which returns what it did and never throws. */
  invite: (userIds: string[], conversation: Conversation) => Promise<BulkAdditionOutcome>;
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
  const outcome = await deps.invite([request.userId], convo);
  if (outcome.kind === 'not-added') {
    return { done: false, reason: `the Add did not happen (${outcome.reason})` };
  }
  if (!outcome.addedUsers.includes(request.userId.toLowerCase())) {
    return { done: false, reason: 'the Add admitted none of their devices' };
  }
  return { done: true };
}

/**
 * DECLINES the ask: the person's roster row and pending devices leave the server, which is what
 * stops the ask from coming back. There is no leaf to remove - nobody added one - so no commit is
 * made; a person who DOES hold a leaf by now was admitted by another member, and is left alone
 * rather than half-removed (roster row gone, leaf still in the tree). A refusal of the server throws
 * inside, and is reported as not done.
 */
export async function declineJoinRequest(
  request: JoinRequest,
  deps: JoinAnswerDeps
): Promise<JoinAnswerResult> {
  const convo = groupOf(request, deps.conversations);
  if (typeof convo === 'string') return { done: false, reason: convo };
  const holds = await holdsALeaf(request, deps);
  if (holds === null) return { done: false, reason: 'the tree could not be read' };
  if (holds) {
    return {
      done: false,
      reason: 'they hold a leaf already - another member admitted them; removing them is a Remove',
    };
  }
  try {
    await deps.mlsService.removeMemberFromServer(request.groupId, request.userId);
  } catch (e) {
    return { done: false, reason: `the server refused the removal: ${String(e).slice(0, 120)}` };
  }
  deps.log(`[JOIN_REQUEST] ${request.userId} declined - roster row removed`);
  return { done: true };
}
