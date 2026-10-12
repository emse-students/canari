/**
 * The claims of a JWT, read WITHOUT verifying its signature - the server already did, and the
 * client only needs to know what it was handed (`exp` to schedule a refresh, `sub` to know whose
 * session this is).
 *
 * One decoder: `auth.ts` used to carry two inline copies of the same base64url dance.
 */
export interface TokenClaims {
  sub?: string;
  admin?: boolean;
  exp?: number;
}

/** Returns the payload of `token`, or `null` when it is not a decodable JWT. Never throws. */
export function decodeTokenClaims(token: string): TokenClaims | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as TokenClaims;
  } catch {
    return null;
  }
}
