import { FollowerTabCommitError } from '$lib/mls-client/commitSubmission';
import { reportFollowerTabRefusal } from '$lib/utils/chat/conversationRefusalMessage';

/**
 * Handles a key-group create or join this tab may not do ({@link FollowerTabCommitError}, thrown by
 * `BaseMlsService.createGroup` and `externalJoin`). Only the leader tab writes this device's MLS
 * state, so the group is the main tab's to enter, and this tab goes on without it - its sends are
 * refused by the same leadership fact.
 *
 * A GESTURE says so to the member (`reportFollowerTabRefusal`); a LOAD says it in the log only,
 * since every follower tab meets it on every load and the member asked for nothing. Anything else
 * is rethrown untouched, so it reaches the handling it had before.
 *
 * @param e - what the create or join threw.
 * @param what - the group, as the log names it.
 * @param how - a member's gesture, or a load with the log it writes to.
 */
export function leaveKeyGroupToMainTab(
  e: unknown,
  what: string,
  how: { gesture: true } | { gesture: false; log: (message: string) => void }
): void {
  if (!(e instanceof FollowerTabCommitError)) throw e;
  if (how.gesture) {
    reportFollowerTabRefusal(e);
    return;
  }
  how.log(`[GRAINE] ${what}: not entered in a follower tab - the main tab enters it`);
}
