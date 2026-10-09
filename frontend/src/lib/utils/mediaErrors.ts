/**
 * The single classification of "this media is gone for good".
 *
 * Chat media (retention class `ephemeral`) are garbage-collected server-side after 90 days without
 * an access - every other class, and an object with none, is kept (media-service `isSweepable`) -
 * so a download can fail for a reason no retry, no reload and no other device can repair. That is a DIFFERENT
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
import { SegmentedMediaError, isWrittenByNewerClient } from '$lib/mediaSegmented';

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
 * The media service never answered: the request failed in transport (offline, captive portal, DNS,
 * TLS, a dropped connection). Retrying can repair it, and the reader's network is what to check.
 *
 * Thrown where `fetch` rejects, so the cause is decided by the layer that SAW it - a `TypeError`
 * from `fetch` carries no field saying "network", and reading its message would be prose.
 */
export class MediaUnreachableError extends Error {
  constructor(cause: unknown) {
    super('Media service unreachable', { cause });
    this.name = 'MediaUnreachableError';
  }
}

/** The media service answered 404: no object by that id - deleted, or never uploaded. Permanent. */
export class MediaNotFoundError extends Error {
  constructor() {
    super('Media not found (404)');
    this.name = 'MediaNotFoundError';
  }
}

/** Any other non-2xx answer to a download. The status is carried, never spelled into prose. */
export class MediaDownloadError extends Error {
  constructor(readonly status: number) {
    super(`Media download failed: ${status}`);
    this.name = 'MediaDownloadError';
  }
}

/**
 * The bytes arrived and do not decrypt: the AES-GCM tag refused them, so they are damaged or were
 * altered in storage. `crypto.subtle` rejects with a bare `OperationError`, which says nothing a
 * catch three components away could tell from any other DOMException - so it is named here.
 */
export class MediaDecryptError extends Error {
  constructor(cause: unknown) {
    super('Media ciphertext failed to decrypt', { cause });
    this.name = 'MediaDecryptError';
  }
}

/**
 * Why a media could not be shown, as the ONE vocabulary every renderer speaks.
 *
 * - `unreachable`: transport failure - retry, check the network.
 * - `expired`: purged by retention (410) - permanent, never in red.
 * - `not-found`: 404 - permanent.
 * - `corrupt`: downloaded but failed to decrypt - a retry re-downloads (the cached copy is evicted).
 *   A segmented stream's refusal (`SegmentedMediaError`: a segment whose tag fails, a blob shorter
 *   or longer than its header) is this cause too, thrown raw by the streaming reader - except an
 *   encoding or header version written by a NEWER client, which is `other`: nothing is damaged.
 * - `other`: anything else (a 5xx, an unexpected throw) - retry.
 */
export type MediaFailureCause = 'unreachable' | 'expired' | 'not-found' | 'corrupt' | 'other';

/**
 * Classifies a rejection caught around a media download - by TYPE, never by message.
 *
 * The only reader of the classes above, exactly as `isMediaPurgedError` is of its own; a renderer
 * switches on the answer and nothing else.
 *
 * @param err  Any rejection value caught around a media download.
 */
export function mediaFailureCause(err: unknown): MediaFailureCause {
  if (err instanceof MediaPurgedError) return 'expired';
  if (err instanceof MediaNotFoundError) return 'not-found';
  if (err instanceof MediaUnreachableError) return 'unreachable';
  if (err instanceof MediaDecryptError) return 'corrupt';
  if (err instanceof SegmentedMediaError) return isWrittenByNewerClient(err) ? 'other' : 'corrupt';
  return 'other';
}

/** Whether trying again can change the answer. A 404 and a retention purge cannot. */
export function isRetryableMediaFailure(cause: MediaFailureCause): boolean {
  return cause !== 'expired' && cause !== 'not-found';
}

/**
 * The one log line of a media that could not be shown, at the level its cause deserves.
 *
 * A purge or a 404 is the server's ANSWER about an object, expected and permanent: a `warn`. Every
 * other cause is a failure of this path and is logged as one. The cause leads the line so a log
 * read in the field separates them without opening the error.
 */
export function logMediaFailure(
  where: string,
  cause: MediaFailureCause,
  mediaId: string,
  err: unknown
): void {
  const line = `[${where}] media not shown (${cause})`;
  if (isRetryableMediaFailure(cause)) console.error(line, mediaId, err);
  else console.warn(line, mediaId, err);
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
  constructor(
    status: number,
    message: string,
    /**
     * WHO ANSWERED, read from the response's Content-Type at the throw. `gateway`: an HTML page,
     * which the application never produces (its refusals are JSON) - the host's WAF or a proxy
     * speaking, e.g. the CrowdSec ban page a body over 10 MiB earns. `app`: our own service.
     */
    readonly origin: 'app' | 'gateway' = 'app'
  ) {
    super(status, null, message);
    this.name = 'MediaUploadError';
  }
}

/**
 * Builds the typed refusal for a non-2xx answer to an upload. The sentence is for logs: it carries
 * the status and, for the application's own JSON answers only, a short excerpt - NEVER the HTML of
 * a gateway page (it was 5.75 KB of ban page in every retry line). Nothing reads it back.
 */
export async function uploadRefusalFrom(res: Response, what: string): Promise<MediaUploadError> {
  const contentType = res.headers?.get('Content-Type') ?? '';
  const origin = /text\/html/i.test(contentType) ? 'gateway' : 'app';
  const text = origin === 'app' ? await res.text().catch(() => '') : '';
  const excerpt = text ? ` - ${text.slice(0, 160)}` : '';
  return new MediaUploadError(
    res.status,
    `${what} (${res.status}${origin === 'gateway' ? ', answered by the gateway, not the app' : ''})${excerpt}`,
    origin
  );
}

/**
 * Why an upload was REFUSED for good, or `null` when trying again could change the answer.
 *
 * AN ANSWER IS NEVER TRANSIENT: the server (or the gateway in front of it) has said no to THIS
 * request, and sending the same bytes again asks the same question. Read from the TYPE the throw
 * carried (status and origin), never from its message.
 *
 * - `too-large`: 413.
 * - `blocked`: a 4xx from the GATEWAY (the host WAF's ban page): the body or the sender was refused
 *   before the application saw it (a 429 from it is still "later", not a ban).
 * - `refused`: any other 4xx from the application, except the ones a retry can mend: 401 (the token
 *   is renewed once by `fetchUpload`), 408, 425 and 429 (the server says "later").
 *
 * A 5xx, a deadline, a network error: `null`, retried with backoff as before.
 */
export function uploadRefusalCause(err: unknown): 'too-large' | 'blocked' | 'refused' | null {
  if (!(err instanceof MediaUploadError)) return null;
  const { status } = err;
  if (status === 413) return 'too-large';
  if (status < 400 || status >= 500) return null;
  if ([408, 425, 429].includes(status)) return null;
  if (err.origin === 'gateway') return 'blocked';
  return status === 401 ? null : 'refused';
}
