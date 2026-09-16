/**
 * The single classification of "this media is gone for good".
 *
 * Media are garbage-collected server-side after 30 days without an access, so a download can
 * fail for a reason no retry, no reload and no other device can repair. That is a DIFFERENT
 * fact from "the download failed", and every surface that renders media has to be able to tell
 * them apart - otherwise a permanent absence is displayed as a transient error, which is a lie
 * the user acts on (they retry, they blame the network, they ask the sender to resend).
 *
 * WHY A CLASS AND NOT A STRING
 * ----------------------------
 * The server answers 410 and the transport layer used to throw `new Error('MEDIA_PURGED_...')`,
 * leaving each call site to sniff the message with `String.includes`. Branching on an error
 * MESSAGE is branching on prose: it survives no refactor, no wrapper, and no translation, and
 * the one surface that did it was the only surface that handled the case at all - the other
 * three rendered a generic failure, and one of them printed the raw token to the user.
 * The type is the contract; `isMediaPurgedError` is the only reader of it.
 */

import { ApiRefusalError } from './apiRefusal';

/** Wire-level marker kept as the message so existing logs stay greppable. */
export const MEDIA_PURGED_MESSAGE = 'MEDIA_PURGED_BY_RETENTION';

/** Thrown when the media service answers 410: the blob was purged by the retention policy. */
export class MediaPurgedError extends Error {
  constructor() {
    super(MEDIA_PURGED_MESSAGE);
    this.name = 'MediaPurgedError';
  }
}

/**
 * True when a rejection means "purged by retention" rather than "the download failed".
 *
 * @param err  Any rejection value caught around a media download.
 */
export function isMediaPurgedError(err: unknown): boolean {
  return err instanceof MediaPurgedError;
}

/**
 * A refusal answered by the media service on the way UP, carrying the STATUS instead of spelling it.
 *
 * THE SAME ARGUMENT AS `MediaPurgedError` ABOVE, one direction later. The five `!res.ok` sites in
 * `MediaService` threw a plain `Error` whose message held the number, and one of them was worse
 * than that: `Media upload failed: 413 (fichier trop volumineux)` put French words inside a
 * dev-facing English sentence, which was then interpolated whole into a French sentence on screen.
 * **NOTHING read that 413 back out.** The special case existed only to write a different string, so
 * the one refusal a member can act on - your file is too big - was, to the code, indistinguishable
 * from a 500.
 *
 * It lives HERE rather than beside the throws so that a screen mapping an upload failure does not
 * have to import `MediaService` to name the type. That is not hypothetical: `$lib/media` sits in a
 * module cycle (`media` -> `mediaBlobCache` -> `mediaTouch` -> `globalChatSingleton` ->
 * `useMessaging` -> `media`), so importing it first is enough to construct `MediaService` before
 * its own module has finished evaluating.
 */
export class MediaUploadError extends ApiRefusalError {
  constructor(status: number, message: string) {
    super(status, null, message);
    this.name = 'MediaUploadError';
  }
}
