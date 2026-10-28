/**
 * The seam through which an MLS client says that the session it serves has NO native MLS session
 * left under it while the user is still signed in - and the one reaction to that: the session ends
 * into the sign-in screen.
 *
 * **WHY THE SESSION ENDS RATHER THAN RE-INITIALISING.** The native slot is emptied only by a teardown
 * (a sign-out, an account switch, a failed install, a state reset). Finding it empty under a live
 * session means one of those ran and the client in memory no longer describes what is installed: a
 * failed identity rotation already moved the client's device id, and a silent re-init would decide,
 * without the user, which identity and which key the session continues under. A sign-in reads the
 * state as the disk holds it and runs every gate a login runs, so it is the one deterministic way
 * back. Warning and carrying on was the other option, and it is a dead end: every later MLS command
 * fails with `MLS_MANAGER_ABSENT` while the screen looks alive.
 *
 * The client does not own the session, so the shell registers the reaction (`ChatBackgroundService`,
 * the same handler as an expired session) and the client only reports.
 */

/** Why the native session was found vacant - carried to the log line, never branched on. */
export type MlsSessionVacancy = 'resume found no native session' | 'identity rotation failed';

type VacancyHandler = (why: MlsSessionVacancy) => void;

let handler: VacancyHandler | null = null;

/** Registers the shell's reaction (ends the session into the sign-in screen); `null` removes it. */
export function setMlsSessionVacatedHandler(fn: VacancyHandler | null): void {
  handler = fn;
}

/**
 * Reports that the live session has no native MLS session under it. With no handler registered the
 * report is said at ERROR, because nothing will end the session then.
 */
export function reportMlsSessionVacated(why: MlsSessionVacancy): void {
  console.error(
    `[MLS] the signed-in session has no native MLS session under it (${why}) - ending it`
  );
  if (!handler) {
    console.error('[MLS] no handler is registered to end the session - it stays on screen, inert');
    return;
  }
  handler(why);
}
