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
