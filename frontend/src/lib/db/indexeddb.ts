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
  idbCommitted,
  OutboxBlobStore,
  outboxBlobReleased,
  writeOutboxWithBlob,
} from './outboxBlob';
import {
  decodeOutboxEntry,
  encodeOutboxSensitive,
  isOutboxClearPatch,
  mergeOutboxEntry,
  OutboxPayloadUnreadableError,
  outboxClearColumns,
  OUTBOX_CLEAR_PATCH_KEYS,
} from './outboxCodec';
import {
  byNewestSession,
  decodeGraineSession,
  encodeGraineSensitive,
  graineClearColumns,
  toEncryptedGraineRow,
  type GraineClearColumns,
} from './graineCodec';
import {
  compareStoredOrder,
  fromMessagePayload,
  mergeStoredMessage,
  storedOrderAt,
  toMessagePayload,
} from './messagePayload';
import { readStoredTimestampMs } from '$lib/utils/dates';
import {
  deriveOrderKeysInChunks,
  OrderKeyDerivations,
  type OrderKeyDerivation,
} from './orderKeyDerivation';

// ---------------------------------------------------------------------------
// IndexedDB implementation (Web / PWA)
// ---------------------------------------------------------------------------

/** The schema version `init` opens; every branch of its upgrade handler is written against it. */
const IDB_SCHEMA_VERSION = 12;

/**
 * The messages index pages were read from until v12: `[conversationId, timestamp]`, so one
 * conversation's rows are CONTIGUOUS and in `sentAt` order. `byConversation` orders a
 * conversation's rows by id, which is why a page used to read every row of the conversation and
 * sort them to keep fifty. Kept because the v11 step repairs string timestamps by walking it.
 */
const MESSAGES_BY_CONVERSATION_TIME = 'byConversationTime';

/**
 * The messages index a page is read from since v12: `[conversationId, orderAt, id]`, the key the
 * timeline sorts on (`storedOrderAt` - the server's receive time when the row knows it) with ties
 * broken by id, the pair a page boundary is drawn on. Every row has an `orderAt`: a row stored before
 * v12 or imported from a backup carries its `timestamp` there PROVISIONALLY, flagged
 * `orderPending` ({@link MESSAGES_BY_CONVERSATION_PENDING}, `$lib/db/orderKeyDerivation`).
 */
const MESSAGES_BY_CONVERSATION_ORDER = 'byConversationOrder';

/**
 * The provisional rows, `[conversationId, orderPending, id]`: only a row carrying `orderPending` has
 * an entry, so the index empties as the derivation keys the rows, and a save (which writes the row
 * without the flag) leaves it.
 */
const MESSAGES_BY_CONVERSATION_PENDING = 'byConversationPending';

/** The value of `orderPending` on a provisional row; the property is absent on every other row. */
const ORDER_PENDING = 1;

/**
 * One conversation's rows in {@link MESSAGES_BY_CONVERSATION_ORDER}. Bounded by numbers on both ends
 * because an IndexedDB key orders every number before every string: an unbounded range would hand a
 * row whose key was stored as a string to the reverse cursor FIRST, as the newest message. The v11
 * upgrade rewrote those timestamps ({@link normalizeStoredTimestamps}), every key is written from a
 * number since, and `importEncryptedRow` refuses a row it cannot read a number from.
 */
function conversationOrderRange(conversationId: string): IDBKeyRange {
  return IDBKeyRange.bound([conversationId, -Infinity], [conversationId, Infinity]);
}

/** One conversation's rows strictly below `before` on the pair `(orderAt, id)`. */
function conversationOrderBelow(conversationId: string, before: PageKey): IDBKeyRange {
  return IDBKeyRange.bound(
    [conversationId, -Infinity],
    [conversationId, before.orderAt, before.id],
    false,
    true
  );
}

/** One conversation's rows at or above `from` on the pair `(orderAt, id)`. */
function conversationOrderFrom(conversationId: string, from: PageKey): IDBKeyRange {
  return IDBKeyRange.bound([conversationId, from.orderAt, from.id], [conversationId, Infinity]);
}

/**
 * One conversation's provisional rows in {@link MESSAGES_BY_CONVERSATION_PENDING}, strictly after
 * the id `after` when given. The upper bound `[]` sorts above every string id.
 */
function conversationPendingRange(conversationId: string, after?: string): IDBKeyRange {
  return after === undefined
    ? IDBKeyRange.bound([conversationId, ORDER_PENDING], [conversationId, ORDER_PENDING, []])
    : IDBKeyRange.bound(
        [conversationId, ORDER_PENDING, after],
        [conversationId, ORDER_PENDING, []],
        true,
        false
      );
}

/**
 * Rewrites every stored timestamp that is not a number into one, inside the v11 upgrade.
 *
 * WHY THEY EXIST. `SqliteStorage.getAllEncryptedRows` handed its `timestamp` column to the backup
 * as the plugin returned it, and on Android an INTEGER column can come back as a STRING
 * (`readStoredTimestampMs`). A backup taken on a phone and restored in a browser therefore wrote
 * string timestamps here. The old page read sorted with `b.timestamp - a.timestamp`, which coerces,
 * so nothing showed; an index orders a string after every number, so the new read would not.
 *
 * Cheap on purpose: it walks the NEW index and jumps from each conversation's first numeric key
 * straight past its numbers (`continue([conversationId, ''])` - the lowest string key), so it reads
 * one entry per conversation plus the rows it repairs, never every row. A row whose timestamp
 * cannot be read as a time at all is left as it is and counted, and so is a row with no timestamp,
 * which no compound index can hold: neither can be placed in a conversation's order, and the
 * warning is the only trace a later reader would have that a page leaves them out.
 */
function normalizeStoredTimestamps(tx: IDBTransaction, then: () => void): void {
  const store = tx.objectStore('messages');
  let repaired = 0;
  let unreadable = 0;
  const cursorReq = store.index(MESSAGES_BY_CONVERSATION_TIME).openCursor();
  cursorReq.onerror = () => {
    console.error('[IDB] Migration v10->v11: timestamp cursor error', cursorReq.error);
    tx.abort();
  };
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) {
      reportUnplacedRows(store, repaired, unreadable);
      then();
      return;
    }
    const [conversationId, raw] = cursor.key as [string, unknown];
    if (typeof raw === 'number') {
      cursor.continue([conversationId, '']);
      return;
    }
    const ms = readStoredTimestampMs(raw);
    if (ms === undefined) {
      unreadable++;
    } else {
      cursor.update({ ...cursor.value, timestamp: ms });
      repaired++;
    }
    cursor.continue();
  };
}

/**
 * Keys every stored row that has no `orderAt` PROVISIONALLY, inside the v12 upgrade: its
 * `timestamp` as the key and the {@link ORDER_PENDING} flag, so every row is in the page index from
 * the first read on and the derivation finds it (`$lib/db/orderKeyDerivation`). Nothing is decrypted
 * - the device key is not known here. Runs AFTER the v11 repair when both are owed (`then`): two
 * cursors updating the same rows in one transaction would each write back the value it read, and the
 * later write would drop the other's change. A row whose timestamp cannot be read is left unkeyed
 * and counted: no index can place it, as the v11 step already reported.
 */
function keyStoredRowsProvisionally(tx: IDBTransaction): void {
  const store = tx.objectStore('messages');
  let keyed = 0;
  let unplaced = 0;
  const cursorReq = store.openCursor();
  cursorReq.onerror = () => {
    console.error('[IDB] Migration v11->v12: provisional key cursor error', cursorReq.error);
    tx.abort();
  };
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) {
      if (keyed > 0) {
        console.info(
          `[IDB] Migration v11->v12: ${keyed} message row(s) keyed provisionally on their sentAt - derived behind the page reads`
        );
      }
      if (unplaced > 0) {
        console.error(
          `[IDB] Migration v11->v12: ${unplaced} message row(s) with no readable timestamp left unkeyed - no page will show them`
        );
      }
      return;
    }
    const row = cursor.value;
    if (typeof row.orderAt !== 'number') {
      const timestamp = readStoredTimestampMs(row.timestamp);
      if (timestamp === undefined) {
        unplaced++;
      } else {
        cursor.update({ ...row, timestamp, orderAt: timestamp, orderPending: ORDER_PENDING });
        keyed++;
      }
    }
    cursor.continue();
  };
}

/**
 * The end of {@link normalizeStoredTimestamps}: says what it repaired, and counts the rows the new
 * index cannot hold (no timestamp) against the ones `byConversation` holds - two index counts,
 * nothing decrypted. Silent when there is nothing to say, which is every database written by a
 * browser alone.
 */
function reportUnplacedRows(store: IDBObjectStore, repaired: number, unreadable: number): void {
  const all = store.index('byConversation').count();
  all.onsuccess = () => {
    const indexed = store.index(MESSAGES_BY_CONVERSATION_TIME).count();
    indexed.onsuccess = () => {
      const missing = all.result - indexed.result;
      if (repaired > 0) {
        console.warn(
          `[IDB] Migration v10->v11: ${repaired} message row(s) carried a string timestamp (a backup restored from a phone) - rewritten as numbers`
        );
      }
      if (unreadable > 0 || missing > 0) {
        console.error(
          `[IDB] Migration v10->v11: ${unreadable} message row(s) with an unreadable timestamp and ${missing} with none - no page will show them`
        );
      }
    };
  };
}

/**
 * The local store could not be opened, with the browser's own reason attached.
 *
 * A TYPE rather than a string, and the string it replaced said `'IndexedDB open error'` and threw
 * `request.error` away - so the one caller who might have wanted to know WHY (a quota that is full,
 * a store the browser refuses in a private window, a corrupt database) got a sentence it could only
 * have branched on by reading it. `cause` carries the DOMException; `blocked` separates the one
 * failure that is not an error at all.
 */
export class StorageOpenError extends Error {
  constructor(
    readonly dbName: string,
    readonly blocked: boolean,
    options?: { cause?: unknown }
  ) {
    super(
      blocked
        ? `IndexedDB open blocked for ${dbName} - another tab holds an older version open`
        : `IndexedDB open failed for ${dbName}`,
      options
    );
    this.name = 'StorageOpenError';
  }
}

/**
 * IStorage implementation backed by the browser's IndexedDB API.
 * Used in the web / PWA build; falls back from SqliteStorage when Tauri is not available.
 * Database name is scoped per user: `CanariDB_<userId>`.
 */
/**
 * Every `IndexedDbStorage` that currently holds an open connection.
 *
 * WHY A REGISTRY AND NOT A PARAMETER. `getStorage()` is a FACTORY, not a singleton: every call
 * constructs a new `IndexedDbStorage` and opens its own connection to `CanariDB_<userId>`. Only one
 * of those connections is ever reachable afterwards - the one the session keeps on its context - so
 * the factory hands out handles whose lifetime belongs to nobody, and `wipeDeviceToFactory` used to
 * take a `closeStorage` callback that could only ever close the one the caller happened to hold.
 *
 * `indexedDB.deleteDatabase` does not fail on an open connection, it BLOCKS. Measured on prod by
 * HEAL-REVOKE-9 on 2026-08-30: loading `/posts` opens TWO connections - the session's and
 * `ConversationsMiniPanel`'s, which states in its own comment that it deliberately never closes -
 * so a device revoked while its owner was on that page logged `CanariDB_... is still open elsewhere
 * - delete deferred`, then `1 store(s) SURVIVED the wipe`, and kept its message store until some
 * later moment nobody controls. A destructive security control does not get to finish "later".
 *
 * This is the same answer `closeMlsDb` gives for `CanariDBMls_<userId>`: the connection is closed
 * where it is CREATED, by the module that creates it, because no caller can see the others.
 */
const openConnections = new Set<IndexedDbStorage>();

/** Byte equality of two stored ciphertexts - the compare half of {@link IndexedDbStorage.swapSealedPayloads}. */
function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Closes every open connection to a `CanariDB_<userId>` database, so a delete can COMPLETE.
 *
 * Returns how many were closed - a wipe that reports nothing cannot be told from a wipe that found
 * nothing, and those have different fixes. It is safe to call with none open.
 *
 * WEB STORES ONLY, AND DELIBERATELY SO. `SqliteStorage.close()` tears down a connection pool shared
 * with whatever else is running, which is why `ConversationsMiniPanel` cannot close its own handle;
 * this touches only the WebView's IndexedDB, which every platform has and which every platform's
 * wipe already deletes unconditionally.
 */
export async function closeOpenIndexedDbStores(): Promise<number> {
  const held = [...openConnections];
  await Promise.all(held.map((s) => s.close()));
  return held.length;
}

export class IndexedDbStorage implements IStorage {
  private readonly dbName: string;
  private db: IDBDatabase | null = null;
  /** The bytes of queued attachments, in their own database (see outboxBlob.ts). */
  private readonly blobs: OutboxBlobStore;
  /** One order-key derivation in flight per conversation (`$lib/db/orderKeyDerivation`). */
  private readonly orderKeyDerivations = new OrderKeyDerivations();

  /** Create a storage instance for the given user. Call init() before using. */
  constructor(userId: string) {
    this.dbName = `CanariDB_${userId}`;
    this.blobs = new OutboxBlobStore(userId);
  }

  /** Whether the IndexedDB connection is open. See {@link IStorage.isOpen}. */
  get isOpen(): boolean {
    return this.db !== null;
  }

  /**
   * Closes the connection so the database can be DELETED deterministically.
   *
   * `indexedDB.deleteDatabase` does not fail while a connection is open - it fires `onblocked` and
   * completes at some later moment nobody controls. See {@link IStorage.close}.
   */
  async close(): Promise<void> {
    openConnections.delete(this);
    await this.blobs.close();
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  /**
   * ANOTHER TAB NEEDS A NEWER SCHEMA: THIS ONE LETS GO AND RELOADS (review of #1896).
   *
   * Without it, a tab still running the previous bundle held its connection open and every newer
   * tab's open was BLOCKED (`StorageOpenError`, "close the other tabs") until the old one closed -
   * which a member with a forgotten tab never does. The old bundle cannot reopen the upgraded
   * database either (it asks for the version below), so closing and reloading onto the new bundle is
   * the only state it can continue from. `db.close()` lets the transactions already running finish.
   * The reload drops what this tab held only in memory (a chat composer's text, a PIN prompt); that
   * is decided, not overlooked - why no guard defers it is in docs/wiki/frontend/modules/posts.md.
   *
   * A DELETE (`newVersion === null`, the revoked-device wipe of another tab) is deliberately left as
   * it was: this tab reopening would re-create the database the wipe is removing.
   */
  private onVersionChange(event: IDBVersionChangeEvent): void {
    if (event.newVersion === null) {
      console.warn(
        `[DB] ${this.dbName} is being deleted by another tab - this tab keeps its connection until it closes`
      );
      return;
    }
    console.warn(
      `[DB] ${this.dbName} is being upgraded to v${event.newVersion} by a newer tab - closing this connection and reloading`
    );
    openConnections.delete(this);
    this.db?.close();
    this.db = null;
    if (typeof window !== 'undefined') window.location.reload();
  }

  /** Open (or upgrade) the IndexedDB database, applying the schema migrations up to {@link IDB_SCHEMA_VERSION}. */
  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Version 3: conversation.id is now the MLS groupId UUID (was human-readable contactName).
      // Migration: the conversations store is recreated (same keyPath 'id') and all existing
      // rows are migrated by setting id = groupId (old rows had a separate groupId field).
      // Version 5: adds the `outbox` store (queued outbound messages).
      // Version 6: PBKDF2+salt → deviceKeyB64 (direct AES-256-GCM). Drops all encrypted
      //            messages/outbox rows — they will be re-fetched from the server.
      // Version 7: adds the `graine` store (community-channel session seeds).
      // Version 8: adds the `pendingGroupExits` store (a delete/leave the server has not answered).
      // Version 9: adds the `distributionGroups` store (which held groups carry Graine seeds).
      // Version 10: adds the `feedPages` store (the feed's stored first pages, sealed).
      // Version 11: adds the `byConversationTime` index on messages ([conversationId, timestamp]).
      const request = indexedDB.open(this.dbName, IDB_SCHEMA_VERSION);

      request.onerror = () =>
        reject(new StorageOpenError(this.dbName, false, { cause: request.error }));

      /**
       * A BLOCKED OPEN IS THE ONE OUTCOME THAT NEVER ARRIVES ON ITS OWN.
       *
       * `onblocked` fires when this open needs a version change and another tab still holds the old
       * version. It is not an error and it is not a success: neither of the two handlers above ever
       * runs, so before this the promise simply never settled and `init()` hung for as long as the
       * other tab stayed open - a start-up with no bound, and nothing logged to say why.
       *
       * It rejects rather than waiting, because waiting is the caller's decision and there is
       * something for a person to DO about it. The message says what to do.
       */
      request.onblocked = () => {
        console.error(
          `[DB] IndexedDB upgrade blocked for ${this.dbName} - another tab is holding an older ` +
            'version of this database open. Close the other tabs and reload.'
        );
        reject(new StorageOpenError(this.dbName, true));
      };

      request.onsuccess = () => {
        this.db = request.result;
        this.db.onversionchange = (event) => this.onVersionChange(event);
        // Registered HERE and nowhere else: an open connection is exactly what defers a delete, so
        // the set holds what is OPEN rather than what was ever constructed.
        openConnections.add(this);
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

        if (oldVersion < 8) {
          // Group exits decided locally and not yet answered by the server. Purely additive, and
          // EMPTY on every existing database, which is the honest state: a delete lost to a transport
          // failure before this store existed left nothing behind to recover from, and inventing
          // rows here would be guessing at intentions no column ever recorded.
          if (!db.objectStoreNames.contains('pendingGroupExits')) {
            db.createObjectStore('pendingGroupExits', { keyPath: 'groupId' });
          }
        }

        if (oldVersion < 9) {
          // Key-distribution groups this device holds. Additive and EMPTY on every existing
          // database, which is safe rather than lossy: the community loop registers each group again
          // on the first load, which is what writes its row, and the frames refused before it are
          // re-fetched by that same registration (see `registerDistributionGroup`).
          if (!db.objectStoreNames.contains('distributionGroups')) {
            db.createObjectStore('distributionGroups', { keyPath: 'groupId' });
          }
        }

        if (oldVersion < 10) {
          // The feed's stored first pages (`$lib/posts/feedStore`). Additive and EMPTY on every
          // existing database, which is the honest state: the next feed answer writes the first one.
          if (!db.objectStoreNames.contains('feedPages')) {
            db.createObjectStore('feedPages', { keyPath: 'key' });
          }
        }

        if (oldVersion < 11) {
          // The page read's index (see `getMessagesPage`). Built over the rows already stored, inside
          // this upgrade transaction, so no row exists that it does not cover. Taken from the
          // TRANSACTION rather than a handle above: a database below v6 recreated `messages` in this
          // same upgrade, and the index belongs on the store that now exists.
          const messages = tx.objectStore('messages');
          if (!messages.indexNames.contains(MESSAGES_BY_CONVERSATION_TIME)) {
            messages.createIndex(MESSAGES_BY_CONVERSATION_TIME, ['conversationId', 'timestamp'], {
              unique: false,
            });
          }
        }

        if (oldVersion < 12) {
          // The page read's index on the ORDER key (see `getMessagesPage`), and the provisional
          // rows' index. The rows already stored carry no `orderAt` - it is derived from the
          // ciphertext, which this upgrade cannot read - so they are keyed provisionally on their
          // `timestamp` and derived behind the page reads (`$lib/db/orderKeyDerivation`).
          const messages = tx.objectStore('messages');
          if (!messages.indexNames.contains(MESSAGES_BY_CONVERSATION_ORDER)) {
            messages.createIndex(
              MESSAGES_BY_CONVERSATION_ORDER,
              ['conversationId', 'orderAt', 'id'],
              { unique: false }
            );
          }
          if (!messages.indexNames.contains(MESSAGES_BY_CONVERSATION_PENDING)) {
            messages.createIndex(
              MESSAGES_BY_CONVERSATION_PENDING,
              ['conversationId', 'orderPending', 'id'],
              { unique: false }
            );
          }
        }

        // The two row walks, in sequence (see `keyStoredRowsProvisionally`): the v11 repair of string
        // timestamps, then the v12 provisional keys. The first only on a store that had rows to
        // repair (v6..v10), the second on every store below v12.
        const keyProvisionally = () => {
          if (oldVersion < 12) keyStoredRowsProvisionally(tx);
        };
        if (oldVersion < 11 && oldVersion >= 6) normalizeStoredTimestamps(tx, keyProvisionally);
        else keyProvisionally();

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
      serverReadWatermarks: parseReadWatermarks(r.serverReadWatermarks),
      historyFloor: parseHistoryFloor(r.historyFloor),
      awaitingAdmission: r.awaitingAdmission === true,
    };
  }

  /**
   * Return all stored conversation metadata rows, most recently updated first.
   *
   * THE INTERFACE SAYS "ORDERED BY RECENCY" AND THIS IMPLEMENTATION SAID "UNORDERED - CALLERS
   * SHOULD SORT". Two implementations of one contract disagreed, and the disagreement was invisible
   * because each platform only ever runs one of them: `SqliteStorage` answers
   * `ORDER BY updated_at DESC`, so the Tauri clients always had it, while `getAll()` on an object
   * store returns rows in KEY order - the conversation id, which is a group id and therefore
   * arbitrary.
   *
   * It decides the order of the startup replay. Phase 2 of `restoreConversations` walks this list
   * one conversation at a time (serialised, because the WASM client is not concurrency-safe), so
   * the list IS the schedule: on the web the conversation somebody is about to open was as likely
   * to be walked last as first, while on a phone it was always walked first. That is the same
   * session behaving differently on two platforms for no reason anybody chose.
   *
   * Sorted here rather than at the caller so the contract is true of the STORE, which is where it
   * is written down and where the other implementation already honours it.
   */
  async getConversations(): Promise<ConversationMeta[]> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('conversations', 'readonly');
      const req = tx.objectStore('conversations').getAll();
      req.onsuccess = () => {
        const rows = (req.result as Array<ConversationMeta & { isReady?: boolean }>).map((r) =>
          this.rowToMeta(r)
        );
        rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
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
          orderAt: storedOrderAt(msg),
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
    const msg = await this.getMessage(id, deviceKeyB64);
    // A row we cannot read is a row we must not overwrite: replacing it with the patch alone
    // would turn an undecryptable message into a truncated one. `getMessage` reports both that
    // and an absent row as `null`, and neither is a reason to write.
    if (!msg) return;
    await this.saveMessage(mergeStoredMessage(msg, patch), deviceKeyB64);
  }

  /** Decrypt and return one message by id; `null` when the row is absent or undecryptable. */
  async getMessage(id: string, deviceKeyB64: string): Promise<StoredMessage | null> {
    const db = this.ensureDb();
    const existing: any = await new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readonly');
      const req = tx.objectStore('messages').get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!existing) return null;
    try {
      const payload = (await decryptData(existing.cipherText, existing.iv, deviceKeyB64)) as Record<
        string,
        unknown
      >;
      return fromMessagePayload(
        { id: existing.id, conversationId: existing.conversationId, timestamp: existing.timestamp },
        payload
      );
    } catch {
      console.warn('Failed to decrypt message', id);
      return null;
    }
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
    return results.sort(compareStoredOrder);
  }

  /** Rows held for `conversationId`, counted on the index - nothing is read or decrypted. */
  async countMessages(conversationId: string): Promise<number> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readonly');
      const req = tx
        .objectStore('messages')
        .index('byConversation')
        .count(IDBKeyRange.only(conversationId));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** See {@link IStorage.getMessageConversationIds}: walks the conversation index, one key each. */
  async getMessageConversationIds(prefix: string): Promise<string[]> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const ids: string[] = [];
      const tx = db.transaction('messages', 'readonly');
      const req = tx
        .objectStore('messages')
        .index('byConversation')
        .openKeyCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`), 'nextunique');
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(ids);
        ids.push(String(cursor.key));
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Decrypt and return a paginated slice of messages for `conversationId`: the most recent `limit`
   * rows on the ORDER key with ties broken by id (strictly below `before` on that pair, for "load
   * older"), oldest first ({@link compareStoredOrder}), each with its {@link PageKey}.
   *
   * READS `limit` ROWS, NOT THE CONVERSATION. A reverse cursor on `[conversationId, orderAt, id]`
   * walks newest-first and stops at `limit`; the read it replaces `getAll`ed every row of the
   * conversation through `byConversation` and sorted them in JS to keep fifty - 28-31 ms for 5 000
   * rows on every page, measured in the 2026-10-12 performance audit, and more on every load-older.
   *
   * NEVER WAITS FOR A DERIVATION ON A FIRST PAGE: the same contract as `SqliteStorage` - rows keyed
   * provisionally are paged with that key and derived behind the read ({@link orderKeysDerived}); a
   * `before` read while the conversation was provisional waits for the derivation, then also returns
   * every row at or above `before`.
   */
  async getMessagesPage(
    conversationId: string,
    deviceKeyB64: string,
    limit: number,
    before?: PageKey
  ): Promise<StoredMessage[]> {
    const derive = () => this.deriveOrderKeys(conversationId, deviceKeyB64);
    let provisional = await this.hasProvisionalOrderKeys(conversationId);
    if (provisional && before?.provisional) {
      try {
        await this.orderKeyDerivations.run(conversationId, derive);
      } catch (e) {
        console.error(
          `[IDB] load-older of ${conversationId.slice(0, 8)} read over provisional keys - the derivation failed: ${String(e)}`
        );
      }
      provisional = await this.hasProvisionalOrderKeys(conversationId);
    } else if (provisional) {
      this.orderKeyDerivations.startInBackground(conversationId, derive);
    }

    let page: any[] = await this.readOrderRange(
      before === undefined
        ? conversationOrderRange(conversationId)
        : conversationOrderBelow(conversationId, before),
      limit
    );
    if (before?.provisional) {
      const above = await this.readOrderRange(
        conversationOrderFrom(conversationId, before),
        Infinity
      );
      console.info(
        `[IDB] load-older of ${conversationId.slice(0, 8)} below a provisional boundary - ${above.length} row(s) above it re-read`
      );
      page = [...above, ...page];
    }

    const results: StoredMessage[] = [];
    for (const row of page) {
      try {
        const payload = (await decryptData(row.cipherText, row.iv, deviceKeyB64)) as Record<
          string,
          unknown
        >;
        const msg = fromMessagePayload(
          { id: row.id, conversationId: row.conversationId, timestamp: row.timestamp },
          payload
        );
        msg.pageKey = { orderAt: row.orderAt, id: row.id, provisional };
        results.push(msg);
      } catch {
        console.warn('Failed to decrypt message', row.id);
      }
    }
    return results.sort(compareStoredOrder);
  }

  /** Up to `limit` rows of `range` in {@link MESSAGES_BY_CONVERSATION_ORDER}, newest first. */
  private readOrderRange(range: IDBKeyRange, limit: number): Promise<any[]> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const rows: any[] = [];
      if (limit <= 0) return resolve(rows);
      const req = db
        .transaction('messages', 'readonly')
        .objectStore('messages')
        .index(MESSAGES_BY_CONVERSATION_ORDER)
        .openCursor(range, 'prev');
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(rows);
        rows.push(cursor.value);
        if (rows.length >= limit) return resolve(rows);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  /** Whether `conversationId` still holds a row keyed provisionally - one key read off the index. */
  private hasProvisionalOrderKeys(conversationId: string): Promise<boolean> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const req = db
        .transaction('messages', 'readonly')
        .objectStore('messages')
        .index(MESSAGES_BY_CONVERSATION_PENDING)
        .getKey(conversationPendingRange(conversationId));
      req.onsuccess = () => resolve(req.result !== undefined);
      req.onerror = () => reject(req.error);
    });
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
   * One run of `$lib/db/orderKeyDerivation` over this store: the pending rows read off
   * {@link MESSAGES_BY_CONVERSATION_PENDING} by id, a chunk per read-only transaction; each chunk
   * written in its own transaction that re-reads every row and keys it only while it is STILL
   * pending, spreading the CURRENT value - a row the app rewrote meanwhile already carries the key
   * its save computed, and is never overwritten with the older ciphertext this run decrypted.
   */
  private deriveOrderKeys(
    conversationId: string,
    deviceKeyB64: string
  ): Promise<OrderKeyDerivation> {
    const db = this.ensureDb();
    return deriveOrderKeysInChunks(conversationId, deviceKeyB64, {
      readChunk: (after, limit) =>
        new Promise((resolve, reject) => {
          const rows: any[] = [];
          const req = db
            .transaction('messages', 'readonly')
            .objectStore('messages')
            .index(MESSAGES_BY_CONVERSATION_PENDING)
            .openCursor(conversationPendingRange(conversationId, after));
          const done = () =>
            resolve(
              rows.map((row) => ({
                id: row.id,
                timestamp: readStoredTimestampMs(row.timestamp) ?? 0,
                iv: row.iv,
                cipherText: row.cipherText,
              }))
            );
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return done();
            rows.push(cursor.value);
            if (rows.length >= limit) return done();
            cursor.continue();
          };
          req.onerror = () => reject(req.error);
        }),
      writeChunk: (keyed) => {
        invalidateHistoryStateKey(conversationId);
        return new Promise<void>((resolve, reject) => {
          const tx = db.transaction('messages', 'readwrite');
          const store = tx.objectStore('messages');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          for (const { id, orderAt } of keyed) {
            const req = store.get(id);
            req.onsuccess = () => {
              const current = req.result;
              if (current?.orderPending !== ORDER_PENDING) return;
              const next = { ...current, orderAt };
              delete next.orderPending;
              store.put(next);
            };
          }
        });
      },
    });
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
    // A backup is INPUT, and one taken on a phone before 2026-10-17 carries the timestamp as the
    // SQLite plugin returned it - a string on Android. Stored as a string it would sort after every
    // number in the page index and no page would place it (see `conversationOrderRange`).
    const timestamp = readStoredTimestampMs(row.timestamp);
    if (timestamp === undefined) {
      console.error(
        `[IDB] importEncryptedRow: row ${row.id} of ${row.conversationId.slice(0, 8)} has no readable timestamp (${typeof row.timestamp}) - not imported, no page could place it`
      );
      return;
    }
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      // `add` skips on duplicate; `put` would overwrite newer local messages.
      // The row is ciphertext, so its order key is PROVISIONAL - its `timestamp`, flagged - and the
      // next page read of its conversation derives the real one (`$lib/db/orderKeyDerivation`).
      const req = tx
        .objectStore('messages')
        .add({ ...row, timestamp, orderAt: timestamp, orderPending: ORDER_PENDING });
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

  /**
   * The message and the entry that will send it, written together or not at all.
   *
   * BOTH PAYLOADS ARE ENCRYPTED BEFORE THE TRANSACTION OPENS. An IndexedDB transaction commits when
   * it runs out of work, so an `await` inside one ends it - the second put would then land in a
   * transaction of its own and the atomicity this method exists for would be gone while every test
   * still passed.
   */
  async saveMessageWithOutboxEntry(
    msg: StoredMessage,
    entry: OutboxEntry,
    deviceKeyB64: string
  ): Promise<void> {
    invalidateHistoryStateKey(msg.conversationId);
    const db = this.ensureDb();
    // An attachment's bytes are committed to the blob store BEFORE this transaction opens (see
    // `writeOutboxWithBlob`): the pair below stays atomic, and a blob without its row is swept.
    await writeOutboxWithBlob(this.blobs, entry, async (blobKeyB64) => {
      const [encryptedMessage, encryptedEntry] = await Promise.all([
        encryptData(toMessagePayload(msg), deviceKeyB64),
        encryptData(encodeOutboxSensitive(entry, blobKeyB64), deviceKeyB64),
      ]);
      const tx = db.transaction(['messages', 'outbox'], 'readwrite');
      const done = idbCommitted(tx);
      tx.objectStore('messages').put({
        id: msg.id,
        conversationId: msg.conversationId,
        timestamp: msg.timestamp,
        orderAt: storedOrderAt(msg),
        ...encryptedMessage,
      });
      tx.objectStore('outbox').put({ ...outboxClearColumns(entry), ...encryptedEntry });
      await done;
    });
  }

  /** Encrypt the sensitive payload and upsert a queued outbound message. */
  async saveOutboxEntry(entry: OutboxEntry, deviceKeyB64: string): Promise<void> {
    const db = this.ensureDb();
    // Blob FIRST, row SECOND: see `writeOutboxWithBlob`.
    await writeOutboxWithBlob(this.blobs, entry, async (blobKeyB64) => {
      const encrypted = await encryptData(encodeOutboxSensitive(entry, blobKeyB64), deviceKeyB64);
      const row = { ...outboxClearColumns(entry), ...encrypted };
      const tx = db.transaction('outbox', 'readwrite');
      const done = idbCommitted(tx);
      tx.objectStore('outbox').put(row);
      await done;
    });
  }

  /** The queue with `media` rows left undecrypted (clear columns only) - see {@link IStorage.getOutboxQueue}. */
  async getOutboxQueue(deviceKeyB64: string): Promise<OutboxEntry[]> {
    const db = this.ensureDb();
    const rows: any[] = await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readonly');
      const req = tx.objectStore('outbox').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const media = rows.filter((r) => r.kind === 'media').map((r) => decodeOutboxEntry(r));
    const others = await this.decodeOutboxRows(
      rows.filter((r) => r.kind !== 'media'),
      deviceKeyB64
    );
    return [...media, ...others].sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id));
  }

  /** One entry with its full payload - see {@link IStorage.getOutboxEntry}. */
  async getOutboxEntry(
    id: string,
    deviceKeyB64: string,
    opts?: { withFile?: boolean }
  ): Promise<OutboxEntry | null> {
    const db = this.ensureDb();
    const row: any = await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readonly');
      const req = tx.objectStore('outbox').get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!row) return null;
    let entry: OutboxEntry;
    try {
      entry = decodeOutboxEntry(row, await decryptData(row.cipherText, row.iv, deviceKeyB64));
    } catch (e) {
      throw new OutboxPayloadUnreadableError(id, e);
    }
    if (opts?.withFile === false) return entry;
    return attachOutboxBlob(
      this.blobs,
      entry,
      () =>
        new Promise<boolean>((resolve, reject) => {
          const req = db.transaction('outbox', 'readonly').objectStore('outbox').getKey(id);
          req.onsuccess = () => resolve(req.result !== undefined);
          req.onerror = () => reject(req.error);
        })
    );
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
    if (isOutboxClearPatch(patch)) {
      // Scheduling columns are clear: rewrite the row as it is, ciphertext untouched, instead of
      // decrypting and re-encrypting a payload that may hold a whole file (see the sqlite twin).
      // ONE readwrite transaction, get then put, and only if the row still exists: a get in one
      // transaction and a put in another could resurrect a row `cancelPending` deleted in between
      // (the flusher would then send a deleted message) or overwrite a fresh `saveOutboxEntry`.
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('outbox', 'readwrite');
        const store = tx.objectStore('outbox');
        const req = store.get(id);
        req.onsuccess = () => {
          const row = req.result;
          if (!row) return;
          for (const k of OUTBOX_CLEAR_PATCH_KEYS) {
            if (patch[k] !== undefined) row[k] = patch[k];
          }
          store.put(row);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return;
    }
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
    // The row read above is the small one: a blob-format row carries a key, not the file, so the
    // post-upload patch (uploadedRef, fileBytes dropped) rewrites ~1 KB and never the attachment.
    const merged = mergeOutboxEntry(entry, patch);
    await this.saveOutboxEntry(merged, deviceKeyB64);
    if (outboxBlobReleased(merged)) await deleteOutboxBlobQuietly(this.blobs, id);
  }

  /**
   * Remove a queued entry (after a confirmed send or a permanent failure), and its blob. The row
   * goes first: a kill between the two leaves a blob with no row, which the boot sweep removes.
   */
  async deleteOutboxEntry(id: string): Promise<void> {
    const db = this.ensureDb();
    const tx = db.transaction('outbox', 'readwrite');
    const done = idbCommitted(tx);
    const store = tx.objectStore('outbox');
    let kind: string | undefined;
    const req = store.get(id);
    req.onsuccess = () => {
      kind = req.result?.kind;
      store.delete(id);
    };
    // The kind only decides whether a blob may exist: a failed read must not abort the delete.
    req.onerror = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      kind = 'unknown';
      store.delete(id);
    };
    await done;
    if (kind === 'media' || kind === 'unknown') await deleteOutboxBlobQuietly(this.blobs, id);
  }

  /** See {@link IStorage.sweepOutboxBlobs}. */
  async sweepOutboxBlobs(): Promise<number> {
    const db = this.ensureDb();
    const removed = await this.blobs.sweep(
      () =>
        new Promise<IDBValidKey[]>((resolve, reject) => {
          const req = db.transaction('outbox', 'readonly').objectStore('outbox').getAllKeys();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }) as Promise<string[]>
    );
    return removed.length;
  }

  // -- Pending group exits -------------------------------------------------

  /** Record that this device owes the server an exit for `entry.groupId`. */
  async savePendingGroupExit(entry: PendingGroupExit): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pendingGroupExits', 'readwrite');
      tx.objectStore('pendingGroupExits').put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Every exit still owed, oldest first. */
  async getPendingGroupExits(): Promise<PendingGroupExit[]> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pendingGroupExits', 'readonly');
      const req = tx.objectStore('pendingGroupExits').getAll();
      req.onsuccess = () =>
        resolve((req.result as PendingGroupExit[]).sort((a, b) => a.requestedAt - b.requestedAt));
      req.onerror = () => reject(req.error);
    });
  }

  /** Forget the exit owed for `groupId`. A groupId that names nothing is not an error. */
  async deletePendingGroupExit(groupId: string): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pendingGroupExits', 'readwrite');
      tx.objectStore('pendingGroupExits').delete(groupId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // -- Key-distribution groups -------------------------------------------

  /** Record that `entry.groupId` is the key-distribution group of `entry`'s scope. */
  async saveDistributionGroup(entry: StoredDistributionGroup): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('distributionGroups', 'readwrite');
      tx.objectStore('distributionGroups').put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Every key-distribution group recorded. */
  async getDistributionGroups(): Promise<StoredDistributionGroup[]> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('distributionGroups', 'readonly');
      const req = tx.objectStore('distributionGroups').getAll();
      req.onsuccess = () => resolve(req.result as StoredDistributionGroup[]);
      req.onerror = () => reject(req.error);
    });
  }

  /** Forget `groupId`'s row. A groupId that names nothing is not an error. */
  async deleteDistributionGroup(groupId: string): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('distributionGroups', 'readwrite');
      tx.objectStore('distributionGroups').delete(groupId);
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

  /** A community's session rows, decryptable or not. See {@link IStorage.countGraineSessionsForWorkspace}. */
  async countGraineSessionsForWorkspace(workspaceId: string): Promise<number> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('graine', 'readonly');
      const req = tx.objectStore('graine').index('byWorkspace').count(workspaceId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
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

  // -- Device key change ---------------------------------------------------

  /** See {@link IStorage.getSealedPayloads}. The object store names ARE the {@link SealedStore} names. */
  async getSealedPayloads(store: SealedStore): Promise<SealedPayload[]> {
    const db = this.ensureDb();
    const rows: any[] = await new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return rows.map((row) => ({
      id: store === 'graine' ? row.sessionId : row.id,
      iv: row.iv,
      cipherText: row.cipherText,
    }));
  }

  /**
   * See {@link IStorage.swapSealedPayloads}. ONE readwrite transaction for the whole batch, every
   * payload already sealed by the caller, so nothing awaited inside it can end it early.
   */
  async swapSealedPayloads(
    store: SealedStore,
    swaps: readonly SealedPayloadSwap[]
  ): Promise<number> {
    if (swaps.length === 0) return 0;
    // A message write must drop the reconciliation's cached state key (see IStorage).
    if (store === 'messages') invalidateAllHistoryStateKeys();
    const db = this.ensureDb();
    let swapped = 0;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      for (const swap of swaps) {
        const req = os.get(swap.id);
        req.onsuccess = () => {
          const row = req.result;
          if (!row || !sameBytes(row.cipherText, swap.expected)) return;
          os.put({ ...row, iv: swap.iv, cipherText: swap.cipherText });
          swapped++;
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return swapped;
  }

  // -- Stored feed pages ---------------------------------------------------

  /** Seal and replace one stored feed page. See {@link IStorage.saveFeedPage}. */
  async saveFeedPage(key: string, payload: unknown, deviceKeyB64: string): Promise<void> {
    const encrypted = await encryptData(payload, deviceKeyB64);
    const db = this.ensureDb();
    const tx = db.transaction('feedPages', 'readwrite');
    const done = idbCommitted(tx);
    tx.objectStore('feedPages').put({ key, ...encrypted });
    await done;
  }

  /** One stored feed page, opened, or `null`. See {@link IStorage.getFeedPage}. */
  async getFeedPage(key: string, deviceKeyB64: string): Promise<unknown> {
    const db = this.ensureDb();
    const row: any = await new Promise((resolve, reject) => {
      const req = db.transaction('feedPages', 'readonly').objectStore('feedPages').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!row) return null;
    try {
      return await decryptData(row.cipherText, row.iv, deviceKeyB64);
    } catch (error) {
      throw new FeedPageUnreadableError(key, { cause: error });
    }
  }

  /** Delete every stored feed page. See {@link IStorage.deleteFeedPages}. */
  async deleteFeedPages(): Promise<number> {
    const db = this.ensureDb();
    const tx = db.transaction('feedPages', 'readwrite');
    const done = idbCommitted(tx);
    const store = tx.objectStore('feedPages');
    const counted = new Promise<number>((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    store.clear();
    const [count] = await Promise.all([counted, done]);
    return count;
  }

  // -- Misc ----------------------------------------------------------------

  /**
   * Erase every store in a single transaction, THEN the outbox blob store - row first, blob second,
   * so a blob store that refuses to open cannot leave rows naming blobs that are gone. Rejects with
   * `OutboxBlobClearError` when only the blob store failed (every store is empty by then).
   */
  async clear(): Promise<void> {
    invalidateAllHistoryStateKeys();
    const db = this.ensureDb();
    const tx = db.transaction(
      [
        'conversations',
        'messages',
        'outbox',
        'graine',
        'pendingGroupExits',
        'distributionGroups',
        'feedPages',
      ],
      'readwrite'
    );
    const done = idbCommitted(tx);
    try {
      tx.objectStore('conversations').clear();
      tx.objectStore('messages').clear();
      tx.objectStore('outbox').clear();
      tx.objectStore('graine').clear();
      // AN ACCOUNT RESET TAKES THE OWED EXITS WITH IT, and that is the right answer rather than a
      // loss: the exits name groups this device is wiping its membership of anyway, and a drain
      // firing afterwards would be acting on a decision taken by an account that is no longer here.
      tx.objectStore('pendingGroupExits').clear();
      // The seeds go with the reset, so the classification that routes to them goes too.
      tx.objectStore('distributionGroups').clear();
      // A copy of the feed is the account's content too; a reset leaves none of it behind.
      tx.objectStore('feedPages').clear();
    } catch (e) {
      // A synchronous refusal does NOT abort the transaction: the clears already queued would
      // commit and the reset would be half done. All of it, or none of it.
      tx.abort();
      throw e;
    }
    await done;
    await clearOutboxBlobsLast(this.blobs);
  }
}
