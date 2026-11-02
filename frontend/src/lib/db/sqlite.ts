import { encryptData, decryptData } from '../encryption';
import { readStoredTimestampMs } from '$lib/utils/dates';
import { normalizeConversationLifecycle } from '$lib/utils/chat/groupLifecycle';
import { parseHistoryFloor } from '$lib/utils/chat/historyWindow';
import {
  invalidateAllHistoryStateKeys,
  invalidateHistoryStateKey,
} from '$lib/utils/chat/historyStateKey';
import { parseReadWatermarks } from '$lib/utils/chat/readState';
import { OutboxEntryWrittenAloneError } from '$lib/utils/chat/messageWrittenError';
import type {
  ConversationMeta,
  EncryptedGraineRow,
  EncryptedMessageRow,
  IStorage,
  OutboxBlobRef,
  OutboxEntry,
  PageKey,
  PendingGroupExit,
  SealedPayload,
  SealedPayloadSwap,
  SealedStore,
  StoredDistributionGroup,
  StoredGraineSession,
  StoredMessage,
  StoredMessagePatch,
} from './types';
import { FeedPageUnreadableError } from './types';
import {
  attachOutboxBlob,
  clearOutboxBlobsLast,
  deleteOutboxBlobQuietly,
  OutboxBlobStore,
  outboxBlobReleased,
  writeOutboxWithBlob,
} from './outboxBlob';
import { appendLog } from '$lib/utils/sessionLog';
import {
  decodeOutboxEntry,
  encodeOutboxSensitive,
  isOutboxClearPatch,
  mergeOutboxEntry,
  OutboxPayloadUnreadableError,
  outboxClearColumns,
  outboxKindHoldsBlob,
  REEL_TAKE_RECORDS,
  type OutboxClearColumns,
} from './outboxCodec';
import type { GraineClearColumns } from './graineCodec';
import {
  byNewestSession,
  decodeGraineSession,
  encodeGraineSensitive,
  graineClearColumns,
  toEncryptedGraineRow,
} from './graineCodec';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import {
  SCHEMA_VERSION,
  conversationAwaitingAdmissionStatement,
  conversationServerReadWatermarksStatement,
  conversationStartedAtStatement,
  isFreshDatabase,
  legacyBlobPurgeStatement,
  LEGACY_MESSAGE_TIME_INDEX_DROP,
  MESSAGE_ORDER_INDEX_STATEMENT,
  MESSAGE_ORDER_MISSING_INDEX_STATEMENT,
  MESSAGE_ORDER_PENDING_INDEX_STATEMENT,
  MESSAGE_PROVISIONAL_ORDER_FILL,
  messageOrderColumnsStatements,
  outboxServerErrorsStatement,
} from './sqliteMigrations';
import {
  compareStoredOrder,
  fromMessagePayload,
  mergeStoredMessage,
  storedOrderAt,
  toMessagePayload,
} from './messagePayload';
import {
  deriveOrderKeysInChunks,
  OrderKeyDerivations,
  type OrderKeyDerivation,
} from './orderKeyDerivation';
import {
  MESSAGE_ROWS_PER_STATEMENT,
  ORDER_AT_FILL_ROWS_PER_STATEMENT,
  SEALED_SWAP_ROWS_PER_STATEMENT,
  chunk,
  messageInsertSql,
  OUTBOX_ROWS_PER_STATEMENT,
  OUTBOX_UPDATE_ROW_SQL,
  outboxInsertSql,
  orderAtFillStatement,
  sealedStoreTable,
  sealedSwapStatement,
} from './sqliteBatch';

function rowTimestampMs(raw: unknown): number {
  return readStoredTimestampMs(raw) ?? 0;
}

// ---------------------------------------------------------------------------
// SQLite implementation (Tauri desktop / mobile)
// Requires the @tauri-apps/plugin-sql npm package and the Rust crate.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helper: encode/decode binary data as base64 for SQLite TEXT columns.
// The Tauri SQL plugin binds serde_json::Value::Array as JSON text, not as a
// binary BLOB, so raw number[] round-trips are broken after an app restart.
// Storing binary as base64 (TEXT storage class) ensures reliable persistence.
// ---------------------------------------------------------------------------

/** Encode a binary buffer as a base64 string for safe storage in SQLite TEXT columns. */
const uint8ToBase64 = toBase64;

/** Decode a base64 string (or legacy number array) back to a Uint8Array; returns an empty array on failure. */
function base64ToUint8(val: unknown): Uint8Array {
  if (val == null) return new Uint8Array(0);
  // New format: base64-encoded string
  if (typeof val === 'string') {
    try {
      return fromBase64(val);
    } catch {
      return new Uint8Array(0);
    }
  }
  // Fallback: plain number array (e.g. if the plugin ever writes real BLOBs)
  if (Array.isArray(val)) return new Uint8Array(val as number[]);
  return new Uint8Array(0);
}

/**
 * IStorage implementation backed by the Tauri SQL plugin (SQLite).
 * Used on Tauri desktop and mobile builds.  Binary fields (iv, salt, cipherText) are stored
 * as base64-encoded TEXT columns rather than BLOBs to work around a Tauri SQL serialisation
 * bug where BLOB values are read back as JSON arrays after an app restart.
 * Database file path: `<app-config-dir>/canari_<userId>.db` (the plugin resolves `app_config_dir()`).
 */
export class SqliteStorage implements IStorage {
  private db: any = null;
  private readonly dbPath: string;
  /** The bytes of queued attachments: IndexedDB, never the SQL bridge (see outboxBlob.ts). */
  private readonly blobs: OutboxBlobStore;
  /** One order-key derivation in flight per conversation (`$lib/db/orderKeyDerivation`). */
  private readonly orderKeyDerivations = new OrderKeyDerivations();

  /** Create a storage instance for the given user. Call init() before using. */
  constructor(userId: string) {
    this.dbPath = `sqlite:canari_${userId}.db`;
    this.blobs = new OutboxBlobStore(userId);
  }

  /** Whether the SQLite handle is open. See {@link IStorage.isOpen}. */
  get isOpen(): boolean {
    return this.db !== null;
  }

  /** Open (or create) the SQLite database, enable WAL mode, create tables, and run migrations up to {@link SCHEMA_VERSION}. */
  /** Closes the SQLite handle. See {@link IStorage.close}. */
  async close(): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.close();
    } catch (e) {
      // Best-effort: a handle that cannot be closed must not stop the wipe that follows, but it is
      // the reason a later delete could block, so it is never swallowed silently.
      console.warn('[DB] SQLite close failed:', e);
    }
    this.db = null;
    await this.blobs.close();
  }

  async init(): Promise<void> {
    const Database = (await import('@tauri-apps/plugin-sql')).default;
    this.db = await Database.load(this.dbPath);

    // Read the schema state BEFORE the CREATE TABLE statements below, while the file still
    // reflects what was on disk. Afterwards every database looks alike and a brand-new one can no
    // longer be told apart from a pre-migration-system one - both report user_version = 0.
    const preExistingTables: string[] = (
      await this.db.select("SELECT name FROM sqlite_master WHERE type = 'table'")
    ).map((r: any) => String(r.name));
    const versionRows: any[] = await this.db.select('PRAGMA user_version');
    const currentVersion: number = versionRows[0]?.user_version ?? 0;
    const fresh = isFreshDatabase(preExistingTables, currentVersion);

    // WAL mode: non-blocking concurrent reads, critical on mobile.
    await this.db.execute('PRAGMA journal_mode=WAL');

    // busy_timeout: if ANOTHER connection holds the write lock (native background/FCM engine,
    // WorkManager, or a WAL checkpoint), wait up to 5s instead of failing IMMEDIATELY with
    // "database is locked" (SQLITE_BUSY). Without it, a history replay that hits a lock loses the
    // messages: the MLS ratchet has already advanced (session.finish), so a retry can no longer
    // decrypt them -> messages permanently invisible on the recipient side (observed symptom:
    // "Echec replay historique ... database is locked").
    await this.db.execute('PRAGMA busy_timeout=5000');

    // Schema: conversations carry their lifecycle state (active|pending|removed).
    // Older databases (with an `is_ready` column) are migrated in v4 below.
    await this.db.execute(`
            CREATE TABLE IF NOT EXISTS conversations (
                id               TEXT    PRIMARY KEY,
                name             TEXT    NOT NULL,
                lifecycle        TEXT    DEFAULT 'pending',
                updated_at       INTEGER DEFAULT 0,
                read_watermarks  TEXT,
                history_floor    INTEGER,
                image_media_id   TEXT,
                awaiting_admission INTEGER,
                server_read_watermarks TEXT,
                started_at       INTEGER
            )
        `);

    // TEXT (base64) columns for iv/cipher_text.
    // The old schema used BLOB columns, which caused the Tauri SQL plugin to
    // serialise Uint8Array values as JSON text "[1,2,3]" → unreadable after restart.
    // No salt column — the deviceKeyB64 is imported directly as an AES-256-GCM key
    // (no PBKDF2 derivation needed per message).
    await this.db.execute(`
            CREATE TABLE IF NOT EXISTS messages (
                id              TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                timestamp       INTEGER,
                iv              TEXT,
                cipher_text     TEXT,
                order_at        INTEGER,
                order_pending   INTEGER,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            )
        `);

    await this.db.execute(
      'CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id)'
    );
    // The page read's index (`idx_messages_conv_order`, on `order_at`) and the pending rows' index are
    // NOT created here: an older file has neither column until the v16 step below adds them. The
    // fresh branch and that step create them (`MESSAGE_ORDER_INDEX_STATEMENT`,
    // `MESSAGE_ORDER_PENDING_INDEX_STATEMENT`).

    // Outbox: queued outgoing messages. Cleartext columns so sorting/re-keying works without the
    // device key; the sensitive payload (text/replyTo/media) is encrypted in cipher_text
    // (base64 TEXT).
    await this.db.execute(`
            CREATE TABLE IF NOT EXISTS outbox (
                id              TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                sent_at         INTEGER,
                kind            TEXT,
                status          TEXT,
                attempts        INTEGER DEFAULT 0,
                last_attempt_at INTEGER,
                next_attempt_at INTEGER,
                server_errors   INTEGER DEFAULT 0,
                created_at      INTEGER,
                iv              TEXT,
                cipher_text     TEXT
            )
        `);
    await this.db.execute('CREATE INDEX IF NOT EXISTS idx_outbox_conv ON outbox(conversation_id)');

    // Graine sessions: one row per (sender, session), holding the seed every message key of that
    // session derives from. The seed alone is encrypted; the rest stays clear so a community can be
    // listed, ordered and PURGED without the device key - a purge that needed it could not run at
    // logout, which is exactly when leaving a community has to erase what it left behind.
    await this.db.execute(`
            CREATE TABLE IF NOT EXISTS graine (
                session_id   TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                channel_id   TEXT NOT NULL,
                sender_id    TEXT NOT NULL,
                first_index  INTEGER DEFAULT 0,
                created_at   INTEGER,
                sent_count   INTEGER,
                distribution_epoch INTEGER,
                iv           TEXT,
                cipher_text  TEXT
            )
        `);
    await this.db.execute('CREATE INDEX IF NOT EXISTS idx_graine_channel ON graine(channel_id)');
    await this.db.execute(
      'CREATE INDEX IF NOT EXISTS idx_graine_workspace ON graine(workspace_id)'
    );

    // Pending group exits: a delete/leave this device DECIDED and the server has not answered.
    // Every column is clear, and that is deliberate - the drain runs at start-up, before any PIN,
    // and a row it could not read would be a decision it could not honour. See `PendingGroupExit`.
    await this.db.execute(`
            CREATE TABLE IF NOT EXISTS pending_group_exits (
                group_id     TEXT PRIMARY KEY,
                kind         TEXT NOT NULL,
                requested_at INTEGER NOT NULL
            )
        `);

    // Key-distribution groups this device holds, and whose roster each is. Every column clear: it
    // is read before the first drain, which is the whole point, and it names nothing the local
    // store does not already name. See `StoredDistributionGroup`.
    await this.db.execute(`
            CREATE TABLE IF NOT EXISTS distribution_groups (
                group_id     TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                channel_id   TEXT
            )
        `);

    // The feed's stored first pages (`$lib/posts/feedStore`): one sealed page per feed tab, a COPY the
    // server's next answer replaces. Only the key is clear; it names a tab, never a post.
    await this.db.execute(`
            CREATE TABLE IF NOT EXISTS feed_pages (
                feed_key     TEXT PRIMARY KEY,
                iv           TEXT,
                cipher_text  TEXT
            )
        `);

    // A database created by the statements above has no history to migrate. Stamp it at the
    // current version and skip every branch below: they are written against schemas this file
    // never had, and running them is how "no such column: salt" broke every fresh install.
    if (fresh) {
      await this.db.execute(MESSAGE_ORDER_INDEX_STATEMENT);
      await this.db.execute(MESSAGE_ORDER_PENDING_INDEX_STATEMENT);
      await this.db.execute(MESSAGE_ORDER_MISSING_INDEX_STATEMENT);
      await this.db.execute(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      return;
    }

    // Migration v1->v2: BLOB columns -> TEXT (base64).
    // Delete rows whose iv/salt/cipher_text are not valid base64 (stored in the old JSON
    // "[1,2,3]" format): they cannot be decrypted without the source device's private key.
    // The statement is built from the columns the table actually has, so a column dropped by a
    // later refactor cannot break a migration that predates the drop.
    if (currentVersion < 2) {
      const msgCols: any[] = await this.db.select('PRAGMA table_info(messages)');
      const purge = legacyBlobPurgeStatement(msgCols.map((c) => String(c.name)));
      if (purge) await this.db.execute(purge);
      await this.db.execute('PRAGMA user_version = 2');
    }

    if (currentVersion < 3) {
      // Encryption format changed from Argon2+ChaCha20 (WASM) to PBKDF2+AES-GCM.
      // Old rows cannot be decrypted - drop them. Messages re-fetch from server.
      await this.db.execute('DELETE FROM messages');
      await this.db.execute('PRAGMA user_version = 3');
    }

    if (currentVersion < 4) {
      // v3→v4: replace the boolean `is_ready` column with `lifecycle` (active|pending|removed).
      // Idempotent: the column is added only if missing (fresh databases already have it
      // from the CREATE TABLE above); then backfill from `is_ready` if it still exists.
      const cols: any[] = await this.db.select('PRAGMA table_info(conversations)');
      const hasLifecycle = cols.some((c) => c.name === 'lifecycle');
      const hasIsReady = cols.some((c) => c.name === 'is_ready');
      if (!hasLifecycle) {
        await this.db.execute('ALTER TABLE conversations ADD COLUMN lifecycle TEXT');
      }
      if (hasIsReady) {
        await this.db.execute(
          "UPDATE conversations SET lifecycle = CASE WHEN is_ready = 1 THEN 'active' ELSE 'pending' END WHERE lifecycle IS NULL OR lifecycle = ''"
        );
      }
      await this.db.execute('PRAGMA user_version = 4');
    }

    if (currentVersion < 5) {
      // v4→v5: PBKDF2+salt replaced by direct deviceKeyB64 AES-256-GCM.
      // All encrypted rows are dropped — messages will be re-fetched from the server
      // and re-encrypted with the device key. Conversations (plaintext) are preserved.
      await this.db.execute('DELETE FROM messages');
      await this.db.execute('DELETE FROM outbox');
      await this.db.execute('PRAGMA user_version = 5');
    }

    if (currentVersion < 6) {
      // v5->v6: read state moved off the messages and onto the conversation, as one monotone
      // instant per participant (see `$lib/utils/chat/readState`). Additive: the column is added
      // when missing, and a database that has none simply starts everyone at "has read nothing",
      // which the next reconciliation fills in. Nothing is dropped - the `readBy` arrays still
      // inside old encrypted payloads are ignored on read.
      const cols: any[] = await this.db.select('PRAGMA table_info(conversations)');
      if (!cols.some((c) => c.name === 'read_watermarks')) {
        await this.db.execute('ALTER TABLE conversations ADD COLUMN read_watermarks TEXT');
      }
      // Stamped at 6, NOT at SCHEMA_VERSION: a branch that stamps the CURRENT version claims every
      // migration written after it, so the next one never runs on the databases this one touched.
      await this.db.execute('PRAGMA user_version = 6');
    }

    if (currentVersion < 7) {
      // v6->v7: the conversation carries the shared history floor - where its history begins, as
      // every member agrees it does (see `$lib/utils/chat/historyWindow`). Additive and worth zero
      // on arrival: an absent floor reads as "history begins at the beginning", which is what every
      // conversation means today, and the merge that would raise it is `max`.
      const cols: any[] = await this.db.select('PRAGMA table_info(conversations)');
      if (!cols.some((c) => c.name === 'history_floor')) {
        await this.db.execute('ALTER TABLE conversations ADD COLUMN history_floor INTEGER');
      }
      // Stamped at 7, NOT at SCHEMA_VERSION, for the reason spelled out in the v6 branch: this
      // branch stamping the CURRENT version would claim v8 for databases it never migrated.
      await this.db.execute('PRAGMA user_version = 7');
    }

    if (currentVersion < 8) {
      // v7->v8: the `graine` table, created unconditionally by the statement above (it runs for
      // every database, fresh or not), so this branch has only to record that it happened. Purely
      // additive: nothing is dropped, because a Graine seed is the first key material the server
      // cannot re-serve, and a migration that cleared them would throw away history no peer is
      // guaranteed to still hold.
      //
      // Stamped at 8, NOT at SCHEMA_VERSION, for the reason spelled out in the v6 branch - it read
      // `SCHEMA_VERSION` while 8 WAS the current version, which is exactly how such a branch hides:
      // it is only wrong once a v9 exists, and by then it has already claimed every database it
      // touched.
      await this.db.execute('PRAGMA user_version = 8');
    }

    if (currentVersion < 9) {
      // v8->v9: `graine.distribution_epoch` - the epoch of the community's MLS distribution group
      // when this device minted the session, which is what makes "rotate when somebody leaves" a
      // decision rather than a notification (see `$lib/utils/graine/sessionManager`). Additive, and
      // NULL on every existing row: a session that predates the column is treated as minted under
      // an unknown roster and is rotated away on the next send, which costs one seed distribution
      // and is the only safe reading.
      const cols: any[] = await this.db.select('PRAGMA table_info(graine)');
      if (!cols.some((c) => c.name === 'distribution_epoch')) {
        await this.db.execute('ALTER TABLE graine ADD COLUMN distribution_epoch INTEGER');
      }
      await this.db.execute('PRAGMA user_version = 9');
    }

    if (currentVersion < 10) {
      // v9->v10: `pending_group_exits`, created unconditionally by the statement above (it runs for
      // every database, fresh or not), so this branch has only to record that it happened. Additive,
      // and EMPTY on every existing database: an exit lost to a transport failure before this table
      // existed left nothing behind, and inventing rows would be guessing at an intention no column
      // ever recorded.
      //
      // Stamped at 10, NOT at SCHEMA_VERSION, for the reason spelled out in the v6 branch.
      await this.db.execute('PRAGMA user_version = 10');
    }

    if (currentVersion < 11) {
      // v10->v11: `distribution_groups`, created unconditionally above like `pending_group_exits`,
      // so this branch only records it. EMPTY on every existing database, and safe: the community
      // loop registers each group again on the first load, which writes its row, and the frames
      // refused before that are re-fetched by the same registration.
      //
      // Stamped at 11, NOT at SCHEMA_VERSION, for the reason spelled out in the v6 branch.
      await this.db.execute('PRAGMA user_version = 11');
    }

    if (currentVersion < 12) {
      // v11->v12: the conversation carries its group photo id, so the sidebar draws it from the
      // local row at first render instead of waiting for the server's group list. Additive and
      // NULL on arrival, which reads as "no photo known yet" - the next discovery fills it.
      const cols: any[] = await this.db.select('PRAGMA table_info(conversations)');
      if (!cols.some((c) => c.name === 'image_media_id')) {
        await this.db.execute('ALTER TABLE conversations ADD COLUMN image_media_id TEXT');
      }
      // Stamped at 12, NOT at SCHEMA_VERSION, for the reason spelled out in the v6 branch.
      await this.db.execute('PRAGMA user_version = 12');
    }

    if (currentVersion < 13) {
      // v12->v13: `feed_pages`, created unconditionally above like `distribution_groups`, so this
      // branch only records it. EMPTY on every existing database: the next feed answer writes it.
      //
      // Stamped at 13, NOT at SCHEMA_VERSION, for the reason spelled out in the v6 branch.
      await this.db.execute('PRAGMA user_version = 13');
    }

    if (currentVersion < 14) {
      // v13->v14: the outbox row counts its CONSECUTIVE 5xx answers (`server_errors`), so a text the
      // server keeps failing reaches its terminal state across reloads. Additive and 0 on arrival:
      // a queued row starts a fresh run, which costs at most N more attempts.
      const cols: any[] = await this.db.select('PRAGMA table_info(outbox)');
      const add = outboxServerErrorsStatement(cols.map((c) => String(c.name)));
      if (add) await this.db.execute(add);
      // Stamped at 14, NOT at SCHEMA_VERSION, for the reason spelled out in the v6 branch.
      await this.db.execute('PRAGMA user_version = 14');
    }

    if (currentVersion < 15) {
      // v14->v15: the conversation says whether this account's seat is an invitation-link ask no
      // member has answered (`awaiting_admission`), so a never-admitted conversation reads as
      // waiting rather than established, and leaves when the server stops listing it. Additive and
      // NULL on arrival: the next discovery sets it from the server's list.
      const cols: any[] = await this.db.select('PRAGMA table_info(conversations)');
      const add = conversationAwaitingAdmissionStatement(cols.map((c) => String(c.name)));
      if (add) await this.db.execute(add);
      // Stamped at 15, NOT at SCHEMA_VERSION, for the reason spelled out in the v6 branch.
      await this.db.execute('PRAGMA user_version = 15');
    }

    if (currentVersion < 16) {
      // v15->v16: the read marks on the SERVER's clock get their own column (`readState.ts`), next
      // to the stamped ones it does not replace. Additive and NULL on arrival.
      const cols: any[] = await this.db.select('PRAGMA table_info(conversations)');
      const add = conversationServerReadWatermarksStatement(cols.map((c) => String(c.name)));
      if (add) await this.db.execute(add);
      // ...and the message rows get the key a page is read on, the same key the timeline sorts on
      // (`storedOrderAt`). It is derived from the ciphertext, so the rows already stored are keyed
      // PROVISIONALLY on their `timestamp` in one statement and derived behind the page reads
      // (`$lib/db/orderKeyDerivation`). The `timestamp` index it replaces goes.
      const messageCols: any[] = await this.db.select('PRAGMA table_info(messages)');
      for (const add of messageOrderColumnsStatements(messageCols.map((c) => String(c.name)))) {
        await this.db.execute(add);
      }
      await this.db.execute(MESSAGE_PROVISIONAL_ORDER_FILL);
      await this.db.execute(LEGACY_MESSAGE_TIME_INDEX_DROP);
      await this.db.execute(MESSAGE_ORDER_INDEX_STATEMENT);
      await this.db.execute(MESSAGE_ORDER_PENDING_INDEX_STATEMENT);
      await this.db.execute(MESSAGE_ORDER_MISSING_INDEX_STATEMENT);
      // Stamped at 16, NOT at SCHEMA_VERSION, for the reason spelled out in the v6 branch.
      await this.db.execute('PRAGMA user_version = 16');
    }

    if (currentVersion < 17) {
      // v16->v17: the conversation keeps the server's record of the group's creation (`started_at`),
      // which this backend dropped on every save while IndexedDB kept it. Additive and NULL on
      // arrival, read as unknown: the next group sweep fills it (`recordGroupStart`).
      const cols: any[] = await this.db.select('PRAGMA table_info(conversations)');
      const add = conversationStartedAtStatement(cols.map((c) => String(c.name)));
      if (add) await this.db.execute(add);
      // Stamped at 17, NOT at SCHEMA_VERSION, for the reason spelled out in the v6 branch.
      await this.db.execute('PRAGMA user_version = 17');
    }

    // EVERY OPEN, not a migration: a build older than v16 that opened this file meanwhile wrote its
    // rows with no order key (`MESSAGE_ORDER_MISSING_INDEX_STATEMENT`), and no page would reach
    // them. Re-keyed provisionally through the partial index - nothing read when there are none. The
    // same build recreated its `timestamp` page index unconditionally: dropped again, since every
    // write would otherwise keep paying for an index nothing reads.
    await this.db.execute(MESSAGE_PROVISIONAL_ORDER_FILL);
    await this.db.execute(LEGACY_MESSAGE_TIME_INDEX_DROP);
  }

  // -- Conversations -------------------------------------------------------

  /** Upsert a conversation metadata row (INSERT OR REPLACE). */
  async saveConversation(conv: ConversationMeta): Promise<void> {
    await this.db.execute(
      'INSERT OR REPLACE INTO conversations (id, name, lifecycle, updated_at, read_watermarks, history_floor, image_media_id, awaiting_admission, server_read_watermarks, started_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [
        conv.id,
        conv.name,
        conv.lifecycle,
        conv.updatedAt,
        conv.readWatermarks ? JSON.stringify(conv.readWatermarks) : null,
        conv.historyFloor ?? null,
        conv.imageMediaId ?? null,
        conv.awaitingAdmission === true ? 1 : 0,
        conv.serverReadWatermarks ? JSON.stringify(conv.serverReadWatermarks) : null,
        conv.startedAt ?? null,
      ]
    );
  }

  /**
   * One row as callers see it. Shared by the list read and the single-row read so the two cannot
   * drift - a field parsed in one and passed through raw in the other is the exact shape that made
   * `readWatermarks` correct until the first restart.
   */
  private rowToMeta(r: any): ConversationMeta {
    return {
      id: r.id,
      name: r.name,
      lifecycle: normalizeConversationLifecycle(r.lifecycle, r.is_ready === 1),
      updatedAt: r.updated_at,
      readWatermarks: parseReadWatermarks(r.read_watermarks),
      serverReadWatermarks: parseReadWatermarks(r.server_read_watermarks),
      historyFloor: parseHistoryFloor(r.history_floor),
      imageMediaId:
        typeof r.image_media_id === 'string' && r.image_media_id ? r.image_media_id : null,
      // On Android the plugin returns INTEGER columns as strings.
      awaitingAdmission: Number(r.awaiting_admission) === 1,
      // INTEGER, so a string on Android too; absent or unusable reads as unknown.
      ...(Number(r.started_at) > 0 ? { startedAt: Number(r.started_at) } : {}),
    };
  }

  /** Return all stored conversation metadata rows ordered most-recently-updated first. */
  async getConversations(): Promise<ConversationMeta[]> {
    const rows: any[] = await this.db.select(
      'SELECT * FROM conversations ORDER BY updated_at DESC'
    );
    return rows.map((r) => this.rowToMeta(r));
  }

  /**
   * One conversation's metadata row, or `null` when there is none.
   *
   * Exists because every caller that wanted a single conversation was reading the whole table and
   * filtering it in JS - which inside a per-group loop makes the work grow with the square of the
   * number of conversations, for a question the primary key answers directly.
   */
  async getConversation(id: string): Promise<ConversationMeta | null> {
    const rows: any[] = await this.db.select('SELECT * FROM conversations WHERE id = $1 LIMIT 1', [
      id,
    ]);
    return rows.length > 0 ? this.rowToMeta(rows[0]) : null;
  }

  /** Delete the conversation row and all of its messages (messages first to respect the foreign key). */
  async deleteConversation(id: string): Promise<void> {
    await this.deleteMessagesForConversation(id);
    await this.db.execute('DELETE FROM conversations WHERE id = $1', [id]);
  }

  /** Delete all messages for a conversation without removing its metadata row. */
  async deleteMessagesForConversation(conversationId: string): Promise<void> {
    invalidateHistoryStateKey(conversationId);
    await this.db.execute('DELETE FROM messages WHERE conversation_id = $1', [conversationId]);
  }

  // -- Messages ------------------------------------------------------------

  /** Remove one message row by primary key; a missing row deletes nothing and is not an error. */
  async deleteMessage(id: string, conversationId: string): Promise<void> {
    invalidateHistoryStateKey(conversationId);
    await this.db.execute('DELETE FROM messages WHERE id = $1', [id]);
  }

  /** Encrypt and persist a single message; delegates to saveMessages. */
  async saveMessage(msg: StoredMessage, deviceKeyB64: string): Promise<void> {
    return this.saveMessages([msg], deviceKeyB64);
  }

  /**
   * Encrypt and persist a batch of messages wrapped in a single SQLite transaction.
   * Binary iv/cipherText are stored as base64 TEXT to avoid a Tauri SQL plugin
   * serialisation bug where BLOB bindings are read back as JSON arrays on restart.
   * No salt column — the deviceKeyB64 is imported directly as an AES-256-GCM key.
   */
  async saveMessages(msgs: StoredMessage[], deviceKeyB64: string): Promise<void> {
    // Every write through this class passes here - `saveMessage` and `updateMessage` both delegate
    // to it - so this is where the reconciliation's cached state key is dropped.
    for (const msg of msgs) invalidateHistoryStateKey(msg.conversationId);
    const encryptedMessages = await Promise.all(
      msgs.map(async (msg) => {
        const encrypted = await encryptData(toMessagePayload(msg), deviceKeyB64);
        return { msg, encrypted };
      })
    );

    // ONE STATEMENT PER BATCH, and it is not an optimisation - see `sqliteBatch.ts`. The plugin
    // pools connections, so a `BEGIN`/`COMMIT` pair issued as separate `execute` calls is not
    // guaranteed to reach the same connection: measured on device, two concurrent `BEGIN`s both
    // succeeded and a following `ROLLBACK` reported "no transaction is active". Under load that
    // failed real writes ("database is locked", "cannot start a transaction within a transaction"),
    // and a failed write here is a message the sender does not keep.
    //
    // Binary data stored as base64 TEXT: passing number[] would cause the plugin to
    // serialise as JSON "[1,2,3]" (not a BLOB), which is unreadable after restart.
    for (const batch of chunk(encryptedMessages, MESSAGE_ROWS_PER_STATEMENT)) {
      await this.db.execute(
        messageInsertSql(batch.length),
        batch.flatMap((item) => [
          item.msg.id,
          item.msg.conversationId,
          item.msg.timestamp,
          uint8ToBase64(item.encrypted.iv),
          uint8ToBase64(item.encrypted.cipherText),
          storedOrderAt(item.msg),
          // The key above is the real one: a save is never provisional.
          null,
        ])
      );
    }
  }

  /**
   * Merge `patch` into the stored message (read-modify-write; re-encrypts the payload).
   * No-op if the row is absent or undecryptable.
   *
   * Primary-key lookup, so the cost is the same in a conversation of ten messages and one of ten
   * thousand - which is what makes this usable on every mutation.
   */
  async updateMessage(id: string, patch: StoredMessagePatch, deviceKeyB64: string): Promise<void> {
    const msg = await this.getMessage(id, deviceKeyB64);
    // A row we cannot read is a row we must not overwrite: replacing it with the patch alone
    // would turn an undecryptable message into a truncated one. `getMessage` reports both that
    // and an absent row as `null`, and neither is a reason to write.
    if (!msg) return;
    await this.saveMessage(mergeStoredMessage(msg, patch), deviceKeyB64);
  }

  /** Decrypt and return one message by id; `null` when the row is absent or undecryptable. */
  async getMessage(id: string, deviceKeyB64: string): Promise<StoredMessage | null> {
    const rows: any[] = await this.db.select('SELECT * FROM messages WHERE id = $1', [id]);
    if (rows.length === 0) return null;
    const row = rows[0];
    try {
      const payload = (await decryptData(
        base64ToUint8(row.cipher_text),
        base64ToUint8(row.iv),
        deviceKeyB64
      )) as Record<string, unknown>;
      return fromMessagePayload(
        {
          id: row.id,
          conversationId: row.conversation_id,
          timestamp: rowTimestampMs(row.timestamp),
        },
        payload
      );
    } catch {
      console.warn('Failed to decrypt SQLite row', id);
      return null;
    }
  }

  /** Decrypt and return all messages for `conversationId` sorted oldest-first; silently skips rows that fail decryption. */
  async getMessages(conversationId: string, deviceKeyB64: string): Promise<StoredMessage[]> {
    const rows: any[] = await this.db.select(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY timestamp ASC',
      [conversationId]
    );
    const results: StoredMessage[] = [];
    for (const row of rows) {
      try {
        const iv = base64ToUint8(row.iv);
        const cipherText = base64ToUint8(row.cipher_text);
        const payload = (await decryptData(cipherText, iv, deviceKeyB64)) as Record<
          string,
          unknown
        >;
        results.push(
          fromMessagePayload(
            {
              id: row.id,
              conversationId: row.conversation_id,
              timestamp: rowTimestampMs(row.timestamp),
            },
            payload
          )
        );
      } catch {
        console.warn('Failed to decrypt SQLite row', row.id);
      }
    }
    return results.sort(compareStoredOrder);
  }

  /** Rows held for `conversationId`, counted on `idx_messages_conv` - nothing is decrypted. */
  async countMessages(conversationId: string): Promise<number> {
    const rows: Array<{ n: number }> = await this.db.select(
      'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = $1',
      [conversationId]
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * See {@link IStorage.getMessageConversationIds}. A RANGE on `idx_messages_conv`, so SQLite
   * searches the index instead of scanning it (`EXPLAIN QUERY PLAN`: SEARCH, not SCAN), and compares
   * the prefix exactly - never as a `LIKE` pattern, where `_` and `%` are wildcards. The upper bound
   * is the prefix followed by the highest code point: no id that starts with the prefix sorts above it.
   */
  async getMessageConversationIds(prefix: string): Promise<string[]> {
    const rows: Array<{ conversation_id: string }> = await this.db.select(
      'SELECT DISTINCT conversation_id FROM messages WHERE conversation_id >= $1 AND conversation_id < $1 || char(1114111)',
      [prefix]
    );
    return rows.map((r) => String(r.conversation_id));
  }

  /**
   * Decrypt and return a paginated slice of messages using a server-side LIMIT clause, on the ORDER
   * KEY (`order_at`, {@link storedOrderAt}) with ties broken by id: the newest `limit` rows, or those
   * strictly below `before` on that pair for "load older", handed back oldest first
   * ({@link compareStoredOrder}), each with its {@link PageKey}. Every statement is answered by
   * `idx_messages_conv_order` with no sort step.
   *
   * NEVER WAITS FOR A DERIVATION ON A FIRST PAGE. Rows still keyed provisionally on their `sentAt`
   * are paged with that key, and their derivation starts behind the read ({@link orderKeysDerived}):
   * the cost of a first page is the page, whatever the conversation holds. A `before` read while the
   * conversation was provisional waits for the derivation (the reader is scrolling, off the first
   * paint), then also returns every row at or above `before`: a row whose real key rose past the
   * boundary is in neither page otherwise.
   */
  async getMessagesPage(
    conversationId: string,
    deviceKeyB64: string,
    limit: number,
    before?: PageKey
  ): Promise<StoredMessage[]> {
    const derive = () => this.deriveOrderKeys(conversationId, deviceKeyB64);
    // A conversation whose run deferred a row this session reads as keyed (`OrderKeyDerivations`).
    const provisionalNow = async () =>
      !this.orderKeyDerivations.gaveUp(conversationId) &&
      (await this.hasProvisionalOrderKeys(conversationId));
    let provisional = await provisionalNow();
    if (provisional && before?.provisional) {
      try {
        await this.orderKeyDerivations.run(conversationId, derive);
      } catch (e) {
        console.error(
          `[STORE] load-older of ${conversationId.slice(0, 8)} read over provisional keys - the derivation failed: ${String(e)}`
        );
      }
      provisional = await provisionalNow();
    } else if (provisional) {
      this.orderKeyDerivations.startInBackground(conversationId, derive);
    }

    let rows: any[];
    if (before === undefined) {
      rows = await this.db.select(
        'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY order_at DESC, id DESC LIMIT $2',
        [conversationId, limit]
      );
    } else {
      rows = await this.db.select(
        'SELECT * FROM messages WHERE conversation_id = $1 AND (order_at, id) < ($2, $3) ORDER BY order_at DESC, id DESC LIMIT $4',
        [conversationId, before.orderAt, before.id, limit]
      );
      if (before.provisional) {
        const above: any[] = await this.db.select(
          'SELECT * FROM messages WHERE conversation_id = $1 AND (order_at, id) >= ($2, $3) ORDER BY order_at DESC, id DESC',
          [conversationId, before.orderAt, before.id]
        );
        appendLog(
          `[STORE] load-older of ${conversationId.slice(0, 8)} below a provisional boundary - ${above.length} row(s) above it re-read`
        );
        rows = [...above, ...rows];
      }
    }

    const results: StoredMessage[] = [];
    let readPending = false;
    for (const row of rows) {
      try {
        const iv = base64ToUint8(row.iv);
        const cipherText = base64ToUint8(row.cipher_text);
        const payload = (await decryptData(cipherText, iv, deviceKeyB64)) as Record<
          string,
          unknown
        >;
        const msg = fromMessagePayload(
          {
            id: row.id,
            conversationId: row.conversation_id,
            timestamp: rowTimestampMs(row.timestamp),
          },
          payload
        );
        msg.pageKey = { orderAt: rowTimestampMs(row.order_at), id: String(row.id), provisional };
        results.push(msg);
        if (Number(row.order_pending) === 1) readPending = true;
      } catch {
        console.warn('Failed to decrypt SQLite row', row.id);
      }
    }
    // A deferred row that decrypts now re-arms the conversation (`OrderKeyDerivations.readableAgain`).
    if (readPending) this.orderKeyDerivations.readableAgain(conversationId, results, derive);
    return results.sort(compareStoredOrder);
  }

  /** Whether `conversationId` still holds a row keyed provisionally - one probe of the partial index. */
  private async hasProvisionalOrderKeys(conversationId: string): Promise<boolean> {
    const rows: any[] = await this.db.select(
      'SELECT 1 AS p FROM messages WHERE conversation_id = $1 AND order_pending = 1 LIMIT 1',
      [conversationId]
    );
    return rows.length > 0;
  }

  /**
   * The derivation of `conversationId`'s provisional keys: the run in flight, or a new one. Page
   * reads start it on their own; exposed so a caller (and the tests) can wait for the keys to settle.
   */
  orderKeysDerived(conversationId: string, deviceKeyB64: string): Promise<OrderKeyDerivation> {
    return this.orderKeyDerivations.run(conversationId, () =>
      this.deriveOrderKeys(conversationId, deviceKeyB64)
    );
  }

  /**
   * One run of `$lib/db/orderKeyDerivation` over this table: the pending rows read through
   * `idx_messages_order_pending` by id, the keys written in statements that touch only rows still
   * pending ({@link orderAtFillStatement}).
   */
  private deriveOrderKeys(
    conversationId: string,
    deviceKeyB64: string
  ): Promise<OrderKeyDerivation> {
    return deriveOrderKeysInChunks(conversationId, deviceKeyB64, {
      readChunk: async (after, limit) => {
        const rows: any[] = await this.db.select(
          'SELECT id, timestamp, iv, cipher_text FROM messages WHERE conversation_id = $1 AND order_pending = 1 AND id > $2 ORDER BY id LIMIT $3',
          [conversationId, after ?? '', limit]
        );
        return rows.map((row) => ({
          id: String(row.id),
          timestamp: rowTimestampMs(row.timestamp),
          iv: base64ToUint8(row.iv),
          cipherText: base64ToUint8(row.cipher_text),
        }));
      },
      writeChunk: async (keyed) => {
        invalidateHistoryStateKey(conversationId);
        for (const batch of chunk([...keyed], ORDER_AT_FILL_ROWS_PER_STATEMENT)) {
          const { sql, params } = orderAtFillStatement(batch);
          await this.db.execute(sql, params);
        }
      },
    });
  }

  // -- Backup helpers ------------------------------------------------------

  /** Return all raw encrypted rows for backup export, decoding base64 columns back to Uint8Array. */
  async getAllEncryptedRows(): Promise<EncryptedMessageRow[]> {
    const rows: any[] = await this.db.select('SELECT * FROM messages');
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      // Read like every other row of this table: on Android the plugin returns INTEGER columns as
      // strings, and a backup that carried one wrote a string timestamp into the browser's store.
      timestamp: rowTimestampMs(row.timestamp),
      iv: base64ToUint8(row.iv),
      cipherText: base64ToUint8(row.cipher_text),
    }));
  }

  /** Non-destructive insert: write the conversation only if no row with this id already exists. */
  async mergeConversation(conv: ConversationMeta): Promise<void> {
    // INSERT OR IGNORE: only insert if no row with this id already exists.
    await this.db.execute(
      'INSERT OR IGNORE INTO conversations (id, name, lifecycle, updated_at, read_watermarks, history_floor, image_media_id, awaiting_admission, server_read_watermarks, started_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [
        conv.id,
        conv.name,
        conv.lifecycle,
        conv.updatedAt,
        conv.readWatermarks ? JSON.stringify(conv.readWatermarks) : null,
        conv.historyFloor ?? null,
        conv.imageMediaId ?? null,
        conv.awaitingAdmission === true ? 1 : 0,
        conv.serverReadWatermarks ? JSON.stringify(conv.serverReadWatermarks) : null,
        conv.startedAt ?? null,
      ]
    );
  }

  /** Non-destructive insert: write the encrypted row only if no row with this id already exists. */
  async importEncryptedRow(row: EncryptedMessageRow): Promise<void> {
    invalidateHistoryStateKey(row.conversationId);
    this.orderKeyDerivations.rearm(row.conversationId);
    // INSERT OR IGNORE: skip rows that already exist on this device so that
    // messages received after the backup was taken are never overwritten. The row is ciphertext, so
    // its order key is PROVISIONAL - its `timestamp`, flagged - and the next page read of its
    // conversation derives the real one (`$lib/db/orderKeyDerivation`).
    const timestamp = rowTimestampMs(row.timestamp);
    await this.db.execute(
      'INSERT OR IGNORE INTO messages (id, conversation_id, timestamp, iv, cipher_text, order_at, order_pending) VALUES ($1, $2, $3, $4, $5, $3, 1)',
      [row.id, row.conversationId, timestamp, uint8ToBase64(row.iv), uint8ToBase64(row.cipherText)]
    );
  }

  // -- Garbage Collection --------------------------------------------------

  /** Delete messages older than `maxAgeMs` milliseconds using a single DELETE statement; returns the number of affected rows. */
  async deleteOldMessages(maxAgeMs: number): Promise<number> {
    // Age-based, so it cannot name the conversations it touched: everything goes.
    invalidateAllHistoryStateKeys();
    const result = await this.db.execute('DELETE FROM messages WHERE timestamp < $1', [
      Date.now() - maxAgeMs,
    ]);
    return result?.rowsAffected ?? 0;
  }

  // -- Outbox --------------------------------------------------------------

  /** Decrypt one outbox row into an entry, or null if it cannot be decrypted. */
  private async decodeOutboxRow(row: any, deviceKeyB64: string): Promise<OutboxEntry | null> {
    try {
      const iv = base64ToUint8(row.iv);
      const cipherText = base64ToUint8(row.cipher_text);
      const payload = await decryptData(cipherText, iv, deviceKeyB64);
      return decodeOutboxEntry(this.outboxClearOf(row), payload);
    } catch {
      console.warn('Failed to decrypt outbox row', row.id);
      return null;
    }
  }

  /** The clear columns of an outbox row. */
  private outboxClearOf(row: any): OutboxClearColumns {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      sentAt: rowTimestampMs(row.sent_at),
      kind: row.kind,
      status: row.status,
      attempts: typeof row.attempts === 'number' ? row.attempts : 0,
      lastAttemptAt: row.last_attempt_at ?? undefined,
      nextAttemptAt: row.next_attempt_at ?? undefined,
      serverErrors: typeof row.server_errors === 'number' ? row.server_errors : undefined,
      createdAt: rowTimestampMs(row.created_at),
    };
  }

  /** Encrypt the sensitive payload and upsert a queued outbound message. */
  /**
   * The message and the entry that will send it - THE ENTRY FIRST, because here they cannot be one.
   *
   * IndexedDB gives this pair a real two-store transaction. SQLite, as reached through
   * `tauri-plugin-sql`, does not: the plugin pools connections, so a `BEGIN`/`COMMIT` issued as
   * separate `execute` calls can land on three different ones (measured on device 2026-08-11, see
   * `sqliteBatch.ts`) - a statement is the largest unit of atomicity available, and two tables need
   * two statements.
   *
   * So the choice is not whether a tear can happen but WHICH HALF SURVIVES it, and the two are not
   * equally bad. Entry without message: the flush sends it, the peer receives the message, and what
   * is missing is the sender's own echo. Message without entry: nothing is ever sent, nothing
   * retries, nothing reports, and the author keeps a message no one else will ever have (TAB-5,
   * 2026-09-05). The first is recoverable in the only direction that matters, so the entry is
   * written first and the message second.
   *
   * **AND THE TEAR IS REPORTED AS WHAT IT IS.** A message write that fails after the entry landed
   * throws {@link OutboxEntryWrittenAloneError}: the caller must not write the entry a second time
   * (a second blob in its slot) nor give the file back for another send (a duplicate) - the queue
   * already owns it (review of #2874, M2). A failure of the entry write throws as it comes: nothing
   * is on disk.
   */
  async saveMessageWithOutboxEntry(
    msg: StoredMessage,
    entry: OutboxEntry,
    deviceKeyB64: string
  ): Promise<void> {
    await this.saveOutboxEntry(entry, deviceKeyB64);
    try {
      await this.saveMessages([msg], deviceKeyB64);
    } catch (e) {
      console.error(
        `[DB] ${msg.id.slice(0, 8)}… outbox entry written, its message row NOT - the queue sends it, the echo is missing:`,
        e
      );
      throw new OutboxEntryWrittenAloneError(msg.id, e);
    }
  }

  /**
   * Upsert a queued entry. An attachment's bytes go to the blob store FIRST and the row, holding
   * only the blob's key, SECOND - so a row without its blob is a typed failure at flush time and a
   * blob without its row is garbage {@link sweepOutboxBlobs} removes.
   */
  async saveOutboxEntry(entry: OutboxEntry, deviceKeyB64: string): Promise<void> {
    await writeOutboxWithBlob(this.blobs, entry, async (blobKeyB64) => {
      await this.db.execute(
        outboxInsertSql(1),
        await this.outboxRowParams(entry, blobKeyB64, deviceKeyB64)
      );
    });
  }

  /**
   * See {@link IStorage.saveReelTake}. The take and its sends are ONE `INSERT` (the plugin's largest
   * atomic unit), so no kill leaves one without the other; the messages follow in a second write,
   * the entries first as for a single send (`saveMessageWithOutboxEntry`).
   */
  async saveReelTake(
    take: OutboxEntry,
    sends: Array<{ entry: OutboxEntry; message: StoredMessage }>,
    deviceKeyB64: string
  ): Promise<void> {
    const rows = 1 + sends.length;
    // NEVER SPLIT: two statements would be two transactions, and the point is one.
    if (rows > OUTBOX_ROWS_PER_STATEMENT) {
      throw new Error(`a reel take with ${sends.length} sends does not fit one outbox statement`);
    }
    await writeOutboxWithBlob(this.blobs, take, async (blobKeyB64) => {
      const params = [
        ...(await this.outboxRowParams(take, blobKeyB64, deviceKeyB64)),
        ...(
          await Promise.all(
            sends.map((s) => this.outboxRowParams(s.entry, undefined, deviceKeyB64))
          )
        ).flat(),
      ];
      await this.db.execute(outboxInsertSql(rows), params);
    });
    try {
      await this.saveMessages(
        sends.map((s) => s.message),
        deviceKeyB64
      );
    } catch (e) {
      console.error(
        `[DB] reel take ${take.id.slice(0, 8)}… and its ${sends.length} send(s) written, their messages NOT - the queue sends them, the echoes are missing:`,
        e
      );
      throw new OutboxEntryWrittenAloneError(take.id, e);
    }
  }

  /** The `OUTBOX_COLUMNS` parameters of one outbox row, its payload sealed under the device key. */
  private async outboxRowParams(
    entry: OutboxEntry,
    blob: OutboxBlobRef | undefined,
    deviceKeyB64: string
  ): Promise<unknown[]> {
    const encrypted = await encryptData(encodeOutboxSensitive(entry, blob), deviceKeyB64);
    const c = outboxClearColumns(entry);
    return [
      c.id,
      c.conversationId,
      c.sentAt,
      c.kind,
      c.status,
      c.attempts,
      c.lastAttemptAt ?? null,
      c.nextAttemptAt ?? null,
      c.serverErrors ?? 0,
      c.createdAt,
      uint8ToBase64(encrypted.iv),
      uint8ToBase64(encrypted.cipherText),
    ];
  }

  /** Decrypt and return queued entries targeting `conversationId`, sorted by `sentAt`. */
  async getOutboxEntriesForConversation(
    conversationId: string,
    deviceKeyB64: string
  ): Promise<OutboxEntry[]> {
    const rows: any[] = await this.db.select(
      'SELECT * FROM outbox WHERE conversation_id = $1 ORDER BY sent_at ASC',
      [conversationId]
    );
    const out: OutboxEntry[] = [];
    for (const row of rows) {
      const entry = await this.decodeOutboxRow(row, deviceKeyB64);
      if (entry) out.push(entry);
    }
    return out;
  }

  /**
   * The queue as the flusher reads it - several times per flush. A media row comes back with its
   * clear columns ONLY: its ciphertext column is not even selected, so the file neither crosses the
   * SQL bridge nor is decrypted until {@link getOutboxEntry} is asked for that one entry.
   */
  async getOutboxQueue(deviceKeyB64: string): Promise<OutboxEntry[]> {
    const rows: any[] = await this.db.select(
      `SELECT id, conversation_id, sent_at, kind, status, attempts, last_attempt_at, next_attempt_at, server_errors, created_at,
         CASE WHEN kind = 'media' THEN NULL ELSE iv END AS iv,
         CASE WHEN kind = 'media' THEN NULL ELSE cipher_text END AS cipher_text
       FROM outbox WHERE conversation_id <> $1 ORDER BY sent_at ASC, id ASC`,
      // A SENT-TAKE RECORD IS NOT QUEUED WORK (RC-13): no flush decrypts, drives or counts it.
      [REEL_TAKE_RECORDS]
    );
    const out: OutboxEntry[] = [];
    for (const row of rows) {
      const entry =
        row.kind === 'media'
          ? decodeOutboxEntry(this.outboxClearOf(row), undefined)
          : await this.decodeOutboxRow(row, deviceKeyB64);
      if (entry) out.push(entry);
    }
    return out;
  }

  /** See {@link IStorage.getReelTakeRecords}: the records the queue read leaves out. */
  async getReelTakeRecords(deviceKeyB64: string): Promise<OutboxEntry[]> {
    const rows: any[] = await this.db.select(
      'SELECT * FROM outbox WHERE conversation_id = $1 ORDER BY sent_at ASC, id ASC',
      [REEL_TAKE_RECORDS]
    );
    const out: OutboxEntry[] = [];
    for (const row of rows) {
      const entry = await this.decodeOutboxRow(row, deviceKeyB64);
      if (entry) out.push(entry);
    }
    return out;
  }

  /** One entry with its full payload, or null when not queued. Throws {@link OutboxPayloadUnreadableError}. */
  async getOutboxEntry(
    id: string,
    deviceKeyB64: string,
    opts?: { withFile?: boolean }
  ): Promise<OutboxEntry | null> {
    const rows: any[] = await this.db.select('SELECT * FROM outbox WHERE id = $1', [id]);
    if (rows.length === 0) return null;
    const row = rows[0];
    let entry: OutboxEntry;
    try {
      const payload = await decryptData(
        base64ToUint8(row.cipher_text),
        base64ToUint8(row.iv),
        deviceKeyB64
      );
      entry = decodeOutboxEntry(this.outboxClearOf(row), payload);
    } catch (e) {
      throw new OutboxPayloadUnreadableError(id, e);
    }
    if (opts?.withFile === false) return entry;
    return attachOutboxBlob(this.blobs, entry, async () => {
      const again: any[] = await this.db.select('SELECT id FROM outbox WHERE id = $1', [id]);
      return again.length > 0;
    });
  }

  /**
   * Read-modify-write: merge `patch` into the stored entry and re-encrypt. No-op if absent - and
   * still a no-op when the row is deleted between the read and the write (see the write below).
   */
  async updateOutboxEntry(
    id: string,
    patch: Partial<OutboxEntry>,
    deviceKeyB64: string
  ): Promise<void> {
    if (isOutboxClearPatch(patch)) {
      // A retry only moves the clear scheduling columns. Decoding the row and writing it back
      // re-encrypts the whole payload - file bytes included - for a change that never touches it:
      // measured on a Pixel 6a (2026-10-10), the renderer swung from 160 MB to 1.4 GB and the
      // INSERT took 1.5 s on EVERY backoff of one queued media entry.
      await this.db.execute(
        `UPDATE outbox SET status = COALESCE($2, status), attempts = COALESCE($3, attempts),
           last_attempt_at = COALESCE($4, last_attempt_at), next_attempt_at = COALESCE($5, next_attempt_at),
           server_errors = COALESCE($6, server_errors)
         WHERE id = $1`,
        [
          id,
          patch.status ?? null,
          patch.attempts ?? null,
          patch.lastAttemptAt ?? null,
          patch.nextAttemptAt ?? null,
          patch.serverErrors ?? null,
        ]
      );
      return;
    }
    const rows: any[] = await this.db.select('SELECT * FROM outbox WHERE id = $1', [id]);
    if (rows.length === 0) return;
    const entry = await this.decodeOutboxRow(rows[0], deviceKeyB64);
    if (!entry) return;
    // The row read above is the small one: a blob-format row carries a key, not the file, so the
    // post-upload patch (uploadedRef, fileBytes dropped) rewrites ~1 KB and never the attachment.
    const merged = mergeOutboxEntry(entry, patch);
    // AN UPDATE, NEVER AN `INSERT OR REPLACE`: a row deleted while this merge was decrypting (a
    // withdrawal, a send) stays deleted - the replace would put it back, and the flusher would then
    // send a message the member withdrew. One statement: the existence check and the write are one.
    let gone = false;
    await writeOutboxWithBlob(this.blobs, merged, async (blobKeyB64) => {
      const res = await this.db.execute(
        OUTBOX_UPDATE_ROW_SQL,
        await this.outboxRowParams(merged, blobKeyB64, deviceKeyB64)
      );
      gone = res.rowsAffected === 0;
    });
    if (gone) {
      appendLog(`[DB] outbox ${id.slice(0, 8)}… deleted during its update - not written back`);
      // Bytes this patch carried went to a blob slot no row names: given back now.
      if (merged.media?.fileBytes?.length) await deleteOutboxBlobQuietly(this.blobs, id);
      return;
    }
    if (outboxBlobReleased(merged)) await deleteOutboxBlobQuietly(this.blobs, id);
  }

  /**
   * Remove a queued entry (after a confirmed send or a permanent failure), and its blob. The row
   * goes first: a kill between the two leaves a blob with no row, which the boot sweep removes.
   */
  async deleteOutboxEntry(id: string): Promise<void> {
    // The kind only decides whether a blob may exist, so its read must never be what fails a
    // cancel: unreadable, the blob is deleted anyway (absent is success).
    let kind: string | undefined = 'unknown';
    try {
      const rows: any[] = await this.db.select('SELECT kind FROM outbox WHERE id = $1', [id]);
      kind = rows[0]?.kind;
    } catch (e) {
      appendLog(
        `[DB] outbox ${id}: kind not readable before delete, blob deleted too: ${String(e)}`
      );
    }
    await this.db.execute('DELETE FROM outbox WHERE id = $1', [id]);
    if (outboxKindHoldsBlob(kind) || kind === 'unknown')
      await deleteOutboxBlobQuietly(this.blobs, id);
  }

  /** See {@link IStorage.sweepOutboxBlobs}. */
  async sweepOutboxBlobs(): Promise<number> {
    const removed = await this.blobs.sweep(async () => {
      const rows: any[] = await this.db.select('SELECT id FROM outbox');
      return rows.map((r) => String(r.id));
    });
    return removed.length;
  }

  // -- Pending group exits -------------------------------------------------

  /** Record that this device owes the server an exit for `entry.groupId`. */
  async savePendingGroupExit(entry: PendingGroupExit): Promise<void> {
    await this.db.execute(
      'INSERT OR REPLACE INTO pending_group_exits (group_id, kind, requested_at) VALUES ($1, $2, $3)',
      [entry.groupId, entry.kind, entry.requestedAt]
    );
  }

  /** Every exit still owed, oldest first. */
  async getPendingGroupExits(): Promise<PendingGroupExit[]> {
    const rows: any[] = await this.db.select(
      'SELECT * FROM pending_group_exits ORDER BY requested_at ASC'
    );
    // `kind` is narrowed rather than cast: the column is TEXT, so a row written by a future version
    // (or by hand) can hold a verb this build has no call for, and running the WRONG exit is worse
    // than leaving the row alone. Anything unrecognised is skipped, which keeps the row for a build
    // that does know it.
    return rows
      .filter((r) => r.kind === 'delete' || r.kind === 'leave')
      .map((r) => ({
        groupId: String(r.group_id),
        kind: r.kind as 'delete' | 'leave',
        requestedAt: Number(r.requested_at) || 0,
      }));
  }

  /** Forget the exit owed for `groupId`. A groupId that names nothing is not an error. */
  async deletePendingGroupExit(groupId: string): Promise<void> {
    await this.db.execute('DELETE FROM pending_group_exits WHERE group_id = $1', [groupId]);
  }

  // -- Key-distribution groups -------------------------------------------

  /** Record that `entry.groupId` is the key-distribution group of `entry`'s scope. */
  async saveDistributionGroup(entry: StoredDistributionGroup): Promise<void> {
    await this.db.execute(
      'INSERT OR REPLACE INTO distribution_groups (group_id, workspace_id, channel_id) VALUES ($1, $2, $3)',
      [entry.groupId, entry.workspaceId, entry.channelId]
    );
  }

  /** Every key-distribution group recorded. */
  async getDistributionGroups(): Promise<StoredDistributionGroup[]> {
    const rows: any[] = await this.db.select('SELECT * FROM distribution_groups');
    return rows.map((r) => ({
      groupId: String(r.group_id),
      workspaceId: String(r.workspace_id),
      channelId: r.channel_id == null ? null : String(r.channel_id),
    }));
  }

  /** Forget `groupId`'s row. A groupId that names nothing is not an error. */
  async deleteDistributionGroup(groupId: string): Promise<void> {
    await this.db.execute('DELETE FROM distribution_groups WHERE group_id = $1', [groupId]);
  }

  // -- Graine sessions -----------------------------------------------------

  /** The clear columns of a `graine` row, named as callers know them. */
  private graineRowColumns(row: any): GraineClearColumns {
    return {
      sessionId: String(row.session_id),
      workspaceId: String(row.workspace_id),
      channelId: String(row.channel_id),
      senderId: String(row.sender_id),
      firstIndex: Number(row.first_index) || 0,
      createdAt: rowTimestampMs(row.created_at),
      sentCount: row.sent_count ?? undefined,
      distributionEpoch: row.distribution_epoch ?? undefined,
    };
  }

  /**
   * Decrypt a batch of Graine rows, skipping and REPORTING any that fail.
   *
   * One unreadable seed must not cost the other nineteen, and it must not pass unmentioned either:
   * after Graine the server holds nothing to re-serve, so a seed that cannot be decrypted is
   * history this device has to ask a peer for.
   */
  private async decodeGraineRows(
    rows: any[],
    deviceKeyB64: string
  ): Promise<StoredGraineSession[]> {
    const out: StoredGraineSession[] = [];
    for (const row of rows) {
      try {
        const payload = await decryptData(
          base64ToUint8(row.cipher_text),
          base64ToUint8(row.iv),
          deviceKeyB64
        );
        out.push(decodeGraineSession(this.graineRowColumns(row), payload));
      } catch {
        console.warn('[GRAINE] failed to decrypt session seed', row.session_id);
      }
    }
    return out.sort(byNewestSession);
  }

  /** Encrypt the seed and upsert the session. See {@link IStorage.saveGraineSession}. */
  async saveGraineSession(session: StoredGraineSession, deviceKeyB64: string): Promise<void> {
    const encrypted = await encryptData(encodeGraineSensitive(session), deviceKeyB64);
    const c = graineClearColumns(session);
    await this.db.execute(
      `INSERT OR REPLACE INTO graine
         (session_id, workspace_id, channel_id, sender_id, first_index, created_at, sent_count, distribution_epoch, iv, cipher_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        c.sessionId,
        c.workspaceId,
        c.channelId,
        c.senderId,
        c.firstIndex,
        c.createdAt,
        c.sentCount ?? null,
        c.distributionEpoch ?? null,
        uint8ToBase64(encrypted.iv),
        uint8ToBase64(encrypted.cipherText),
      ]
    );
  }

  /** Every session known for a channel, newest first. See {@link IStorage.getGraineSessions}. */
  async getGraineSessions(channelId: string, deviceKeyB64: string): Promise<StoredGraineSession[]> {
    const rows: any[] = await this.db.select('SELECT * FROM graine WHERE channel_id = $1', [
      channelId,
    ]);
    return this.decodeGraineRows(rows, deviceKeyB64);
  }

  /** One session by id, or null. See {@link IStorage.getGraineSession}. */
  async getGraineSession(
    sessionId: string,
    deviceKeyB64: string
  ): Promise<StoredGraineSession | null> {
    const rows: any[] = await this.db.select('SELECT * FROM graine WHERE session_id = $1', [
      sessionId,
    ]);
    if (rows.length === 0) return null;
    const decoded = await this.decodeGraineRows(rows, deviceKeyB64);
    return decoded[0] ?? null;
  }

  /** Every session of a community, newest first. See {@link IStorage.getGraineSessionsForWorkspace}. */
  async getGraineSessionsForWorkspace(
    workspaceId: string,
    deviceKeyB64: string
  ): Promise<StoredGraineSession[]> {
    const rows: any[] = await this.db.select('SELECT * FROM graine WHERE workspace_id = $1', [
      workspaceId,
    ]);
    return this.decodeGraineRows(rows, deviceKeyB64);
  }

  /** A community's session rows, decryptable or not. See {@link IStorage.countGraineSessionsForWorkspace}. */
  async countGraineSessionsForWorkspace(workspaceId: string): Promise<number> {
    const rows: { n: number }[] = await this.db.select(
      'SELECT COUNT(*) AS n FROM graine WHERE workspace_id = $1',
      [workspaceId]
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Erase a community's seeds and report how many. See {@link IStorage.deleteGraineSessionsForWorkspace}. */
  async deleteGraineSessionsForWorkspace(workspaceId: string): Promise<number> {
    const rows: any[] = await this.db.select(
      'SELECT session_id FROM graine WHERE workspace_id = $1',
      [workspaceId]
    );
    await this.db.execute('DELETE FROM graine WHERE workspace_id = $1', [workspaceId]);
    return rows.length;
  }

  /** Drop the named sessions and report how many went. See {@link IStorage.deleteGraineSessions}. */
  async deleteGraineSessions(sessionIds: readonly string[]): Promise<number> {
    if (sessionIds.length === 0) return 0;
    const placeholders = sessionIds.map((_, i) => `$${i + 1}`).join(', ');
    const params = [...sessionIds];
    // Counted from what is really there, not from the length of the list: an id naming nothing is
    // an allowed request, and reporting it as a drop would overstate every sweep.
    const rows: { session_id: string }[] = await this.db.select(
      `SELECT session_id FROM graine WHERE session_id IN (${placeholders})`,
      params
    );
    await this.db.execute(`DELETE FROM graine WHERE session_id IN (${placeholders})`, params);
    return rows.length;
  }

  /** Every row, seeds still sealed, for a backup. See {@link IStorage.getAllEncryptedGraineRows}. */
  async getAllEncryptedGraineRows(): Promise<EncryptedGraineRow[]> {
    const rows: any[] = await this.db.select('SELECT * FROM graine');
    return rows.map((row) =>
      toEncryptedGraineRow(this.graineRowColumns(row), {
        iv: base64ToUint8(row.iv),
        cipherText: base64ToUint8(row.cipher_text),
      })
    );
  }

  /** Non-destructive restore of one row. See {@link IStorage.importEncryptedGraineRow}. */
  async importEncryptedGraineRow(row: EncryptedGraineRow): Promise<void> {
    await this.db.execute(
      `INSERT OR IGNORE INTO graine
         (session_id, workspace_id, channel_id, sender_id, first_index, created_at, sent_count, distribution_epoch, iv, cipher_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        row.sessionId,
        row.workspaceId,
        row.channelId,
        row.senderId,
        row.firstIndex,
        row.createdAt,
        row.sentCount ?? null,
        row.distributionEpoch ?? null,
        uint8ToBase64(row.iv),
        uint8ToBase64(row.cipherText),
      ]
    );
  }

  // -- Device key change ---------------------------------------------------

  /** See {@link IStorage.getSealedPayloads}. */
  async getSealedPayloads(store: SealedStore): Promise<SealedPayload[]> {
    const { table, key } = sealedStoreTable(store);
    const rows: any[] = await this.db.select(`SELECT ${key} AS id, iv, cipher_text FROM ${table}`);
    return rows.map((row) => ({
      id: row.id,
      iv: base64ToUint8(row.iv),
      cipherText: base64ToUint8(row.cipher_text),
    }));
  }

  /**
   * See {@link IStorage.swapSealedPayloads}. One statement per batch (`sealedSwapStatement`): each
   * statement is atomic, the whole is not, and that is safe here because every swap is a
   * compare-and-swap - a batch that never ran leaves its rows under the old key, where the next
   * re-seal finds them.
   */
  async swapSealedPayloads(
    store: SealedStore,
    swaps: readonly SealedPayloadSwap[]
  ): Promise<number> {
    if (swaps.length === 0) return 0;
    // A message write must drop the reconciliation's cached state key (see IStorage).
    if (store === 'messages') invalidateAllHistoryStateKeys();
    let swapped = 0;
    for (const batch of chunk(swaps, SEALED_SWAP_ROWS_PER_STATEMENT)) {
      const { sql, params } = sealedSwapStatement(
        store,
        batch.map((s) => ({
          id: s.id,
          expected: uint8ToBase64(s.expected),
          iv: uint8ToBase64(s.iv),
          cipherText: uint8ToBase64(s.cipherText),
        }))
      );
      const result = await this.db.execute(sql, params);
      swapped += result?.rowsAffected ?? 0;
    }
    return swapped;
  }

  // -- Stored feed pages ---------------------------------------------------

  /** Seal and replace one stored feed page. See {@link IStorage.saveFeedPage}. */
  async saveFeedPage(key: string, payload: unknown, deviceKeyB64: string): Promise<void> {
    const encrypted = await encryptData(payload, deviceKeyB64);
    await this.db.execute(
      'INSERT OR REPLACE INTO feed_pages (feed_key, iv, cipher_text) VALUES ($1, $2, $3)',
      [key, uint8ToBase64(encrypted.iv), uint8ToBase64(encrypted.cipherText)]
    );
  }

  /** One stored feed page, opened, or `null`. See {@link IStorage.getFeedPage}. */
  async getFeedPage(key: string, deviceKeyB64: string): Promise<unknown> {
    const rows: any[] = await this.db.select(
      'SELECT iv, cipher_text FROM feed_pages WHERE feed_key = $1',
      [key]
    );
    const row = rows[0];
    if (!row) return null;
    try {
      return await decryptData(base64ToUint8(row.cipher_text), base64ToUint8(row.iv), deviceKeyB64);
    } catch (error) {
      throw new FeedPageUnreadableError(key, { cause: error });
    }
  }

  /** Delete every stored feed page. See {@link IStorage.deleteFeedPages}. */
  async deleteFeedPages(): Promise<number> {
    const rows: Array<{ n: number | string }> = await this.db.select(
      'SELECT COUNT(*) AS n FROM feed_pages'
    );
    await this.db.execute('DELETE FROM feed_pages');
    return Number(rows[0]?.n ?? 0);
  }

  // -- Misc ----------------------------------------------------------------

  /**
   * Delete every row from the messages, conversations, outbox, graine, owed-exit, distribution and
   * feed-page tables, then the outbox blob store (account reset / testing). Rejects with
   * `OutboxBlobClearError` when only the blob store failed - every table is empty by then.
   */
  async clear(): Promise<void> {
    invalidateAllHistoryStateKeys();
    await this.db.execute('DELETE FROM messages');
    await this.db.execute('DELETE FROM conversations');
    await this.db.execute('DELETE FROM outbox');
    await this.db.execute('DELETE FROM graine');
    // See the IndexedDB twin: an account reset takes the owed exits with it, because a drain firing
    // afterwards would act on a decision taken by an account that is no longer here.
    await this.db.execute('DELETE FROM pending_group_exits');
    // The seeds go with the reset, so the classification that routes to them goes too.
    await this.db.execute('DELETE FROM distribution_groups');
    // A copy of the feed is the account's content too; a reset leaves none of it behind.
    await this.db.execute('DELETE FROM feed_pages');
    // LAST, and only once every row above is gone: a separate database that may refuse to open
    // must not be able to skip the deletes of the seeds (see `clearOutboxBlobsLast`).
    await clearOutboxBlobsLast(this.blobs);
  }
}
