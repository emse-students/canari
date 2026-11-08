import { FollowerTabCommitError } from '$lib/mls-client/commitSubmission';
import { getTabLeadership } from '$lib/mls-client/tabLeader';
import {
  reportDelegationRefusal,
  reportFollowerTabRefusal,
} from '$lib/utils/chat/conversationRefusalMessage';
import {
  delegateCommitToLeader,
  type DelegatedCommitOp,
} from '$lib/utils/chat/tabCommitDelegation';

/**
 * Enters a community's or a salon's key group on a member's GESTURE (creating a community or a
 * salon, joining a salon).
 *
 * Decided by the ROLE, read before anything is asked: only the leader tab writes this device's MLS
 * state, so a FOLLOWER hands the entry to the leader (`tabCommitDelegation.ts`), which runs the same
 * idempotent entry on its own state; the member is told only when the main tab could not answer
 * (`reportDelegationRefusal`). The leader enters here. A tab DEMOTED between the read and the commit
 * is refused by the service ({@link FollowerTabCommitError}) and told so; anything else is rethrown
 * untouched, to the handling it had before.
 *
 * @param op - the entry, as the leader would run it.
 * @param enterHere - the same entry, run in this tab when it leads.
 */
export async function enterKeyGroupOnGesture(
  op: Extract<DelegatedCommitOp, { kind: 'enter-community-key-group' | 'enter-salon-group' }>,
  enterHere: () => Promise<void>
): Promise<void> {
  if (getTabLeadership() === 'follower') {
    const answer = await delegateCommitToLeader(op);
    if (answer.status === 'refused') reportDelegationRefusal(answer.reason);
    return;
  }
  try {
    await enterHere();
  } catch (e) {
    if (!(e instanceof FollowerTabCommitError)) throw e;
    reportFollowerTabRefusal(e);
  }
}

/**
 * Handles a key-group create or join a LOAD met in a follower tab ({@link FollowerTabCommitError},
 * thrown by `BaseMlsService.createGroup` and `externalJoin`). Every follower tab meets it on every
 * load and the member asked for nothing, so it is said in the log only: the main tab's own load
 * enters the group. Anything else is rethrown untouched, so it reaches the handling it had before.
 *
 * @param e - what the create or join threw.
 * @param what - the group, as the log names it.
 * @param log - the load's log.
 */
export function leaveKeyGroupToMainTab(
  e: unknown,
  what: string,
  log: (message: string) => void
): void {
  if (!(e instanceof FollowerTabCommitError)) throw e;
  log(`[GRAINE] ${what}: not entered in a follower tab - the main tab enters it`);
}
