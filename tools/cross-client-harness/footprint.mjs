/**
 * What is LEFT on a device, read off the device instead of out of its own log.
 *
 * `[RESET] done - nothing of this device remains` is a statement about the steps that RAN, which is
 * a different claim from "the disk is empty" - and on 2026-08-28 the two disagreed on prod: a
 * revoked device printed exactly that line and kept ten localStorage keys, its per-user MLS database
 * and 8.2 MB, because the SYNC_WATCHDOG nobody had stopped rebuilt them 1.25 s later. Twenty HEAL
 * rows asserted the log line and none asked the disk, so the wipe was believed for precisely as long
 * as it was broken.
 *
 * COUNTS ONLY, NEVER NAMES: a surviving key is `mls_not_ready_since:<userId>:<groupId>`, and this
 * output is read into a PUBLIC repository.
 *
 * It reads the WebView's own stores, which is all CDP can reach. On A1 that is the whole of the web
 * half and none of the native half - `delete_mls_state` and `clear_app_data` write to the Tauri app
 * data directory, and only `adb` can see whether those files are gone. A row about a phone needs
 * BOTH, and this module deliberately answers only the half it can prove.
 *
 * Usage: node footprint.mjs --device W1
 */
import { client, evaluate } from "./chat.mjs";
import { ORIGIN, PORTS } from "./names.mjs";
import { pathToFileURL } from "node:url";

/**
 * @param cx - an open CDP connection to the page whose origin is being measured
 * @returns counts, and `-1` for a store that could not be read at all - which is not zero
 */
export async function storageFootprint(cx) {
  const raw = await evaluate(
    cx,
    `(async function () {
      var keys = -1;
      try { keys = localStorage.length; } catch (e) { keys = -1; }
      var session = -1;
      try { session = sessionStorage.length; } catch (e) { session = -1; }
      var dbs = -1;
      try {
        if (indexedDB.databases) {
          var all = await indexedDB.databases();
          dbs = all.filter(function (d) { return d.name && d.name.indexOf('CanariDB') === 0; }).length;
        }
      } catch (e) { dbs = -1; }
      var cacheNames = -1;
      try {
        if (typeof caches !== 'undefined') cacheNames = (await caches.keys()).length;
      } catch (e) { cacheNames = -1; }
      var bytes = null;
      try { bytes = (await navigator.storage.estimate()).usage; } catch (e) { bytes = null; }
      return JSON.stringify({
        localStorageKeys: keys,
        sessionStorageKeys: session,
        canariDatabases: dbs,
        cacheEntries: cacheNames,
        bytesInUse: bytes,
      });
    })()`,
  );
  return JSON.parse(raw);
}

/**
 * True when nothing that could only have come from a SESSION is left in the WebView's stores.
 *
 * Only the databases are a criterion, and the other three counts are evidence beside them - because
 * each of the others is rewritten by an empty app. `PARAGLIDE_LOCALE` lands in localStorage the
 * moment the page draws a frame, and the service worker re-caches the shell on the very next
 * navigation, so a wiped device that has merely been LOOKED at already has a key and a cache entry.
 * Asserting those at zero would fail a correct wipe for having been observed.
 *
 * `CanariDB*` is different: nothing but a signed-in session creates one, so one surviving database
 * is the whole of the claim. `-1` means the store could not be read, which is NOT zero and is why
 * this reads `=== 0` rather than `< 1`.
 */
export function nothingOfTheAccountRemains(f) {
  return f.canariDatabases === 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--device");
  const label = i === -1 ? "W1" : process.argv[i + 1];
  const port = PORTS[label];
  if (!port) {
    console.error(`[footprint] no such device: ${label}. Have ${Object.keys(PORTS).join(" ")}`);
    process.exit(2);
  }
  const cx = await client(port, ORIGIN[label], { allowMany: true });
  const f = await storageFootprint(cx);
  console.log(
    `[footprint] ${label} ${JSON.stringify(f)} -> ${
      nothingOfTheAccountRemains(f) ? "nothing of the account remains" : "STATE PRESENT"
    }`,
  );
  cx.close();
}
