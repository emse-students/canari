import type { SessionExpiredOutcome } from './sessionTypes';

/** What {@link endExpiredSession} needs, injected so the sign-out count can be driven by a test. */
export interface EndExpiredSessionDeps {
  /** What the caller of `onSessionExpired` already knows about the sign-out. */
  outcome?: SessionExpiredOutcome;
  /** The revoked-device reaction: answers `true` when it ran the reset, whose own `clearAuth` signed out. */
  settleRevocation: () => Promise<boolean>;
  /** The ordinary sign-out (`clearAuth`). */
  signOut: () => Promise<void>;
  /** The page the user is sent to, for the log line only. */
  loginPath: string;
  log: (msg: string) => void;
}

/**
 * The sign-out half of a dead session: settles a device revocation first, then signs out UNLESS the
 * revoked-device reset has already done it. Returns whether THIS call ran the sign-out.
 *
 * THE RESET'S OWN `clearAuth` IS THE SIGN-OUT, so a second one was a second `POST /api/auth/logout`
 * and a second round of sign-out handlers. The fact comes from where it is known, never from a timing
 * argument: the reset answering `true` (refusal path), or the frame path saying `alreadySignedOut`.
 *
 * A reset that THROWS answers nothing, so the sign-out still runs: a reset that failed before its
 * `clearAuth` must never leave a dead session unsigned (0 logouts). One that failed AFTER its
 * `clearAuth` costs a second logout - the accepted case, a harmless write on an already-gone session.
 */
export async function endExpiredSession(deps: EndExpiredSessionDeps): Promise<boolean> {
  let signedOut = deps.outcome?.alreadySignedOut === true;
  try {
    if (await deps.settleRevocation()) signedOut = true;
  } catch (e) {
    // ACCUSED, never swallowed: the stores of a disowned device may remain.
    console.error('[SECURITY] The revoked-device reset FAILED - local data may remain:', e);
    deps.log(`[SECURITY] The revoked-device reset FAILED - local data may remain: ${e}`);
  }
  if (signedOut) {
    deps.log(
      `[AUTH] Session expired - the revoked-device reset already signed out; redirecting to ${deps.loginPath}.`
    );
    return false;
  }
  deps.log(`[AUTH] Session expired - logging out and redirecting to ${deps.loginPath}.`);
  await deps.signOut().catch(() => {});
  return true;
}
