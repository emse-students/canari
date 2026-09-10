import { fetchMyProfile, isGlobalAdmin } from '$lib/stores/user';
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
 */

/**
 * Sends a non-ICM, non-admin visitor to `/chat`, and returns whether it did.
 *
 * A profile that cannot be fetched redirects, on purpose: this runs where the alternative is
 * rendering a feed to somebody whose formation is unknown. That is the one judgement in here, and
 * it was already the behaviour of both copies this replaces.
 */
export async function redirectIfNotFeedAudience(): Promise<boolean> {
  if (isGlobalAdmin()) return false;
  try {
    const profile = await fetchMyProfile();
    if (profile.formation === 'ICM') return false;
  } catch {
    /* unknown formation is treated as not in the audience - see above */
  }
  await goto('/chat', { replaceState: true }).catch(() => {});
  return true;
}
