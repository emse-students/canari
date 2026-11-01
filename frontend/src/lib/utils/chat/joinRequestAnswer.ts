import { showToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';
import { answerJoinRequestOutcome, type JoinRequest } from './joinRequests.svelte';

/**
 * A member's answer to a new person asking to join, from the line the ask is drawn as in its
 * conversation (`JoinRequestRow`). One path, so an answer always says the same thing: the ask stays
 * on screen until it is settled, and the toast says WHY it did not go through
 * (`answerJoinRequestOutcome` names the cause, as a type, never from prose).
 *
 * A failure of the member's own answer says "try again". When ANOTHER MEMBER is the cause - their Add
 * holds the lock, or their answer settled the ask first - the member is told that, and nothing broke:
 * the settlement frame clears the card by itself.
 *
 * @returns whether the answer went through.
 */
export async function answerJoinRequestOrToast(
  request: JoinRequest,
  choice: 'approve' | 'decline'
): Promise<boolean> {
  const outcome = await answerJoinRequestOutcome(request, choice);
  switch (outcome) {
    case 'done':
      return true;
    case 'busy':
      showToast(m.join_request_other_member_answering(), 'info');
      return false;
    case 'raced':
      showToast(m.join_request_other_member_answered(), 'info');
      return false;
    case 'failed':
      showToast(m.join_request_failed(), 'error');
      return false;
  }
}
