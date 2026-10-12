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
 * stay in `pinUnlock.ts`. An entry is consumed exactly once ({@link takePinSaltAhead}), so a second
 * submit after a wrong PIN gets a round trip of its own.
 *
 * A FAILED ROUND TRIP IS A RESULT, NOT A REJECTION. The entry settles to `{ failure }` instead, so a
 * submit that took it before it failed is handed a value it must branch on, and cannot be handed the
 * prefetch's exception in place of its own: `unlockWithPin` reads the failure, logs it, and asks the
 * salt at submit with that login's token - the round trip it would have made without this module.
 * A failure that lands while nobody has taken the entry evicts it, with the same effect.
 *
 * A STALE SALT IS THE SERVER'S TO NAME. A PIN reset elsewhere while the keypad is up mints a new salt
 * on the next GET; the entry here cannot know. `pin-check` is sent the salt it was derived from and
 * answers `stale-salt` without comparing anything, so a correct PIN is never refused for it.
 *
 * WHEN IT IS FORGOTTEN ({@link forgetPinSaltAhead}): every way the keypad stops being the next
 * thing to submit - an unlock (by PIN, biometrics or the vault), the keypad closing, a sign-out, a
 * PIN reset. An entry left behind would otherwise be handed to a later keypad for a different
 * session.
 *
 * The round trip is passed in rather than imported, so this module holds the whole lifecycle and
 * nothing else - and a test can drive it without a network or a token.
 */

/** What a salt round trip asked ahead came to: the salt, or why it did not arrive. */
export type PinSaltAhead = { salt: string } | { failure: string };

const ahead = new Map<string, Promise<PinSaltAhead>>();

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
  const pending: Promise<PinSaltAhead> = fetchSalt().then(
    (salt) => ({ salt }),
    (e: unknown) => {
      // Only this entry is evicted: a later round trip for the same user is not this one's to drop.
      if (ahead.get(userId) === pending) ahead.delete(userId);
      log(`[PIN] Salt asked ahead failed (${String(e)}); the submit will ask the server itself.`);
      return { failure: String(e) };
    }
  );
  ahead.set(userId, pending);
  return true;
}

/**
 * Hands the round trip started for `userId` to the submit that consumes it, and forgets it.
 *
 * @returns The pending result, or `undefined` when no round trip was started for this user.
 */
export function takePinSaltAhead(userId: string): Promise<PinSaltAhead> | undefined {
  const pending = ahead.get(userId);
  ahead.delete(userId);
  return pending;
}

/**
 * Drops every round trip asked ahead, because the keypad it was asked for is no longer the next
 * thing to submit. Silent when there was nothing to drop.
 *
 * @param reason - What ended the keypad, for the log line.
 */
export function forgetPinSaltAhead(reason: string, log: (msg: string) => void): void {
  if (ahead.size === 0) return;
  ahead.clear();
  log(`[PIN] Salt asked ahead forgotten: ${reason}.`);
}

/** Test seam: forgets every entry, so one test cannot hand its round trip to the next. */
export function resetPinSaltAheadForTests(): void {
  ahead.clear();
}
