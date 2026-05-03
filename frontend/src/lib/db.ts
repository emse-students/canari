import { encryptData, decryptData } from './encryption';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationMeta {
  /** Primary key — equals the MLS groupId UUID (e.g. "g-abc123", "channel_xyz", "dm_uuid"). */
  id: string;
  name: string;
  isReady: boolean;
  updatedAt: number;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  timestamp: number;
  readBy?: string[];
  reactions?: Array<{ emoji: string; userId: string }>;
  isDeleted?: boolean;
  isEdited?: boolean;
}

export interface EncryptedMessageRow {
  id: string;
  conversationId: string;
  timestamp: number;
  iv: Uint8Array;
  salt: Uint8Array;
  cipherText: Uint8Array;
}

export interface IStorage {
  init(): Promise<void>;

  // Conversations (stored as plaintext metadata)
  saveConversation(conv: ConversationMeta): Promise<void>;
  getConversations(): Promise<ConversationMeta[]>;
  deleteConversation(id: string): Promise<void>;

  // Messages (content encrypted with user PIN)
  saveMessage(msg: StoredMessage, pin: string): Promise<void>;
  saveMessages(msgs: StoredMessage[], pin: string): Promise<void>;
  getMessages(conversationId: string, pin: string): Promise<StoredMessage[]>;
  /** Return the most recent `limit` messages, optionally those strictly before `beforeTimestamp`. */
  getMessagesPage(
    conversationId: string,
    pin: string,
    limit: number,
    beforeTimestamp?: number
  ): Promise<StoredMessage[]>;

  // Garbage collection – delete messages older than the given threshold.
  deleteOldMessages(maxAgeMs: number): Promise<number>;

  // Backup helpers – expose raw encrypted rows so backups don't require
  // re-encryption and can be imported to a new device with the same PIN.
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

  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// IndexedDB implementation (Web / PWA)
// ---------------------------------------------------------------------------

export class IndexedDbStorage implements IStorage {
  private readonly dbName: string;
  private db: IDBDatabase | null = null;

  constructor(userId: string) {
    this.dbName = `CanariDB_${userId}`;
  }

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

  private ensureDb(): IDBDatabase {
    if (!this.db) throw new Error('DB not initialized – call init() first');
    return this.db;
  }

  // -- Conversations -------------------------------------------------------

  async saveConversation(conv: ConversationMeta): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('conversations', 'readwrite');
      tx.objectStore('conversations').put(conv);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getConversations(): Promise<ConversationMeta[]> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('conversations', 'readonly');
      const req = tx.objectStore('conversations').getAll();
      req.onsuccess = () => resolve(req.result as ConversationMeta[]);
      req.onerror = () => reject(req.error);
    });
  }

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

  async saveMessage(msg: StoredMessage, pin: string): Promise<void> {
    return this.saveMessages([msg], pin);
  }

  async saveMessages(msgs: StoredMessage[], pin: string): Promise<void> {
    const db = this.ensureDb();
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
        const encrypted = await encryptData(payload, pin);
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

function uint8ToBase64(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary);
}

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

export class SqliteStorage implements IStorage {
  private db: any = null;
  private readonly dbPath: string;

  constructor(userId: string) {
    this.dbPath = `sqlite:canari_${userId}.db`;
  }

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

  async saveConversation(conv: ConversationMeta): Promise<void> {
    await this.db.execute(
      'INSERT OR REPLACE INTO conversations (id, name, is_ready, updated_at) VALUES ($1, $2, $3, $4)',
      [conv.id, conv.name, conv.isReady ? 1 : 0, conv.updatedAt]
    );
  }

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

  async deleteConversation(id: string): Promise<void> {
    await this.db.execute('DELETE FROM messages WHERE conversation_id = $1', [id]);
    await this.db.execute('DELETE FROM conversations WHERE id = $1', [id]);
  }

  // -- Messages ------------------------------------------------------------

  async saveMessage(msg: StoredMessage, pin: string): Promise<void> {
    return this.saveMessages([msg], pin);
  }

  async saveMessages(msgs: StoredMessage[], pin: string): Promise<void> {
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
        const encrypted = await encryptData(payload, pin);
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

  async deleteOldMessages(maxAgeMs: number): Promise<number> {
    const result = await this.db.execute('DELETE FROM messages WHERE timestamp < $1', [
      Date.now() - maxAgeMs,
    ]);
    return result?.rowsAffected ?? 0;
  }

  // -- Misc ----------------------------------------------------------------

  async clear(): Promise<void> {
    await this.db.execute('DELETE FROM messages');
    await this.db.execute('DELETE FROM conversations');
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

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
