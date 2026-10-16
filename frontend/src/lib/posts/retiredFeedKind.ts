/**
 * THE CANAREELS FILTER'S REMEMBERED CHOICE, RETIRED (2026-10-16). The `1.2.9-alpha.2`/`.3` builds kept
 * "Tous les posts" / "CanaReels" under this device-global key; the filter is gone (the CanaReels
 * icon opens the viewer instead), nothing reads the key, so the feed's `load` drops it. A shim with
 * a removal condition: docs/wiki/legacy-compatibility.md.
 */
const RETIRED_KEY = 'canari_post_feed_kind';

/** Removes the retired key if this device still holds it. Storage may be absent or throw: logged. */
export function dropRetiredFeedKind(): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage || storage.getItem(RETIRED_KEY) === null) return;
    storage.removeItem(RETIRED_KEY);
    console.log(`[POSTS] dropped the retired CanaReels filter choice (${RETIRED_KEY})`);
  } catch (error) {
    console.warn(
      `[POSTS] the retired CanaReels filter choice could not be dropped: ${String(error)}`
    );
  }
}
