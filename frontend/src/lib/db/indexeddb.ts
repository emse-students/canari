import { encryptData, decryptData } from '../encryption';
import { normalizeConversationLifecycle } from '$lib/utils/chat/groupLifecycle';
import { parseHistoryFloor } from '$lib/utils/chat/historyWindow';
import {
  invalidateAllHistoryStateKeys,
  invalidateHistoryStateKey,
} from '$lib/utils/chat/historyStateKey';
import { parseReadWatermarks } from '$lib/utils/chat/readState';
import type {
  ConversationMeta,
  EncryptedGraineRow,
  EncryptedMessageRow,
  IStorage,
  OutboxEntry,
  StoredGraineSession,
  StoredMessage,
  StoredMessagePatch,
} from './types';
import {
  decodeOutboxEntry,
  encodeOutboxSensitive,
  mergeOutboxEntry,
  outboxClearColumns,
} from './outboxCodec';
import {
  byNewestSession,
  decodeGraineSession,
  encodeGraineSensitive,
  graineClearColumns,
  toEncryptedGraineRow,
  type GraineClearColumns,
} from './graineCodec';
import { fromMessagePayload, mergeStoredMessage, toMessagePayload } from './messagePayload';

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

  /** Open (or upgrade) the IndexedDB database and apply schema migrations up to version 6. */
  /**
   * Closes the connection so the database can be DELETED deterministically.
   *
   * `indexedDB.deleteDatabase` does not fail while a connection is open - it fires `onblocked` and
   * completes at some later moment nobody controls. See {@link IStorage.close}.
   */
  async close(): Promise<void> {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Version 3: conversation.id is now the MLS groupId UUID (was human-readable contactName).
      // Migration: the conversations store is recreated (same keyPath 'id') and all existing
      // rows are migrated by setting id = groupId (old rows had a separate groupId field).
      // Version 5: adds the `outbox` store (queued outbound messages).
      // Version 6: PBKDF2+salt → deviceKeyB64 (direct AES-256-GCM). Drops all encrypted
      //            messages/outbox rows — they will be re-fetched from the server.
      // Version 7: adds the `graine` store (community-channel session seeds).
      const request = indexedDB.open(this.dbName, 7);

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

        if (oldVersion < 6) {
          // v5→v6: PBKDF2+salt replaced by direct deviceKeyB64 AES-256-GCM.
          // All encrypted rows (messages, outbox) are dropped — messages will be
          // re-fetched from the server and re-encrypted with the device key.
          // Conversations (plaintext metadata) are preserved.
          if (db.objectStoreNames.contains('messages')) {
            db.deleteObjectStore('messages');
          }
          if (db.objectStoreNames.contains('outbox')) {
            db.deleteObjectStore('outbox');
          }
          const freshMsgStore = db.createObjectStore('messages', { keyPath: 'id' });
          freshMsgStore.createIndex('byConversation', 'conversationId', { unique: false });
          const freshOutboxStore = db.createObjectStore('outbox', { keyPath: 'id' });
          freshOutboxStore.createIndex('byConversation', 'conversationId', { unique: false });
          freshOutboxStore.createIndex('bySentAt', 'sentAt', { unique: false });
        }

        if (oldVersion < 7) {
          // Graine session seeds. Purely additive: nothing existing is dropped, because the seeds
          // this store will hold are the first key material the server cannot re-serve, and a
          // migration that cleared them would be throwing away history no peer may still have.
          if (!db.objectStoreNames.contains('graine')) {
            const graineStore = db.createObjectStore('graine', { keyPath: 'sessionId' });
            graineStore.createIndex('byChannel', 'channelId', { unique: false });
            graineStore.createIndex('byWorkspace', 'workspaceId', { unique: false });
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

  /**
   * One row as callers see it. Shared by the list read and the single-row read so the two cannot
   * drift - a field parsed in one and passed through raw in the other is the exact shape that made
   * `readWatermarks` correct until the first restart.
   *
   * Normalizes legacy rows (the `isReady` field, from before `lifecycle` was introduced), and
   * validates on the way OUT like every other store: a structured-clone round trip preserves
   * whatever was written, including a value an older build got wrong.
   */
  private rowToMeta(r: ConversationMeta & { isReady?: boolean }): ConversationMeta {
    return {
      ...r,
      lifecycle: normalizeConversationLifecycle(r.lifecycle, r.isReady),
      readWatermarks: parseReadWatermarks(r.readWatermarks),
      historyFloor: parseHistoryFloor(r.historyFloor),
    };
  }

  /** Return all stored conversation metadata rows (unordered - callers should sort). */
  async getConversations(): Promise<ConversationMeta[]> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('conversations', 'readonly');
      const req = tx.objectStore('conversations').getAll();
      req.onsuccess = () => {
        const rows = (req.result as Array<ConversationMeta & { isReady?: boolean }>).map((r) =>
          this.rowToMeta(r)
        );
        resolve(rows);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * One conversation's metadata row, or `null` when there is none.
   *
   * Exists because every caller that wanted a single conversation was reading the whole store and
   * filtering it in JS - which inside a per-group loop makes the work grow with the square of the
   * number of conversations, for a question the key path answers directly.
   */
  async getConversation(id: string): Promise<ConversationMeta | null> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('conversations', 'readonly');
      const req = tx.objectStore('conversations').get(id);
      req.onsuccess = () => {
        const row = req.result as (ConversationMeta & { isReady?: boolean }) | undefined;
        resolve(row ? this.rowToMeta(row) : null);
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

  /** Remove one message row by primary key; absent rows resolve without error, as IDB's delete does. */
  async deleteMessage(id: string, conversationId: string): Promise<void> {
    const db = this.ensureDb();
    invalidateHistoryStateKey(conversationId);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      tx.objectStore('messages').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private deleteMessagesInTransaction(tx: IDBTransaction, conversationId: string): void {
    invalidateHistoryStateKey(conversationId);
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
  async saveMessage(msg: StoredMessage, deviceKeyB64: string): Promise<void> {
    return this.saveMessages([msg], deviceKeyB64);
  }

  /**
   * Encrypt and persist a batch of messages in a single IndexedDB transaction.
   * Each message's senderId, content, reactions, and flags are JSON-serialized and
   * encrypted with AES-256-GCM (deviceKeyB64 imported directly as a CryptoKey — no
   * PBKDF2 derivation or per-message salt needed).
   */
  async saveMessages(msgs: StoredMessage[], deviceKeyB64: string): Promise<void> {
    // Every write through this class passes here - `saveMessage` and `updateMessage` both delegate
    // to it - so this is where the reconciliation's cached state key is dropped.
    for (const msg of msgs) invalidateHistoryStateKey(msg.conversationId);
    const db = this.ensureDb();
    const encryptedMessages = await Promise.all(
      msgs.map(async (msg) => {
        const encrypted = await encryptData(toMessagePayload(msg), deviceKeyB64);
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

  /**
   * Merge `patch` into the stored message (read-modify-write; re-encrypts the payload).
   * No-op if the row is absent or undecryptable.
   *
   * Keyed lookup, so the cost is the same in a conversation of ten messages and one of ten
   * thousand - which is what makes this usable on every mutation.
   */
  async updateMessage(id: string, patch: StoredMessagePatch, deviceKeyB64: string): Promise<void> {
    const db = this.ensureDb();
    const existing: any = await new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readonly');
      const req = tx.objectStore('messages').get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!existing) return;
    let msg: StoredMessage;
    try {
      const payload = (await decryptData(existing.cipherText, existing.iv, deviceKeyB64)) as Record<
        string,
        unknown
      >;
      msg = fromMessagePayload(
        { id: existing.id, conversationId: existing.conversationId, timestamp: existing.timestamp },
        payload
      );
    } catch {
      // A row we cannot read is a row we must not overwrite: replacing it with the patch alone
      // would turn an undecryptable message into a truncated one.
      console.warn('Failed to decrypt message for update', id);
      return;
    }
    await this.saveMessage(mergeStoredMessage(msg, patch), deviceKeyB64);
  }

  /** Decrypt and return all messages for `conversationId`, sorted oldest-first. Rows that fail decryption (wrong key or corruption) are silently skipped. */
  async getMessages(conversationId: string, deviceKeyB64: string): Promise<StoredMessage[]> {
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
        const payload = (await decryptData(row.cipherText, row.iv, deviceKeyB64)) as Record<
          string,
          unknown
        >;
        results.push(
          fromMessagePayload(
            { id: row.id, conversationId: row.conversationId, timestamp: row.timestamp },
            payload
          )
        );
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
    deviceKeyB64: string,
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
        const payload = (await decryptData(row.cipherText, row.iv, deviceKeyB64)) as Record<
          string,
          unknown
        >;
        results.push(
          fromMessagePayload(
            { id: row.id, conversationId: row.conversationId, timestamp: row.timestamp },
            payload
          )
        );
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
    invalidateHistoryStateKey(row.conversationId);
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
    // Age-based, so it cannot name the conversations it touched: everything goes.
    invalidateAllHistoryStateKeys();
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
  private async decodeOutboxRows(rows: any[], deviceKeyB64: string): Promise<OutboxEntry[]> {
    const out: OutboxEntry[] = [];
    for (const row of rows) {
      try {
        const payload = await decryptData(row.cipherText, row.iv, deviceKeyB64);
        out.push(decodeOutboxEntry(row, payload));
      } catch {
        console.warn('Failed to decrypt outbox entry', row.id);
      }
    }
    return out.sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id));
  }

  /** Encrypt the sensitive payload and upsert a queued outbound message. */
  async saveOutboxEntry(entry: OutboxEntry, deviceKeyB64: string): Promise<void> {
    const db = this.ensureDb();
    const encrypted = await encryptData(encodeOutboxSensitive(entry), deviceKeyB64);
    const row = { ...outboxClearColumns(entry), ...encrypted };
    return new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Decrypt and return all queued entries, sorted by `sentAt` ascending. */
  async getOutboxEntries(deviceKeyB64: string): Promise<OutboxEntry[]> {
    const db = this.ensureDb();
    const rows: any[] = await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readonly');
      const req = tx.objectStore('outbox').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.decodeOutboxRows(rows, deviceKeyB64);
  }

  /** Decrypt and return queued entries targeting `conversationId`, sorted by `sentAt`. */
  async getOutboxEntriesForConversation(
    conversationId: string,
    deviceKeyB64: string
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
    return this.decodeOutboxRows(rows, deviceKeyB64);
  }

  /** Read-modify-write: merge `patch` into the stored entry and re-encrypt. No-op if absent. */
  async updateOutboxEntry(
    id: string,
    patch: Partial<OutboxEntry>,
    deviceKeyB64: string
  ): Promise<void> {
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
      const payload = await decryptData(existing.cipherText, existing.iv, deviceKeyB64);
      entry = decodeOutboxEntry(existing, payload);
    } catch {
      return;
    }
    await this.saveOutboxEntry(mergeOutboxEntry(entry, patch), deviceKeyB64);
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

  // -- Graine sessions -----------------------------------------------------

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
        const payload = await decryptData(row.cipherText, row.iv, deviceKeyB64);
        out.push(decodeGraineSession(row as GraineClearColumns, payload));
      } catch {
        console.warn('[GRAINE] failed to decrypt session seed', row.sessionId);
      }
    }
    return out.sort(byNewestSession);
  }

  async saveGraineSession(session: StoredGraineSession, deviceKeyB64: string): Promise<void> {
    const db = this.ensureDb();
    const encrypted = await encryptData(encodeGraineSensitive(session), deviceKeyB64);
    const row = { ...graineClearColumns(session), ...encrypted };
    return new Promise((resolve, reject) => {
      const tx = db.transaction('graine', 'readwrite');
      tx.objectStore('graine').put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getGraineSessions(channelId: string, deviceKeyB64: string): Promise<StoredGraineSession[]> {
    const db = this.ensureDb();
    const rows: any[] = await new Promise((resolve, reject) => {
      const tx = db.transaction('graine', 'readonly');
      const req = tx.objectStore('graine').index('byChannel').getAll(channelId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.decodeGraineRows(rows, deviceKeyB64);
  }

  async getGraineSession(
    sessionId: string,
    deviceKeyB64: string
  ): Promise<StoredGraineSession | null> {
    const db = this.ensureDb();
    const row: any = await new Promise((resolve, reject) => {
      const tx = db.transaction('graine', 'readonly');
      const req = tx.objectStore('graine').get(sessionId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!row) return null;
    const decoded = await this.decodeGraineRows([row], deviceKeyB64);
    return decoded[0] ?? null;
  }

  async getGraineSessionsForWorkspace(
    workspaceId: string,
    deviceKeyB64: string
  ): Promise<StoredGraineSession[]> {
    const db = this.ensureDb();
    const rows: any[] = await new Promise((resolve, reject) => {
      const tx = db.transaction('graine', 'readonly');
      const req = tx.objectStore('graine').index('byWorkspace').getAll(workspaceId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.decodeGraineRows(rows, deviceKeyB64);
  }

  async deleteGraineSessionsForWorkspace(workspaceId: string): Promise<number> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      let deleted = 0;
      const tx = db.transaction('graine', 'readwrite');
      const store = tx.objectStore('graine');
      const req = store.index('byWorkspace').openCursor(IDBKeyRange.only(workspaceId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        cursor.delete();
        deleted++;
        cursor.continue();
      };
      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteGraineSessions(sessionIds: readonly string[]): Promise<number> {
    if (sessionIds.length === 0) return 0;
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      let deleted = 0;
      const tx = db.transaction('graine', 'readwrite');
      const store = tx.objectStore('graine');
      for (const sessionId of sessionIds) {
        // Read before delete only to COUNT: `delete` succeeds on an absent key, so without this
        // the caller would be told it dropped seeds it never held.
        const existing = store.get(sessionId);
        existing.onsuccess = () => {
          if (!existing.result) return;
          store.delete(sessionId);
          deleted++;
        };
      }
      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAllEncryptedGraineRows(): Promise<EncryptedGraineRow[]> {
    const db = this.ensureDb();
    const rows: any[] = await new Promise((resolve, reject) => {
      const tx = db.transaction('graine', 'readonly');
      const req = tx.objectStore('graine').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return rows.map((row) =>
      toEncryptedGraineRow(row as GraineClearColumns, { iv: row.iv, cipherText: row.cipherText })
    );
  }

  async importEncryptedGraineRow(row: EncryptedGraineRow): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('graine', 'readwrite');
      const store = tx.objectStore('graine');
      const existing = store.get(row.sessionId);
      existing.onsuccess = () => {
        // Non-destructive: a device live since the backup was taken keeps what it has learned.
        if (!existing.result) store.put(row);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // -- Misc ----------------------------------------------------------------

  /** Erase every store in a single transaction. */
  async clear(): Promise<void> {
    invalidateAllHistoryStateKeys();
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['conversations', 'messages', 'outbox', 'graine'], 'readwrite');
      tx.objectStore('conversations').clear();
      tx.objectStore('messages').clear();
      tx.objectStore('outbox').clear();
      tx.objectStore('graine').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
