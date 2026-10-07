import { resolve } from '$app/paths';
import { isGlobalAdmin } from '$lib/stores/user';
import { feedAudienceState, setFeedAudience } from '$lib/stores/userState.svelte';
import { fetchFeedAudience } from '$lib/posts/api';
import { goto } from '$app/navigation';
import { Log } from '$lib/utils/Log';
import { refusalStatus } from '$lib/utils/apiRefusal';

/**
 * WHO MAY SEE THE SOCIAL FEED, ON THE CLIENT SIDE - ASKED, NOT RESTATED.
 *
 * The rule lives on the server, once (`apps/social-service/src/spaces/reader-spaces.ts`): a global
 * admin, anybody with a space (a cursus formation on their own campus), or a member of at least
 * one association (WP6b, docs/wiki/profiles-and-access.md). Until WP6b this file carried its own
 * copy - a test of the profile's formation against one literal - and a copy in a second language
 * is the one that drifts; memberships are not even on the profile. So the client asks
 * `GET /api/posts/audience`, which runs the very SQL `FeedAudienceGuard` refuses with, and the two
 * cannot disagree.
 *
 * WHAT THIS IS NOT. It is a REDIRECT, not an authorization: the guard is what keeps a reader out,
 * and which posts a reader gets is decided per post by the server. This only decides whether the
 * browser shows the feed page or sends the reader to `/chat`.
 *
 * AND IT IS NOT A ROUND TRIP BEFORE FIRST PAINT, SINCE 2026-09-23. It used to await a request
 * before the feed route's `load` created its posts promise at all, so every tap on the Fil tab spent
 * a full latency before anything could paint - 2045 ms to first paint under a shaped 1500 ms/64 kbps
 * link against 262 ms unshaped. The verdict is remembered per account
 * ([`feedAudienceState`](../stores/userState.svelte.ts)) and revalidated behind the render instead.
 */

/**
 * What the server's answer says about this reader, or `null` when the body is not the answer.
 *
 * `=== true` and `=== false` only: a body of any other shape is not a statement about anybody, and
 * reading it as `false` would eject a reader from the feed on a malformed response.
 */
export function verdictFromAnswer(body: unknown): boolean | null {
  if (!body || typeof body !== 'object') return null;
  const inAudience = (body as { inAudience?: unknown }).inAudience;
  return typeof inAudience === 'boolean' ? inAudience : null;
}

/**
 * Asks the server and records what it says, leaving the remembered verdict alone on any failure.
 * Never throws: it is called without being awaited.
 *
 * A STATUS CODE IS AN ANSWER, A TRANSPORT FAILURE IS NOT - and this endpoint never refuses a
 * signed-in reader (it answers `inAudience: false`), so every failure here is the transport, an
 * expired session the auth layer handles, or a server fault. None of them says who this person is.
 */
export async function revalidateFeedAudience(): Promise<boolean | null> {
  try {
    const verdict = verdictFromAnswer(await fetchFeedAudience());
    if (verdict === null) {
      Log.d('FeedAudience', 'the audience answer was not a boolean - verdict kept');
      return null;
    }
    setFeedAudience(verdict);
    return verdict;
  } catch (error) {
    // The error itself as the payload: `Log` renders an Error's own text, an object holding one
    // would print `{}`.
    Log.d('FeedAudience: could not ask the server - verdict kept', error);
    return null;
  }
}

/**
 * Sends a visitor outside the feed audience to `/chat`, and returns whether it did.
 *
 * ONLY A KNOWN VERDICT REDIRECTS. A reader whose verdict has never been established waits for the
 * first answer, because there is nothing to render from; from then on the remembered one decides
 * immediately and the fresh one lands behind the page. A verdict that stays unknown - first ever
 * visit, on a dead link - keeps the reader here, which is what the layout does one level up.
 */
export async function redirectIfNotFeedAudience(): Promise<boolean> {
  if (isGlobalAdmin()) return false;

  let verdict = feedAudienceState();
  if (verdict === null) verdict = await revalidateFeedAudience();
  else void revalidateFeedAudience();

  if (verdict !== false) return false;
  await goto(resolve('/chat'), { replaceState: true }).catch(() => {});
  return true;
}

/** The pure classification: a 403 from the feed read, by status. */
export function isFeedAudienceRefusal(error: unknown): boolean {
  return refusalStatus(error) === 403;
}

/**
 * Whether a failed feed read is the server's "this reader is outside the audience" answer.
 *
 * `FeedAudienceGuard` refuses a signed-in reader with no space and no association with a 403, and
 * a 403 is an ANSWER about the reader, not a failure of the feed. Classified by STATUS, never by
 * the guard's sentence. When it is one, the refusal also corrects the remembered verdict: the page
 * rendered from a stale `true` (or an unknown one), so the next visit must redirect.
 *
 * Any other failure (transport, 5xx, 401) is NOT a verdict and keeps the generic error.
 */
export function isOutsideFeedAudience(error: unknown): boolean {
  if (!isFeedAudienceRefusal(error)) return false;
  Log.d('FeedAudience: the feed answered 403 - reader is outside the audience, verdict corrected');
  setFeedAudience(false);
  return true;
}
