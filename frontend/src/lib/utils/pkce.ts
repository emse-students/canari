/**
 * PKCE (RFC 7636) for the MiConnect sign-in: the proof that the client redeeming an authorization
 * code is the one that asked for it.
 *
 * WHY CANARI NEEDS IT ALTHOUGH ITS CLIENT IS CONFIDENTIAL. The client secret lives in core-service,
 * and core-service redeems whatever code it is POSTed. A code that reaches anybody else - a custom
 * scheme (`fr.emse.canari://callback`) another app also claims, a loopback port another process
 * listens on - could therefore be redeemed through core-service with the secret's full authority.
 * The verifier never leaves this device until the redemption, so a code alone is worth nothing.
 * MiConnect (authentik) checks the pair at its token endpoint and refuses a verifier sent for a
 * code issued without a challenge, so nobody can strip it on the way.
 */

/** The pair one authorization request needs: the secret kept here, the hash sent to MiConnect. */
export interface PkcePair {
  /** 43 base64url characters (32 random bytes), sent only with the code redemption. */
  verifier: string;
  /** BASE64URL(SHA-256(verifier)), sent on the authorize request with `code_challenge_method=S256`. */
  challenge: string;
}

/** Unpadded base64url, the encoding RFC 7636 section 4 prescribes for both halves. */
function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The S256 challenge of `verifier` (RFC 7636 section 4.2). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** A fresh verifier from the platform CSPRNG, and its S256 challenge. */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: await pkceChallenge(verifier) };
}
