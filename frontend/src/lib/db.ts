/**
 * Local storage entry point for Canari.
 *
 * Re-exports all shared types, both storage implementations, and the
 * getStorage factory so that existing imports from `$lib/db` continue to
 * work without modification.
 */

export type {
  ConversationMeta,
  EncryptedGraineRow,
  EncryptedMessageRow,
  IStorage,
  OutboxEntry,
  OutboxMediaPayload,
  OutboxMediaUploadedRef,
  StoredGraineSession,
  StoredMessage,
} from './db/types';
export { closeOpenIndexedDbStores, IndexedDbStorage } from './db/indexeddb';
export { SqliteStorage } from './db/sqlite';

import { IndexedDbStorage } from './db/indexeddb';
import { SqliteStorage } from './db/sqlite';
import type { IStorage } from './db/types';
import { isTauriRuntime } from '$lib/utils/openExternal';

/**
 * The open store per user, so a second caller joins the first open instead of starting its own.
 *
 * A HANDLE IS CACHED, A SCHEMA BOOTSTRAP IS NOT REPEATED. `init()` is not a cheap read: it opens
 * the database and replays PRAGMA + every CREATE TABLE and CREATE INDEX. A cold Android launch
 * called `getStorage` twice - once for the conversations panel, once from the login flow - and paid
 * that whole sequence twice, the second time ON THE PATH TO THE BIOMETRIC PROMPT (measured on a
 * Pixel 6a, 2026-09-15). Nothing wanted two connections; the factory simply had no memory.
 *
 * The promise, not the resolved store, is what is kept: two callers racing a cold start must join
 * the same open rather than run two.
 */
const openStores = new Map<string, Promise<IStorage>>();

/**
 * Instantiate the correct storage backend for the current runtime.
 * Returns SqliteStorage when running inside Tauri (detected via `__TAURI_INTERNALS__`),
 * falling back to IndexedDbStorage for regular browser / PWA environments.
 *
 * The handle is shared per user for as long as it stays open - see {@link openStores}.
 */
export async function getStorage(userId: string): Promise<IStorage> {
  const cached = openStores.get(userId);
  if (cached) {
    // A CACHE THAT CANNOT SEE A CLOSE HANDS BACK A DEAD HANDLE. `close()` is reachable from the
    // revoked-device wipe, which closes the store and expects the next caller to get a working one.
    // Asking the store itself is the only answer that cannot drift from what actually happened.
    const store = await cached.catch(() => null);
    if (store?.isOpen) return store;
    openStores.delete(userId);
  }

  const opening = openStore(userId);
  openStores.set(userId, opening);
  // A FAILED OPEN MUST NOT BE REMEMBERED AS ONE. Leaving the rejected promise in the map would
  // turn a transient failure into a permanent one for the rest of the session.
  opening.catch(() => openStores.delete(userId));
  return opening;
}

/** Open a fresh store for the runtime in use. Callers go through {@link getStorage}. */
async function openStore(userId: string): Promise<IStorage> {
  if (isTauriRuntime()) {
    // NO FALLBACK, AND THE FALLBACK THAT WAS HERE WAS WORSE THAN NO STORAGE AT ALL.
    //
    // A failed SQLite open used to be caught and answered with IndexedDB inside the same webview.
    // That is not the same device: on Tauri the MLS state persister writes `mls.bin` to the
    // FILESYSTEM and does not follow this choice, so the two halves would have landed in two
    // different places - group state on disk, conversations and messages in the webview's store -
    // and a reader would have seen a client that opened, looked healthy, and had a history that did
    // not match its ratchet.
    //
    // The realistic cause is also the one a fallback cannot help: a device with no space left. The
    // second store is on the same full disk.
    const s = new SqliteStorage(userId);
    await s.init();
    console.log('[DB] Using SQLite storage (Tauri)');
    return s;
  }
  const s = new IndexedDbStorage(userId);
  await s.init();
  console.log(`[DB] Using IndexedDB storage (Web) for user: ${userId}`);
  return s;
}
