/**
 * Eviction policy: what the client does once a Remove commit naming this device has been applied.
 *
 * The rule is that the REMOVE COMMIT IS AUTHORITATIVE. It is a signed, ordered statement by a
 * member with the right to make it, and it is the same statement every other member applies - so
 * there is nothing to confirm, nothing to retry and nothing to repair. The conversation is retired
 * exactly as a peer-side deletion retires it, and `requestReAdd` is reserved for what it was
 * written for: a group this device believes it is IN but cannot use (an epoch fork, a lost
 * Welcome). Eviction is not a broken state, it is a correct one we are not part of.
 *
 * The fact is read from OpenMLS (`isGroupActive`), never mirrored into a flag of our own: the group
 * state is already durable, and a second copy can only ever be wrong in the direction that matters
 * - saying we are still a member of a group we were removed from.
 */

import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { Conversation } from '$lib/types';
import { markConversationDeletedRemotely } from '$lib/utils/chat/conversations';

/** Everything {@link retireIfEvicted} needs, kept to the narrowest set both call sites can supply. */
export interface EvictionCheckDeps {
  mlsService: Pick<IMlsService, 'isGroupActive'>;
  conversations: Map<string, Conversation>;
  groupId: string;
  userId: string;
  saveConversation: (key: string) => Promise<void>;
  log: (message: string) => void;
}

/**
 * Reads this device's membership of `groupId` from OpenMLS - the authoritative fact.
 *
 * THREE ANSWERS, NOT TWO, and the third is the point. `true` we are a member, `false` a Remove
 * commit named us, `null` the local state could not say - a group this device does not hold throws
 * here, and collapsing that into `false` would retire conversations it had merely not loaded yet.
 * Every caller must decide what to do about `null` for itself; none of them may treat it as a "no".
 *
 * This is the fact `verifyCurrentUserMembership` consults before it asks the delivery service, and
 * the reason it can: the answer is local, durable and free, and the server's own membership
 * endpoint is members-only - so on the one question that matters it is certain to refuse.
 *
 * The swallowed branch logs, and names its caller through `context`: it is the branch that would
 * hide an eviction, so a run must be able to see which decision it was about to inform.
 */
export async function readLocalMembership(deps: {
  mlsService: Pick<IMlsService, 'isGroupActive'>;
  groupId: string;
  /** What was about to be decided, spliced into the log line ("after a commit"). */
  context: string;
  log: (message: string) => void;
}): Promise<boolean | null> {
  const { mlsService, groupId, context, log } = deps;
  try {
    return await mlsService.isGroupActive(groupId);
  } catch (e) {
    log(`[EVICT] Membership of ${groupId.slice(0, 8)}… could not be read ${context}: ${String(e)}`);
    return null;
  }
}

/**
 * Retires the conversation if this device is no longer a member of the group.
 *
 * Returns true when this call performed the transition, false when the device is still a member,
 * the conversation was already retired, or membership could not be read. Idempotent: the retire
 * itself is a no-op on a conversation already in `removed`, so a replayed commit costs one query.
 *
 * A failure to READ membership is deliberately not treated as an eviction. The two are opposite
 * facts and only one of them retires a conversation; an unheld group throws here, and answering
 * "evicted" to that would retire conversations this device simply had not loaded yet.
 */
export async function retireIfEvicted(deps: EvictionCheckDeps): Promise<boolean> {
  const { mlsService, conversations, groupId, userId, saveConversation, log } = deps;
  // `null` is NOT an eviction: a membership query is not the point of the path this runs on, and the
  // send-path backstop in the outbox is what would find a missed eviction, one refused message
  // later. `readLocalMembership` owns the log for that branch.
  const active = await readLocalMembership({ mlsService, groupId, context: 'after a commit', log });
  if (active !== false) return false;

  const retired = markConversationDeletedRemotely(conversations, groupId, userId, saveConversation);
  log(
    retired
      ? `[EVICT] Removed from ${groupId.slice(0, 8)}… by a Remove commit - conversation retired`
      : `[EVICT] Removed from ${groupId.slice(0, 8)}… - already retired, nothing to do`
  );
  return retired;
}

/**
 * Whether the row itself already records that this device is OUT of the group - so the delivery
 * service must not be asked anything that only a member may ask.
 *
 * WHY A SECOND READER OF THE SAME FACT. `readLocalMembership` answers the question for a caller
 * that can afford an async round-trip into OpenMLS and that has something to do with all three of
 * its answers. The roster loader has neither: it runs on every conversation SELECTION, it wants one
 * cheap yes/no, and the only thing it can do with "no" is show no roster. `lifecycle === 'removed'`
 * is that yes/no, it is durable, it is already in the row the caller is holding, and it is written
 * in exactly one place (`retireConversation`) from the Remove commit that is authoritative.
 *
 * IT EXISTS BECAUSE THE GUARD WAS PUT ON ONE OF TWO DOORS. On 2026-08-23 the membership check
 * stopped asking `GET /api/mls/groups/:id/members` on a device holding a Remove commit, because
 * that endpoint is members-only BY DESIGN and could only refuse. `loadGroupMembers` reaches the
 * same endpoint, is fired by the same two selection paths one line above that check, and had no
 * guard of any kind - so a removed device selecting its retired conversation still logged the same
 * 403, and GRP-3 still recorded it on 2026-08-24. Fixing a call site is not fixing a seam.
 *
 * IT COVERS A DEPARTURE THIS DEVICE CHOSE, and only because the departure states the fact before
 * it acts. A leave and a delete are not learnt from a commit - the device decides - and they used
 * to record that decision LAST, after the server call and the WASM forget, which left a window in
 * which the row still read as live while the membership behind it was already gone. `$effect`s over
 * the conversations map fire inside that window, so the same 403 came back a third time (GRP-6,
 * 2026-08-24). `exitGroupAndCleanup` now retires first and purges last; this predicate did not have
 * to widen, and a third call-site guard was not what was missing.
 *
 * A retired conversation has no roster this device is entitled to know, so `false` here is the
 * ANSWER and not a fallback: the absence is what the UI should render.
 *
 * `undefined` - a group id naming no row - is deliberately not "lost". Nothing is recorded about
 * it, and suppressing a request on the strength of a missing row would hide a real lookup bug.
 */
export function membershipIsDurablyLost(
  convo: Pick<Conversation, 'lifecycle'> | undefined
): boolean {
  return convo?.lifecycle === 'removed';
}
