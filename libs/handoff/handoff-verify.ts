/**
 * THE HANDOFF VERIFIER - steps 1 to 3 of the redemption contract every MiConnect site implements
 * (Canari's docs/wiki/backlog.d/sign-in-handoff-to-the-ecosystem-sites-and-migallery-notifications.md,
 * section 8, "The contract MiGallery implements").
 *
 * VENDORED BYTE-IDENTICALLY. The source is Canari's `libs/handoff/handoff-verify.ts`; each site
 * holds an exact copy, and Canari's `tools/ecosystem-shape/shape.mjs` fails when a GitHub copy
 * differs. Edit it in Canari, then copy it. Each copy runs Canari's vectors
 * (`libs/contracts/handoff-token.cases.json`, copied too) in the site's own tests.
 *
 * What it does NOT do, because it is the site's: the `Origin` check (step 0), single use (the
 * `handoff_redemptions` insert, step 5), admission and the session (steps 6-7). It never logs and
 * never returns the token: the caller logs the outcome's class.
 *
 * Classified by the error's CLASS and its `claim` field, never by its message. A failure to OBTAIN
 * the keys (Canari's JWKS unreachable, a timeout, a non-200 or malformed answer) is
 * `keys_unavailable`, decided where it happens - inside the key resolver - so nothing a token carries
 * can be classified as an outage: the site answers it 503 and logs it at error, the token's fault
 * answers 400.
 */
import { errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** The token's `typ` header; jose compares it case-insensitively, `application/` optional. */
export const HANDOFF_TOKEN_TYPE = 'canari-handoff+jwt';
/** Clock skew tolerated on `exp` and `iat`, in seconds. */
export const HANDOFF_LEEWAY_SECONDS = 30;
/** The longest lifetime (`exp - iat`) a token may declare, in seconds. */
export const HANDOFF_MAX_LIFETIME_SECONDS = 60;

/** Why a token was refused, in the contract's words. */
export type HandoffRefusalClass =
  | 'keys_unavailable'
  | 'invalid'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'expired'
  | 'not_yet_valid'
  | 'too_long'
  | 'bad_dest';

/** The claims a verified token carries. */
export interface HandoffClaims {
  sub: string;
  jti: string;
  dest: string;
  iat: number;
  exp: number;
}

export type HandoffVerification =
  | { outcome: 'ok'; claims: HandoffClaims }
  | { outcome: HandoffRefusalClass };

export interface HandoffVerifyOptions {
  /** Canari's keys: `createRemoteJWKSet(<issuer>/api/auth/handoff/jwks, { cacheMaxAge: 60_000 })`. */
  keys: JWTVerifyGetKey;
  /** The ONE issuer accepted (`CANARI_HANDOFF_ISSUER`). */
  issuer: string;
  /** This site's id in Canari's registry - a constant of the site, never a variable. */
  audience: string;
  /** The site's own redirect validator (MiGallery: `safeRedirectTarget`), applied to `dest`. */
  redirectAllows: (dest: string) => boolean;
  /** The clock; tests pass the vector's `now`. */
  currentDate?: Date;
}

/** Steps 1-3 of the contract: signature and header, issuer and audience, time, `dest`. */
export async function verifyHandoff(
  token: string,
  options: HandoffVerifyOptions
): Promise<HandoffVerification> {
  const currentDate = options.currentDate ?? new Date();
  // The resolver's own failures are marked here: an unknown or ambiguous `kid` is the token's
  // fault; anything else it throws means the keys could not be obtained.
  const keys: JWTVerifyGetKey = async (header, token) => {
    try {
      return await options.keys(header, token);
    } catch (e) {
      if (e instanceof errors.JWKSNoMatchingKey || e instanceof errors.JWKSMultipleMatchingKeys) {
        throw e;
      }
      throw new KeysUnavailable(e);
    }
  };
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      algorithms: ['ES256'],
      typ: HANDOFF_TOKEN_TYPE,
      issuer: options.issuer,
      audience: options.audience,
      clockTolerance: HANDOFF_LEEWAY_SECONDS,
      requiredClaims: ['sub', 'jti', 'iat', 'exp', 'dest'],
      currentDate,
    }));
  } catch (e) {
    return { outcome: classify(e) };
  }
  const { sub, jti, dest, iat, exp } = payload;
  if (
    typeof sub !== 'string' ||
    typeof jti !== 'string' ||
    typeof dest !== 'string' ||
    typeof iat !== 'number' ||
    typeof exp !== 'number'
  ) {
    return { outcome: 'invalid' };
  }
  const now = Math.floor(currentDate.getTime() / 1000);
  if (iat > now + HANDOFF_LEEWAY_SECONDS) return { outcome: 'not_yet_valid' };
  if (exp - iat > HANDOFF_MAX_LIFETIME_SECONDS) return { outcome: 'too_long' };
  if (!options.redirectAllows(dest)) return { outcome: 'bad_dest' };
  return { outcome: 'ok', claims: { sub, jti, dest, iat, exp } };
}

/** The key resolver could not obtain Canari's keys; `cause` is what it threw. */
class KeysUnavailable extends Error {
  constructor(readonly cause: unknown) {
    super('handoff keys unavailable');
  }
}

/** A jose failure, as the contract's class. Anything unrecognised is `invalid`. */
function classify(e: unknown): HandoffRefusalClass {
  if (e instanceof KeysUnavailable) return 'keys_unavailable';
  if (e instanceof errors.JWTExpired) return 'expired';
  if (e instanceof errors.JWTClaimValidationFailed) {
    if (e.claim === 'iss') return 'wrong_issuer';
    if (e.claim === 'aud') return 'wrong_audience';
    if (e.claim === 'iat' || e.claim === 'nbf') return 'not_yet_valid';
  }
  return 'invalid';
}
