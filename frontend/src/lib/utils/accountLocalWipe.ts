import { closeCachedStore, closeOpenIndexedDbStores } from '$lib/db';
import { closeOutboxBlobStores } from '$lib/db/outboxBlob';
import { closeMlsDb } from '$lib/utils/hex';
import { clearDeviceKey } from '$lib/utils/deviceKeyVault';
import { deleteIndexedDbByName } from '$lib/utils/indexedDbDelete';
import { isTauriRuntime } from '$lib/utils/openExternal';

/** The IndexedDB databases keyed by an account id, all of which die with that account. */
export function accountIndexedDbNames(userId: string): string[] {
  return [`CanariDB_${userId}`, `CanariDBOutbox_${userId}`, `CanariDBMls_${userId}`];
}

/**
 * Removes what ONE deleted account left on this device: its local message database and its slot of
 * the device-key vault. NOT a device reset - another account signed in on the same install keeps its
 * database, its vault slot, the in-app log, the preferences and `mls.bin` (one file per install,
 * which may hold another account's state, so it is deliberately left alone).
 *
 * A sign-out keeps all of this on purpose ("keep the state"); a DELETION is the one exit after which
 * nobody can ever open it again, so leaving it is only a cost: every message row stays under the
 * device key. The caller has already ended the live session and waited for its final checkpoint,
 * otherwise a write still in flight would recreate what this deletes.
 *
 * BEST-EFFORT PER STEP AND NEVER SILENT, like the device wipe: the account is already gone on the
 * server, so one failing store must not stop the others, and each failure is logged and returned.
 *
 * @returns the steps that failed, empty when everything was removed
 */
export async function wipeDeletedAccountLocalData(userId: string): Promise<string[]> {
  const failures: string[] = [];
  const tag = `[DEL-LOCAL] ${userId.slice(0, 8)}`;
  console.log(`${tag} removing this account's local database and vault slot`);

  const step = async (what: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (e) {
      failures.push(what);
      console.error(`${tag} could not clear ${what}:`, e);
    }
  };

  // Handles first: a delete does not fail on an open connection, it BLOCKS (see `deviceReset.ts`).
  await step('the message store handle', async () => {
    await closeCachedStore(userId);
    await closeOpenIndexedDbStores();
  });
  await step('the outbox attachment connections', async () => {
    await closeOutboxBlobStores();
  });
  await step('the MLS database connection', closeMlsDb);

  // The WebView's databases exist on every platform (a phone's MESSAGE store is SQLite, but its
  // outbox blobs are IndexedDB), and are named by the account, so no other account is reachable.
  await step('the local IndexedDB databases', async () => {
    const results = await Promise.all(
      accountIndexedDbNames(userId).map((name) => deleteIndexedDbByName(name, '[DEL-LOCAL]'))
    );
    if (results.includes(false)) throw new Error('an IndexedDB delete failed or is deferred');
  });

  if (isTauriRuntime()) {
    await step('the native message database', async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('delete_user_database', { userId });
    });
  }

  await step('the device-key vault slot', async () => {
    clearDeviceKey(userId);
  });

  if (failures.length > 0) {
    console.error(
      `${tag} finished with ${failures.length} unfinished step(s): ${failures.join(', ')}`
    );
  } else {
    console.log(`${tag} done`);
  }
  return failures;
}
