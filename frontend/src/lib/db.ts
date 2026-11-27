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
  SealedPayload,
  SealedPayloadSwap,
  SealedStore,
  StoredGraineSession,
  StoredMessage,
} from './db/types';
export { closeOpenIndexedDbStores, IndexedDbStorage } from './db/indexeddb';
export { SqliteStorage } from './db/sqlite';

import { IndexedDbStorage } from './db/indexeddb';
import { SqliteStorage } from './db/sqlite';
import type { IStorage } from './db/types';
import { gateStorage } from './db/deviceKeyGate';
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
 * The close in flight per user. The plugin shares ONE pool per file, so a store opened while an older
 * handle of the same file is still closing would have its pool closed under it by that close
 * (a wipe racing a sign-in). `getStorage` therefore waits for the user's close to settle first.
 */
const closingStores = new Map<string, Promise<unknown>>();

/**
 * Instantiate the correct storage backend for the current runtime.
 * Returns SqliteStorage when running inside Tauri (detected via `__TAURI_INTERNALS__`),
 * falling back to IndexedDbStorage for regular browser / PWA environments.
 *
 * The handle is shared per user for as long as it stays open - see {@link openStores}.
 */
export async function getStorage(userId: string): Promise<IStorage> {
  // An open never overlaps a close of the same file (see {@link closingStores}).
  while (closingStores.has(userId)) await closingStores.get(userId);
  const cached = openStores.get(userId);
  if (cached) {
    // A JOINER SHARES THE OPEN'S OUTCOME, FAILURE INCLUDED. It used to read a rejected open as "no
    // store yet" and start its own - so every caller that had joined a failed open started one, all
    // at once: on 2026-11-25 five of them ran the v23 rebuild side by side and dropped the table one
    // of them had just filled, a user's whole history (`docs/wiki/frontend/local-store-rebuild.md`).
    // A failed open is the caller's answer; the NEXT call, made after it, opens again.
    const store = await cached;
    // A CACHE THAT CANNOT SEE A CLOSE HANDS BACK A DEAD HANDLE. `close()` is reachable from the
    // revoked-device wipe, which closes the store and expects the next caller to get a working one.
    // Asking the store itself is the only answer that cannot drift from what actually happened.
    if (store.isOpen) return store;
    // Only the caller that finds THIS closed handle still cached forgets it; the others join
    // whatever open replaced it.
    if (openStores.get(userId) === cached) openStores.delete(userId);
    return getStorage(userId);
  }

  const opening = openStore(userId);
  openStores.set(userId, opening);
  // A FAILED OPEN MUST NOT BE REMEMBERED AS ONE. Leaving the rejected promise in the map would
  // turn a transient failure into a permanent one for the rest of the session. Forgotten only if it
  // is still the one cached, and logged: every caller that joined it is about to fail with it.
  opening.catch((e: unknown) => {
    console.error(`[DB] the local store did not open - its joiners fail with it: ${String(e)}`);
    if (openStores.get(userId) === opening) openStores.delete(userId);
  });
  return opening;
}

/**
 * Closes and forgets `userId`'s cached open store, WITHOUT opening one when none is cached.
 *
 * `getStorage` would open the database just to close it. A deletion of that account's local data
 * needs the handle gone so the file (SQLite) or the delete (IndexedDB) cannot be blocked by it.
 * Returns whether a store was open.
 */
export async function closeCachedStore(userId: string): Promise<boolean> {
  // A second close joins the first rather than finding an empty cache and answering "none open".
  const inFlight = closingStores.get(userId);
  if (inFlight) return (await inFlight) as boolean;
  const cached = openStores.get(userId);
  if (!cached) return false;
  openStores.delete(userId);
  const closing = (async () => {
    const store = await cached.catch(() => null);
    if (!store) return false;
    await store.close();
    return true;
  })();
  closingStores.set(userId, closing);
  try {
    return await closing;
  } finally {
    if (closingStores.get(userId) === closing) closingStores.delete(userId);
  }
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
    return gateStorage(s, userId);
  }
  const s = new IndexedDbStorage(userId);
  await s.init();
  console.log(`[DB] Using IndexedDB storage (Web) for user: ${userId}`);
  // THROUGH THE GATE, ALWAYS: a device key change holds every call here while it re-seals, and
  // forwards the retired key afterwards (`db/deviceKeyGate.ts`).
  return gateStorage(s, userId);
}
