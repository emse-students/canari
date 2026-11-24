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
 * What is kept is a SHA-256 DIGEST of the account id with the time of the latest erasure call, never
 * the id: the record only has to answer "was this owner erased", which a digest answers.
 */
import { createHash } from 'crypto';
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

/** The key the record is held under: the digest of the account id, never the id. */
export function erasedOwnerKey(ownerId: string): string {
  return createHash('sha256').update(ownerId, 'utf8').digest('hex');
}

/** A digest as {@link erasedOwnerKey} writes it; anything else read from the index is dropped. */
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
 * A registration for an owner needs an access token of that owner, checked at the request (or, for
 * a form file, by social-service before it calls). Every token is issued before the account was
 * deactivated, and the erasure call comes after the deactivation, so none is still valid
 * `ACCESS_TOKEN_TTL + skew` after the call. An upload session can be addressed for its whole window
 * (`MEDIA_UPLOAD_SESSION_TTL_MS`, 24 h); its `complete` needs a token too, so the token bound already
 * covers it, and the window is the larger of the two so that neither number moving alone shortens it
 * below the other. With today's values: max(62 min, 24 h) = 24 h.
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
