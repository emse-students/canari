/**
 * THE KLIPY CUSTOMER ID, RETIRED (owner decision 2026-10-16). Builds before the GIF search moved to
 * the server kept a random per-install identifier under this key and sent it to KLIPY with every
 * search, so KLIPY could tie one install's searches together. Nothing reads it any more; the root
 * layout drops it at startup. A shim with a removal condition: docs/wiki/legacy-compatibility.md.
 */
const RETIRED_KEY = 'klipy_cid';

/** Removes the retired identifier if this device still holds it. Storage may be absent or throw: logged. */
export function dropRetiredKlipyCustomerId(): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage || storage.getItem(RETIRED_KEY) === null) return;
    storage.removeItem(RETIRED_KEY);
    console.log(`[GifSearch] dropped the retired KLIPY customer id (${RETIRED_KEY})`);
  } catch (error) {
    console.warn(
      `[GifSearch] the retired KLIPY customer id could not be dropped: ${String(error)}`
    );
  }
}
