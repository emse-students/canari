import { encryptData, decryptData } from '../encryption';
import { readStoredTimestampMs } from '$lib/utils/dates';
import { getOrCreateEncryptionSalt } from './salt';
import type { ConversationMeta, EncryptedMessageRow, IStorage, StoredMessage } from './types';

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

  /** Open (or create) the SQLite database, enable WAL mode, create tables, and run migrations up to version 3. */
  async init(): Promise<void> {
    const Database = (await import('@tauri-apps/plugin-sql')).default;
    this.db = await Database.load(this.dbPath);

    // WAL mode : lectures concurrentes non bloquantes, critique sur mobile
    await this.db.execute('PRAGMA journal_mode=WAL');

    // Schéma v1 : création initiale
    await this.db.execute(`
            CREATE TABLE IF NOT EXISTS conversations (
                id         TEXT    PRIMARY KEY,
                name       TEXT    NOT NULL,
                is_ready   INTEGER DEFAULT 0,
                updated_at INTEGER DEFAULT 0
            )
        `);

    // Colonnes TEXT (base64) pour iv/salt/cipher_text.
    // L'ancien schéma utilisait BLOB, ce qui amenait le plugin Tauri SQL à
    // sérialiser les Uint8Array en JSON text "[1,2,3]" → données illisibles au redémarrage.
    await this.db.execute(`
            CREATE TABLE IF NOT EXISTS messages (
                id              TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                timestamp       INTEGER,
                iv              TEXT,
                salt            TEXT,
                cipher_text     TEXT,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            )
        `);

    await this.db.execute(
      'CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id)'
    );

    // Migration v1→v2 : colonnes BLOB → TEXT (base64).
    // Détecte les lignes dont iv/salt/cipher_text ne sont pas des chaînes base64 valides
    // (stockées avec l'ancien format JSON "[1,2,3]") et les supprime car elles ne peuvent
    // pas être déchiffrées sans la clé privée du device source.
    const versionRows: any[] = await this.db.select('PRAGMA user_version');
    const currentVersion: number = versionRows[0]?.user_version ?? 0;

    if (currentVersion < 2) {
      await this.db.execute(`
        DELETE FROM messages
        WHERE typeof(iv) != 'text'
           OR iv LIKE '[%'
           OR salt LIKE '[%'
           OR cipher_text LIKE '[%'
      `);
      await this.db.execute('PRAGMA user_version = 2');
    }

    if (currentVersion < 3) {
      // Encryption format changed from Argon2+ChaCha20 (WASM) to PBKDF2+AES-GCM.
      // Old rows cannot be decrypted — drop them. Messages re-fetch from server.
      await this.db.execute('DELETE FROM messages');
      await this.db.execute('PRAGMA user_version = 3');
    }
  }

  // -- Conversations -------------------------------------------------------

  /** Upsert a conversation metadata row (INSERT OR REPLACE). */
  async saveConversation(conv: ConversationMeta): Promise<void> {
    await this.db.execute(
      'INSERT OR REPLACE INTO conversations (id, name, is_ready, updated_at) VALUES ($1, $2, $3, $4)',
      [conv.id, conv.name, conv.isReady ? 1 : 0, conv.updatedAt]
    );
  }

  /** Return all stored conversation metadata rows ordered most-recently-updated first. */
  async getConversations(): Promise<ConversationMeta[]> {
    const rows: any[] = await this.db.select(
      'SELECT * FROM conversations ORDER BY updated_at DESC'
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      isReady: r.is_ready === 1,
      updatedAt: r.updated_at,
    }));
  }

  /** Delete the conversation row and all of its messages (messages first to respect the foreign key). */
  async deleteConversation(id: string): Promise<void> {
    await this.deleteMessagesForConversation(id);
    await this.db.execute('DELETE FROM conversations WHERE id = $1', [id]);
  }

  /** Delete all messages for a conversation without removing its metadata row. */
  async deleteMessagesForConversation(conversationId: string): Promise<void> {
    await this.db.execute('DELETE FROM messages WHERE conversation_id = $1', [conversationId]);
  }

  // -- Messages ------------------------------------------------------------

  /** Encrypt and persist a single message; delegates to saveMessages. */
  async saveMessage(msg: StoredMessage, pin: string): Promise<void> {
    return this.saveMessages([msg], pin);
  }

  /**
   * Encrypt and persist a batch of messages wrapped in a single SQLite transaction.
   * Binary iv/salt/cipherText are stored as base64 TEXT to avoid a Tauri SQL plugin
   * serialisation bug where BLOB bindings are read back as JSON arrays on restart.
   */
  async saveMessages(msgs: StoredMessage[], pin: string): Promise<void> {
    const stableSalt = getOrCreateEncryptionSalt(this.dbPath);
    const encryptedMessages = await Promise.all(
      msgs.map(async (msg) => {
        const payload: Record<string, unknown> = {
          senderId: msg.senderId.trim().toLowerCase(),
          content: msg.content,
        };
        if (msg.readBy && msg.readBy.length > 0) payload.readBy = msg.readBy;
        if (msg.reactions && msg.reactions.length > 0) payload.reactions = msg.reactions;
        if (msg.readAt) payload.readAt = msg.readAt;
        if (msg.serverTimestamp) payload.serverTimestamp = msg.serverTimestamp;
        if (msg.isDeleted) payload.isDeleted = true;
        if (msg.isEdited) payload.isEdited = true;
        const encrypted = await encryptData(payload, pin, stableSalt);
        return { msg, encrypted };
      })
    );

    // Enveloppe tous les inserts dans une transaction pour l'atomicité et la performance.
    // Binary data stockée en base64 TEXT : passer number[] causerait le plugin à sérialiser
    // en JSON "[1,2,3]" (non-BLOB), illisible après redémarrage.
    await this.db.execute('BEGIN');
    try {
      for (const item of encryptedMessages) {
        await this.db.execute(
          'INSERT OR REPLACE INTO messages (id, conversation_id, timestamp, iv, salt, cipher_text) VALUES ($1, $2, $3, $4, $5, $6)',
          [
            item.msg.id,
            item.msg.conversationId,
            item.msg.timestamp,
            uint8ToBase64(item.encrypted.iv),
            uint8ToBase64(item.encrypted.salt),
            uint8ToBase64(item.encrypted.cipherText),
          ]
        );
      }
      await this.db.execute('COMMIT');
    } catch (e) {
      await this.db.execute('ROLLBACK');
      throw e;
    }
  }

  /** Decrypt and return all messages for `conversationId` sorted oldest-first; silently skips rows that fail decryption. */
  async getMessages(conversationId: string, pin: string): Promise<StoredMessage[]> {
    const rows: any[] = await this.db.select(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY timestamp ASC',
      [conversationId]
    );
    const results: StoredMessage[] = [];
    for (const row of rows) {
      try {
        const iv = base64ToUint8(row.iv);
        const salt = base64ToUint8(row.salt);
        const cipherText = base64ToUint8(row.cipher_text);
        const payload = await decryptData(cipherText, iv, salt, pin);
        results.push({
          id: row.id,
          conversationId: row.conversation_id,
          timestamp: rowTimestampMs(row.timestamp),
          senderId: payload.senderId,
          content: payload.content,
          readBy: Array.isArray(payload.readBy) ? payload.readBy : undefined,
          reactions: Array.isArray(payload.reactions) ? payload.reactions : undefined,
          readAt:
            typeof payload.readAt === 'number' && payload.readAt > 0 ? payload.readAt : undefined,
          serverTimestamp:
            typeof payload.serverTimestamp === 'number' && payload.serverTimestamp > 0
              ? payload.serverTimestamp
              : undefined,
          isDeleted: payload.isDeleted === true ? true : undefined,
          isEdited: payload.isEdited === true ? true : undefined,
        });
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
    pin: string,
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
        const salt = base64ToUint8(row.salt);
        const cipherText = base64ToUint8(row.cipher_text);
        const payload = await decryptData(cipherText, iv, salt, pin);
        results.push({
          id: row.id,
          conversationId: row.conversation_id,
          timestamp: rowTimestampMs(row.timestamp),
          senderId: payload.senderId,
          content: payload.content,
          readBy: Array.isArray(payload.readBy) ? payload.readBy : undefined,
          reactions: Array.isArray(payload.reactions) ? payload.reactions : undefined,
          readAt:
            typeof payload.readAt === 'number' && payload.readAt > 0 ? payload.readAt : undefined,
          serverTimestamp:
            typeof payload.serverTimestamp === 'number' && payload.serverTimestamp > 0
              ? payload.serverTimestamp
              : undefined,
          isDeleted: payload.isDeleted === true ? true : undefined,
          isEdited: payload.isEdited === true ? true : undefined,
        });
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
      salt: base64ToUint8(row.salt),
      cipherText: base64ToUint8(row.cipher_text),
    }));
  }

  /** Non-destructive insert: write the conversation only if no row with this id already exists. */
  async mergeConversation(conv: ConversationMeta): Promise<void> {
    // INSERT OR IGNORE: only insert if no row with this id already exists.
    await this.db.execute(
      'INSERT OR IGNORE INTO conversations (id, name, is_ready, updated_at) VALUES ($1, $2, $3, $4)',
      [conv.id, conv.name, conv.isReady ? 1 : 0, conv.updatedAt]
    );
  }

  /** Non-destructive insert: write the encrypted row only if no row with this id already exists. */
  async importEncryptedRow(row: EncryptedMessageRow): Promise<void> {
    // INSERT OR IGNORE: skip rows that already exist on this device so that
    // messages received after the backup was taken are never overwritten.
    await this.db.execute(
      'INSERT OR IGNORE INTO messages (id, conversation_id, timestamp, iv, salt, cipher_text) VALUES ($1, $2, $3, $4, $5, $6)',
      [
        row.id,
        row.conversationId,
        row.timestamp,
        uint8ToBase64(row.iv),
        uint8ToBase64(row.salt),
        uint8ToBase64(row.cipherText),
      ]
    );
  }

  // -- Garbage Collection --------------------------------------------------

  /** Delete messages older than `maxAgeMs` milliseconds using a single DELETE statement; returns the number of affected rows. */
  async deleteOldMessages(maxAgeMs: number): Promise<number> {
    const result = await this.db.execute('DELETE FROM messages WHERE timestamp < $1', [
      Date.now() - maxAgeMs,
    ]);
    return result?.rowsAffected ?? 0;
  }

  // -- Misc ----------------------------------------------------------------

  /** Delete all rows from both tables (used for account reset or testing). */
  async clear(): Promise<void> {
    await this.db.execute('DELETE FROM messages');
    await this.db.execute('DELETE FROM conversations');
  }
}
