/**
 * "MLS is ready for this session" as something a caller can AWAIT, not only read.
 *
 * WHY IT EXISTS (F2 of community-open-budget, 2026-10-14). The community listing starts on the
 * access token now, before MLS is up, because drawing the rail and the salon rows needs nothing
 * else. One step of it does need MLS: joining each community's key group. `ensureMls()` cannot
 * answer that - it CREATES a client when none exists and never waits for the login to initialise
 * one - so that step awaits this instead, and runs the moment the login flips `isLoggedIn`.
 *
 * ONE WRITER: `useChatSession`'s `setIsLoggedIn` marks it ready or not, so it can never disagree
 * with the flag every other reader uses. A sign-out ABANDONS the waiters with
 * {@link MlsSessionEndedError}: one with no live session (the PIN gate, a login still running) never
 * flips the flag, and a waiter left pending would wake inside the next account's session.
 */

/** Thrown to whoever was waiting for MLS when the session they waited for ended instead. */
export class MlsSessionEndedError extends Error {
  constructor(reason: string) {
    super(`[MLS-READY] the session ended before MLS was ready: ${reason}`);
    this.name = 'MlsSessionEndedError';
  }
}

let ready = false;
let waiters: { resolve: () => void; reject: (error: Error) => void }[] = [];

/** Resolves once MLS is initialised for the current session (at once if it already is). */
export function whenMlsReady(): Promise<void> {
  if (ready) return Promise.resolve();
  return new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }));
}

/** Records whether MLS is up for the session. Called by the one writer of `isLoggedIn`. */
export function setMlsReady(isReady: boolean): void {
  ready = isReady;
  if (!isReady) return;
  const released = waiters;
  waiters = [];
  for (const waiter of released) waiter.resolve();
}

/**
 * Ends every wait for MLS: the session they belong to was signed out. Returns how many there were,
 * for the caller's log.
 */
export function abandonMlsReadyWaiters(reason: string): number {
  const abandoned = waiters;
  waiters = [];
  for (const waiter of abandoned) waiter.reject(new MlsSessionEndedError(reason));
  return abandoned.length;
}
