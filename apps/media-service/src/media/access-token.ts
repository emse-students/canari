import * as crypto from 'crypto';
import { UnauthorizedException } from '@nestjs/common';

/**
 * Reads the account an ACCESS token names, or refuses it.
 *
 * The same four checks chat-gateway makes on a socket (`decode_access_claims`, `models.rs`), so one
 * token is accepted or refused the same way by both:
 *
 * - the signature, HS256 over the shared secret, compared in constant time;
 * - `exp`, which must be THERE and in the future - a token that names no expiry is refused, not
 *   treated as one that never expires;
 * - `type`, absent or `access` - a refresh token lives for days and is bound to a server-side
 *   session, so it never stands in for the short-lived access token;
 * - `sub`, a non-empty string.
 *
 * @param nowSeconds the current time, in seconds since the epoch
 * @returns the account id (`sub`)
 * @throws UnauthorizedException for every refusal; the message names the check that refused
 */
export function subjectOfAccessToken(token: string, secret: string, nowSeconds: number): string {
  return readAccessToken(token, secret, nowSeconds).sub;
}

/** What an accepted access token says about its holder: who, and when the token was minted. */
export interface AccessCredential {
  /** The account id (`sub`). */
  sub: string;
  /**
   * When core minted the token, in ms since the epoch (`iat` x 1000; every token core signs carries
   * one), or `undefined` when the claim is absent or not a number - read as "minted at an unknown
   * time", which the erased-owner record treats as old (`erased-owners.ts`).
   */
  issuedAt?: number;
}

/**
 * The same checks as {@link subjectOfAccessToken}, answering the token's mint time as well: the
 * fact that tells a credential issued before an account's erasure from one issued to the person
 * who came back under the same id (`erased-owners.ts`).
 *
 * @throws UnauthorizedException for every refusal; the message names the check that refused
 */
export function readAccessToken(
  token: string,
  secret: string,
  nowSeconds: number
): AccessCredential {
  const claims = verifiedClaims(token, secret);
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    throw new UnauthorizedException('JWT without an expiry');
  }
  if (claims.exp < nowSeconds) throw new UnauthorizedException('JWT expired');
  return credentialOf(claims);
}

/**
 * DATES a request another service already authenticated: the signature, the type (`access`) and the
 * subject, WITHOUT the expiry. For `internal/form-file` only, where nginx and core accepted the
 * member's token when the request arrived, and social-service forwards it for its `iat` alone: a
 * large file on a slow link can outlast the token, and an expiry met on the way would leave the
 * upload undated - refused, for a person who came back. The caller checks that `sub` is the
 * uploader it was told of.
 *
 * @throws UnauthorizedException when the signature, the type or the subject is refused
 */
export function datingAccessToken(token: string, secret: string): AccessCredential {
  return credentialOf(verifiedClaims(token, secret));
}

/** The claims a verified token carries; `type` and `sub` already checked. */
interface VerifiedClaims {
  exp?: unknown;
  sub: string;
  iat?: unknown;
}

function credentialOf({ sub, iat }: VerifiedClaims): AccessCredential {
  return typeof iat === 'number' && Number.isFinite(iat) ? { sub, issuedAt: iat * 1000 } : { sub };
}

/** The signature in constant time, the payload's shape, the type and the subject - not the expiry. */
function verifiedClaims(token: string, secret: string): VerifiedClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new UnauthorizedException('Malformed JWT');

  const [headerB64, payloadB64, sigB64] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  // CONSTANT TIME, because `!==` on an HMAC tells its caller how much of a guess was right.
  // `timingSafeEqual` THROWS on a length mismatch rather than answering false, and a signature of
  // the wrong length is a refusal either way - so the length is checked first and the buffers are
  // built from the same encoding.
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(sigB64, 'utf8');
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    throw new UnauthorizedException('Invalid JWT signature');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new UnauthorizedException('Malformed JWT');
  }
  if (payload === null || typeof payload !== 'object') {
    throw new UnauthorizedException('Malformed JWT');
  }
  const { exp, type, sub, iat } = payload as {
    exp?: unknown;
    type?: unknown;
    sub?: unknown;
    iat?: unknown;
  };

  if (type !== undefined && type !== 'access') {
    throw new UnauthorizedException('Not an access token');
  }
  if (typeof sub !== 'string' || sub === '') {
    throw new UnauthorizedException('JWT without a subject');
  }
  return { exp, sub, iat };
}
