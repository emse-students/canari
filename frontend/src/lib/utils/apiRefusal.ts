import { m } from '$lib/paraglide/messages';

/**
 * THE SENTENCE A REFUSED API WRITE READS AS, CHOSEN FROM THE STATUS AND THE OPERATION.
 *
 * A server exception's message is DEV-FACING and English, like every other log and error in this
 * tree, and that is correct for it. What is not correct is a client treating `error.message` as
 * display copy: nothing types a string as user-visible, so no compiler catches it, and a 4xx the
 * API answered in English reached a French reader verbatim. The cure is the standing rule about
 * never branching on an error MESSAGE, applied one step earlier - classify at the THROW as a type,
 * and build the sentence here from what the type carries.
 *
 * **NO `detail` SLOT, AND THAT IS THE POINT.** The proven mapper this generalises -
 * `toUiActionError` in `useChannelWorkspaces` - interpolates the backend's own words into its 403
 * and its generic arm. That is a deliberate decision in that module and it is not copied here: a
 * helper whose whole purpose is to keep prose that crossed the network away from a reader must not
 * offer a slot to put it back in.
 *
 * **IT RETURNS `null` RATHER THAN GUESSING**, the shape `describeCommunityRefusal` already
 * established. A status this function has nothing better to say about leaves the caller's own
 * generic line in place - which is safe - instead of inventing a reason the server never gave.
 *
 * @param status The HTTP status the refusal carried, or null/undefined when the error is not one
 *   of ours and therefore carries none. An absent status is a question nobody answered, never a
 *   default: it returns `null` here.
 * @param action Localized label for what the user was trying to do (e.g. `m.calendar_action_deposit()`).
 * @returns A localized sentence, or `null` when the status says nothing worth saying.
 */
export function describeApiRefusal(
  status: number | null | undefined,
  action: string
): string | null {
  switch (status) {
    case 401:
      return m.api_refusal_session({ action });
    case 403:
      return m.api_refusal_forbidden({ action });
    case 404:
      return m.api_refusal_gone({ action });
    case 409:
      return m.api_refusal_conflict({ action });
    case 429:
      return m.api_refusal_rate_limited({ action });
    default:
      // DELIBERATELY NOT A RANGE. A 5xx arm reading "the server broke" would be right about the
      // status and wrong about a 502 from the edge, which is a reachability failure the caller may
      // already classify better than this can - and `isRetryableLoadError` is where that question
      // is answered. 400 is left out for the opposite reason: a validation refusal has a CODE, and
      // a code is more precise than any status, so it must not be answered generically here.
      return null;
  }
}
