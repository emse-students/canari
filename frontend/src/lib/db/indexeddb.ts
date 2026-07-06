import { encryptData, decryptData } from '../encryption';
import { normalizeConversationLifecycle } from '$lib/utils/chat/groupLifecycle';
import { getOrCreateEncryptionSalt } from './salt';
import type {
  ConversationMeta,
  EncryptedMessageRow,
  IStorage,
  OutboxEntry,
  StoredMessage,
} from './types';
import {
  decodeOutboxEntry,
  encodeOutboxSensitive,
  mergeOutboxEntry,
  outboxClearColumns,
} from './outboxCodec';

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

  /** Open (or upgrade) the IndexedDB database and apply schema migrations up to version 5. */
  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Version 3: conversation.id is now the MLS groupId UUID (was human-readable contactName).
      // Migration: the conversations store is recreated (same keyPath 'id') and all existing
      // rows are migrated by setting id = groupId (old rows had a separate groupId field).
      // Version 5: adds the `outbox` store (queued outbound messages).
      const request = indexedDB.open(this.dbName, 5);

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
          // (SubtleCrypto). Old ciphertext is unreadable - drop all message rows.
          // Conversations are kept; messages will be re-fetched from the server.
          if (db.objectStoreNames.contains('messages')) {
            db.deleteObjectStore('messages');
          }
          const freshMsgStore = db.createObjectStore('messages', { keyPath: 'id' });
          freshMsgStore.createIndex('byConversation', 'conversationId', { unique: false });
        }

        if (oldVersion < 5) {
          // Queued outbound messages (sensitive payload encrypted with the user PIN).
          if (!db.objectStoreNames.contains('outbox')) {
            const outboxStore = db.createObjectStore('outbox', { keyPath: 'id' });
            outboxStore.createIndex('byConversation', 'conversationId', { unique: false });
            outboxStore.createIndex('bySentAt', 'sentAt', { unique: false });
          }
        }

        if (oldVersion < 3 && oldVersion >= 2) {
          // Migrate v2→v3: set conversation.id = conversation.groupId for all existing rows,
          // and update messages.conversationId accordingly.
          const convStore = tx.objectStore('conversations');
          const msgStore = tx.objectStore('messages');

          const oldToNew = new Map<string, string>();

          const cursorReq = convStore.openCursor();
          cursorReq.onerror = () => {
            console.error('[IDB] Migration v2→v3: conversation cursor error', cursorReq.error);
            tx.abort();
          };
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
                // Same key - just strip groupId field if present
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
                msgCursorReq.onerror = () => {
                  console.error('[IDB] Migration v2→v3: message cursor error', msgCursorReq.error);
                  tx.abort();
                };
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
    if (!this.db) throw new Error('DB not initialized - call init() first');
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

  /** Return all stored conversation metadata rows (unordered - callers should sort). */
  async getConversations(): Promise<ConversationMeta[]> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('conversations', 'readonly');
      const req = tx.objectStore('conversations').getAll();
      req.onsuccess = () => {
        // Normalise les anciennes lignes (champ `isReady` avant l'introduction de `lifecycle`).
        const rows = (req.result as Array<ConversationMeta & { isReady?: boolean }>).map((r) => ({
          ...r,
          lifecycle: normalizeConversationLifecycle(r.lifecycle, r.isReady),
        }));
        resolve(rows);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /** Delete the conversation row and cascade-delete all associated messages via the byConversation index. */
  async deleteConversation(id: string): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['conversations', 'messages'], 'readwrite');
      tx.objectStore('conversations').delete(id);
      this.deleteMessagesInTransaction(tx, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Delete all messages for a conversation; metadata row is kept. */
  async deleteMessagesForConversation(conversationId: string): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      this.deleteMessagesInTransaction(tx, conversationId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private deleteMessagesInTransaction(tx: IDBTransaction, conversationId: string): void {
    const index = tx.objectStore('messages').index('byConversation');
    const cursorReq = index.openCursor(IDBKeyRange.only(conversationId));
    cursorReq.onerror = () => {
      // Log but allow the transaction's own onerror to propagate the failure.
      console.error('[IDB] deleteMessagesInTransaction cursor error', cursorReq.error);
    };
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
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
        if (msg.readAt) payload.readAt = msg.readAt;
        if (msg.serverTimestamp) payload.serverTimestamp = msg.serverTimestamp;
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
        console.warn('Failed to decrypt message', row.id);
      }
    }
    return results.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
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

  /** Non-destructive insert: write the conversation only if no row with this id already exists. */
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
          resolve(); // row already exists - keep local version
        } else {
          reject(err);
        }
      };
    });
  }

  /** Non-destructive insert: write the encrypted row only if no row with this id already exists. */
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
          resolve(); // already exists - non-destructive skip
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

  // -- Outbox --------------------------------------------------------------

  /** Decrypt a batch of outbox rows, skipping any that fail, sorted by `sentAt` (compose order). */
  private async decodeOutboxRows(rows: any[], pin: string): Promise<OutboxEntry[]> {
    const out: OutboxEntry[] = [];
    for (const row of rows) {
      try {
        const payload = await decryptData(row.cipherText, row.iv, row.salt, pin);
        out.push(decodeOutboxEntry(row, payload));
      } catch {
        console.warn('Failed to decrypt outbox entry', row.id);
      }
    }
    return out.sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id));
  }

  /** Encrypt the sensitive payload and upsert a queued outbound message. */
  async saveOutboxEntry(entry: OutboxEntry, pin: string): Promise<void> {
    const db = this.ensureDb();
    const stableSalt = getOrCreateEncryptionSalt(this.dbName);
    const encrypted = await encryptData(encodeOutboxSensitive(entry), pin, stableSalt);
    const row = { ...outboxClearColumns(entry), ...encrypted };
    return new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Decrypt and return all queued entries, sorted by `sentAt` ascending. */
  async getOutboxEntries(pin: string): Promise<OutboxEntry[]> {
    const db = this.ensureDb();
    const rows: any[] = await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readonly');
      const req = tx.objectStore('outbox').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.decodeOutboxRows(rows, pin);
  }

  /** Decrypt and return queued entries targeting `conversationId`, sorted by `sentAt`. */
  async getOutboxEntriesForConversation(
    conversationId: string,
    pin: string
  ): Promise<OutboxEntry[]> {
    const db = this.ensureDb();
    const rows: any[] = await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readonly');
      const req = tx
        .objectStore('outbox')
        .index('byConversation')
        .getAll(IDBKeyRange.only(conversationId));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.decodeOutboxRows(rows, pin);
  }

  /** Read-modify-write: merge `patch` into the stored entry and re-encrypt. No-op if absent. */
  async updateOutboxEntry(id: string, patch: Partial<OutboxEntry>, pin: string): Promise<void> {
    const db = this.ensureDb();
    const existing: any = await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readonly');
      const req = tx.objectStore('outbox').get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!existing) return;
    let entry: OutboxEntry;
    try {
      const payload = await decryptData(existing.cipherText, existing.iv, existing.salt, pin);
      entry = decodeOutboxEntry(existing, payload);
    } catch {
      return;
    }
    await this.saveOutboxEntry(mergeOutboxEntry(entry, patch), pin);
  }

  /** Remove a queued entry (after a confirmed send or a permanent failure). */
  async deleteOutboxEntry(id: string): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // -- Misc ----------------------------------------------------------------

  /** Erase all rows from the conversations, messages, and outbox stores in a single transaction. */
  async clear(): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['conversations', 'messages', 'outbox'], 'readwrite');
      tx.objectStore('conversations').clear();
      tx.objectStore('messages').clear();
      tx.objectStore('outbox').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
