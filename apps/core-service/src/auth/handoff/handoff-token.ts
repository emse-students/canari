import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';

/**
 * THE ONE-TIME SIGN-IN HANDOFF TOKEN - its format, and the pure crypto that writes it
 * (docs/wiki/backlog.d/sign-in-handoff-to-the-ecosystem-sites-and-migallery-notifications.md,
 * section 3.2; docs/wiki/sessions.md, "The sign-in handoff").
 *
 * A compact JWS, ES256 (P-256), with its own `typ` and its own key: never `JWT_SECRET`, which signs
 * Canari's access tokens with HS256. A separate key and an explicit type keep a handoff token from
 * ever being taken for an access token, or the reverse (RFC 8725). Asymmetric, so a site verifies
 * with the public half (the JWKS) and can never mint.
 *
 * Pure and dependency-free (node:crypto only), so `tools/handoff-vectors/generate.ts` writes the
 * contract vectors with this very code, under bun.
 */

/** The `typ` header of every handoff token. A verifier refuses any other. */
export const HANDOFF_TOKEN_TYPE = 'canari-handoff+jwt';

/** The only algorithm. A verifier refuses `none`, HS256 and everything else (algorithm confusion). */
export const HANDOFF_TOKEN_ALG = 'ES256';

/**
 * How long a token lives, in seconds. A verifier refuses a token whose `exp - iat` is longer, so a
 * signed token with a longer lifetime is refused even if this ever changed by mistake.
 */
export const HANDOFF_TOKEN_LIFETIME_SECONDS = 60;

/** The payload of a handoff token. `claims` is absent: the F1 shape (sub only), see the note. */
export interface HandoffClaims {
  /** The estate that minted it, the origin of `FRONTEND_URL`'s first entry. */
  iss: string;
  /** The target site's id in `libs/contracts/ecosystem-sites.json`. */
  aud: string;
  /** The MiConnect `sub`, which IS Canari's `users.id`. */
  sub: string;
  /** 128 random bits, base64url: the nonce, and the site's single-use key. */
  jti: string;
  /** Issued at, seconds since the epoch. */
  iat: number;
  /** `iat` + {@link HANDOFF_TOKEN_LIFETIME_SECONDS}. */
  exp: number;
  /** A path on the audience, from its allowlist. Never a URL. */
  dest: string;
}

/** The public half of the signing key, as the JWKS publishes it. */
export interface HandoffPublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid: string;
  alg: typeof HANDOFF_TOKEN_ALG;
  use: 'sig';
}

/**
 * Reads `HANDOFF_SIGNING_KEY`: the base64 of a PKCS#8 DER P-256 private key, one line
 * (`openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 | openssl pkcs8 -topk8 -nocrypt -outform DER | base64 -w0`).
 * ONE spelling: a PEM, another curve or another key type throws, so a wrong value is seen at boot
 * rather than signing with something no site expects.
 */
export function loadHandoffSigningKey(raw: string): KeyObject {
  const der = Buffer.from(raw.trim(), 'base64');
  if (der.length === 0) throw new Error('HANDOFF_SIGNING_KEY is empty');
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch {
    // Named, because the commonest wrong value is a SEC1 `ECPrivateKey` (what `openssl genpkey
    // -outform DER` writes for an EC key), which only differs from PKCS#8 in its ASN.1 wrapper.
    throw new Error(
      'HANDOFF_SIGNING_KEY is not a PKCS#8 DER private key, base64 (a SEC1 EC key or a PEM is ' +
        'refused): openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 | openssl ' +
        'pkcs8 -topk8 -nocrypt -outform DER | base64 -w0'
    );
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('HANDOFF_SIGNING_KEY is not a P-256 (prime256v1) EC private key');
  }
  return key;
}

/** The RFC 7638 thumbprint of an EC public JWK: SHA-256 over its required members, in order. */
export function jwkThumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash('sha256').update(canonical).digest('base64url');
}

/** The public JWK of a signing key, its `kid` being the RFC 7638 thumbprint. */
export function publicJwk(privateKey: KeyObject): HandoffPublicJwk {
  const exported = createPublicKey(privateKey).export({ format: 'jwk' }) as {
    crv?: string;
    x?: string;
    y?: string;
  };
  if (exported.crv !== 'P-256' || !exported.x || !exported.y) {
    throw new Error('the handoff signing key does not export as a P-256 JWK');
  }
  const base = { kty: 'EC' as const, crv: 'P-256' as const, x: exported.x, y: exported.y };
  return { ...base, kid: jwkThumbprint(base), alg: HANDOFF_TOKEN_ALG, use: 'sig' };
}

/** 128 random bits, base64url: a token's `jti`. */
export function newHandoffJti(): string {
  return randomBytes(16).toString('base64url');
}

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/**
 * Signs `claims` as a compact JWS. The signature is the raw `r || s` pair (IEEE P1363) that JWS
 * ES256 requires, not DER.
 *
 * `header` overrides exist for the contract vectors only (a wrong `typ`), never for a mint.
 */
export function signHandoffToken(
  privateKey: KeyObject,
  kid: string,
  claims: HandoffClaims | Record<string, unknown>,
  header: Record<string, unknown> = {}
): string {
  const input = `${b64url({ alg: HANDOFF_TOKEN_ALG, typ: HANDOFF_TOKEN_TYPE, kid, ...header })}.${b64url(claims)}`;
  const signature = sign('sha256', Buffer.from(input, 'utf8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${input}.${signature.toString('base64url')}`;
}
