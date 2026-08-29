import { closeMlsDb } from '$lib/utils/hex';
import { isTauriRuntime } from '$lib/utils/openExternal';

/**
 * Everything still on this device that a factory wipe was supposed to remove.
 *
 * Names the survivors rather than counting them: a count cannot say whether a step did nothing or
 * something re-created what it deleted, and those have different fixes.
 */
async function surveyDeviceStorage(): Promise<string[]> {
  const survivors: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null) survivors.push(k);
    }
  } catch (e) {
    console.warn('[RESET] could not read the stored preferences back:', e);
  }
  try {
    if (indexedDB.databases) {
      const all = await indexedDB.databases();
      for (const db of all) if (db.name?.startsWith('CanariDB')) survivors.push(db.name);
    }
  } catch (e) {
    console.warn('[RESET] could not read the local databases back:', e);
  }
  return survivors;
}

/**
 * Every platform-keystore alias this device recorded, read off the device itself.
 *
 * The alias is `mls_device_key_<userId>_<deviceId>`, and only the session that created it knows both
 * halves - which is why the wipe used to call `BiometricService.disable()` with NO alias at all and
 * therefore deleted no key: a step named "the biometric key" that cleared two flags. Rather than ask
 * a caller to thread an identity in (the login page's reset button has no session and could not),
 * the pairs are reconstructed from the `mls_device_id_<userId>` records the device already keeps, so
 * both callers sweep the same set and neither needs to know anything.
 *
 * MUST BE READ BEFORE `localStorage.clear()`, which is why it is a separate step and not inlined.
 */
function recordedKeystoreAliases(): string[] {
  const aliases: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null || !key.startsWith('mls_device_id_')) continue;
      const userId = key.slice('mls_device_id_'.length);
      const deviceId = localStorage.getItem(key);
      if (userId && deviceId) aliases.push(`mls_device_key_${userId}_${deviceId}`);
    }
  } catch (e) {
    console.warn('[RESET] could not read the recorded device ids back:', e);
  }
  return aliases;
}

/**
 * Returns this device to the state of a brand-new install: no MLS state, no local database, no
 * cached response, no stored preference, nothing in the platform keystore.
 *
 * Two callers need EXACTLY this and used to share nothing: the login page's "reset" button, and a
 * device the server has revoked. The second is why it is more than an MLS wipe - a revoked device
 * is one its owner has declared lost or stolen, so leaving its cached avatars, its drafts, its
 * theme and its conversation list behind answers the wrong question. What must remain afterwards is
 * an app that has never been used.
 *
 * BEST-EFFORT PER STEP, DELIBERATELY, AND NEVER SILENT. One failing store must not stop the others -
 * the alternative is a wipe that stops half way and reports success - so each step is caught
 * individually and each failure is logged with what it was clearing. Callers that must know use the
 * returned list of failures.
 *
 * It does NOT log out: signing out is a server round trip with its own failure mode, and the two are
 * kept separate so the wipe cannot be blocked by an unreachable server.
 *
 * @param closeStorage - closes the open database connection before it is deleted. Without it
 *   `deleteDatabase` merely BLOCKS, and the wipe completes at some later moment nobody controls.
 * @returns the steps that failed, empty when everything was cleared
 */
export async function wipeDeviceToFactory(closeStorage?: () => Promise<void>): Promise<string[]> {
  const failures: string[] = [];
  console.log('[RESET] wiping this device back to a fresh install');

  const step = async (what: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (e) {
      failures.push(what);
      console.error(`[RESET] could not clear ${what}:`, e);
    }
  };

  if (closeStorage) await step('the open database connection', closeStorage);

  // THE CONNECTION NO CALLER CAN PASS. `closeStorage` covers the message store, which the session
  // owns and can therefore hand over; `CanariDBMls_<userId>` is held by a module singleton inside
  // `hex.ts`, opened on first use, never released, and REOPENED by `removeMlsState` - which is the
  // last thing a revoked device does before this runs. `deleteDatabase` does not fail on an open
  // connection, it BLOCKS, so the wipe deferred the delete, reported the store as a SURVIVOR and
  // left a device its owner had declared lost holding its MLS state. Measured by HEAL-REVOKE-5 on
  // prod, 2026-08-29. It is closed HERE and not asked of the caller because no caller can see it.
  await step('the MLS database connection', closeMlsDb);

  // READ BEFORE ANYTHING IS CLEARED: the aliases live in the very store this wipe empties.
  const aliases = recordedKeystoreAliases();

  if (isTauriRuntime()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await step('the native MLS state', async () => {
      await invoke('delete_mls_state');
    });
    // Everything Canari wrote in the Tauri app data directory: the MLS state, the message
    // database, the Graine seeds and channel keys the background push service reads, the
    // cached notification avatars and the device-key alias index. NOT the WebView's own
    // stores, which the unconditional block below owns - and which this step must not touch,
    // because deleting them from under a running engine is what killed the process.
    await step('the native app data', async () => {
      await invoke('clear_app_data');
    });
  }

  // UNCONDITIONAL, AND IT USED TO BE THE `else` OF THE BRANCH ABOVE. Every platform has a WebView
  // with its own stores, so the native steps are an ADDITION to this one and never a replacement -
  // measured on a Pixel 6a on 2026-08-28, which held a `CanariDB_<userId>` of 5.9 MB that no wipe on
  // that platform could reach. The phone's real message store is SQLite, so that database should not
  // have existed at all; what created it is a call site that opened IndexedDB without asking the
  // runtime, and one such call site is enough to leave a revoked phone holding its conversations.
  await step('the local databases', async () => {
    // `indexedDB.databases()` is absent on Firefox, where there is no way to enumerate them; the
    // per-user database is dropped by its own name instead, which is what the session teardown
    // already did before this existed.
    if (!indexedDB.databases) return;
    const all = await indexedDB.databases();
    await Promise.all(
      all
        .filter((db) => db.name?.startsWith('CanariDB'))
        .map(
          (db) =>
            new Promise<void>((resolve) => {
              if (!db.name) return resolve();
              const req = indexedDB.deleteDatabase(db.name);
              req.onsuccess = () => resolve();
              // A DELETE THAT FAILED USED TO LOOK EXACTLY LIKE ONE THAT WORKED. `resolve()` alone
              // left the survey as the only witness, which says WHAT remains and never WHY - and
              // the two databases HEAL-REVOKE-5 found surviving were distinguishable only by the
              // one that happened to log `blocked`. Every swallowed branch logs.
              req.onerror = () => {
                console.error(`[RESET] could not delete ${db.name}:`, req.error);
                resolve();
              };
              // Reached only if something else still holds the database open - a second tab, for
              // instance. The delete then completes when that connection closes, so the reset is
              // not lost, only deferred; saying so is what stops it reading as success.
              req.onblocked = () => {
                console.warn(`[RESET] ${db.name} is still open elsewhere - delete deferred`);
                resolve();
              };
            })
        )
    );
  });

  // The HTTP cache the service worker keeps. Cached avatars and media outlive every other store,
  // which is exactly what "wipe the cache" means to the person asking for it.
  await step('the cached responses', async () => {
    if (typeof caches === 'undefined') return;
    const names = await caches.keys();
    await Promise.all(names.map((n) => caches.delete(n)));
  });

  await step('the stored preferences', async () => {
    localStorage.clear();
    sessionStorage.clear();
  });

  // LAST, AND THAT IS THE WHOLE POINT. `step()` catches a rejected promise, which is every failure
  // this file can survive - but the biometric plugin raises an ANDROID ACTIVITY, and an activity
  // that fails to inflate takes the PROCESS with it. Measured on a Pixel 6a on 2026-08-28: this step
  // ran third, `BiometricActivity` died on a missing `CoordinatorLayout`, the process was killed 55
  // ms after `[RESET] wiping this device back to a fresh install`, and the revoked phone kept its
  // `CanariDB` and 5.9 MB because every step after this one never ran. `forget` no longer raises an
  // activity, so the crash is gone at the source; running the only step that COULD kill the process
  // after all the others is what stops a future one costing them.
  //
  // It also asks for no fingerprint, deliberately - see `BiometricService.forget`.
  // Gated on the runtime because the platform keystore is the only thing this step can reach, and
  // only Tauri has one; on the web the flag it also clears left with `localStorage.clear()` above.
  if (isTauriRuntime()) {
    await step('the biometric keys', async () => {
      const { BiometricService } = await import('$lib/services/biometric');
      // Per alias, so one unreachable keystore entry cannot cost the others - and once with none,
      // so the native flag is cleared on a device that recorded no id at all.
      for (const alias of aliases) await BiometricService.forget(alias);
      if (aliases.length === 0) await BiometricService.forget();
    });
  }

  // NEVER CLAIM AN EMPTY DEVICE WITHOUT LOOKING. This function used to print "nothing of this
  // device remains" on the strength of the steps it RAN, and on 2026-08-28 it printed it on a
  // revoked device that kept its MLS database and ten `mls_not_ready_since` keys - 8.2 MB - because
  // the session's watchdog was still running and rebuilt them 1.25 s later. A wipe reports what it
  // deleted; only a survey reports what is GONE, which is the claim being made.
  const survivors = await surveyDeviceStorage();
  if (failures.length > 0) {
    console.error(
      `[RESET] finished with ${failures.length} step(s) unfinished: ${failures.join(', ')}`
    );
  }
  if (survivors.length > 0) {
    console.error(
      `[RESET] ${survivors.length} store(s) SURVIVED the wipe: ${survivors.join(', ')}`
    );
  } else if (failures.length === 0) {
    console.log('[RESET] done - nothing of this device remains');
  }

  // THE SURVEY IS SYNCHRONOUS ON PURPOSE, and a second, later look was deliberately NOT added: the
  // login page's "reset" button is the other caller, and a user who signs back in writes keys
  // within seconds, so a delayed audit would accuse an ordinary new session of being a zombie. What
  // stops the state coming back is `tearDownLiveSession`, which leaves nothing running to write it.

  return failures;
}
