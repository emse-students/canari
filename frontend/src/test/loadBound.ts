import { vi } from 'vitest';

/**
 * THE FAILURE CEILING OF A WAIT FOR AN EVENT, never an assertion about speed (docs/wiki/test-suite-reform.md
 * s8). A test that waits for something to HAPPEN ends the instant it does; this is only how long it
 * is willing to be told it never will. The defaults (1 s for `vi.waitFor`, 5 s for a test) are
 * tighter than a worker frozen by CPU oversubscription, which fails whichever test it was in - the
 * victims are random, the cause is the load. A file whose cases drive real IndexedDB/SQLite fakes
 * calls {@link useLoadBounds} once; a genuine hang still fails, only later.
 */
export const EVENT_BOUND_MS = 20_000;

/** The test deadline that leaves {@link EVENT_BOUND_MS} room to report its own failure first. */
export const TEST_BOUND_MS = 30_000;

/** Raises the test deadline of the calling file; pair with {@link waitForEvent} for the waits. */
export function useLoadBounds(): void {
  vi.setConfig({ testTimeout: TEST_BOUND_MS });
}

/** `vi.waitFor` with the {@link EVENT_BOUND_MS} ceiling. */
export function waitForEvent<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, { timeout: EVENT_BOUND_MS, interval: 20 });
}

/** The most event-loop turns {@link waitForEventNoClock} gives an event (no clock reads them). */
export const EVENT_TURNS = 200_000;

/**
 * {@link waitForEvent} for a case that FAKES TIMERS: `vi.waitFor` advances a faked clock by its
 * interval on every poll, so a loaded machine (many polls) moves time by itself and can cross a
 * backoff the case drives by hand. This one polls once per macrotask turn and touches no clock, real
 * or faked; its bound is a count of turns, never a duration.
 */
export async function waitForEventNoClock(check: () => unknown | Promise<unknown>): Promise<void> {
  let last: unknown;
  for (let turn = 0; turn < EVENT_TURNS; turn++) {
    try {
      await check();
      return;
    } catch (e) {
      last = e;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw last;
}
