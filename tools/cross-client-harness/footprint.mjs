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
 * TWO HALVES, AND THE VERDICT IS THE AND OF THEM. `storageFootprint` reads the WebView's own stores,
 * which is all CDP can reach; on a Tauri client that is the smaller half, because `mls.bin`, the
 * per-user SQLite store and the Graine seeds live in the app data directory where only `adb` can see
 * them. Reading the web half alone once answered "nothing of the account remains" about a phone that
 * was displaying eleven conversations - a predicate that CANNOT FAIL on the device class it judges is
 * not a criterion. `deviceResidue()` is therefore the entry point for any assertion, and an
 * unreadable native half VOIDS its verdict rather than passing it.
 *
 * Usage: node footprint.mjs --device W1
 */
import { client, evaluate } from "./chat.mjs";
import { residueVerdict } from "./native-residue.mjs";
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
/**
 * THE WEB HALF ALONE. Kept exported because a web device has no other half, but **do not call this
 * about a device that might be a phone** - use `deviceResidue()`, which is the AND of both halves.
 * On a Tauri origin this returns true for an enrolled device.
 */
export function nothingOfTheAccountRemains(f) {
  return f.canariDatabases === 0 && f.identityKeys === 0;
}

/** An error's first line only: a stack in a ledger detail is noise nobody reads. */
const firstLine = (e) =>
  String(e?.message ?? e)
    .split(String.fromCharCode(10))[0]
    .trim()
    .slice(0, 200);

/**
 * What is left of the account on a device, BOTH halves, with the verdict computed in one place.
 *
 * This is what a runner asserts on. It reads the WebView over CDP and, for a Tauri origin, the app's
 * private directory over `adb run-as` - and `residueVerdict` in `native-residue.mjs` decides what
 * the pair MEANS, so the answer cannot differ between this and the command line.
 *
 * @param label - a device label, `W1` / `A1` - it selects the origin, which decides whether there
 *   is a native half at all
 * @param cx - an open connection to that device's page
 */
export async function deviceResidue(label, cx) {
  const web = await storageFootprint(cx);
  let native = null;
  if (ORIGIN[label].includes("tauri")) {
    const { nativeResidue } = await import("./phone.mjs");
    try {
      native = nativeResidue();
    } catch (e) {
      // An unreadable native half is reported as unreadable. Returning `null` here would say "this
      // device has no native half", which is the one lie that turns a dirty phone green.
      native = { residue: null, error: firstLine(e) };
    }
  }
  return { label, web, native, ...residueVerdict(web, native) };
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
  const r = await deviceResidue(label, cx);
  if (r.native) console.log(`[footprint] ${label} native ${JSON.stringify(r.native)}`);
  console.log(
    `[footprint] ${label} ${JSON.stringify(r.web)} -> ${
      r.empty ? "nothing of the account remains" : r.readable ? "STATE PRESENT" : "UNREADABLE"
    }${r.why.length ? ` (${r.why.join("; ")})` : ""}`,
  );
  cx.close();
}
