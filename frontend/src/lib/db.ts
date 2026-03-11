import { encryptData, decryptData } from './encryption';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationMeta {
  id: string; // contactName – primary key
  groupId: string;
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
      // Version 2: adds conversations store + conversationId index on messages.
      const request = indexedDB.open(this.dbName, 2);

      request.onerror = () => reject('IndexedDB open error');
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const oldVersion = event.oldVersion;

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
        const encrypted = await encryptData(
          { senderId: msg.senderId.trim().toLowerCase(), content: msg.content },
          pin
        );
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

export class SqliteStorage implements IStorage {
  private db: any = null;
  private readonly dbPath: string;

  constructor(userId: string) {
    this.dbPath = `sqlite:canari_${userId}.db`;
  }

  async init(): Promise<void> {
    const Database = (await import('@tauri-apps/plugin-sql')).default;
    this.db = await Database.load(this.dbPath);

    await this.db.execute(`
            CREATE TABLE IF NOT EXISTS conversations (
                id         TEXT    PRIMARY KEY,
                group_id   TEXT    NOT NULL,
                name       TEXT    NOT NULL,
                is_ready   INTEGER DEFAULT 0,
                updated_at INTEGER DEFAULT 0
            )
        `);

    await this.db.execute(`
            CREATE TABLE IF NOT EXISTS messages (
                id              TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                timestamp       INTEGER,
                iv              BLOB,
                salt            BLOB,
                cipher_text     BLOB,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            )
        `);

    await this.db.execute(
      'CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id)'
    );
  }

  // -- Conversations -------------------------------------------------------

  async saveConversation(conv: ConversationMeta): Promise<void> {
    await this.db.execute(
      'INSERT OR REPLACE INTO conversations (id, group_id, name, is_ready, updated_at) VALUES ($1, $2, $3, $4, $5)',
      [conv.id, conv.groupId, conv.name, conv.isReady ? 1 : 0, conv.updatedAt]
    );
  }

  async getConversations(): Promise<ConversationMeta[]> {
    const rows: any[] = await this.db.select(
      'SELECT * FROM conversations ORDER BY updated_at DESC'
    );
    return rows.map((r) => ({
      id: r.id,
      groupId: r.group_id,
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
        const encrypted = await encryptData(
          { senderId: msg.senderId.trim().toLowerCase(), content: msg.content },
          pin
        );
        return { msg, encrypted };
      })
    );

    // Tauri SQL plugin doesn't support bulk insert nicely, so we loop but parallelize encryption
    for (const item of encryptedMessages) {
      await this.db.execute(
        'INSERT OR REPLACE INTO messages (id, conversation_id, timestamp, iv, salt, cipher_text) VALUES ($1, $2, $3, $4, $5, $6)',
        [
          item.msg.id,
          item.msg.conversationId,
          item.msg.timestamp,
          Array.from(item.encrypted.iv),
          Array.from(item.encrypted.salt),
          Array.from(item.encrypted.cipherText),
        ]
      );
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
        const iv = new Uint8Array(row.iv);
        const salt = new Uint8Array(row.salt);
        const cipherText = new Uint8Array(row.cipher_text);
        const payload = await decryptData(cipherText, iv, salt, pin);
        results.push({
          id: row.id,
          conversationId: row.conversation_id,
          timestamp: row.timestamp,
          senderId: payload.senderId,
          content: payload.content,
        });
      } catch {
        console.warn('Failed to decrypt SQLite row', row.id);
      }
    }
    return results;
  }

  // -- Backup helpers ------------------------------------------------------

  async getAllEncryptedRows(): Promise<EncryptedMessageRow[]> {
    const rows: any[] = await this.db.select('SELECT * FROM messages');
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      timestamp: row.timestamp,
      iv: new Uint8Array(row.iv),
      salt: new Uint8Array(row.salt),
      cipherText: new Uint8Array(row.cipher_text),
    }));
  }

  async mergeConversation(conv: ConversationMeta): Promise<void> {
    // INSERT OR IGNORE: only insert if no row with this id already exists.
    await this.db.execute(
      'INSERT OR IGNORE INTO conversations (id, group_id, name, is_ready, updated_at) VALUES ($1, $2, $3, $4, $5)',
      [conv.id, conv.groupId, conv.name, conv.isReady ? 1 : 0, conv.updatedAt]
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
        Array.from(row.iv),
        Array.from(row.salt),
        Array.from(row.cipherText),
      ]
    );
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
