/**
 * Lets everything already queued run: every pending microtask AND the next macrotask, which is
 * where a mocked `await`, a store write or a `queueMicrotask` chain has settled by.
 *
 * This is a QUEUE position, not a duration - `setTimeout(0)` runs after what is queued whatever the
 * machine's load, so it is the one timer a test may use and the only place this suite spells it.
 * A test that waits for something to HAPPEN uses `vi.waitFor` on that thing; a test that waits for
 * a clock uses fake timers. A positive delay in a test is a wall clock and is refused by
 * `noRealSleeps.test.ts`.
 */
// Captured at import, before any test installs fake timers: the yield must keep working under them.
const realSetTimeout = globalThis.setTimeout;

export function flushMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => realSetTimeout(resolve, 0));
}

/**
 * Yields until `read()` has returned the same value on `quiet` consecutive macrotasks. For asserting
 * that NOTHING more happens: a fixed sleep guesses how long "more" would take, this waits for the
 * system to stop moving, however many hops an append, a decrypt or a fetch needs.
 */
export async function settleUntilStable<T>(read: () => T, quiet = 3): Promise<T> {
  let last = read();
  for (let stable = 0; stable < quiet;) {
    await flushMacrotask();
    const now = read();
    stable = Object.is(now, last) ? stable + 1 : 0;
    last = now;
  }
  return last;
}
