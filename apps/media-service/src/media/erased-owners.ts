/**
 * THE RECORD THAT AN OWNER WAS ERASED, and the refusal it answers with
 * (docs/wiki/services/media-service.md#an-erased-owner-registers-nothing-2026-11-24).
 *
 * The account erasure (`DELETE /media/internal/users/:id`) deletes what the account uploaded and
 * answers. Without a record of it, an upload REGISTERED after that answer - a resumable `complete`, a
 * single upload, a chunked `complete`, a form file, made with an access token that was still valid -
 * wrote a live entry carrying the erased id, and nothing erased it again. The record is what every
 * registering path reads, in the same synchronous run as the entry it would write.
 *
 * What is kept is a PSEUDONYM of the account id - an HMAC under a key derived from this service's
 * `JWT_SECRET` under its own label ({@link erasedOwnerKey}) - with the time of the latest erasure call: the record only has to answer "was this owner erased, and
 * when", which the keyed digest answers without the id.
 *
 * IT REFUSES ONLY WHAT DATES FROM BEFORE THAT CALL. `users.id` is the OIDC subject, and core lets
 * the person sign in again under the same id once every erasure job completed: their new tokens are
 * minted after the latest call, and so are their new upload sessions. The discriminator is that
 * moment ({@link datesFromBeforeTheErasure}), carried from where it is known - the token's `iat`, a
 * session's `createdAt` - so a person who came back is never refused.
 */
import { createHmac } from 'crypto';
import { HttpException, HttpStatus } from '@nestjs/common';
import { uploadSessionTtlMs } from './upload-session';

/** The code of the refusal: a client branches on it, never on the message. */
export const OWNER_ERASED = 'OWNER_ERASED';

/**
 * An upload by, or for, an account whose erasure media-service has recorded: `410`, `code:
 * OWNER_ERASED`. Thrown where the record is read, so every caller gets the same type.
 */
export class OwnerErasedException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.GONE,
        message: 'This account was deleted; nothing more is stored for it.',
        code: OWNER_ERASED,
      },
      HttpStatus.GONE
    );
  }
}

/** The label the record's key is derived under: no other use of `JWT_SECRET` computes this MAC. */
export const ERASED_OWNER_KEY_LABEL = 'canari/media/erased-owner/v1';

/** The derived key, computed once per secret value (a test may change the secret). */
let derived: { secret: string; key: Buffer } | undefined;

/**
 * The key the record is held under: HMAC-SHA256 of the account id under a key DERIVED from
 * `JWT_SECRET` under {@link ERASED_OWNER_KEY_LABEL} - a pseudonym. Never the secret itself: a key
 * signs one kind of thing only (domain separation, as core's `deriveRestoreChallengeKey`), and
 * the raw secret already signs the access tokens.
 *
 * Why derived from THAT secret: the record exists to refuse credentials minted before an erasure,
 * and every one of them is signed with it. Rotating it voids every such credential at once, so the
 * records it makes unreadable have nothing left to refuse - the two lifetimes cannot disagree. A
 * plain digest of an id guessable from the school's directory would be an identifier.
 *
 * @throws Error when `JWT_SECRET` is unset - this service's misconfiguration, which also refuses
 *   every user request (`MediaController.verifyToken`)
 */
export function erasedOwnerKey(ownerId: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not configured: no erased-owner record can be keyed');
  if (derived?.secret !== secret) {
    derived = {
      secret,
      key: createHmac('sha256', secret).update(ERASED_OWNER_KEY_LABEL, 'utf8').digest(),
    };
  }
  return createHmac('sha256', derived.key).update(ownerId, 'utf8').digest('hex');
}

/**
 * Whether the credential an upload rests on - its mint time (`iat`, in ms) - dates from before the
 * latest erasure call `erasedAt`. `undefined` (a token with no `iat`, a server-to-server call
 * carrying no credential) cannot be dated, so it is judged old.
 *
 * Compared at the SECOND, the grain of `iat`: what was minted in the second of the call counts as
 * after it. No skew margin either way, deliberately:
 * - a margin AFTER the call would refuse a person signing in again within it - and the client reads
 *   this refusal as final;
 * - an OLD token passing for new is harmless: tokens are minted before the deactivation, the latest
 *   call is core's final pass, which starts once every one of them has expired - so no live token
 *   is near it - and an earlier call is followed by that pass, which erases what registered meanwhile.
 * core and media-service read one host's clock (one compose estate), so there is no skew between them.
 */
export function datesFromBeforeTheErasure(at: number | undefined, erasedAt: number): boolean {
  if (at === undefined) return true;
  return Math.floor(at / 1000) < Math.floor(erasedAt / 1000);
}

/**
 * Whether an upload session opened at `openedAt` was opened before the latest erasure call. Both are
 * this service's own clock in ms, so compared to the millisecond - at `iat`'s whole-second grain a
 * session opened in the second of the call, just before it, would pass. A session opened before the
 * call stays the erased account's, whatever fresh token completes it.
 */
export function openedBeforeTheErasure(openedAt: number, erasedAt: number): boolean {
  return openedAt < erasedAt;
}

/** A key as {@link erasedOwnerKey} writes it; anything else read from the index is dropped. */
export const ERASED_OWNER_KEY_REGEX = /^[0-9a-f]{64}$/;

/**
 * core-service's `ACCESS_TOKEN_TTL_SECONDS` and `CREDENTIAL_SKEW_SECONDS`
 * (`apps/core-service/src/auth/token-lifetimes.ts`), MIRRORED: `erased-owners.spec.ts` reads that
 * file and fails the day either number there moves away from these.
 */
export const CORE_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const CORE_CREDENTIAL_SKEW_SECONDS = 120;

/**
 * HOW LONG THE RECORD IS KEPT after the LATEST erasure call for that owner - derived, not chosen.
 *
 * It refuses only what dates from before that call ({@link datesFromBeforeTheErasure}), so it must
 * last as long as such a thing can still ask, and no longer matters to anyone else:
 * - an access token: minted before the deactivation, which precedes the call, so none is valid
 *   `ACCESS_TOKEN_TTL + skew` after it;
 * - an upload session: opened before the call, addressable until its absolute window
 *   (`MEDIA_UPLOAD_SESSION_TTL_MS`, 24 h) from its opening - a session `complete` is judged by its
 *   `createdAt` as well as by the token, so this bound is load-bearing on its own.
 * The larger of the two: max(62 min, 24 h) = 24 h today. A person who signed in again is not affected
 * by it: their tokens and sessions date from after the call. The one exception is the form file,
 * which arrives from social-service with no credential to date (see the wiki).
 *
 * What a clock cannot bound - an upload ADMITTED before the token expired and still running - is
 * held by the in-flight count instead (`MediaService.admitUploader`): a record is dropped only when
 * its window passed AND no upload of that owner is running.
 */
export function erasedOwnerKeptMs(): number {
  return Math.max(
    (CORE_ACCESS_TOKEN_TTL_SECONDS + CORE_CREDENTIAL_SKEW_SECONDS) * 1000,
    uploadSessionTtlMs()
  );
}
