/**
 * The INCARNATION of the message table - see `IStorage.messageStoreIncarnation`. One value per
 * table lifetime, written in the same file (SQLite) or database (IndexedDB) as the rows it vouches
 * for, so a table that is lost and made again cannot keep the old value.
 *
 * Why it exists: the history records (`historyReconcile.ts`) answer "have I already asked", and a
 * store whose rows were lost inherited them, so the device asked nobody
 * (`docs/wiki/frontend/local-store-rebuild.md`). A record now names the incarnation it was written
 * under, and only that incarnation honours it.
 */

/** The key the incarnation is stored under. */
export const MESSAGES_INCARNATION_KEY = 'messages_incarnation';

/** SQLite: the small key/value table the incarnation lives in. */
export const STORE_META_TABLE_STATEMENT =
  'CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)';

/** SQLite: a new incarnation, replacing any - the table was just created. `$1` is the value. */
export const STORE_INCARNATION_MINT_STATEMENT = `INSERT OR REPLACE INTO store_meta (key, value) VALUES ('${MESSAGES_INCARNATION_KEY}', $1)`;

/** SQLite: an incarnation for a table that predates the field, never one replacing a held one. */
export const STORE_INCARNATION_KEEP_STATEMENT = `INSERT OR IGNORE INTO store_meta (key, value) VALUES ('${MESSAGES_INCARNATION_KEY}', $1)`;

/** SQLite: the incarnation held. */
export const STORE_INCARNATION_READ_STATEMENT = `SELECT value FROM store_meta WHERE key = '${MESSAGES_INCARNATION_KEY}'`;

/** A fresh incarnation value: random, so two lifetimes of a table never share one. */
export function newStoreIncarnation(): string {
  return crypto.randomUUID();
}
