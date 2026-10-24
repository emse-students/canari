import { showToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';
import { answerJoinRequest, type JoinRequest } from './joinRequests.svelte';

/**
 * A member's answer to a new person asking to join, from either place the ask is shown - the global
 * banner and the card in the conversation (`JoinRequestBanner`, `JoinRequestRow`). One path, so the
 * two cannot disagree about what a failed answer says: the ask stays on screen and a toast tells the
 * member it did not go through (`answerJoinRequest` names why in the log).
 *
 * @returns whether the answer went through.
 */
export async function answerJoinRequestOrToast(
  request: JoinRequest,
  choice: 'approve' | 'decline'
): Promise<boolean> {
  const done = await answerJoinRequest(request, choice);
  if (!done) showToast(m.join_request_failed(), 'error');
  return done;
}
