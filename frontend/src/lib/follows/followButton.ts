/**
 * THE PROFILE'S FOLLOW BUTTON, AS DATA: three states, what a tap does in each, and what a refusal
 * reads as. Kept out of the page so the rules are tested without mounting it.
 *
 * - no row: "Suivre" - the tap ASKS, and the button shows the request at once ("Demande envoyee").
 * - `pending`: "Demande envoyee" - the tap WITHDRAWS the request, nothing asked.
 * - `accepted`: "Abonne" - the tap UNFOLLOWS after a confirmation, because following again means
 *   asking again (every personal account is private).
 */
import { m } from '$lib/paraglide/messages';
import {
  FOLLOW_BLOCKED,
  FOLLOW_DAILY_LIMIT,
  FOLLOW_PENDING_LIMIT,
  FOLLOW_TARGET_NOT_FOUND,
  type FollowStatus,
} from './api';

/** What a tap on the button does, given where the reader stands. */
export type FollowAction = 'ask' | 'withdraw' | 'unfollow';

/** The action a tap takes from `status`. */
export function followActionOf(status: FollowStatus | null): FollowAction {
  if (status === 'accepted') return 'unfollow';
  if (status === 'pending') return 'withdraw';
  return 'ask';
}

/**
 * The status the button shows the moment it is tapped, before the server answers - the label flips
 * on the tap (a dead control on a bad link reads as a broken one), and a refusal puts it back.
 */
export function optimisticStatusAfter(action: FollowAction): FollowStatus | null {
  return action === 'ask' ? 'pending' : null;
}

/** The button's label for `status`. */
export function followLabel(status: FollowStatus | null): string {
  if (status === 'accepted') return m.profile_public_following_btn();
  if (status === 'pending') return m.profile_follow_requested_btn();
  return m.profile_public_follow_btn();
}

/**
 * The sentence a refused tap reads as, from the refusal's CODE - never its message. A block is
 * worded neutrally: it never says which side blocked.
 */
export function describeFollowRefusal(code: string | null): string {
  if (code === FOLLOW_BLOCKED) return m.refusal_follow_blocked();
  if (code === FOLLOW_TARGET_NOT_FOUND) return m.refusal_follow_target_not_found();
  if (code === FOLLOW_PENDING_LIMIT) return m.refusal_follow_pending_limit();
  if (code === FOLLOW_DAILY_LIMIT) return m.refusal_follow_daily_limit();
  return m.profile_follow_error();
}
