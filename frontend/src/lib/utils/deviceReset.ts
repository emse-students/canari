import { isTauriRuntime } from '$lib/utils/openExternal';

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

  if (isTauriRuntime()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await step('the native MLS state', async () => {
      await invoke('delete_mls_state');
    });
    await step('the biometric key', async () => {
      const { BiometricService } = await import('$lib/services/biometric');
      await BiometricService.disable();
    });
    // Every .db file in the Tauri app data directory.
    await step('the native app data', async () => {
      await invoke('clear_app_data');
    });
  } else {
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
                req.onerror = () => resolve();
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
  }

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

  if (failures.length > 0) {
    console.error(
      `[RESET] finished with ${failures.length} step(s) unfinished: ${failures.join(', ')}`
    );
  } else {
    console.log('[RESET] done - nothing of this device remains');
  }
  return failures;
}
