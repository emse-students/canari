/**
 * Schema-migration decisions for {@link SqliteStorage}, kept as pure functions so they can be
 * unit-tested without a live Tauri SQL connection.
 *
 * The rule these encode, learned the hard way: a migration written against an OLD schema keeps
 * running against NEW databases forever. The v1 -> v2 purge referenced a `salt` column that the
 * deviceKeyB64 refactor removed from `CREATE TABLE messages`, and because a brand-new database
 * starts at `user_version = 0` it went straight through that branch and threw
 * "no such column: salt" on EVERY fresh install - silently degrading Tauri to IndexedDB.
 *
 * Two defences, both here:
 *  - {@link isFreshDatabase} - a database that did not exist a moment ago has nothing to migrate,
 *    so it is stamped at {@link SCHEMA_VERSION} and skips every historical branch.
 *  - {@link legacyBlobPurgeStatement} - the purge is built from the columns the table ACTUALLY
 *    has, so dropping a column can never again break the migration that mentions it.
 */

/** Current schema version. A freshly created database is stamped with this and skips all migrations. */
export const SCHEMA_VERSION = 16;

/** Columns the v1 -> v2 purge inspects, when they exist. Historical: `salt` is gone since 2c3ec6fe. */
const BLOB_LEGACY_COLUMNS = ['iv', 'salt', 'cipher_text'] as const;

/**
 * True when the database was created by the `CREATE TABLE IF NOT EXISTS` statements that just ran,
 * rather than opened from disk.
 *
 * `user_version` is 0 both for a brand-new file AND for a pre-migration-system database, so the
 * version alone cannot tell them apart - the presence of the `messages` table BEFORE the creation
 * statements is what distinguishes them.
 *
 * @param tablesBeforeCreate Table names read from `sqlite_master` before any CREATE TABLE ran.
 * @param userVersion Value of `PRAGMA user_version` read at the same moment.
 */
export function isFreshDatabase(
  tablesBeforeCreate: readonly string[],
  userVersion: number
): boolean {
  return userVersion === 0 && !tablesBeforeCreate.includes('messages');
}

/**
 * Build the v1 -> v2 purge that drops rows written when iv/salt/cipher_text were BLOB columns and
 * the Tauri SQL plugin read them back as JSON text (`"[1,2,3]"`). Such rows are undecryptable.
 *
 * Only the columns present in `columns` are inspected. Returns `null` when the table has none of
 * them, which means there is nothing this migration could match.
 *
 * @param columns Column names of the `messages` table, from `PRAGMA table_info(messages)`.
 */
export function legacyBlobPurgeStatement(columns: readonly string[]): string | null {
  const present = BLOB_LEGACY_COLUMNS.filter((c) => columns.includes(c));
  if (present.length === 0) return null;

  const conditions = present.map((c) => `${c} LIKE '[%'`);
  // `typeof(iv) != 'text'` catches a real BLOB left by an even older build; it only makes sense
  // when iv itself survived.
  if (present.includes('iv')) conditions.unshift("typeof(iv) != 'text'");

  return `DELETE FROM messages WHERE ${conditions.join(' OR ')}`;
}

/**
 * The v13 -> v14 step: the outbox row gains `server_errors`, its run of CONSECUTIVE 5xx answers
 * (`MAX_CONSECUTIVE_SERVER_ERRORS` in `outbox.ts`). `DEFAULT 0`, so every row already queued reads
 * as a fresh run. Returns `null` when the column is there - a fresh database, or a rerun - so the
 * step is a no-op twice.
 *
 * @param columns Column names of the `outbox` table, from `PRAGMA table_info(outbox)`.
 */
export function outboxServerErrorsStatement(columns: readonly string[]): string | null {
  return columns.includes('server_errors')
    ? null
    : 'ALTER TABLE outbox ADD COLUMN server_errors INTEGER DEFAULT 0';
}

/**
 * The v14 -> v15 step: the conversation row gains `awaiting_admission`, whether this account's seat
 * is an invitation-link ask no member has answered (`ConversationMeta.awaitingAdmission`). NULL on
 * arrival, which reads as "not an ask" - the next discovery sets it from the server's list. Returns
 * `null` when the column is there - a fresh database, or a rerun - so the step is a no-op twice.
 *
 * @param columns Column names of the `conversations` table, from `PRAGMA table_info(conversations)`.
 */
export function conversationAwaitingAdmissionStatement(columns: readonly string[]): string | null {
  return columns.includes('awaiting_admission')
    ? null
    : 'ALTER TABLE conversations ADD COLUMN awaiting_admission INTEGER';
}

/**
 * The v15 -> v16 step: the conversation row gains `started_at`, the server's record of the group's
 * creation (`ConversationMeta.startedAt`). It was declared as persisted and was not on this backend:
 * IndexedDB stores the whole object, SQLite only its named columns, so a phone forgot it on every
 * reload until the next group sweep. History reconciliation reads it to tell a coverage shortfall
 * that predates the group from a real one. NULL on arrival, which reads as unknown - the next sweep
 * fills it (`recordGroupStart`). Returns `null` when the column is there, so the step is a no-op twice.
 *
 * @param columns Column names of the `conversations` table, from `PRAGMA table_info(conversations)`.
 */
export function conversationStartedAtStatement(columns: readonly string[]): string | null {
  return columns.includes('started_at')
    ? null
    : 'ALTER TABLE conversations ADD COLUMN started_at INTEGER';
}
