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
      var identity = -1;
      try {
        identity = 0;
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k === null) continue;
          if (k.indexOf('mls_device_id_') === 0 || k.indexOf('canari_device_key_vault') === 0) identity++;
        }
      } catch (e) { identity = -1; }
      var bytes = null;
      try { bytes = (await navigator.storage.estimate()).usage; } catch (e) { bytes = null; }
      return JSON.stringify({
        localStorageKeys: keys,
        sessionStorageKeys: session,
        canariDatabases: dbs,
        identityKeys: identity,
        cacheEntries: cacheNames,
        bytesInUse: bytes,
      });
    })()`,
  );
  return JSON.parse(raw);
}

/**
 * True when nothing that could only have come from an enrolled SESSION is left in the WebView's
 * stores.
 *
 * Two criteria, and the other counts are evidence beside them - because each of the others is
 * rewritten by an empty app. `PARAGLIDE_LOCALE` lands in localStorage the moment the page draws a
 * frame, and the service worker re-caches the shell on the very next navigation, so a wiped device
 * that has merely been LOOKED at already has a key and a cache entry. Asserting those at zero
 * would fail a correct wipe for having been observed.
 *
 * `CanariDB*` is created by nothing but a signed-in session. It is not enough on its own: on a
 * Tauri client the message store is native SQLite, so it reads 0 whether the account is there or
 * not - measured on A1 on 2026-08-28, which answered "nothing of the account remains" while
 * holding eleven conversations. `mls_device_id_<userId>` (written only by `BaseMlsService` at
 * enrolment) and `canari_device_key_vault` (the wrapped device key) are the identity and the key
 * material, so a count of those two discriminates on every engine.
 *
 * `-1` means the store could not be read, which is NOT zero and is why both read `=== 0`.
 */
export function nothingOfTheAccountRemains(f) {
  return f.canariDatabases === 0 && f.identityKeys === 0;
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
  let verdict = nothingOfTheAccountRemains(f);
  let native = null;
  // A Tauri client keeps its message store, its MLS state and the Graine seeds NATIVELY, where CDP
  // cannot see them. Reading only the WebView on such a device measures the smaller half and calls
  // it the device: on 2026-08-28 that half was empty while `mls.bin`, `graine_seeds.json` and six
  // cached faces were still on disk. So the phone's verdict is the AND of the two, and a native
  // half that could not be read at all voids it rather than passing it.
  if (ORIGIN[label].includes("tauri")) {
    const { nativeResidue } = await import("./phone.mjs");
    native = nativeResidue();
    verdict = verdict && native.residue === 0;
    console.log(`[footprint] ${label} native ${JSON.stringify(native)}`);
  }
  console.log(
    `[footprint] ${label} ${JSON.stringify(f)} -> ${
      verdict ? "nothing of the account remains" : "STATE PRESENT"
    }`,
  );
  cx.close();
}
