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
/** The client MLS was made ready ON ({@link setMlsReady}), or `null` while it is not ready. */
let readyClient: unknown = null;
let waiters: { resolve: () => void; reject: (error: Error) => void }[] = [];

/**
 * Resolves once MLS is initialised for the current session (at once if it already is).
 *
 * @param signal aborting it REMOVES the waiter and rejects with the signal's reason: a caller that
 *   stopped waiting (a call that ended) leaves nothing parked for the next session to wake.
 */
export function whenMlsReady(signal?: AbortSignal): Promise<void> {
  if (ready) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const waiter = { resolve, reject };
    waiters.push(waiter);
    signal?.addEventListener(
      'abort',
      () => {
        waiters = waiters.filter((w) => w !== waiter);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

/**
 * Records whether MLS is up for the session, and on which client. Called by the one writer of
 * `isLoggedIn`, with the session's client when it flips to ready.
 */
export function setMlsReady(isReady: boolean, client: unknown = null): void {
  ready = isReady;
  readyClient = isReady ? client : null;
  if (!isReady) return;
  const released = waiters;
  waiters = [];
  for (const waiter of released) waiter.resolve();
}

/**
 * The client MLS is ready on, or `null`. A caller that captured a client BEFORE readiness (a call
 * service built at mount, a login since replaced the client) compares it with this one: holding
 * another is holding a client the session no longer uses.
 */
export function mlsReadyClient(): unknown {
  return readyClient;
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
