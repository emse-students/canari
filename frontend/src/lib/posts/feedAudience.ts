import {
  fetchMyProfile,
  isAbsentUserError,
  isGlobalAdmin,
  type UserProfile,
} from '$lib/stores/user';
import { feedAudienceState, setFeedAudience } from '$lib/stores/userState.svelte';
import { goto } from '$app/navigation';

/**
 * WHO MAY SEE THE SOCIAL FEED, ON THE CLIENT SIDE, STATED ONCE.
 *
 * The rule is "ICM students, plus global admins", and until 2026-09-10 it was written out twice -
 * the same eleven lines in `routes/posts/+page.ts` and `routes/posts/[postId]/+page.ts`, including
 * the same two `catch` branches and the same redirect target. Announcing posts made the server
 * need the rule too (`apps/social-service/src/posts/feed-audience.ts`), and three copies of one
 * decision is the point at which the decision stops being changeable.
 *
 * WHAT THIS IS NOT. It is a REDIRECT, not an authorization: the API answers `GET /api/posts` to
 * anybody who asks, and no backend gate exists. Moving the check to the server is owed and open
 * ([backlog](../../../../docs/wiki/backlog.md)); until it happens, this decides what a browser
 * SHOWS and the server's twin decides who gets TOLD, and neither one keeps anybody out.
 *
 * AND IT IS NOT A ROUND TRIP, SINCE 2026-09-23. It used to await `GET /api/users/me` before the
 * feed route's `load` created its posts promise at all, so every tap on the Fil tab spent a full
 * latency before anything at all could paint - 2045 ms to first paint under a shaped 1500 ms/64
 * kbps link against 262 ms unshaped, on an account whose feed was then EMPTY. The verdict is
 * remembered per account ([`feedAudienceState`](../stores/userState.svelte.ts)) and revalidated
 * behind the render instead.
 */

/** The one formation string the feed is addressed to. */
const FEED_FORMATION = 'ICM';

/** What a profile the server answered with says about this reader. */
export function verdictFromProfile(profile: Pick<UserProfile, 'formation'>): boolean {
  return profile.formation === FEED_FORMATION;
}

/**
 * What a failed profile fetch says about this reader, or `null` when it says nothing.
 *
 * A STATUS CODE IS AN ANSWER, A TRANSPORT FAILURE IS NOT, and this used to conflate them: the old
 * `catch` redirected on everything, so a reader on a train was ejected from the feed to `/chat` by
 * a timeout. Only a 404 - the account is gone - is a statement about who this person is. This
 * mirrors `routes/+layout.ts`, which reached the same split for the same endpoint and is the
 * reference implementation rather than a second opinion.
 */
export function verdictFromFailure(error: unknown): boolean | null {
  return isAbsentUserError(error) ? false : null;
}

/**
 * Asks the server and records what it says, leaving the remembered verdict alone on a failure
 * that is not an answer. Never throws: it is called without being awaited.
 */
export async function revalidateFeedAudience(): Promise<boolean | null> {
  try {
    const verdict = verdictFromProfile(await fetchMyProfile());
    setFeedAudience(verdict);
    return verdict;
  } catch (error) {
    const verdict = verdictFromFailure(error);
    if (verdict !== null) setFeedAudience(verdict);
    return verdict;
  }
}

/**
 * Sends a non-ICM, non-admin visitor to `/chat`, and returns whether it did.
 *
 * ONLY A KNOWN VERDICT REDIRECTS. A reader whose formation has never been established once waits
 * for the first answer, because there is nothing to render from; from then on the remembered one
 * decides immediately and the fresh one lands behind the page. A verdict that stays unknown -
 * first ever visit, on a dead link - keeps the reader here, which is what the layout does one
 * level up and the opposite of what this used to do.
 */
export async function redirectIfNotFeedAudience(): Promise<boolean> {
  if (isGlobalAdmin()) return false;

  let verdict = feedAudienceState();
  if (verdict === null) verdict = await revalidateFeedAudience();
  else void revalidateFeedAudience();

  if (verdict !== false) return false;
  await goto('/chat', { replaceState: true }).catch(() => {});
  return true;
}
