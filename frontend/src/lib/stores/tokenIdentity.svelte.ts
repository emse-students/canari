/**
 * THE TOKEN AND THE LOCAL IDENTITY MUST NAME THE SAME PERSON, and nothing used to check.
 *
 * The MLS identity (`canari_saved_user`, the `userId` the WASM client was initialised with) is read
 * from local state, while the session the server sees is the access token's `sub`. They are written
 * by different paths, so a switch of account can leave them apart: measured on a bench phone
 * 2026-10-10, the MLS identity was Alpha while the refresh credential belonged to Delta. The gateway
 * registered the socket as Delta carrying Alpha's device id, every send / history / seed request
 * answered `403 AUTHZ FAIL caller != requester`, the outbox re-posted the same six entries 23 times,
 * and live frames were fanned out to an account that was offline.
 *
 * THE GUARD IS AT THE CAUSE: one comparison, made where a token is obtained ({@link checkTokenIdentity}
 * is called by the refresh). On a mismatch it does NOT wipe the MLS state - that belongs to a person
 * who is about to sign in as the right account - and it does NOT let the session carry on: the
 * verdict is latched here, the refresh refuses to hand a token out while it stands, the outbox
 * gate reads it, and a blocking notice offers the one way out (the ordinary sign-out).
 */

import { decodeTokenClaims } from '$lib/utils/jwtClaims';

/** The two identities that disagree. Ids only - never a name, an address or a token. */
export interface IdentitySplit {
  /** The `sub` of the access token: who the server believes is asking. */
  tokenSub: string;
  /** The user id of the local / MLS state: whose keys and conversations are on this device. */
  localId: string;
}

/**
 * Thrown by the token path while a split stands. Typed so a caller reads `instanceof` and never the
 * sentence; it is NOT a session expiry (the credential is alive) and NOT a transport failure.
 */
export class IdentitySplitError extends Error {
  constructor(readonly split: IdentitySplit) {
    super('Token identity does not match the local identity - sign out to continue');
    this.name = 'IdentitySplitError';
  }
}

let current = $state<IdentitySplit | null>(null);

/** The standing split, or `null`. Reactive: the blocking notice reads it. */
export function getIdentitySplit(): IdentitySplit | null {
  return current;
}

/** True while a split stands. Plain read for the non-reactive gates (outbox, refresh). */
export function isIdentitySplit(): boolean {
  return current !== null;
}

/** Voids the verdict - on sign-out, the only event that changes the answer. */
export function clearIdentitySplit(): void {
  if (current) console.warn('[A] identity split cleared (sign-out)');
  current = null;
}

/**
 * Compares the access token's `sub` with the local identity and latches the verdict.
 *
 * Returns `true` when the token may be used. With NO local identity there is nothing to disagree
 * with (the refresh restores it from the `sub`), and an undecodable token proves nothing, so both
 * return `true`. Ids compare case-insensitively, as the server does.
 */
export function checkTokenIdentity(token: string, localId: string | null): boolean {
  const sub = decodeTokenClaims(token)?.sub;
  if (!sub || !localId) return true;
  if (sub.toLowerCase() === localId.toLowerCase()) {
    current = null;
    return true;
  }
  current = { tokenSub: sub, localId };
  // ACCUSES: reaching here means two writers disagreed about who is signed in. Ids only.
  console.error(
    `[A] IDENTITY SPLIT: the access token is for ${sub} but the local/MLS identity is ${localId} - ` +
      'token withheld, MLS and outbox traffic stopped, sign-out required'
  );
  return false;
}
