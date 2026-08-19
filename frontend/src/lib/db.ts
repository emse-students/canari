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
export { IndexedDbStorage } from './db/indexeddb';
export { SqliteStorage } from './db/sqlite';

import { IndexedDbStorage } from './db/indexeddb';
import { SqliteStorage } from './db/sqlite';
import type { IStorage } from './db/types';
import { isTauriRuntime } from '$lib/utils/openExternal';

/**
 * Instantiate the correct storage backend for the current runtime.
 * Returns SqliteStorage when running inside Tauri (detected via `__TAURI_INTERNALS__`),
 * falling back to IndexedDbStorage for regular browser / PWA environments.
 */
export async function getStorage(userId: string): Promise<IStorage> {
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
