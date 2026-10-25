/**
 * The per-account `localStorage` the MLS client's small durable records live in
 * (`owedInvitations.ts`, `addLockMarkers.ts`), RESOLVED ONCE: a page with no usable storage
 * (blocked site data, a runtime without one) says so in one line, not on every Welcome, lock or
 * release that asks.
 */
let store: Storage | null | undefined;

/** The usable store, or null - logged once, at error, the first time it is found missing. */
export function accountStore(): Storage | null {
  if (store !== undefined) return store;
  try {
    const s = globalThis.localStorage;
    // The accessor itself may throw, and a present object may refuse its first read.
    s.getItem('__mls_account_store_probe__');
    store = s;
  } catch (e) {
    store = null;
    console.error(
      `[ACCOUNT_STORE] no usable local storage - a lost invitation is told instead of recorded, and an add lock left behind by a dead page waits for its expiry: ${String(e).slice(0, 120)}`
    );
  }
  return store;
}
