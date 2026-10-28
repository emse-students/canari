import type { MlsSessionLoss } from '$lib/mls-client/mlsSessionLoss';

/** What {@link reopenAtPinGate} needs from the shell - each the shell's own step, named. */
export interface ReopenAtPinGateDeps {
  /** Why the MLS session was lost, from `reportMlsSessionLost`. */
  why: MlsSessionLoss;
  /** Ends the live session on this device only (`endLostSessionImpl`): nothing revoked, nothing erased. */
  endLiveSession: () => void;
  /** Releases the login flow's latches, so the gate's unlock may run. */
  releaseLoginFlow: () => void;
  /** Puts the PIN gate up for the account still signed in. */
  openPinGate: () => Promise<void>;
  log: (line: string) => void;
}

/**
 * The shell's ONE reaction to a lost MLS session: the live session ends on this device and the
 * account is reopened at the PIN gate, which reads the state as the disk holds it through every gate.
 *
 * **NEVER `clearAuth`, NEVER THE EXPIRED-SESSION PATH.** A lost MLS session is a local fact, and only a
 * 401/403 may end an account's session: a sign-out would revoke the session on the server and the
 * identity provider's, clear the restore key, end the push registration and erase the shares - and an
 * offline user could not sign back in. See `mlsSessionLoss.ts` for why it is not a re-init either.
 */
export async function reopenAtPinGate(deps: ReopenAtPinGateDeps): Promise<void> {
  deps.log(
    `[SESSION] MLS session LOST (${deps.why}) - ending the live session on this device and reopening it at the PIN gate; nothing is revoked or erased.`
  );
  deps.endLiveSession();
  deps.releaseLoginFlow();
  await deps.openPinGate();
}
