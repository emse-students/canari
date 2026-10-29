/**
 * The seam through which an MLS client says that the session it serves has LOST its MLS session
 * while the user is still signed in - and the one reaction to that: the live session ends ON THIS
 * DEVICE and reopens at the PIN gate (`endLostSessionImpl`, wired by `ChatBackgroundService`).
 *
 * **WHY IT REOPENS RATHER THAN RE-INITIALISING IN PLACE.** Two causes reach here. A resume finds the
 * native slot empty, which only a teardown does (a sign-out, an account switch, a failed install, a
 * state reset): the client in memory no longer describes what is installed. Or an identity rotation
 * failed: the client already moved its device id while the id on disk is still the old one. A silent
 * re-init would decide, without the user, which identity and which key the session continues under.
 * The PIN gate reopens the state as the disk holds it and runs every gate an unlock runs. Warning and
 * carrying on was the other option, and it is a dead end: every later MLS command is refused while
 * the screen looks alive.
 *
 * **WHY IT IS NEVER A SIGN-OUT.** This is a local fact, not a status: only a 401/403 may end an
 * account's session. Signing out would revoke the session on the server and the identity provider's,
 * clear the restore key and the push registration - and an offline user could not sign back in.
 *
 * The client does not own the session, so the shell registers the reaction and the client only
 * reports.
 */

/** Why the MLS session was lost - carried to the log line, never branched on. */
export type MlsSessionLoss =
  | 'resume found no native session'
  | 'identity rotation found no native session'
  | 'identity rotation failed';

type LossHandler = (why: MlsSessionLoss) => void;

let handler: LossHandler | null = null;

/** Registers the shell's reaction (ends the session locally, reopens the PIN gate); `null` removes it. */
export function setMlsSessionLostHandler(fn: LossHandler | null): void {
  handler = fn;
}

/**
 * Reports that the live session has lost its MLS session, at ERROR: the session it serves is about to
 * end on this device. With no handler registered that is said too, because nothing will end it then.
 */
export function reportMlsSessionLost(why: MlsSessionLoss): void {
  console.error(
    `[MLS] the signed-in session lost its MLS session (${why}) - reopening it at the PIN gate`
  );
  if (!handler) {
    console.error('[MLS] no handler is registered to end the session - it stays on screen, inert');
    return;
  }
  handler(why);
}
