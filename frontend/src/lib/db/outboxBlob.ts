import { fromBase64, toBase64 } from '$lib/utils/hex';
import { OutboxPayloadUnreadableError } from './outboxCodec';
import type { OutboxEntry } from './types';

// ---------------------------------------------------------------------------
// The bytes of a queued attachment, kept OUT of the encrypted outbox row.
//
// WHY. A queued 13 MB file used to live inside the row as base64 of a ciphertext of base64 of the
// file (23 MiB), and on Android that row crossed the SQL bridge as a JSON string three times per
// send (write, read, post-upload patch): ~1.2 GB of renderer memory, a wait of tens of seconds
// before the first byte (Mi 9T, 2026-10-11, docs/wiki/backlog.md). The bridge cannot carry binary,
// so the bytes never go through it: they sit in the WebView's own IndexedDB as a structured-clone
// ArrayBuffer - no base64, no JSON - and the row keeps only the key that opens them.
//
// ONE DATABASE FOR BOTH BACKENDS. `CanariDBOutbox_<userId>` is deliberately NOT a store of
// `CanariDB_<userId>`: on a phone that database does not exist (the message store is SQLite) and a
// call site opening it by accident is already a recorded defect (deviceReset). The `CanariDB`
// prefix is what the device wipe enumerates, so this one is swept by the existing wipe, and
// `closeOutboxBlobStores` is its own step there because a delete BLOCKS on an open connection.
//
// ENCRYPTION. Each blob is AES-256-GCM under a RANDOM per-entry key that lives only in the row's
// encrypted payload (`media.blob.keyB64`). So the blob is unreadable without the device key (which
// opens the row), a row and its blob die together, and a PIN change - which does not re-encrypt
// outbox rows - changes nothing about this store that it had not already done to the row.
//
// ORDER (the storage layers enforce it): blob FIRST, row SECOND. A blob with no row is invisible
// garbage the boot sweep deletes; a row with no blob is a typed, visible failure
// ({@link OutboxBlobMissingError}). The reverse order would put a ghost in the queue.
//
// THE BLOB ID IS THE ENTRY ID. Deleting an entry then needs no read of its row (which may be the
// very thing that is unreadable), and the sweep's question - "is there a row with this id?" - is
// answered from the clear `id` column, without the device key.
// ---------------------------------------------------------------------------

const DB_PREFIX = 'CanariDBOutbox_';
const STORE = 'blobs';
const BY_CREATED = 'byCreated';

/**
 * A blob younger than this is never swept. The sweep runs once per session, and another tab of the
 * web build may be between its blob write and its row write; the harm of a wrong clock is bounded
 * and unobservable (one more boot of garbage, or - clock far in the future - a typed failure on a
 * file written in the last seconds), which is why a clock is acceptable HERE and nowhere in the
 * enqueue path itself.
 */
export const BLOB_SWEEP_GRACE_MS = 10 * 60 * 1000;

/** The row names a blob that is not in the store: the attachment is gone from this device. */
export class OutboxBlobMissingError extends Error {
  readonly entryId: string;
  constructor(entryId: string) {
    super(`the queued attachment of ${entryId} is no longer stored on this device`);
    this.name = 'OutboxBlobMissingError';
    this.entryId = entryId;
  }
}

/** The blob is stored but the row's key does not open it (a damaged record, a key that never matched). */
export class OutboxBlobCorruptError extends Error {
  readonly entryId: string;
  constructor(entryId: string, cause: unknown) {
    super(`the queued attachment of ${entryId} cannot be decrypted`, { cause });
    this.name = 'OutboxBlobCorruptError';
    this.entryId = entryId;
  }
}

/** The blob could not be written. `quota` is the one a member can act on (free some space). */
export class OutboxBlobWriteError extends Error {
  readonly quota: boolean;
  constructor(entryId: string, cause: unknown) {
    const quota = isQuotaError(cause);
    super(
      quota
        ? `no storage left to queue the attachment of ${entryId}`
        : `the queued attachment of ${entryId} could not be written`,
      { cause }
    );
    this.name = 'OutboxBlobWriteError';
    this.quota = quota;
  }
}

/** True for the browser's "out of storage" refusal, read from the error NAME, never a message. */
export function isQuotaError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    ((e as { name?: string }).name === 'QuotaExceededError' || (e as { code?: number }).code === 22)
  );
}

interface BlobRecord {
  id: string;
  iv: Uint8Array;
  cipher: ArrayBuffer;
  createdAt: number;
}

const openStores = new Set<OutboxBlobStore>();

/** Close every open blob connection so the wipe's `deleteDatabase` can complete (it BLOCKS otherwise). */
export async function closeOutboxBlobStores(): Promise<number> {
  const held = [...openStores];
  await Promise.all(held.map((s) => s.close()));
  return held.length;
}

/** Promise form of an IDB request, rejecting with the request's own error. */
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Resolves when the transaction COMMITS; rejects with its error on abort (a quota refusal included). */
function committed(tx: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  // Marked handled up front: a synchronous throw between opening the transaction and awaiting it
  // (a DataCloneError on `put`) would otherwise leave an unhandled rejection behind the real one.
  done.catch(() => undefined);
  return done;
}

/** The per-user store of queued attachment bytes. Connection opened lazily, closed by `close()`. */
export class OutboxBlobStore {
  private readonly dbName: string;
  private dbPromise: Promise<IDBDatabase> | null = null;
  /** Ids between their blob write and the end of their row write, in THIS document. */
  private readonly writing = new Set<string>();

  constructor(userId: string) {
    this.dbName = DB_PREFIX + userId;
  }

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex(BY_CREATED, 'createdAt', { unique: false });
        };
        req.onsuccess = () => {
          const db = req.result;
          // A delete from another tab (the wipe) must not be blocked by this connection.
          db.onversionchange = () => {
            db.close();
            this.dbPromise = null;
          };
          openStores.add(this);
          resolve(db);
        };
        req.onerror = () => {
          this.dbPromise = null;
          reject(req.error);
        };
      });
    }
    return this.dbPromise;
  }

  /** Release the connection; a later call reopens it. */
  async close(): Promise<void> {
    openStores.delete(this);
    const pending = this.dbPromise;
    this.dbPromise = null;
    if (!pending) return;
    await pending.then((db) => db.close()).catch(() => undefined);
  }

  /**
   * Mark `id` as being written. The sweep skips it until {@link endWrite}: the window between the
   * blob's commit and the row's commit is exactly when a blob has no row and is NOT garbage.
   */
  beginWrite(id: string): void {
    this.writing.add(id);
  }

  /** The row write finished (either way). */
  endWrite(id: string): void {
    this.writing.delete(id);
  }

  /**
   * Encrypt `bytes` under a fresh random key and commit them under `id`. Resolves with the key
   * (base64) the row must keep. Rejects with {@link OutboxBlobWriteError}, `quota` set when the
   * browser refused for lack of space - never a partial write: the put is one transaction.
   */
  async put(id: string, bytes: Uint8Array): Promise<string> {
    try {
      const rawKey = crypto.getRandomValues(new Uint8Array(32));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, [
        'encrypt',
      ]);
      const cipher = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        bytes as BufferSource
      );
      const db = await this.open();
      const tx = db.transaction(STORE, 'readwrite');
      const done = committed(tx);
      const record: BlobRecord = { id, iv, cipher, createdAt: Date.now() };
      tx.objectStore(STORE).put(record);
      await done;
      return toBase64(rawKey);
    } catch (e) {
      throw new OutboxBlobWriteError(id, e);
    }
  }

  /**
   * The bytes of `id`, opened with the row's key. Throws {@link OutboxBlobMissingError} when no
   * blob is stored (evicted by the platform, or never written), and the crypto error when the key
   * does not open it (a damaged record).
   */
  async get(id: string, keyB64: string): Promise<Uint8Array> {
    const db = await this.open();
    const record = (await request(db.transaction(STORE, 'readonly').objectStore(STORE).get(id))) as
      | BlobRecord
      | undefined;
    if (!record) throw new OutboxBlobMissingError(id);
    try {
      const key = await crypto.subtle.importKey(
        'raw',
        fromBase64(keyB64) as BufferSource,
        { name: 'AES-GCM' },
        false,
        ['decrypt']
      );
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(record.iv) },
        key,
        record.cipher
      );
      return new Uint8Array(plain);
    } catch (e) {
      throw new OutboxBlobCorruptError(id, e);
    }
  }

  /** Remove `id`'s blob. Absent is success. */
  async delete(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite');
    const done = committed(tx);
    tx.objectStore(STORE).delete(id);
    await done;
  }

  /** Remove every blob (account reset). */
  async clear(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite');
    const done = committed(tx);
    tx.objectStore(STORE).clear();
    await done;
  }

  /** Every stored id with its write time, read from the index KEYS only - no blob is loaded. */
  async list(): Promise<Array<{ id: string; createdAt: number }>> {
    const db = await this.open();
    const out: Array<{ id: string; createdAt: number }> = [];
    await new Promise<void>((resolve, reject) => {
      const req = db
        .transaction(STORE, 'readonly')
        .objectStore(STORE)
        .index(BY_CREATED)
        .openKeyCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        out.push({ id: String(cursor.primaryKey), createdAt: Number(cursor.key) });
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
    return out;
  }

  /**
   * Delete every blob that no row owns. `listRowIds` is read AFTER the blob list and the in-flight
   * set AFTER that, which is the only order in which a concurrent enqueue cannot be swept: either
   * its row is already visible, or it is still marked as being written.
   * Returns the ids removed.
   */
  async sweep(listRowIds: () => Promise<Iterable<string>>, now = Date.now()): Promise<string[]> {
    const stored = await this.list();
    const rowIds = new Set(await listRowIds());
    const garbage = stored.filter(
      (b) =>
        !rowIds.has(b.id) && !this.writing.has(b.id) && now - b.createdAt >= BLOB_SWEEP_GRACE_MS
    );
    for (const b of garbage) await this.delete(b.id);
    return garbage.map((b) => b.id);
  }
}

/**
 * Write an entry's row WITH its blob, in the only safe order. When the entry carries bytes they are
 * committed first and `writeRow` receives the key to record; a throw from the blob write means no
 * row was attempted, and a throw from `writeRow` leaves a blob with no row - garbage the sweep
 * removes, never a queued entry. The id stays marked as being written until the row write ends so
 * the sweep cannot mistake the blob for garbage in between.
 */
export async function writeOutboxWithBlob(
  blobs: OutboxBlobStore,
  entry: OutboxEntry,
  writeRow: (blobKeyB64: string | undefined) => Promise<void>
): Promise<void> {
  const bytes = entry.media?.fileBytes;
  if (!bytes || bytes.length === 0) return writeRow(undefined);
  blobs.beginWrite(entry.id);
  try {
    const keyB64 = await blobs.put(entry.id, bytes);
    await writeRow(keyB64);
  } finally {
    blobs.endWrite(entry.id);
  }
}

/**
 * Put the bytes of a decoded row's blob back on it. A row with no `media.blob` is returned as is.
 * A blob that is absent or cannot be decrypted is the row's own verdict - this device will never
 * read that attachment - and so is {@link OutboxPayloadUnreadableError}, which the flusher parks as
 * a visible error. Any OTHER failure (the database would not open) is not a verdict and propagates
 * untouched, to be retried.
 */
export async function attachOutboxBlob(
  blobs: OutboxBlobStore,
  entry: OutboxEntry
): Promise<OutboxEntry> {
  const blob = entry.media?.blob;
  if (!entry.media || !blob) return entry;
  let fileBytes: Uint8Array;
  try {
    fileBytes = await blobs.get(entry.id, blob.keyB64);
  } catch (e) {
    if (e instanceof OutboxBlobMissingError || e instanceof OutboxBlobCorruptError) {
      throw new OutboxPayloadUnreadableError(entry.id, e);
    }
    throw e;
  }
  return { ...entry, media: { ...entry.media, fileBytes } };
}

/**
 * True when a merged entry no longer needs its blob: the file is uploaded and no bytes are being
 * re-queued. The caller deletes the blob AFTER the row that stopped naming it is written.
 */
export function outboxBlobReleased(merged: OutboxEntry): boolean {
  return !!merged.media?.uploadedRef && !merged.media.fileBytes?.length;
}
