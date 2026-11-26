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

import { retainedName, retainTableStatements } from './sqliteRetained';

/** Current schema version. A freshly created database is stamped with this and skips all migrations. */
export const SCHEMA_VERSION = 23;

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
 * The v18 -> v19 step: the outbox row gains `unavailable_answers`, its count of "not now" answers
 * (502, 503, 504) since it was queued (`OutboxEntry.unavailableAnswers`). `DEFAULT 0`, so every row
 * already queued reads as never answered "not now". Returns `null` when the column is there - a
 * fresh database, or a rerun - so the step is a no-op twice.
 *
 * @param columns Column names of the `outbox` table, from `PRAGMA table_info(outbox)`.
 */
export function outboxUnavailableAnswersStatement(columns: readonly string[]): string | null {
  return columns.includes('unavailable_answers')
    ? null
    : 'ALTER TABLE outbox ADD COLUMN unavailable_answers INTEGER DEFAULT 0';
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

/**
 * The v19 -> v20 step, first half: the conversation row gains `local_read_seed`
 * (`ConversationMeta.localReadSeed`), the upgrade's one-time LOCAL read point. Returns `null` when
 * the column is there. The second half, {@link CONVERSATION_LOCAL_READ_SEED_FILL}, writes it.
 *
 * @param columns Column names of the `conversations` table, from `PRAGMA table_info(conversations)`.
 */
export function conversationLocalReadSeedStatement(columns: readonly string[]): string | null {
  return columns.includes('local_read_seed')
    ? null
    : 'ALTER TABLE conversations ADD COLUMN local_read_seed INTEGER';
}

/**
 * The v20 -> v21 step: the conversation row gains `name_at`, the server time of the MLS statement
 * that set its name (`ConversationMeta.nameAt`, `groupName.ts`). NULL on arrival, which reads as
 * "never stated": the server's group list keeps correcting such a name until a frame dates it.
 * Returns `null` when the column is there, so the step is a no-op twice.
 *
 * @param columns Column names of the `conversations` table, from `PRAGMA table_info(conversations)`.
 */
export function conversationNameAtStatement(columns: readonly string[]): string | null {
  return columns.includes('name_at')
    ? null
    : 'ALTER TABLE conversations ADD COLUMN name_at INTEGER';
}

/**
 * The v20 -> v21 step, second column: `name_sync` (`ConversationMeta.nameSync`, JSON), what this
 * device still owes about a rename it made - a server copy, a frame whose send ended unanswered. NULL
 * on arrival: nothing owed. Returns `null` when the column is there.
 *
 * @param columns Column names of the `conversations` table, from `PRAGMA table_info(conversations)`.
 */
export function conversationNameSyncStatement(columns: readonly string[]): string | null {
  return columns.includes('name_sync')
    ? null
    : 'ALTER TABLE conversations ADD COLUMN name_sync TEXT';
}

/**
 * The conversation row's `kind` (`ConversationMeta.kind`, TEXT): `self` for "Mes notes", NULL for
 * every other row. Added on EVERY OPEN, guarded by name like the rank columns - no version stamp, so
 * no historical branch can skip it. Returns `null` when the column is there.
 *
 * @param columns Column names of the `conversations` table, from `PRAGMA table_info(conversations)`.
 */
export function conversationKindStatement(columns: readonly string[]): string | null {
  return columns.includes('kind') ? null : 'ALTER TABLE conversations ADD COLUMN kind TEXT';
}

/**
 * The conversation row's `server_last_message_at` (`ConversationMeta.serverLastMessageAt`, INTEGER):
 * the server's receive time of the newest visible frame, a floor under the sidebar key. Added on
 * EVERY OPEN, guarded by name like `kind` - no version stamp, so no historical branch can skip it.
 * NULL on arrival, which reads as never stated: the next group sweep fills it (`recordGroupStart`).
 * Returns `null` when the column is there.
 *
 * @param columns Column names of the `conversations` table, from `PRAGMA table_info(conversations)`.
 */
export function conversationServerLastMessageAtStatement(
  columns: readonly string[]
): string | null {
  return columns.includes('server_last_message_at')
    ? null
    : 'ALTER TABLE conversations ADD COLUMN server_last_message_at INTEGER';
}

/**
 * The v21 -> v22 step: the RANK of the dated name (`NameRank`, `groupNameSupersedes`), three columns:
 * - `name_from_statement` (`ConversationMeta.nameFromStatement`): 1 when a silent `groupNamed`
 *   statement dated it, which any rename beats;
 * - `name_rename_at` (`nameRenameAt`): beside it, the rename date an ANSWER restated;
 * - `name_renamed_by` (`nameRenamedBy`): beside a rename's rank, the user who made it.
 * All NULL on arrival: a rename's rank with no author known, which every name dated before these
 * columns existed has. Returns the statements still owed - none when every column is there.
 *
 * @param columns Column names of the `conversations` table, from `PRAGMA table_info(conversations)`.
 */
export function conversationNameRankStatements(columns: readonly string[]): string[] {
  return (
    [
      ['name_from_statement', 'INTEGER'],
      ['name_rename_at', 'INTEGER'],
      ['name_renamed_by', 'TEXT'],
    ] as const
  )
    .filter(([column]) => !columns.includes(column))
    .map(([column, type]) => `ALTER TABLE conversations ADD COLUMN ${column} ${type}`);
}

/**
 * The v19 -> v20 step, second half: EVERY conversation's local read seed, written INSIDE THE
 * MIGRATION. It runs at open, before `init` resolves, so no app code - no push-cache poll, no boot
 * pull, no socket - can have stored a message yet: "held before the upgrade" is a property of the
 * store, never of an app-level order.
 *
 * PER ROW, from its OWN messages: the newest server time among them, read in the clear from the order
 * key (`order_at` is `messageTime`: the server's time when the row knows it, its `sentAt` otherwise,
 * `messagePayload.ts`). A row whose `order_at` equals its `timestamp` is undated (or still
 * provisional, `order_pending`) and says nothing about the server's clock - one phone running fast
 * would otherwise push the seed past messages not received yet - so it is skipped. A conversation
 * with no dated row reads 0: nothing held before the upgrade is covered, everything later counts.
 * `WHERE local_read_seed IS NULL`, so a second run - a crash before the version stamp - changes
 * nothing it already wrote.
 */
export const CONVERSATION_LOCAL_READ_SEED_FILL =
  'UPDATE conversations SET local_read_seed = COALESCE((' +
  'SELECT MAX(m.order_at) FROM messages m WHERE m.conversation_id = conversations.id ' +
  'AND m.order_at IS NOT NULL AND m.order_at > 0 AND m.order_at <> m.timestamp ' +
  'AND (m.order_pending IS NULL OR m.order_pending <> 1)' +
  '), 0) WHERE local_read_seed IS NULL';

/**
 * The value `saveConversation` writes into `local_read_seed` (parameters: `$1` the id, `$11` the
 * caller's value or NULL). The caller's value when it states one; else what the row already holds
 * (a save that does not know the seed must not erase it); else, for a row that does not exist yet,
 * 0 - new on this install, nothing to cover.
 */
export const CONVERSATION_LOCAL_READ_SEED_VALUE =
  'CASE WHEN $11 IS NOT NULL THEN $11 ' +
  'WHEN EXISTS (SELECT 1 FROM conversations WHERE id = $1) ' +
  'THEN (SELECT local_read_seed FROM conversations WHERE id = $1) ELSE 0 END';

/**
 * The v17 -> v18 table: mutations whose message is not here yet (`PendingMutation`). Created by
 * every open, fresh or not, like `feed_pages`. Keyed by TAGS of the message, the sender and the slot
 * (`pendingMutationCodec.ts`) plus the kind, so one sender's later frame of the same kind REPLACES its
 * earlier one by `rank`, in the upsert itself - and nothing at rest names who reacted to what. No
 * foreign key to `conversations`: an entry may be written before the conversation row reaches the
 * store, and it names the conversation only to be cleared with it.
 */
export const PENDING_MUTATIONS_TABLE_STATEMENT = `
            CREATE TABLE IF NOT EXISTS pending_mutations (
                conversation_id TEXT    NOT NULL,
                message_tag     TEXT    NOT NULL,
                sender_tag      TEXT    NOT NULL,
                kind            TEXT    NOT NULL,
                slot_tag        TEXT    NOT NULL,
                tier            INTEGER NOT NULL,
                rank            INTEGER NOT NULL,
                at              INTEGER NOT NULL,
                iv              TEXT,
                cipher_text     TEXT,
                PRIMARY KEY (conversation_id, message_tag, sender_tag, kind, slot_tag)
            )
        `;

/**
 * The eviction order of `pending_mutations` within one sender: reactions before deletions and
 * edits, oldest frame first - IndexedDB's `bySenderTierAt`. A read by message is a prefix of the
 * primary key and needs no index of its own.
 */
export const PENDING_MUTATIONS_ORDER_INDEX_STATEMENT =
  'CREATE INDEX IF NOT EXISTS idx_pending_mutations_sender_tier_at ON pending_mutations(conversation_id, sender_tag, tier, at)';

/**
 * The v18 column of `messages`: `rev`, the row's revision, raised by EVERY write - the compare half
 * of the compare-and-set every rewrite goes through (`messageCas.ts`). An existing row starts at 0.
 * Returns `null` when the column is there (a fresh file has it from `CREATE TABLE`), so the step is a
 * no-op twice.
 *
 * @param columns Column names of the `messages` table, from `PRAGMA table_info(messages)`.
 */
export function messageRevisionStatement(columns: readonly string[]): string | null {
  return columns.includes('rev')
    ? null
    : 'ALTER TABLE messages ADD COLUMN rev INTEGER NOT NULL DEFAULT 0';
}

/**
 * THE `messages` TABLE, KEYED BY ITS CONVERSATION (v23): a stored message is the pair
 * `(conversation_id, id)`. A message id is chosen by the frame that carries it, so the same id may
 * name a row in two conversations, and each conversation keeps its own. The one definition, used by
 * the fresh schema and by the v23 rebuild ({@link messageRekeySteps}).
 *
 * `id` carries no `NOT NULL`, exactly as the old single-column key did not (SQLite lets a non-integer
 * primary key hold NULL): the rebuild copies with `INSERT OR IGNORE`, which would SKIP a row a
 * constraint the old table never had refuses - and the rebuild keeps every row.
 *
 * NO FOREIGN KEY onto `conversations` any more. It cascaded nothing (`deleteConversation` deletes
 * the rows itself), and a file may hold a row whose conversation row is gone - written while the
 * constraint was not enforced on that connection. The rebuild's copy would then FAIL on it, and a
 * store that cannot finish its migration cannot open: the constraint is dropped rather than the row.
 */
export function messagesTableStatement(name: string): string {
  return `
            CREATE TABLE IF NOT EXISTS ${name} (
                id              TEXT,
                conversation_id TEXT NOT NULL,
                timestamp       INTEGER,
                iv              TEXT,
                cipher_text     TEXT,
                order_at        INTEGER,
                order_pending   INTEGER,
                rev             INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (conversation_id, id)
            )
        `;
}

/** The staging table of the v23 rebuild; its presence is the durable mark of a rebuild under way. */
export const MESSAGES_REKEY_STAGING = 'messages_rekey';

/** Every column the v23 rebuild carries, in the order of {@link messagesTableStatement}. */
const MESSAGE_REKEY_COLUMNS = [
  'id',
  'conversation_id',
  'timestamp',
  'iv',
  'cipher_text',
  'order_at',
  'order_pending',
  'rev',
] as const;

/** One row of `PRAGMA table_info(messages)`, as far as the key decision reads it. */
export interface TableInfoRow {
  name: string;
  pk: number;
}

/**
 * Whether `messages` is keyed by `(conversation_id, id)`, read from `PRAGMA table_info(messages)`:
 * `pk` is a column's 1-based place in the primary key, 0 outside it.
 */
export function messagesKeyedByConversation(info: readonly TableInfoRow[]): boolean {
  const key = info
    .filter((c) => Number(c.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((c) => String(c.name));
  return key.length === 2 && key[0] === 'conversation_id' && key[1] === 'id';
}

/**
 * The rows of `messages` the staging table does not hold yet - the proof the rebuild owes before it
 * drops anything. `IS` and not `=` on the id, so a NULL id (see {@link messagesTableStatement}) is
 * matched rather than reported missing.
 */
export const MESSAGES_REKEY_MISSING_COUNT =
  `SELECT COUNT(*) AS n FROM messages m WHERE NOT EXISTS (SELECT 1 FROM ${MESSAGES_REKEY_STAGING} s ` +
  'WHERE s.conversation_id = m.conversation_id AND s.id IS m.id)';

/** What the v23 rebuild owes, as {@link messageRekeySteps} reads it from the file. */
export interface MessageRekeyState {
  /** `messages` is already keyed by `(conversation_id, id)` ({@link messagesKeyedByConversation}). */
  keyed: boolean;
  /** {@link MESSAGES_REKEY_STAGING} exists: a rebuild began and did not finish. */
  staging: boolean;
  /** The columns `messages` has now, from `PRAGMA table_info(messages)`. */
  columns: readonly string[];
  /** The names of the indexes `messages` has now (`sqlite_master`, `sql IS NOT NULL`). */
  indexes: readonly string[];
}

/**
 * The v23 rebuild stopped rather than drop a table it could not prove was copied - the file is left
 * as it was, and the next open resumes from it. Typed at the throw, so no caller reads its message.
 */
export class MessageRekeyRefusedError extends Error {
  constructor(detail: string) {
    super(`messages rekey: ${detail}`);
    this.name = 'MessageRekeyRefusedError';
  }
}

/** The per-connection table the swap's guards write into; its CHECK is what refuses. */
const MESSAGES_REKEY_GUARD = 'messages_rekey_guard';

/**
 * THE v22 -> v23 REBUILD, AS STATEMENTS DECIDED FROM DURABLE STATE - NEVER FROM A CLOCK OR A FLAG
 * THE APP KEEPS. SQLite cannot change a primary key in place, so `messages` is rebuilt: a staging
 * table with the composite key, every row copied into it, the old table SET ASIDE (never dropped:
 * `sqliteRetained.ts` releases it once the file proves every row is in the new table), the staging
 * table renamed, the indexes made again.
 *
 * THE COPY IS RESUMABLE, THE SWAP IS ONE TRANSACTION THAT PROVES ITSELF.
 *
 * - `keyed` and no staging: done, nothing owed (a fresh file, or a rebuild that finished).
 * - no staging: the rebuild has not begun - the staging table is created, then everything below.
 * - staging: a rebuild began. Whatever `messages` is now - the old table, or the empty keyed table
 *   `init`'s own `CREATE TABLE IF NOT EXISTS` made after 1.8.1 stopped between its drop and its
 *   rename - its rows are copied in AGAIN with `INSERT OR IGNORE`, which finds the rows already
 *   copied under their key and adds the others. So a second run converges.
 *
 * `swap` is ONE `execute` - one pooled connection, its statements prepared one after the other
 * (sqlx's `VirtualStatement`, like `sqlite3_exec`) - and inside it ONE `BEGIN IMMEDIATE`
 * transaction. 1.8.1 ran the drop and the rename as two `execute`s, and that LOST A USER'S WHOLE
 * HISTORY (2026-11-25, `docs/wiki/frontend/local-store-rebuild.md`), for two reasons this shape
 * removes:
 *
 * - THE POOL'S OTHER CONNECTIONS CACHE THE SCHEMA. The rename landed on a connection that had not
 *   run a statement since the drop, whose cached schema still held `messages`, and SQLite checks a
 *   rename's target name at PARSE time against that cache, so it refused "there is already another
 *   table or index with this name: messages" - with the old table gone and the rows only in staging.
 *   One connection, whose first statement in the transaction reads the file, parses the renames
 *   against the real file.
 * - A PROOF READ BEFORE A DROP IS NOT A PROOF AT THE DROP. The guards run INSIDE the transaction, which
 *   holds the file's write lock, so nothing - another init of this process, another process - can
 *   change either table between them and the swap. The first proves both tables are there (it reads
 *   only `sqlite_master`, so it parses whatever the file holds) and that no earlier copy is still set
 *   aside under the name this one takes; the second proves every row of `messages` is in staging.
 *   Either one false is a `CHECK` violation under `OR ROLLBACK`, which ENDS the transaction before
 *   anything moves: the file is left exactly as it was and the pooled connection
 *   carries no open transaction, and the error reaches the caller.
 *
 * The guards make every statement after them stand on a proven precondition, so the only failure left
 * inside the transaction is the file itself (I/O, a full disk). SQLite does NOT promise to roll that
 * back on its own, and sqlx never checks a pooled connection for a transaction raw SQL opened: such a
 * failure leaves the transaction open, uncommitted, on one pooled connection - nothing committed, so
 * nothing lost - until the failed open's retry calls `Database.load`, whose new pool replaces the old
 * one (read in the plugin's source, not measured), or the app restarts.
 */
export function messageRekeySteps(state: MessageRekeyState): {
  copy: string[];
  swap: string | null;
} {
  if (state.keyed && !state.staging) return { copy: [], swap: null };
  const carried = MESSAGE_REKEY_COLUMNS.filter((c) => state.columns.includes(c)).join(', ');
  return {
    copy: [
      ...(state.staging ? [] : [messagesTableStatement(MESSAGES_REKEY_STAGING)]),
      `INSERT OR IGNORE INTO ${MESSAGES_REKEY_STAGING} (${carried}) SELECT ${carried} FROM messages`,
    ],
    swap: messagesRekeySwapStatement(state.indexes),
  };
}

/**
 * The swap of {@link messageRekeySteps}: one `execute`, one transaction, guarded inside it. The old
 * table is SET ASIDE, never dropped (`sqliteRetained.ts`): the rebuild's own settlement releases it
 * once the file proves every one of its rows is in the new table.
 */
function messagesRekeySwapStatement(indexes: readonly string[]): string {
  return [
    `CREATE TEMP TABLE IF NOT EXISTS ${MESSAGES_REKEY_GUARD} (proven INTEGER NOT NULL CHECK (proven = 1))`,
    'BEGIN IMMEDIATE',
    // Both tables are in the file and no earlier copy is still set aside, read from `sqlite_master`
    // so it parses whatever the file holds.
    `INSERT OR ROLLBACK INTO temp.${MESSAGES_REKEY_GUARD} (proven) SELECT (SELECT COUNT(*) FROM main.sqlite_master ` +
      `WHERE type = 'table' AND name IN ('messages', '${MESSAGES_REKEY_STAGING}')) = 2 AND NOT EXISTS ` +
      `(SELECT 1 FROM main.sqlite_master WHERE name = '${retainedName('messages')}')`,
    // Every row of `messages` is in staging - read under the write lock the swap runs under.
    `INSERT OR ROLLBACK INTO temp.${MESSAGES_REKEY_GUARD} (proven) SELECT NOT EXISTS (SELECT 1 FROM main.messages m ` +
      `WHERE NOT EXISTS (SELECT 1 FROM main.${MESSAGES_REKEY_STAGING} s ` +
      'WHERE s.conversation_id = m.conversation_id AND s.id IS m.id))',
    ...retainTableStatements('messages', indexes),
    `ALTER TABLE main.${MESSAGES_REKEY_STAGING} RENAME TO messages`,
    MESSAGE_CONVERSATION_INDEX_STATEMENT,
    MESSAGE_ID_INDEX_STATEMENT,
    MESSAGE_ORDER_INDEX_STATEMENT,
    MESSAGE_ORDER_PENDING_INDEX_STATEMENT,
    MESSAGE_ORDER_MISSING_INDEX_STATEMENT,
    `DELETE FROM temp.${MESSAGES_REKEY_GUARD}`,
    'COMMIT',
  ].join(';\n');
}

/** The `conversation_id` index every read of one conversation's rows walks. */
export const MESSAGE_CONVERSATION_INDEX_STATEMENT =
  'CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id)';

/**
 * The index on the message id ALONE (v23), which the key `(conversation_id, id)` cannot serve: what
 * `findMessageConversations` reads, for a caller that knows only an id it minted.
 */
export const MESSAGE_ID_INDEX_STATEMENT =
  'CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id)';
