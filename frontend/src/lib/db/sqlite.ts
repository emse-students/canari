import { encryptData, decryptData } from '../encryption';
import { readStoredTimestampMs } from '$lib/utils/dates';
import { normalizeConversationLifecycle } from '$lib/utils/chat/groupLifecycle';
import { parseHistoryFloor } from '$lib/utils/chat/historyWindow';
import {
  invalidateAllHistoryStateKeys,
  invalidateHistoryStateKey,
} from '$lib/utils/chat/historyStateKey';
import { parseReadWatermarks } from '$lib/utils/chat/readState';
import type {
  ConversationMeta,
  EncryptedMessageRow,
  IStorage,
  OutboxEntry,
  StoredMessage,
  StoredMessagePatch,
} from './types';
import {
  decodeOutboxEntry,
  encodeOutboxSensitive,
  mergeOutboxEntry,
  outboxClearColumns,
} from './outboxCodec';
import { SCHEMA_VERSION, isFreshDatabase, legacyBlobPurgeStatement } from './sqliteMigrations';
import { fromMessagePayload, mergeStoredMessage, toMessagePayload } from './messagePayload';
import { MESSAGE_ROWS_PER_STATEMENT, chunk, messageInsertSql } from './sqliteBatch';

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
function uint8ToBase64(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary);
}

/** Decode a base64 string (or legacy number array) back to a Uint8Array; returns an empty array on failure. */
function base64ToUint8(val: unknown): Uint8Array {
  if (val == null) return new Uint8Array(0);
  // New format: base64-encoded string
  if (typeof val === 'string') {
    try {
      return Uint8Array.from(atob(val), (c) => c.charCodeAt(0));
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
 * Database file path: `<app-data-dir>/canari_<userId>.db`.
 */
export class SqliteStorage implements IStorage {
  private db: any = null;
  private readonly dbPath: string;

  /** Create a storage instance for the given user. Call init() before using. */
  constructor(userId: string) {
    this.dbPath = `sqlite:canari_${userId}.db`;
  }

  /** Open (or create) the SQLite database, enable WAL mode, create tables, and run migrations up to {@link SCHEMA_VERSION}. */
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
                history_floor    INTEGER
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
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            )
        `);

    await this.db.execute(
      'CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id)'
    );

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
                created_at      INTEGER,
                iv              TEXT,
                cipher_text     TEXT
            )
        `);
    await this.db.execute('CREATE INDEX IF NOT EXISTS idx_outbox_conv ON outbox(conversation_id)');

    // A database created by the statements above has no history to migrate. Stamp it at the
    // current version and skip every branch below: they are written against schemas this file
    // never had, and running them is how "no such column: salt" broke every fresh install.
    if (fresh) {
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
      await this.db.execute(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  // -- Conversations -------------------------------------------------------

  /** Upsert a conversation metadata row (INSERT OR REPLACE). */
  async saveConversation(conv: ConversationMeta): Promise<void> {
    await this.db.execute(
      'INSERT OR REPLACE INTO conversations (id, name, lifecycle, updated_at, read_watermarks, history_floor) VALUES ($1, $2, $3, $4, $5, $6)',
      [
        conv.id,
        conv.name,
        conv.lifecycle,
        conv.updatedAt,
        conv.readWatermarks ? JSON.stringify(conv.readWatermarks) : null,
        conv.historyFloor ?? null,
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
      historyFloor: parseHistoryFloor(r.history_floor),
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
    const rows: any[] = await this.db.select('SELECT * FROM messages WHERE id = $1', [id]);
    if (rows.length === 0) return;
    const row = rows[0];
    let msg: StoredMessage;
    try {
      const payload = (await decryptData(
        base64ToUint8(row.cipher_text),
        base64ToUint8(row.iv),
        deviceKeyB64
      )) as Record<string, unknown>;
      msg = fromMessagePayload(
        {
          id: row.id,
          conversationId: row.conversation_id,
          timestamp: rowTimestampMs(row.timestamp),
        },
        payload
      );
    } catch {
      // A row we cannot read is a row we must not overwrite: replacing it with the patch alone
      // would turn an undecryptable message into a truncated one.
      console.warn('Failed to decrypt SQLite row for update', id);
      return;
    }
    await this.saveMessage(mergeStoredMessage(msg, patch), deviceKeyB64);
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
    return results;
  }

  /**
   * Decrypt and return a paginated slice of messages using a server-side LIMIT clause.
   * Rows are fetched in descending timestamp order (most recent first) then re-sorted
   * ascending before return so callers always receive chronological order.
   * Pass `beforeTimestamp` (Unix ms) to implement "load older messages" infinite scroll.
   */
  async getMessagesPage(
    conversationId: string,
    deviceKeyB64: string,
    limit: number,
    beforeTimestamp?: number
  ): Promise<StoredMessage[]> {
    let rows: any[];
    if (beforeTimestamp !== undefined) {
      rows = await this.db.select(
        'SELECT * FROM messages WHERE conversation_id = $1 AND timestamp < $2 ORDER BY timestamp DESC LIMIT $3',
        [conversationId, beforeTimestamp, limit]
      );
    } else {
      rows = await this.db.select(
        'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY timestamp DESC LIMIT $2',
        [conversationId, limit]
      );
    }

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
    return results.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  }

  // -- Backup helpers ------------------------------------------------------

  /** Return all raw encrypted rows for backup export, decoding base64 columns back to Uint8Array. */
  async getAllEncryptedRows(): Promise<EncryptedMessageRow[]> {
    const rows: any[] = await this.db.select('SELECT * FROM messages');
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      timestamp: row.timestamp,
      iv: base64ToUint8(row.iv),
      cipherText: base64ToUint8(row.cipher_text),
    }));
  }

  /** Non-destructive insert: write the conversation only if no row with this id already exists. */
  async mergeConversation(conv: ConversationMeta): Promise<void> {
    // INSERT OR IGNORE: only insert if no row with this id already exists.
    await this.db.execute(
      'INSERT OR IGNORE INTO conversations (id, name, lifecycle, updated_at, read_watermarks, history_floor) VALUES ($1, $2, $3, $4, $5, $6)',
      [
        conv.id,
        conv.name,
        conv.lifecycle,
        conv.updatedAt,
        conv.readWatermarks ? JSON.stringify(conv.readWatermarks) : null,
        conv.historyFloor ?? null,
      ]
    );
  }

  /** Non-destructive insert: write the encrypted row only if no row with this id already exists. */
  async importEncryptedRow(row: EncryptedMessageRow): Promise<void> {
    invalidateHistoryStateKey(row.conversationId);
    // INSERT OR IGNORE: skip rows that already exist on this device so that
    // messages received after the backup was taken are never overwritten.
    await this.db.execute(
      'INSERT OR IGNORE INTO messages (id, conversation_id, timestamp, iv, cipher_text) VALUES ($1, $2, $3, $4, $5)',
      [
        row.id,
        row.conversationId,
        row.timestamp,
        uint8ToBase64(row.iv),
        uint8ToBase64(row.cipherText),
      ]
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
      return decodeOutboxEntry(
        {
          id: row.id,
          conversationId: row.conversation_id,
          sentAt: rowTimestampMs(row.sent_at),
          kind: row.kind,
          status: row.status,
          attempts: typeof row.attempts === 'number' ? row.attempts : 0,
          lastAttemptAt: row.last_attempt_at ?? undefined,
          nextAttemptAt: row.next_attempt_at ?? undefined,
          createdAt: rowTimestampMs(row.created_at),
        },
        payload
      );
    } catch {
      console.warn('Failed to decrypt outbox row', row.id);
      return null;
    }
  }

  /** Encrypt the sensitive payload and upsert a queued outbound message. */
  async saveOutboxEntry(entry: OutboxEntry, deviceKeyB64: string): Promise<void> {
    const encrypted = await encryptData(encodeOutboxSensitive(entry), deviceKeyB64);
    const c = outboxClearColumns(entry);
    await this.db.execute(
      `INSERT OR REPLACE INTO outbox
         (id, conversation_id, sent_at, kind, status, attempts, last_attempt_at, next_attempt_at, created_at, iv, cipher_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        c.id,
        c.conversationId,
        c.sentAt,
        c.kind,
        c.status,
        c.attempts,
        c.lastAttemptAt ?? null,
        c.nextAttemptAt ?? null,
        c.createdAt,
        uint8ToBase64(encrypted.iv),
        uint8ToBase64(encrypted.cipherText),
      ]
    );
  }

  /** Decrypt and return all queued entries, sorted by `sentAt` ascending. */
  async getOutboxEntries(deviceKeyB64: string): Promise<OutboxEntry[]> {
    const rows: any[] = await this.db.select('SELECT * FROM outbox ORDER BY sent_at ASC');
    const out: OutboxEntry[] = [];
    for (const row of rows) {
      const entry = await this.decodeOutboxRow(row, deviceKeyB64);
      if (entry) out.push(entry);
    }
    return out;
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

  /** Read-modify-write: merge `patch` into the stored entry and re-encrypt. No-op if absent. */
  async updateOutboxEntry(
    id: string,
    patch: Partial<OutboxEntry>,
    deviceKeyB64: string
  ): Promise<void> {
    const rows: any[] = await this.db.select('SELECT * FROM outbox WHERE id = $1', [id]);
    if (rows.length === 0) return;
    const entry = await this.decodeOutboxRow(rows[0], deviceKeyB64);
    if (!entry) return;
    await this.saveOutboxEntry(mergeOutboxEntry(entry, patch), deviceKeyB64);
  }

  /** Remove a queued entry (after a confirmed send or a permanent failure). */
  async deleteOutboxEntry(id: string): Promise<void> {
    await this.db.execute('DELETE FROM outbox WHERE id = $1', [id]);
  }

  // -- Misc ----------------------------------------------------------------

  /** Delete all rows from the messages, conversations, and outbox tables (account reset / testing). */
  async clear(): Promise<void> {
    invalidateAllHistoryStateKeys();
    await this.db.execute('DELETE FROM messages');
    await this.db.execute('DELETE FROM conversations');
    await this.db.execute('DELETE FROM outbox');
  }
}
