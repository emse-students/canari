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
export const SCHEMA_VERSION = 17;

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
 * The v15 -> v16 step, second half: the message row gains `order_at`, the key a page is read on
 * (`storedOrderAt`), and `order_pending`, set while that key is only PROVISIONAL. The server time the
 * key is derived from is inside the ciphertext, which a migration run before the device key is known
 * cannot read, so the rows already stored are keyed on their `timestamp` and flagged
 * ({@link MESSAGE_PROVISIONAL_ORDER_FILL}); a page read derives the real key behind it
 * (`$lib/db/orderKeyDerivation`). Only the columns the file lacks are added.
 */
export function messageOrderColumnsStatements(columns: readonly string[]): string[] {
  return [
    ...(columns.includes('order_at') ? [] : ['ALTER TABLE messages ADD COLUMN order_at INTEGER']),
    ...(columns.includes('order_pending')
      ? []
      : ['ALTER TABLE messages ADD COLUMN order_pending INTEGER']),
  ];
}

/**
 * Keys every row the v16 step finds unkeyed on its `timestamp`, PROVISIONALLY: one statement, no
 * decryption, so the step costs the same whatever the store holds, and every row is in the page
 * index from the first read on.
 */
export const MESSAGE_PROVISIONAL_ORDER_FILL =
  'UPDATE messages SET order_at = timestamp, order_pending = 1 WHERE order_at IS NULL';

/**
 * The page read's index (`getMessagesPage`) on the order key, ties broken by id - the pair a page
 * boundary is drawn on. Created where the columns are known to exist - the fresh schema and the v16
 * step - never with the unconditional statements that run before the migrations.
 */
export const MESSAGE_ORDER_INDEX_STATEMENT =
  'CREATE INDEX IF NOT EXISTS idx_messages_conv_order ON messages(conversation_id, order_at, id)';

/**
 * The rows with NO order key at all - PARTIAL, so it is empty in the ordinary case. Only a build older
 * than v16 writes one: it can still open this file (it runs no migration above its own version) and
 * its insert names no `order_at`. Every open of a v16 file re-keys them provisionally through this
 * index ({@link MESSAGE_PROVISIONAL_ORDER_FILL}), so a downgrade and an upgrade back cannot leave a
 * row that no page reaches (legacy-compatibility.md, "a downgrade below the server-time order").
 */
export const MESSAGE_ORDER_MISSING_INDEX_STATEMENT =
  'CREATE INDEX IF NOT EXISTS idx_messages_order_missing ON messages(id) WHERE order_at IS NULL';

/**
 * The provisional rows of each conversation, by id - what a derivation reads, chunk after chunk.
 * PARTIAL: it holds the pending rows only, so it is empty once a store is derived and costs nothing
 * on a save.
 */
export const MESSAGE_ORDER_PENDING_INDEX_STATEMENT =
  'CREATE INDEX IF NOT EXISTS idx_messages_order_pending ON messages(conversation_id, id) WHERE order_pending = 1';

/** The `[conversation_id, timestamp]` index the page read used before v16; nothing reads it since. */
export const LEGACY_MESSAGE_TIME_INDEX_DROP = 'DROP INDEX IF EXISTS idx_messages_conv_time';

/**
 * The v15 -> v16 step: the conversation row gains `server_read_watermarks`, the read marks taken on
 * the SERVER's clock (`$lib/utils/chat/readState`, owner 2026-10-31). Additive and NULL on arrival:
 * the stamped marks already held keep covering what they covered, and the next reading writes the
 * first server mark.
 */
export function conversationServerReadWatermarksStatement(
  columns: readonly string[]
): string | null {
  return columns.includes('server_read_watermarks')
    ? null
    : 'ALTER TABLE conversations ADD COLUMN server_read_watermarks TEXT';
}

/**
 * The v16 -> v17 step: the conversation row gains `started_at`, the server's record of the group's
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
