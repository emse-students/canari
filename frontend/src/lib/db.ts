/**
 * Local storage entry point for Canari.
 *
 * Re-exports all shared types, both storage implementations, and the
 * getStorage factory so that existing imports from `$lib/db` continue to
 * work without modification.
 */

export type { ConversationMeta, EncryptedMessageRow, IStorage, StoredMessage } from './db/types';
export { IndexedDbStorage } from './db/indexeddb';
export { SqliteStorage } from './db/sqlite';

import { IndexedDbStorage } from './db/indexeddb';
import { SqliteStorage } from './db/sqlite';
import type { IStorage } from './db/types';

/**
 * Instantiate the correct storage backend for the current runtime.
 * Returns SqliteStorage when running inside Tauri (detected via `__TAURI_INTERNALS__`),
 * falling back to IndexedDbStorage for regular browser / PWA environments.
 */
export async function getStorage(userId: string): Promise<IStorage> {
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      const s = new SqliteStorage(userId);
      await s.init();
      console.log('[DB] Using SQLite storage (Tauri)');
      return s;
    } catch (e) {
      console.warn('[DB] SQLite failed, falling back to IndexedDB:', e);
    }
  }
  const s = new IndexedDbStorage(userId);
  await s.init();
  console.log(`[DB] Using IndexedDB storage (Web) for user: ${userId}`);
  return s;
}
