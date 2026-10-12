/**
 * The PIN salt round trip started while the keypad is up, per user, consumed by the next submit.
 *
 * WHY IT EXISTS: the salt is the first thing a PIN submit needs, and it does not depend on the PIN.
 * Asked at submit, it was 350 ms of a cold notification open on the Mi 9T (2026-10-12, median of
 * six), paid after the person had finished typing - and on a fresh process it is also the request
 * that opens the connection, which the keypad time now absorbs as well.
 *
 * WHAT IT DOES NOT CHANGE: the salt never touches storage (it lives in this process's memory, as it
 * already did for the length of every login), and the PIN check, the derivations and every decision
 * stay in `loginImpl`. An entry is consumed exactly once ({@link takePinSaltAhead}), so a second
 * submit after a wrong PIN gets a round trip of its own, and a rejected entry is evicted the moment
 * it fails so the submit asks the server itself and surfaces ITS answer.
 *
 * The round trip is passed in rather than imported, so this module holds the whole lifecycle and
 * nothing else - and a test can drive it without a network or a token.
 */

const ahead = new Map<string, Promise<string>>();

/**
 * Starts `fetchSalt` for `userId` unless a round trip for that user is already in flight.
 *
 * @returns `true` when a round trip was started by this call.
 */
export function askPinSaltAhead(
  userId: string,
  fetchSalt: () => Promise<string>,
  log: (msg: string) => void
): boolean {
  if (!userId.trim()) {
    log('[PIN] Salt not asked ahead: no user id yet.');
    return false;
  }
  if (ahead.has(userId)) {
    log('[PIN] Salt already asked ahead for this keypad.');
    return false;
  }
  log('[PIN] Asking the salt while the keypad is up.');
  const pending = fetchSalt();
  ahead.set(userId, pending);
  pending.catch((e: unknown) => {
    // Only this entry is evicted: a later round trip for the same user is not this one's to drop.
    if (ahead.get(userId) === pending) ahead.delete(userId);
    log(`[PIN] Salt asked ahead failed (${String(e)}); the submit will ask the server itself.`);
  });
  return true;
}

/**
 * Hands the round trip started for `userId` to the submit that consumes it, and forgets it.
 *
 * @returns The pending salt, or `undefined` when no round trip was started for this user.
 */
export function takePinSaltAhead(userId: string): Promise<string> | undefined {
  const pending = ahead.get(userId);
  ahead.delete(userId);
  return pending;
}

/** Test seam: forgets every entry, so one test cannot hand its round trip to the next. */
export function resetPinSaltAheadForTests(): void {
  ahead.clear();
}
