/**
 * Says whether a value is NEW for its key since the last time it was asked - the memory behind "log
 * once per change, not once per connection".
 *
 * A reconnect re-runs every sweep, and a sweep that reaches the same verdict for the same group
 * printed it again: 11 lines per connection, ~8 % of one 1.6.8 log (`[SYNC] WASM kept`, 300
 * `[DISCOVERY] ... kept`). The verdict was already known; the line carried nothing the first one did
 * not. What a reader needs is the CHANGE, so the first sight of a (key, value) is the line and a
 * repeat is nothing - while a key whose value moves is announced again.
 *
 * DURABLE STATE, NOT A CLOCK: nothing expires, and the map is bounded by the keys a session meets
 * (the groups one device holds). Memory only - a reload says it all once more, which is the right
 * amount for a fresh log.
 */
export interface ChangeLatch {
  /** True when `value` differs from the last one recorded for `key` (or none was): records it. */
  changed(key: string, value: string): boolean;
  /** Forgets everything (an account switch, tests). */
  reset(): void;
}

/** A fresh latch. */
export function createChangeLatch(): ChangeLatch {
  const last = new Map<string, string>();
  return {
    changed(key, value) {
      if (last.get(key) === value) return false;
      last.set(key, value);
      return true;
    },
    reset() {
      last.clear();
    },
  };
}
