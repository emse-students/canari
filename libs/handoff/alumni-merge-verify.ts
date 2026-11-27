/**
 * THE ALUMNI MERGE CALL TOKEN'S VERIFIER - the server-to-server call Canari's site-jobs worker makes
 * when an Alumni merge completes (Canari's docs/wiki/profiles-and-access.md, D52-D54):
 * `POST /api/internal/alumni-merge`, `Authorization: Bearer <token>`, a compact JWS, ES256, signed by
 * Canari's HANDOFF key, `typ: canari-merge+jwt`, audience the site, claims `mode`, `dup`, `target`,
 * `jti` (the job's id), `iat`, `exp`.
 *
 * VENDORED BYTE-IDENTICALLY, next to the handoff verifier whose leeway and lifetime it shares. The
 * source is Canari's `libs/handoff/alumni-merge-verify.ts`; each MiConnect site holds an exact copy in
 * the same directory as its `handoff-verify.ts`, and `tools/ecosystem-shape/shape.mjs` fails when a
 * GitHub copy differs. Edit it in Canari, then copy it.
 *
 * THE TWO MODES, named by the REQUIRED `mode` claim - no default, a token without it is `invalid`.
 * `transfer`: move what the duplicate's account owns onto `target`'s - `target` is REQUIRED. `erase`: the merge's target was erased in Canari before
 * this site answered, so the duplicate's account is erased instead - `target` is ABSENT (Canari blanked
 * it with the person) and a token carrying one is refused.
 *
 * The same key and JWKS as the sign-in handoff, its OWN type, so neither token is ever taken for the
 * other (RFC 8725). Classified by the error's CLASS, never its message. A failure to OBTAIN the keys is
 * `keys_unavailable`, decided inside the key resolver, so nothing a token carries can pass for an
 * outage: the site answers it `503 { outcome: 'keys_unavailable' }`, any other class
 * `401 { outcome: <class> }`, which Canari logs at error on every attempt. It never logs and never
 * returns the token.
 */
import { errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { HANDOFF_LEEWAY_SECONDS, HANDOFF_MAX_LIFETIME_SECONDS } from './handoff-verify.js';

/** The token's `typ` header, Canari's `ALUMNI_MERGE_TOKEN_TYPE`. */
export const ALUMNI_MERGE_TOKEN_TYPE = 'canari-merge+jwt';

/** What a call asks of the site. */
export type AlumniMergeMode = 'transfer' | 'erase';

/** Why a token was refused. */
export type AlumniMergeRefusalClass =
  | 'keys_unavailable'
  | 'invalid'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'expired'
  | 'not_yet_valid'
  | 'too_long';

/** The claims a verified call carries: a transfer names its target, an erase never does. */
export type AlumniMergeClaims =
  | { mode: 'transfer'; dup: string; target: string; jti: string }
  | { mode: 'erase'; dup: string; jti: string };

export type AlumniMergeVerification =
  | { outcome: 'ok'; claims: AlumniMergeClaims }
  | { outcome: AlumniMergeRefusalClass };

export interface AlumniMergeVerifyOptions {
  /** Canari's keys, the handoff's: `createRemoteJWKSet(<issuer>/api/auth/handoff/jwks, ...)`. */
  keys: JWTVerifyGetKey;
  /** The ONE issuer accepted (`CANARI_HANDOFF_ISSUER`). */
  issuer: string;
  /** This site's id in Canari's registry - a constant of the site, never a variable. */
  audience: string;
  /** The clock; tests pass their own. */
  currentDate?: Date;
}

/**
 * THE ONE BOUND OF A SUBJECT (a MiConnect `hashed_user_id`: 64 hex), equal to Canari's
 * `ALUMNI_MERGE_SUBJECT_MAX_LENGTH`: Canari's hook and columns hold none longer, and its test asserts
 * the three agree.
 */
export const ALUMNI_MERGE_SUBJECT_MAX_LENGTH = 128;
const SUBJECT = new RegExp(`^[A-Za-z0-9._-]{1,${ALUMNI_MERGE_SUBJECT_MAX_LENGTH}}$`);

/** Verifies an Alumni merge call token for this site. */
export async function verifyAlumniMergeCall(
  token: string,
  options: AlumniMergeVerifyOptions
): Promise<AlumniMergeVerification> {
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
      typ: ALUMNI_MERGE_TOKEN_TYPE,
      issuer: options.issuer,
      audience: options.audience,
      clockTolerance: HANDOFF_LEEWAY_SECONDS,
      requiredClaims: ['mode', 'dup', 'jti', 'iat', 'exp'],
      currentDate,
    }));
  } catch (e) {
    return { outcome: classify(e) };
  }
  const { mode, dup, target, jti, iat, exp } = payload;

  if (
    typeof dup !== 'string' ||
    typeof jti !== 'string' ||
    typeof iat !== 'number' ||
    typeof exp !== 'number' ||
    !SUBJECT.test(dup) ||
    jti.length === 0 ||
    jti.length > 128 ||
    (mode !== 'transfer' && mode !== 'erase') ||
    (mode === 'transfer' && (typeof target !== 'string' || !SUBJECT.test(target))) ||
    (mode === 'erase' && target !== undefined)
  ) {
    return { outcome: 'invalid' };
  }
  const now = Math.floor(currentDate.getTime() / 1000);
  if (iat > now + HANDOFF_LEEWAY_SECONDS) return { outcome: 'not_yet_valid' };
  if (exp - iat > HANDOFF_MAX_LIFETIME_SECONDS) return { outcome: 'too_long' };
  return {
    outcome: 'ok',
    claims:
      mode === 'transfer'
        ? { mode, dup, target: target as string, jti }
        : { mode, dup, jti },
  };
}

/** The key resolver could not obtain Canari's keys; `cause` is what it threw. */
class KeysUnavailable extends Error {
  constructor(readonly cause: unknown) {
    super('alumni merge keys unavailable');
  }
}

/** A jose failure, as a refusal class. Anything unrecognised is `invalid`. */
function classify(e: unknown): AlumniMergeRefusalClass {
  if (e instanceof KeysUnavailable) return 'keys_unavailable';
  if (e instanceof errors.JWTExpired) return 'expired';
  if (e instanceof errors.JWTClaimValidationFailed) {
    if (e.claim === 'iss') return 'wrong_issuer';
    if (e.claim === 'aud') return 'wrong_audience';
    if (e.claim === 'iat' || e.claim === 'nbf') return 'not_yet_valid';
  }
  return 'invalid';
}
