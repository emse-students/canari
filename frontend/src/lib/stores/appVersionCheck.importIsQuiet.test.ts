/**
 * IMPORTING THE VERSION STORE MUST NOT PUT A REQUEST ON THE WIRE.
 *
 * It used to. The module body ran `void refreshAppVersionCheck()` beside its hydration, and the
 * root layout calls the same function on mount next to the `focus`/`online`/`visibilitychange`
 * listeners - so an ordinary boot carried **two** `GET /api/version`. Read on production on
 * 2026-09-16: one before `Initialised in WEB mode (WASM)` and one after it.
 *
 * `inflight` is not a defence against this. It dedupes CONCURRENT calls, so the two collided only
 * when the second was raised before the first had answered; when the first won the race, as it did
 * there, both went out. A guard that tolerates a second caller inside some window would be a clock
 * deciding idempotence - the one thing a clock must never decide. The fix is to have one caller.
 *
 * What must STILL happen at import is hydration from cached metadata: it is synchronous, reads only
 * `localStorage`, and is what lets a blocking verdict be known before anything renders.
 */
const SERVER_INFO = {
  version: '0.18.7',
  minClientVersion: '0.1.0',
  maintenance: { enabled: false },
};

// The first import of this store transforms a wide module graph (connectivity, storage, paraglide),
// which is comfortably past vitest's 5 s default on a cold run. The timeout is about the compiler,
// not about anything this test asserts.
describe('importing appVersionCheck', { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('fires no version probe', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SERVER_INFO), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await import('./appVersionCheck.svelte');
    // Let any promise the module body might have started settle before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still adopts the cached verdict, which is what makes the probe droppable', async () => {
    // The key and shape are the store's own; writing it through the module keeps this test from
    // restating a storage format it does not own.
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SERVER_INFO), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    const mod = await import('./appVersionCheck.svelte');
    await mod.refreshAppVersionCheck();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const reloaded = await import('./appVersionCheck.svelte');
    await Promise.resolve();
    // A fresh import of the module finds the verdict already there, with no second request.
    expect(reloaded.getAppVersionCheck()).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
