/**
 * Starts the MLS WASM download at app boot instead of after the PIN round trip.
 *
 * ## THE MEASUREMENT THIS EXISTS FOR
 *
 * Production console export from a real account, 2026-09-16 on `0.18.4`: `Initialised in WEB mode`
 * at 07:57:49 and `[TAB] Leadership acquired` at 07:58:04 - **fifteen seconds**, of which
 * `mls_wasm_bg.wasm` alone was **13 286 ms**. The gateway itself was instant once reached (the WS
 * opened and confirmed inside the same second), and the batch history primed 20 groups in ONE
 * request. Nothing else was slow. The whole wait was one file.
 *
 * ## WHY IT WAS LAST IN THE QUEUE, WHICH IS THE ACTUAL DEFECT
 *
 * `loadMlsWasmModule` is reached from the session start-up, so the chain is: verify the PIN against
 * the server, then dynamically import the loader chunk, then dynamically import `?url` to learn the
 * hashed path, THEN fetch ~723 kB (brotli; 2 106 406 bytes raw). Four sequential steps, the first of
 * them a network round trip - and by the time the fetch is issued the social feed has already put
 * two dozen avatar requests and a dozen link previews on the connection. In the export above the
 * binary averaged 54 kB/s while 24 avatars ran beside it at a median of 824 ms each.
 *
 * **None of those steps is a dependency.** The binary is a static, content-hashed asset: it does not
 * depend on the PIN, on a session, on a device key or on any stored state - only DECRYPTING the
 * state does. Making it wait for authentication is ordering, not necessity, which is why the fix is
 * to start it earlier rather than to make it smaller or to race it with a timeout.
 *
 * ## WHY IT IS GUARDED RATHER THAN UNCONDITIONAL
 *
 * An anonymous visitor reading a public post needs no MLS at all, and 723 kB is not a rounding error
 * on a phone. `mls_device_id_<userId>` is written by `resolveDeviceId` the first time a browser
 * enrols an MLS device and is never cleared by a sign-out, so its presence is exactly the statement
 * "this profile has been signed in here before" - the population that will need the binary. It is a
 * fact already on disk rather than a guess, which is the difference between a prefetch and a
 * gamble.
 */

/** The prefix `BaseMlsService.resolveDeviceId` stores an enrolled device id under, per user. */
const DEVICE_ID_PREFIX = 'mls_device_id_';

/**
 * Whether this browser profile has ever enrolled an MLS device, and therefore will need the WASM.
 *
 * Takes the storage rather than reaching for `localStorage` so the predicate is testable and so a
 * profile that refuses storage (private mode, blocked site data) is answered by the caller's
 * `try`/`catch` rather than by a second code path here.
 *
 * @param storage the store to read; `localStorage` in the browser.
 * @returns `true` when at least one `mls_device_id_*` entry is present.
 */
export function browserHasEnrolledMlsDevice(storage: Pick<Storage, 'length' | 'key'>): boolean {
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(DEVICE_ID_PREFIX)) return true;
  }
  return false;
}

/**
 * Fire-and-forget: warms the MLS WASM module so the session start-up awaits a download already in
 * flight rather than issuing one.
 *
 * `loadMlsWasmModule` memoises its promise, so the real caller later awaits THIS promise - there is
 * no second fetch and no second instantiation to reconcile. That memoisation is what makes this a
 * reordering rather than a duplicate request, and it is why nothing here needs to hand the result
 * anywhere.
 *
 * Failures are swallowed deliberately and this is the one place in the file where that is right: the
 * genuine load runs later on its own error path, which reports to the user and classifies the
 * failure. Reporting it twice would put a message on screen for a request nobody was waiting on.
 */
export function prefetchMlsWasmAtBoot(): void {
  let enrolled = false;
  try {
    enrolled = browserHasEnrolledMlsDevice(localStorage);
  } catch {
    // Storage refused (private mode, blocked site data). Not a prefetch candidate; the ordinary
    // path still works.
    return;
  }
  if (!enrolled) return;

  void import('$lib/mls-client/mlsWasmLoader')
    .then(({ loadMlsWasmModule }) => loadMlsWasmModule())
    .catch(() => {});
}
