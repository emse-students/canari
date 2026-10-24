import { fromBase64, toBase64 } from '$lib/utils/hex';
import { Log } from '$lib/utils/Log';
import { appendLog } from '$lib/utils/sessionLog';
import { OutboxPayloadUnreadableError } from './outboxCodec';
import type { OutboxBlobRef, OutboxEntry } from './types';

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
// THE BLOB ID IS THE ENTRY ID, IN ONE OF TWO SLOTS: `<entryId>` or `<entryId>#b`. Deleting an
// entry then needs no read of its row (which may be the very thing that is unreadable) - both slots
// are deleted - and the sweep's question - "is there a row with this id?" - is answered from the
// clear `id` column, without the device key. The SECOND SLOT exists for an entry whose bytes are
// REPLACED (reels-in-chat RC-5: the raw take by the prepared file): the new bytes go to the slot the
// committed row does NOT name, the row is rewritten to name it, and only then is the old slot
// deleted. Overwriting in place would put bytes under a new key while the committed row still holds
// the old one - a kill between the two writes and the take could never be opened again.
// ---------------------------------------------------------------------------

const DB_PREFIX = 'CanariDBOutbox_';
const STORE = 'blobs';
const BY_CREATED = 'byCreated';
const SLOT_SEPARATOR = '#';

/** The store id of an entry's blob in `slot` (absent: the first slot, the entry id itself). */
export function outboxBlobId(entryId: string, slot?: OutboxBlobRef['slot']): string {
  return slot ? `${entryId}${SLOT_SEPARATOR}${slot}` : entryId;
}

/** The entry a stored blob id belongs to, whichever slot it is in. */
export function outboxBlobOwner(blobId: string): string {
  const at = blobId.indexOf(SLOT_SEPARATOR);
  return at < 0 ? blobId : blobId.slice(0, at);
}

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

/**
 * Resolves when the transaction COMMITS; rejects with the error that made it fail.
 *
 * THE ERROR IS READ FROM THE REQUEST FIRST. Per the IndexedDB spec `transaction.error` is set only
 * when the transaction ABORTS, so during the `error` event a request fired it is still `null` -
 * rejecting with it there handed `null` to {@link isQuotaError}, and an engine that reports a full
 * disk as a request error never showed the member "storage full". The request's own `error` is what
 * that event carries; `tx.error` is the answer at abort; a bare abort with neither still rejects
 * with a real error, never `null`.
 *
 * Exported for every IndexedDB transaction of the outbox, on both databases.
 */
export function idbCommitted(tx: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (ev) => {
      const req = ev.target as IDBRequest | null;
      reject(
        req?.error ?? tx.error ?? new DOMException('IndexedDB request failed', 'UnknownError')
      );
    };
    tx.onabort = () =>
      reject(tx.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
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
    Log.d('outboxBlob.put', { id, bytes: bytes.length });
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
      const done = idbCommitted(tx);
      const record: BlobRecord = { id, iv, cipher, createdAt: Date.now() };
      tx.objectStore(STORE).put(record);
      await done;
      return toBase64(rawKey);
    } catch (e) {
      const err = new OutboxBlobWriteError(id, e);
      appendLog(`[DB] outbox blob of ${id} NOT written (quota=${err.quota}): ${String(e)}`);
      throw err;
    }
  }

  /**
   * The bytes of `id`, opened with the row's key. Throws {@link OutboxBlobMissingError} when no
   * blob is stored (evicted by the platform, or never written), and the crypto error when the key
   * does not open it (a damaged record).
   */
  async get(id: string, keyB64: string): Promise<Uint8Array> {
    Log.d('outboxBlob.get', { id });
    const db = await this.open();
    const record = (await request(db.transaction(STORE, 'readonly').objectStore(STORE).get(id))) as
      | BlobRecord
      | undefined;
    if (!record) {
      Log.d('outboxBlob.get.missing', { id });
      throw new OutboxBlobMissingError(id);
    }
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
      Log.d('outboxBlob.get.corrupt', { id });
      throw new OutboxBlobCorruptError(id, e);
    }
  }

  /** Remove `id`'s blob. Absent is success. */
  async delete(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite');
    const done = idbCommitted(tx);
    tx.objectStore(STORE).delete(id);
    await done;
  }

  /** Remove every blob (account reset). Storage layers call it through {@link clearOutboxBlobsLast}. */
  async clear(): Promise<void> {
    Log.d('outboxBlob.clear');
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite');
    const done = idbCommitted(tx);
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
   * Delete every blob that no row owns. Returns the ids removed.
   *
   * WHAT PROTECTS A CONCURRENT ENQUEUE IS THE GRACE ({@link BLOB_SWEEP_GRACE_MS}), NOT THE ORDER OF
   * THE READS. The row ids are a snapshot: an enqueue whose row commits AFTER `listRowIds` read it
   * and whose `endWrite` runs before the filter below looks exactly like garbage - no row in the
   * snapshot, no longer in the in-flight set. The in-flight set also sees only THIS document, never
   * another tab. Both cases are blobs written seconds ago, and only the age test excludes them; the
   * set and the read order narrow the window, they do not close it.
   */
  async sweep(listRowIds: () => Promise<Iterable<string>>, now = Date.now()): Promise<string[]> {
    const stored = await this.list();
    const rowIds = new Set(await listRowIds());
    const garbage = stored.filter((b) => {
      const owner = outboxBlobOwner(b.id);
      return (
        !rowIds.has(owner) && !this.writing.has(owner) && now - b.createdAt >= BLOB_SWEEP_GRACE_MS
      );
    });
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
  writeRow: (blob: OutboxBlobRef | undefined) => Promise<void>
): Promise<void> {
  const bytes = entry.media?.fileBytes;
  if (!bytes || bytes.length === 0) return writeRow(undefined);
  // An entry that already names a blob is REPLACING its bytes: the new ones go to the other slot,
  // so the committed row keeps opening what it names until the new row is committed.
  const previous = entry.media?.blob;
  const slot: OutboxBlobRef['slot'] = previous && !previous.slot ? 'b' : undefined;
  blobs.beginWrite(entry.id);
  try {
    const keyB64 = await blobs.put(outboxBlobId(entry.id, slot), bytes);
    await writeRow(slot ? { keyB64, slot } : { keyB64 });
  } finally {
    blobs.endWrite(entry.id);
  }
  if (previous) {
    Log.d('outboxBlob.replaced', { id: entry.id, from: previous.slot ?? 'a', to: slot ?? 'a' });
    await deleteOneBlobQuietly(blobs, outboxBlobId(entry.id, previous.slot));
  }
}

/** Delete one stored blob id; a failure is logged and left to the boot sweep. */
async function deleteOneBlobQuietly(blobs: OutboxBlobStore, blobId: string): Promise<void> {
  await blobs
    .delete(blobId)
    .catch((e) =>
      appendLog(`[DB] outbox blob ${blobId} NOT deleted (left for the boot sweep): ${String(e)}`)
    );
}

/**
 * Delete the blobs (both slots) of an entry whose row no longer names them (sent, cancelled,
 * uploaded). A failure leaves garbage the boot sweep removes, never an error for the caller - but it
 * is logged, because a delete that keeps failing is a store that keeps refusing.
 */
export async function deleteOutboxBlobQuietly(blobs: OutboxBlobStore, id: string): Promise<void> {
  await deleteOneBlobQuietly(blobs, outboxBlobId(id));
  await deleteOneBlobQuietly(blobs, outboxBlobId(id, 'b'));
}

/**
 * The blob store could not be cleared during an account reset. Thrown AFTER every row store was
 * emptied ({@link clearOutboxBlobsLast}), so what it leaves is encrypted bytes whose keys are gone
 * with the rows - unreadable garbage, never an account half-wiped.
 */
export class OutboxBlobClearError extends Error {
  constructor(cause: unknown) {
    super('the outbox attachment store could not be cleared (its rows are gone)', { cause });
    this.name = 'OutboxBlobClearError';
  }
}

/**
 * The last step of an account reset on either backend: clear the blob store, once every row store
 * (graine seeds, owed exits and distribution groups included) has already been emptied.
 *
 * WHY LAST, AND WHY IT CANNOT THROW EARLY. The blob store is a SEPARATE database: when IndexedDB is
 * unavailable or blocked its open throws. Awaited between two row deletes, that throw skipped the
 * rest of the reset and left sensitive seeds behind; awaited first, it left rows naming blobs that
 * were already gone. Here the rows go first (row first, blob second), so a failure leaves only
 * keyless ciphertext - logged as the defect it is and rethrown typed, so the reset is not reported
 * as clean.
 */
export async function clearOutboxBlobsLast(blobs: OutboxBlobStore): Promise<void> {
  try {
    await blobs.clear();
  } catch (e) {
    appendLog(`[DB] account reset: rows cleared but the outbox blob store was NOT: ${String(e)}`);
    throw new OutboxBlobClearError(e);
  }
}

/**
 * Put the bytes of a decoded row's blob back on it. A row with no `media.blob` is returned as is.
 * A blob that is absent or cannot be decrypted is the row's own verdict - this device will never
 * read that attachment - and so is {@link OutboxPayloadUnreadableError}, which the flusher parks as
 * a visible error. Any OTHER failure (the database would not open) is not a verdict and propagates
 * untouched, to be retried.
 *
 * A MISSING BLOB IS A VERDICT ONLY WHILE THE ROW STILL EXISTS. A cancel deletes the row and then
 * the blob; a read that loaded the row before the cancel and the blob after it finds no blob for a
 * message the member just deleted. `rowExists` is asked again at that point, and a row that is gone
 * resolves `null` - the same answer as "no longer queued" - instead of parking an error for it.
 */
export async function attachOutboxBlob(
  blobs: OutboxBlobStore,
  entry: OutboxEntry,
  rowExists: () => Promise<boolean>
): Promise<OutboxEntry | null> {
  const blob = entry.media?.blob;
  if (!entry.media || !blob) return entry;
  let fileBytes: Uint8Array;
  try {
    fileBytes = await blobs.get(outboxBlobId(entry.id, blob.slot), blob.keyB64);
  } catch (e) {
    if (e instanceof OutboxBlobMissingError && !(await rowExists())) {
      appendLog(`[DB] outbox ${entry.id}: row withdrawn while its blob was read - nothing to send`);
      return null;
    }
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
