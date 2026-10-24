import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * THE CHALLENGES OF THE RESTORE KEY, STATELESS UNTIL THEY ARE SPENT (docs/wiki/account-restore.md).
 *
 * The assertion route is anonymous, and core-service has neither Redis nor a throttler, so a
 * challenge stored at issue time would be a table any caller on the internet could grow. A challenge
 * here therefore carries its own proof instead: `nonce(16) || expiry(8, ms, big-endian) ||
 * HMAC-SHA256(key, purpose || binding || nonce || expiry)`, base64url. Only an assertion whose
 * SIGNATURE verified records its nonce as spent (`restore_challenges_spent`), so nothing an anonymous
 * caller sends writes a row.
 *
 * The validity bound is a property of a security token, like a JWT's `exp` - it decides whether a
 * signed statement is still believed, never whether to retry anything.
 *
 * Pure: the key and the clock are arguments, so every decision is testable without either.
 */

/** How long a challenge is believed after it is issued. */
export const RESTORE_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** The domain label that makes this key unusable for any other token kind. */
const KEY_LABEL = 'canari-restore-challenge-v1';

const NONCE_BYTES = 16;
const EXPIRY_BYTES = 8;
const MAC_BYTES = 32;
const TOTAL_BYTES = NONCE_BYTES + EXPIRY_BYTES + MAC_BYTES;

/**
 * What a challenge is for. A registration challenge is bound to ONE session; an assertion challenge
 * is bound to nothing (the caller is anonymous). The purpose is inside the MAC, so one can never be
 * presented as the other.
 */
export type RestoreChallengePurpose = 'register' | 'assert';

/** A challenge that verified: its nonce (the single-use record's key) and when it stops being believed. */
export interface CheckedChallenge {
  nonce: string;
  expiresAt: Date;
}

/** Why a challenge was refused - logged, never shown. */
export type ChallengeRefusal = 'malformed' | 'forged' | 'expired';

/**
 * Derives the challenge key from the service's signing secret, under a label of its own. An empty
 * secret is refused here rather than producing a key anyone can compute (docs/wiki/sessions.md,
 * "an empty key can fail OPEN or CLOSED").
 */
export function deriveRestoreChallengeKey(secret: string): Buffer {
  if (!secret) throw new Error('restore challenge key: the signing secret is empty');
  return createHmac('sha256', secret).update(KEY_LABEL).digest();
}

function mac(key: Buffer, purpose: RestoreChallengePurpose, binding: string, body: Buffer): Buffer {
  // Lengths are written before each variable part, so `purpose`/`binding` cannot be shifted into
  // each other to forge a MAC for a different pair.
  const purposeBytes = Buffer.from(purpose, 'utf8');
  const bindingBytes = Buffer.from(binding, 'utf8');
  const lengths = Buffer.alloc(8);
  lengths.writeUInt32BE(purposeBytes.length, 0);
  lengths.writeUInt32BE(bindingBytes.length, 4);
  return createHmac('sha256', key)
    .update(lengths)
    .update(purposeBytes)
    .update(bindingBytes)
    .update(body)
    .digest();
}

/**
 * Issues a challenge for `purpose`, bound to `binding` (the session id of a registration, `''` for
 * an assertion).
 */
export function mintRestoreChallenge(
  key: Buffer,
  purpose: RestoreChallengePurpose,
  binding: string,
  now: Date,
  nonce: Buffer = randomBytes(NONCE_BYTES)
): string {
  if (nonce.length !== NONCE_BYTES) throw new Error('restore challenge: nonce must be 16 bytes');
  const expiry = Buffer.alloc(EXPIRY_BYTES);
  expiry.writeBigUInt64BE(BigInt(now.getTime() + RESTORE_CHALLENGE_TTL_MS));
  const body = Buffer.concat([nonce, expiry]);
  return Buffer.concat([body, mac(key, purpose, binding, body)]).toString('base64url');
}

/**
 * Checks a challenge the client echoed back (inside `clientDataJSON`) against the purpose and the
 * binding the server expects NOW. It does not decide single use - only a verified signature may
 * record a nonce as spent, which is the caller's next step.
 */
export function checkRestoreChallenge(
  key: Buffer,
  challenge: string,
  purpose: RestoreChallengePurpose,
  binding: string,
  now: Date
): { ok: true; challenge: CheckedChallenge } | { ok: false; refusal: ChallengeRefusal } {
  let raw: Buffer;
  try {
    raw = Buffer.from(challenge, 'base64url');
  } catch {
    return { ok: false, refusal: 'malformed' };
  }
  if (raw.length !== TOTAL_BYTES || raw.toString('base64url') !== challenge) {
    return { ok: false, refusal: 'malformed' };
  }
  const body = raw.subarray(0, NONCE_BYTES + EXPIRY_BYTES);
  const presented = raw.subarray(NONCE_BYTES + EXPIRY_BYTES);
  if (!timingSafeEqual(presented, mac(key, purpose, binding, body))) {
    return { ok: false, refusal: 'forged' };
  }
  const expiresAtMs = Number(body.readBigUInt64BE(NONCE_BYTES));
  if (expiresAtMs <= now.getTime()) return { ok: false, refusal: 'expired' };
  return {
    ok: true,
    challenge: {
      nonce: body.subarray(0, NONCE_BYTES).toString('base64url'),
      expiresAt: new Date(expiresAtMs),
    },
  };
}
