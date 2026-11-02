import { afterEach, beforeEach, vi } from 'vitest';

/**
 * A STUBBED ResizeObserver for tests whose subject measures from the observer's callbacks
 * (`watchClampOverflow`): `observe` only records, and `fireResize()` delivers the first (or a
 * later) callback to every live observer, standing in for the browser's layout step. Call
 * `useResizeObserverStub()` at the top of the file.
 */
const live = new Set<{ callback: (entries: unknown[]) => void }>();

/**
 * Delivers a resize callback to every observer that is still observing something. The copy is
 * taken first on purpose: a callback may observe or unobserve while being delivered, and a live
 * Set loop would then visit an observer added mid-delivery.
 */
export function fireResize(): void {
  for (const o of Array.from(live)) o.callback([]);
}

/** Installs the stub before each test and removes it after. */
export function useResizeObserverStub(): void {
  beforeEach(() => {
    live.clear();
    class StubObserver {
      private entry: { callback: (entries: unknown[]) => void } = { callback: () => {} };
      constructor(callback: (entries: unknown[]) => void) {
        this.entry.callback = callback;
      }
      observe() {
        live.add(this.entry);
      }
      unobserve() {
        live.delete(this.entry);
      }
      disconnect() {
        live.delete(this.entry);
      }
    }
    vi.stubGlobal('ResizeObserver', StubObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    live.clear();
  });
}
