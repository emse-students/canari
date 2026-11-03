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
 * SHAPE: `<sessionId>.<mac>`, where `mac` is the base64url HMAC-SHA256, under
 * `AVATAR_TOKEN_SECRET`, of `avatar-v1|<sessionId>|<UTC day bucket>`. It is minted beside every
 * access token (sign-in, restore, refresh) and verified by `UsersController.getAvatar`.
 *
 * WHAT MAKES A TOKEN VALID IS DURABLE STATE, NOT THE CLOCK. A token is honoured only while the
 * session it names is LIVE (`AuthSessionsService.isLiveSession`, one primary-key read): ending a
 * session - logout, "sign out everywhere", a device revoked, an idle expiry - deletes its row and
 * kills every avatar URL minted for it at the next request, with no clock involved.
 *
 * THE DAY BUCKET IS A CACHE-FRIENDLINESS CHOICE, NOT A TERMINATION PROOF. Signing the session alone
 * would give one URL per face for the whole life of a session; signing every access token would
 * give a new URL (so a new download) every hour. A UTC day keeps every URL stable for a day, so the
 * browser's HTTP cache and its ETag revalidation keep working, and accepting the previous bucket
 * means a URL minted at 23:59 is not refused at 00:00. Nothing relies on the bucket to END access:
 * the session does. A token older than the previous bucket belongs to a client that has not
 * refreshed for a day, whose access token (one hour) is long dead too - it re-mints both together.
 */

/** The prefix inside the MAC, so this secret can never sign anything another use could replay. */
const MAC_DOMAIN = 'avatar-v1';

/** Below this the secret is refused as if unset - the same floor as the estate's other HMAC keys. */
export const AVATAR_TOKEN_SECRET_MIN_LENGTH = 32;

/** A session id is a uuid (`auth-session.entity.ts`); anything else is malformed before any read. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A base64url SHA-256 digest: 32 bytes, 43 characters, no padding. */
const MAC = /^[A-Za-z0-9_-]{43}$/;

const logger = new Logger('AvatarToken');
/** Set the first time this process is asked to mint with no usable secret, so it is said once. */
let unconfiguredSaid = false;

/**
 * The `AVATAR_TOKEN_SECRET` of this process, or null when it is unset or shorter than
 * {@link AVATAR_TOKEN_SECRET_MIN_LENGTH}. Read per call, like `INTERNAL_SECRET`, so a test sets it.
 *
 * AN EMPTY KEY, DECIDED EXPLICITLY: with none, NOTHING IS MINTED (the client sends unsigned
 * requests, which phase 1 accepts and counts as `[AVATAR_UNSIGNED]`) and EVERY PRESENTED TOKEN IS
 * REFUSED - a token this process cannot verify is not believed. Every deployed estate makes the
 * secret `required` (`infrastructure/deploy/env-manifest.tsv`), so this is a laptop's state only.
 */
export function avatarTokenSecret(): string | null {
  const raw = process.env.AVATAR_TOKEN_SECRET?.trim() ?? '';
  return raw.length >= AVATAR_TOKEN_SECRET_MIN_LENGTH ? raw : null;
}

/** The UTC day `nowMs` falls in, as a whole number of days since the epoch. */
export function avatarDayBucket(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000);
}

function macOf(secret: string, sessionId: string, bucket: number): Buffer {
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
  return `${sessionId}.${macOf(secret, sessionId, avatarDayBucket(nowMs)).toString('base64url')}`;
}

/** Why a presented token was not believed. Each is a 403; the reason is for the log only. */
export type AvatarTokenRefusal = 'unconfigured' | 'malformed' | 'bad-signature' | 'session-ended';

/** The signature half of a check: the session the token names, or why it names none. */
export type AvatarTokenSignature =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly reason: Exclude<AvatarTokenRefusal, 'session-ended'> };

/**
 * Checks the SHAPE and the MAC of a presented token against the current and the previous day
 * bucket. Says nothing about the session being live - that is the caller's durable-state read, kept
 * apart so this half stays pure. A token of an older bucket and a forged one are the same answer,
 * `bad-signature`: neither was signed for a bucket this server still honours.
 */
export function checkAvatarTokenSignature(
  token: string,
  nowMs: number = Date.now()
): AvatarTokenSignature {
  const secret = avatarTokenSecret();
  if (!secret) return { ok: false, reason: 'unconfigured' };
  const dot = token.indexOf('.');
  const sessionId = dot > 0 ? token.slice(0, dot) : '';
  const mac = dot > 0 ? token.slice(dot + 1) : '';
  if (!SESSION_ID.test(sessionId) || !MAC.test(mac)) return { ok: false, reason: 'malformed' };
  const presented = Buffer.from(mac, 'base64url');
  const bucket = avatarDayBucket(nowMs);
  const signed = [bucket, bucket - 1].some((b) =>
    timingSafeEqual(presented, macOf(secret, sessionId, b))
  );
  return signed ? { ok: true, sessionId } : { ok: false, reason: 'bad-signature' };
}
