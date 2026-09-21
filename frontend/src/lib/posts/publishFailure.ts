/**
 * WHAT TO SHOW A READER WHOSE WRITE WAS REFUSED, AND WHY IT IS NOT ONE SENTENCE PER SCREEN.
 *
 * `publishPost` can fail seven ways. FIVE of them already had their own translated sentence at the
 * throw - the content is empty, the media token could not be minted, a poll has no options, a form
 * was not chosen, moderation refused - and one `catch` replaced all five with
 * `m.post_create_publish_error()`: "could not publish the post". A member reported exactly that on
 * a phone on 2026-09-21, and the sentence they were given could not distinguish the seven causes,
 * so the report could not either. Production settled only what it could see: no `POST /api/posts`
 * reached nginx in the whole hour, and `social-service` logged nothing - the failure happened
 * entirely on the device, and the device threw its reason away.
 *
 * So the rule that governs every other seam here applies: **classify at the THROW, as a type.** The
 * five sentences travel as {@link LocalizedError}; moderation travels as `MutedError`, because its
 * message is dev prose and each screen picks its own line; and a transport failure travels as
 * whatever `apiFetch` rejected with.
 *
 * THE THIRD BRANCH IS WHY THIS IS SHARED RATHER THAN INLINE. `PostCard.handleReaction` wraps
 * `assertNotMuted()` alone and shows `m.post_action_not_allowed()` for anything it throws - so a
 * reader whose radio dropped was told they are RESTRICTED BY MODERATION, which is not merely vague,
 * it is false and about them. One screen getting the mapping right does not help the next one, and
 * there are three.
 *
 * WHAT STAYS ON THE FALLBACK is deliberate and small: a refusal from the write itself, and anything
 * the media pipeline throws. Both are dev prose in English, both belong in the console, and neither
 * is a distinction the reader can act on. A fallback is a signal, so the composer logs the STAGE
 * beside it - which is the half that turns the next report into a lookup instead of a dig.
 */
import { m } from '$lib/paraglide/messages';
import { MutedError } from '$lib/moderation/muteCheck';
import { isTransportFailure } from '$lib/stores/connectivity.svelte';
import { localizedMessage } from '$lib/utils/localizedError';

/**
 * The step the composer had reached, so a failure names WHERE and not only THAT.
 *
 * A value and not a stack trace on purpose: the line has to be readable in an in-app log export
 * from a phone, which is where this one would have been read.
 */
export type PublishStage =
  | 'moderation'
  | 'content'
  | 'mediaToken'
  | 'mediaUpload'
  | 'poll'
  | 'form'
  | 'createPost';

/**
 * The sentence to show for a refused write, in the reader's language.
 *
 * @param error Whatever the screen caught.
 * @param fallback The localized line this screen declares for everything else - required rather
 *   than optional, for the same reason {@link localizedMessage} requires one: "could not publish",
 *   "could not comment" and "action not allowed" are three different screens and no default is
 *   right on all three.
 * @returns A sentence in the reader's language, never dev prose.
 */
export function publishFailureMessage(error: unknown, fallback: string): string {
  // Moderation first: it is reached through a transport that WORKED, and its message is dev prose,
  // so neither branch below would answer it correctly.
  if (error instanceof MutedError) return m.post_action_not_allowed();
  // "We could not ASK" is not "we asked and were told no", and it is the only cause here a reader
  // can act on. The sentence is `auth_`-prefixed for historical reasons and says nothing about
  // auth; a second key carrying the same French line would be a second thing to translate.
  if (isTransportFailure(error)) return m.auth_server_unreachable();
  return localizedMessage(error, fallback);
}
