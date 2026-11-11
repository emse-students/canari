/**
 * THE EARLY HARDWARE-HELD KEY READ, BOUND TO THE LOGIN ATTEMPT THAT STARTED IT (slow-link chantier,
 * gap 1, 2026-11-11).
 *
 * `loginImpl` reads an unattended hardware-held key before the token and does not await it in line,
 * so the read can resolve after its login has already ended - failed, stopped by a sign-out, or
 * superseded. Installing the key then would leave a device key in memory for a login that no longer
 * exists: a race that "heals" because nothing is drawn, which is still a defect. So the read carries
 * its ATTEMPT, captured when it starts, and installs only while that same attempt is live. Ending the
 * attempt is a synchronous write in the login's `finally`; the continuation either runs before it (the
 * attempt is live) or after it (dropped) - never a question of timing.
 */

/** One login attempt, as the early read sees it. `live` turns false once, when the attempt ends. */
export interface LoginAttempt {
  readonly id: number;
  live: boolean;
}

/** Starts the identity of a login attempt. */
export function beginLoginAttempt(id: number): LoginAttempt {
  return { id, live: true };
}

/** Ends the attempt: from now on nothing its early read resolves is installed. */
export function endLoginAttempt(attempt: LoginAttempt): void {
  attempt.live = false;
}

/**
 * Waits for `read` and hands its key to `install` only while `attempt` is live and `stillOwned()`
 * agrees (no sign-out since the start). A key resolved for an ended attempt is dropped, with a line
 * saying why. Never rejects: a failed read is `null`, said by the caller's own catch.
 *
 * @param read - The keystore read, already caught to `null` on failure.
 * @param attempt - The attempt captured when the read started.
 * @param stillOwned - Facts outside the attempt that also end it (a sign-out since the start).
 * @param install - Installs the key and starts what draws from it; called at most once.
 * @param log - The login's log line.
 * @returns whether the key was installed.
 */
export async function installEarlyKeyIfLive(
  read: Promise<string | null>,
  attempt: LoginAttempt,
  stillOwned: () => boolean,
  install: (key: string) => void,
  log: (msg: string) => void
): Promise<boolean> {
  const key = await read;
  if (key === null) return false;
  if (!attempt.live) {
    log(
      `[AT_REST_KEY] early key dropped - login attempt ${attempt.id} ended before the read resolved`
    );
    return false;
  }
  if (!stillOwned()) {
    log(`[AT_REST_KEY] early key dropped - signed out during login attempt ${attempt.id}`);
    return false;
  }
  install(key);
  return true;
}
