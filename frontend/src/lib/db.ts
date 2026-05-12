import { encryptData, decryptData } from './encryption';

/**
 * Returns a stable 16-byte AES salt for the given storage identifier,
 * creating and persisting it on first call.  All messages for a given user
 * are encrypted with the same salt so the PBKDF2 key can be cached in memory
 * across the entire session (see encryption.ts).
 */
function getOrCreateEncryptionSalt(storageId: string): Uint8Array {
  const lsKey = `canari_enc_salt:${storageId}`;
  const stored = localStorage.getItem(lsKey);
  if (stored) {
    try {
      return Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
    } catch {
      // corrupted entry — fall through to regenerate
    }
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  try {
    localStorage.setItem(lsKey, btoa(Array.from(salt, (b) => String.fromCharCode(b)).join('')));
  } catch {
    // localStorage quota exceeded — graceful degradation: per-message random salt (no cache)
  }
  return salt;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lightweight metadata row for a conversation stored in the local DB (no message payload). */
export interface ConversationMeta {
  /** Primary key — equals the MLS groupId UUID (e.g. "g-abc123", "channel_xyz", "dm_uuid"). */
  id: string;
  /** Human-readable name shown in the conversation list. */
  name: string;
  /** True once the MLS Welcome has been processed and the group is ready to send/receive. */
  isReady: boolean;
  /** Unix milliseconds — used for ordering conversations by recency. */
  updatedAt: number;
}

/** A decrypted message as stored in and read from the local database. */
export interface StoredMessage {
  /** Stable message UUID shared across all devices in the group. */
  id: string;
  /** Foreign key matching ConversationMeta.id (= MLS groupId). */
  conversationId: string;
  /** Lowercase user ID of the author. */
  senderId: string;
  /** Serialized MessageEnvelope (JSON string produced by serializeEnvelope). */
  content: string;
  /** Creation time as Unix milliseconds. */
  timestamp: number;
  /** User IDs that have acknowledged reading this message. */
  readBy?: string[];
  reactions?: Array<{ emoji: string; userId: string }>;
  /** Set to true when the message has been deleted (content replaced server-side). */
  isDeleted?: boolean;
  /** Set to true when the message body has been edited by the sender. */
  isEdited?: boolean;
}

/**
 * Raw encrypted message row as persisted on disk (IndexedDB or SQLite).
 * The content field of StoredMessage is never stored in plaintext — only this encrypted form exists on disk.
 */
export interface EncryptedMessageRow {
  /** Same UUID as StoredMessage.id. */
  id: string;
  /** Foreign key matching ConversationMeta.id. */
  conversationId: string;
  /** Creation time as Unix milliseconds (stored in plaintext for pagination / GC). */
  timestamp: number;
  /** 12-byte AES-GCM initialization vector, unique per encrypted blob. */
  iv: Uint8Array;
  /** 16-byte PBKDF2 salt used to derive the AES-256 key from the user's PIN. */
  salt: Uint8Array;
  /** AES-256-GCM ciphertext of the JSON-serialized message payload (includes 16-byte auth tag). */
  cipherText: Uint8Array;
}

/**
 * Storage backend abstraction for Canari's local message store.
 *
 * Two implementations exist: IndexedDbStorage (browser / PWA) and SqliteStorage (Tauri desktop/mobile).
 * Conversation metadata is stored as plaintext; message content is encrypted with the user's PIN before
 * being written to disk (PBKDF2-HMAC-SHA-256 key derivation + AES-256-GCM encryption).
 */
export interface IStorage {
  /** Open the underlying database and run any pending schema migrations. Must be called once before any other method. */
  init(): Promise<void>;

  // Conversations (stored as plaintext metadata)

  /** Upsert a conversation metadata row (create or overwrite). */
  saveConversation(conv: ConversationMeta): Promise<void>;
  /** Return all stored conversation metadata rows, ordered by recency. */
  getConversations(): Promise<ConversationMeta[]>;
  /** Delete the conversation row and cascade-delete all of its messages. */
  deleteConversation(id: string): Promise<void>;

  // Messages (content encrypted with user PIN)

  /** Encrypt and persist a single message to the local store. */
  saveMessage(msg: StoredMessage, pin: string): Promise<void>;
  /** Encrypt and persist a batch of messages in a single atomic write. */
  saveMessages(msgs: StoredMessage[], pin: string): Promise<void>;
  /** Decrypt and return all messages for a conversation, sorted oldest-first. */
  getMessages(conversationId: string, pin: string): Promise<StoredMessage[]>;
  /** Return the most recent `limit` messages, optionally those strictly before `beforeTimestamp`. */
  getMessagesPage(
    conversationId: string,
    pin: string,
    limit: number,
    beforeTimestamp?: number
  ): Promise<StoredMessage[]>;

  // Garbage collection – delete messages older than the given threshold.

  /** Delete messages older than `maxAgeMs` milliseconds and return the count of deleted rows. */
  deleteOldMessages(maxAgeMs: number): Promise<number>;

  // Backup helpers – expose raw encrypted rows so backups don't require
  // re-encryption and can be imported to a new device with the same PIN.

  /** Return all encrypted message rows as-is (no decryption) for use in backup export. */
  getAllEncryptedRows(): Promise<EncryptedMessageRow[]>;

  /**
   * Non-destructive insert: write the conversation metadata only if no row
   * with this id already exists.  Used during import so that a device that
   * has been live since the backup was taken keeps its current state.
   */
  mergeConversation(conv: ConversationMeta): Promise<void>;

  /**
   * Non-destructive insert: write the encrypted message row only if no row
   * with this id already exists.  This ensures messages received after the
   * backup was taken are preserved on the target device.
   */
  importEncryptedRow(row: EncryptedMessageRow): Promise<void>;

  /** Wipe all conversations and messages from the local store (used in tests / account reset). */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// IndexedDB implementation (Web / PWA)
// ---------------------------------------------------------------------------

/**
 * IStorage implementation backed by the browser's IndexedDB API.
 * Used in the web / PWA build; falls back from SqliteStorage when Tauri is not available.
 * Database name is scoped per user: `CanariDB_<userId>`.
 */
export class IndexedDbStorage implements IStorage {
  private readonly dbName: string;
  private db: IDBDatabase | null = null;

  /** Create a storage instance for the given user. Call init() before using. */
  constructor(userId: string) {
    this.dbName = `CanariDB_${userId}`;
  }

  /** Open (or upgrade) the IndexedDB database and apply schema migrations up to version 4. */
  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Version 3: conversation.id is now the MLS groupId UUID (was human-readable contactName).
      // Migration: the conversations store is recreated (same keyPath 'id') and all existing
      // rows are migrated by setting id = groupId (old rows had a separate groupId field).
      const request = indexedDB.open(this.dbName, 4);

      request.onerror = () => reject('IndexedDB open error');
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const oldVersion = event.oldVersion;
        const tx = (event.target as IDBOpenDBRequest).transaction!;

        if (oldVersion < 2) {
          // Drop legacy v1 messages store (no conversation support)
          if (db.objectStoreNames.contains('messages')) {
            db.deleteObjectStore('messages');
          }

          if (!db.objectStoreNames.contains('conversations')) {
            db.createObjectStore('conversations', { keyPath: 'id' });
          }

          const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
          msgStore.createIndex('byConversation', 'conversationId', { unique: false });
        }

        if (oldVersion < 4) {
          // Encryption format changed from Argon2+ChaCha20 (WASM) to PBKDF2+AES-GCM
          // (SubtleCrypto). Old ciphertext is unreadable — drop all message rows.
          // Conversations are kept; messages will be re-fetched from the server.
          if (db.objectStoreNames.contains('messages')) {
            db.deleteObjectStore('messages');
          }
          const freshMsgStore = db.createObjectStore('messages', { keyPath: 'id' });
          freshMsgStore.createIndex('byConversation', 'conversationId', { unique: false });
        }

        if (oldVersion < 3 && oldVersion >= 2) {
          // Migrate v2→v3: set conversation.id = conversation.groupId for all existing rows,
          // and update messages.conversationId accordingly.
          const convStore = tx.objectStore('conversations');
          const msgStore = tx.objectStore('messages');

          const oldToNew = new Map<string, string>();

          const cursorReq = convStore.openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
              const old = cursor.value as ConversationMeta & { groupId?: string };
              const newId = old.groupId ?? old.id;
              if (newId !== old.id) {
                oldToNew.set(old.id, newId);
                // Insert with new key; delete old
                const { groupId: _drop, ...rest } = old as any;
                convStore.add({ ...rest, id: newId });
                cursor.delete();
              } else {
                // Same key — just strip groupId field if present
                if ('groupId' in old) {
                  const { groupId: _drop, ...rest } = old as any;
                  cursor.update(rest);
                }
              }
              cursor.continue();
            } else {
              // After conversations are migrated, update messages.conversationId
              if (oldToNew.size > 0) {
                const msgCursorReq = msgStore.openCursor();
                msgCursorReq.onsuccess = () => {
                  const c = msgCursorReq.result;
                  if (c) {
                    const row = c.value;
                    const mapped = oldToNew.get(row.conversationId);
                    if (mapped) {
                      c.update({ ...row, conversationId: mapped });
                    }
                    c.continue();
                  }
                };
              }
            }
          };
        }
      };
    });
  }

  /** Throw if init() has not been called yet; otherwise return the open database handle. */
  private ensureDb(): IDBDatabase {
    if (!this.db) throw new Error('DB not initialized – call init() first');
    return this.db;
  }

  // -- Conversations -------------------------------------------------------

  /** Upsert a conversation metadata row (uses IndexedDB put, which overwrites existing keys). */
  async saveConversation(conv: ConversationMeta): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('conversations', 'readwrite');
      tx.objectStore('conversations').put(conv);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Return all stored conversation metadata rows (unordered — callers should sort). */
  async getConversations(): Promise<ConversationMeta[]> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('conversations', 'readonly');
      const req = tx.objectStore('conversations').getAll();
      req.onsuccess = () => resolve(req.result as ConversationMeta[]);
      req.onerror = () => reject(req.error);
    });
  }

  /** Delete the conversation row and cascade-delete all associated messages via the byConversation index. */
  async deleteConversation(id: string): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['conversations', 'messages'], 'readwrite');
      tx.objectStore('conversations').delete(id);
      // Cascade-delete messages linked to this conversation
      const index = tx.objectStore('messages').index('byConversation');
      const cursorReq = index.openCursor(IDBKeyRange.only(id));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // -- Messages ------------------------------------------------------------

  /** Encrypt and persist a single message; delegates to saveMessages. */
  async saveMessage(msg: StoredMessage, pin: string): Promise<void> {
    return this.saveMessages([msg], pin);
  }

  /**
   * Encrypt and persist a batch of messages in a single IndexedDB transaction.
   * Each message's senderId, content, reactions, and flags are JSON-serialized and
   * encrypted with AES-256-GCM before being written; the stable per-user salt is
   * reused so the PBKDF2 key is derived only once for the whole batch.
   */
  async saveMessages(msgs: StoredMessage[], pin: string): Promise<void> {
    const db = this.ensureDb();
    const stableSalt = getOrCreateEncryptionSalt(this.dbName);
    const encryptedMessages = await Promise.all(
      msgs.map(async (msg) => {
        const payload: Record<string, unknown> = {
          senderId: msg.senderId.trim().toLowerCase(),
          content: msg.content,
        };
        if (msg.readBy && msg.readBy.length > 0) payload.readBy = msg.readBy;
        if (msg.reactions && msg.reactions.length > 0) payload.reactions = msg.reactions;
        if (msg.isDeleted) payload.isDeleted = true;
        if (msg.isEdited) payload.isEdited = true;
        const encrypted = await encryptData(payload, pin, stableSalt);
        return {
          id: msg.id,
          conversationId: msg.conversationId,
          timestamp: msg.timestamp,
          ...encrypted,
        };
      })
    );

    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      const store = tx.objectStore('messages');

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject('saveMessages error: ' + tx.error);

      for (const row of encryptedMessages) {
        store.put(row);
      }
    });
  }

  /** Decrypt and return all messages for `conversationId`, sorted oldest-first. Rows that fail decryption (wrong PIN or corruption) are silently skipped. */
  async getMessages(conversationId: string, pin: string): Promise<StoredMessage[]> {
    const db = this.ensureDb();
    const rows: any[] = await new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readonly');
      const req = tx
        .objectStore('messages')
        .index('byConversation')
        .getAll(IDBKeyRange.only(conversationId));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const results: StoredMessage[] = [];
    for (const row of rows) {
      try {
        const payload = await decryptData(row.cipherText, row.iv, row.salt, pin);
        results.push({
          id: row.id,
          conversationId: row.conversationId,
          timestamp: row.timestamp,
          senderId: payload.senderId,
          content: payload.content,
          readBy: Array.isArray(payload.readBy) ? payload.readBy : undefined,
          reactions: Array.isArray(payload.reactions) ? payload.reactions : undefined,
          isDeleted: payload.isDeleted === true ? true : undefined,
          isEdited: payload.isEdited === true ? true : undefined,
        });
      } catch {
        console.warn('Failed to decrypt message', row.id);
      }
    }
    return results.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Decrypt and return a paginated slice of messages for `conversationId`.
   * Rows are sorted descending by timestamp, the most recent `limit` rows are taken,
   * then re-sorted ascending before being returned so callers always get chronological order.
   * Pass `beforeTimestamp` (Unix ms) to implement "load older messages" infinite scroll.
   */
  async getMessagesPage(
    conversationId: string,
    pin: string,
    limit: number,
    beforeTimestamp?: number
  ): Promise<StoredMessage[]> {
    const db = this.ensureDb();
    const allRows: any[] = await new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readonly');
      const req = tx
        .objectStore('messages')
        .index('byConversation')
        .getAll(IDBKeyRange.only(conversationId));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    // Sort descending by timestamp to easily pick the most recent slice
    allRows.sort((a, b) => b.timestamp - a.timestamp);

    // If beforeTimestamp is given, skip all rows at or after that timestamp
    const filtered =
      beforeTimestamp !== undefined
        ? allRows.filter((r) => r.timestamp < beforeTimestamp)
        : allRows;

    const page = filtered.slice(0, limit);

    const results: StoredMessage[] = [];
    for (const row of page) {
      try {
        const payload = await decryptData(row.cipherText, row.iv, row.salt, pin);
        results.push({
          id: row.id,
          conversationId: row.conversationId,
          timestamp: row.timestamp,
          senderId: payload.senderId,
          content: payload.content,
          readBy: Array.isArray(payload.readBy) ? payload.readBy : undefined,
          reactions: Array.isArray(payload.reactions) ? payload.reactions : undefined,
          isDeleted: payload.isDeleted === true ? true : undefined,
          isEdited: payload.isEdited === true ? true : undefined,
        });
      } catch {
        console.warn('Failed to decrypt message', row.id);
      }
    }
    return results.sort((a, b) => a.timestamp - b.timestamp);
  }

  // -- Backup helpers ------------------------------------------------------

  /** Return all raw encrypted message rows for backup export (no decryption performed). */
  async getAllEncryptedRows(): Promise<EncryptedMessageRow[]> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readonly');
      const req = tx.objectStore('messages').getAll();
      req.onsuccess = () => resolve(req.result as EncryptedMessageRow[]);
      req.onerror = () => reject(req.error);
    });
  }

  async mergeConversation(conv: ConversationMeta): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('conversations', 'readwrite');
      // `add` throws ConstraintError when the key already exists; `put` would overwrite.
      const req = tx.objectStore('conversations').add(conv);
      req.onsuccess = () => resolve();
      req.onerror = (e) => {
        const err = (e.target as IDBRequest).error;
        if (err?.name === 'ConstraintError') {
          e.preventDefault(); // prevent transaction abort
          resolve(); // row already exists – keep local version
        } else {
          reject(err);
        }
      };
    });
  }

  async importEncryptedRow(row: EncryptedMessageRow): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      // `add` skips on duplicate; `put` would overwrite newer local messages.
      const req = tx.objectStore('messages').add(row);
      req.onsuccess = () => resolve();
      req.onerror = (e) => {
        const err = (e.target as IDBRequest).error;
        if (err?.name === 'ConstraintError') {
          e.preventDefault();
          resolve(); // already exists – non-destructive skip
        } else {
          reject(err);
        }
      };
    });
  }

  // -- Garbage Collection --------------------------------------------------

  /** Scan all messages and delete any whose timestamp is older than `maxAgeMs` milliseconds; returns the number of deleted rows. */
  async deleteOldMessages(maxAgeMs: number): Promise<number> {
    const db = this.ensureDb();
    const cutoff = Date.now() - maxAgeMs;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      const store = tx.objectStore('messages');
      const req = store.openCursor();
      let deleted = 0;
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          if (cursor.value.timestamp < cutoff) {
            cursor.delete();
            deleted++;
          }
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => reject(tx.error);
    });
  }

  // -- Misc ----------------------------------------------------------------

  /** Erase all rows from both the conversations and messages stores in a single transaction. */
  async clear(): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['conversations', 'messages'], 'readwrite');
      tx.objectStore('conversations').clear();
      tx.objectStore('messages').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
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
    await this.db.execute('DELETE FROM messages WHERE conversation_id = $1', [id]);
    await this.db.execute('DELETE FROM conversations WHERE id = $1', [id]);
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
          timestamp: row.timestamp,
          senderId: payload.senderId,
          content: payload.content,
          readBy: Array.isArray(payload.readBy) ? payload.readBy : undefined,
          reactions: Array.isArray(payload.reactions) ? payload.reactions : undefined,
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
          timestamp: row.timestamp,
          senderId: payload.senderId,
          content: payload.content,
          readBy: Array.isArray(payload.readBy) ? payload.readBy : undefined,
          reactions: Array.isArray(payload.reactions) ? payload.reactions : undefined,
          isDeleted: payload.isDeleted === true ? true : undefined,
          isEdited: payload.isEdited === true ? true : undefined,
        });
      } catch {
        console.warn('Failed to decrypt SQLite row', row.id);
      }
    }
    return results.sort((a, b) => a.timestamp - b.timestamp);
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

  async mergeConversation(conv: ConversationMeta): Promise<void> {
    // INSERT OR IGNORE: only insert if no row with this id already exists.
    await this.db.execute(
      'INSERT OR IGNORE INTO conversations (id, name, is_ready, updated_at) VALUES ($1, $2, $3, $4)',
      [conv.id, conv.name, conv.isReady ? 1 : 0, conv.updatedAt]
    );
  }

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

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
