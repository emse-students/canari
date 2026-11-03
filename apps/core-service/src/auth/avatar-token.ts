import { Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * THE AVATAR TOKEN - what lets an `<img>` ask `GET /api/users/:id/avatar` as a signed-in viewer.
 *
 * An image request carries no `Authorization` header, and the refresh cookie is scoped to
 * `/api/auth` (and is not kept at all on `tauri://localhost`, where WKWebView drops it), so the
 * avatar route cannot learn who is asking from anything a browser attaches by itself. The token
 * therefore travels IN THE URL, as `?t=`, appended by the one client helper `avatarUrl(userId)`.
 *
 * SHAPE: `<sessionId>.<bucket>.<mac>`, where `bucket` is the UTC day the token was minted in (whole
 * days since the epoch, in decimal) and `mac` is the base64url HMAC-SHA256, under
 * `AVATAR_TOKEN_SECRET`, of `avatar-v1|<sessionId>|<bucket>`. It is minted beside every access token
 * (sign-in, restore, refresh) and verified by `UsersController.getAvatar`.
 *
 * WHAT MAKES A TOKEN VALID IS DURABLE STATE, NOT THE CLOCK. A token is honoured only while the
 * session it names is LIVE (`AuthSessionsService.isLiveSession`, one primary-key read): ending a
 * session - logout, "sign out everywhere", a device revoked, an idle expiry - deletes its row and
 * kills every avatar URL minted for it at the next request, with no clock involved.
 *
 * THE DAY BUCKET IS A CACHE-FRIENDLINESS CHOICE, NOT A TERMINATION PROOF. Signing the session alone
 * would give one URL per face for the whole life of a session; signing every access token would
 * give a new URL (so a new download) every hour. A UTC day keeps every URL stable for a day, so the
 * browser's HTTP cache and its ETag revalidation keep working. Nothing relies on the bucket to END
 * access: the session does.
 *
 * THE BUCKET TRAVELS IN THE TOKEN, so the server never guesses which day was signed: it checks the
 * MAC over the bucket the token NAMES, then honours that bucket if it is yesterday, today or
 * tomorrow by its own clock (a URL minted at 23:59 is not refused at 00:00, and a clock a little
 * ahead is not refused either). A genuine token of another day is told apart from a forged one -
 * `stale` against `bad-signature` - and the client, which reads the bucket too, stops sending a
 * token older than yesterday instead of earning a 403 for it.
 */

/** The prefix inside the MAC, so this secret can never sign anything another use could replay. */
const MAC_DOMAIN = 'avatar-v1';

/** Below this the secret is refused as if unset - the same floor as the estate's other HMAC keys. */
export const AVATAR_TOKEN_SECRET_MIN_LENGTH = 32;

/** A session id is a uuid (`auth-session.entity.ts`); anything else is malformed before any read. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A day bucket in its ONE decimal spelling: no sign, no leading zero, no exponent. */
const BUCKET = /^(?:0|[1-9][0-9]{0,9})$/;

/** A base64url SHA-256 digest: 32 bytes, 43 characters, no padding. */
const MAC = /^[A-Za-z0-9_-]{43}$/;

/** How many day buckets either side of the server's own a signed token may name and be honoured. */
const BUCKET_SKEW = 1;

const logger = new Logger('AvatarToken');
/** Set the first time this process is asked to mint with no usable secret, so it is said once. */
let unconfiguredSaid = false;

/**
 * The `AVATAR_TOKEN_SECRET` of this process, or null when it is unset or shorter than
 * {@link AVATAR_TOKEN_SECRET_MIN_LENGTH}. Read per call, like `INTERNAL_SECRET`, so a test sets it.
 *
 * AN EMPTY KEY, DECIDED EXPLICITLY: with none, NOTHING IS MINTED (the client sends unsigned
 * requests, which phase 1 accepts and logs as `[AVATAR] ... access=unsigned`) and EVERY PRESENTED
 * TOKEN IS REFUSED - a token this process cannot verify is not believed. Every deployed estate makes
 * the secret `required` (`infrastructure/deploy/env-manifest.tsv`), so this is a laptop's state only.
 */
export function avatarTokenSecret(): string | null {
  const raw = process.env.AVATAR_TOKEN_SECRET?.trim() ?? '';
  return raw.length >= AVATAR_TOKEN_SECRET_MIN_LENGTH ? raw : null;
}

/** The UTC day `nowMs` falls in, as a whole number of days since the epoch. */
export function avatarDayBucket(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000);
}

/**
 * The MAC of one session's token for one day. The spec pins its input, domain prefix included,
 * against an HMAC it computes itself.
 */
function avatarTokenMac(secret: string, sessionId: string, bucket: number): Buffer {
  return createHmac('sha256', secret).update(`${MAC_DOMAIN}|${sessionId}|${bucket}`).digest();
}

/**
 * The avatar token for `sessionId` in the day bucket of `nowMs`, or null when this process has no
 * secret (said once at `error`: a deployed estate always has one, so its absence is a defect).
 */
export function mintAvatarToken(sessionId: string, nowMs: number = Date.now()): string | null {
  const secret = avatarTokenSecret();
  if (!secret) {
    if (!unconfiguredSaid) {
      unconfiguredSaid = true;
      logger.error(
        '[AVATAR_TOKEN] AVATAR_TOKEN_SECRET is unset or shorter than 32 characters - no avatar token is minted, so every avatar request of this estate is unsigned'
      );
    }
    return null;
  }
  const bucket = avatarDayBucket(nowMs);
  return `${sessionId}.${bucket}.${avatarTokenMac(secret, sessionId, bucket).toString('base64url')}`;
}

/**
 * Why a presented token was not believed. Each is a 403; the reason is for the log only. `stale` is
 * a token this server DID sign, for a day it no longer honours; `bad-signature` is one it did not.
 */
export type AvatarTokenRefusal =
  | 'unconfigured'
  | 'malformed'
  | 'bad-signature'
  | 'stale'
  | 'session-ended';

/** The signature half of a check: the session the token names, or why it names none. */
export type AvatarTokenSignature =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly reason: Exclude<AvatarTokenRefusal, 'session-ended'> };

/**
 * Checks the SHAPE and the MAC of a presented token, then its day. Says nothing about the session
 * being live - that is the caller's durable-state read, kept apart so this half stays pure.
 *
 * ONE SPELLING PER TOKEN: 43 base64url characters carry 258 bits for a 256-bit digest, so the last
 * character has four spellings that decode to the same bytes. Only the canonical one (the
 * re-encoding of the decoded bytes) is accepted, as is only the canonical decimal of the bucket - a
 * token has exactly one form, so a URL, a cache key and a log line each name it one way.
 */
export function checkAvatarTokenSignature(
  token: string,
  nowMs: number = Date.now()
): AvatarTokenSignature {
  const secret = avatarTokenSecret();
  if (!secret) return { ok: false, reason: 'unconfigured' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [sessionId, bucketText, mac] = parts;
  if (!SESSION_ID.test(sessionId) || !BUCKET.test(bucketText) || !MAC.test(mac)) {
    return { ok: false, reason: 'malformed' };
  }
  const presented = Buffer.from(mac, 'base64url');
  if (presented.toString('base64url') !== mac) return { ok: false, reason: 'malformed' };
  const bucket = Number(bucketText);
  if (!timingSafeEqual(presented, avatarTokenMac(secret, sessionId, bucket))) {
    return { ok: false, reason: 'bad-signature' };
  }
  if (Math.abs(bucket - avatarDayBucket(nowMs)) > BUCKET_SKEW) {
    return { ok: false, reason: 'stale' };
  }
  return { ok: true, sessionId };
}
