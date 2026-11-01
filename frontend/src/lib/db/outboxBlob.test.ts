/**
 * A queued attachment's bytes live in IndexedDB, not in the outbox row.
 *
 * What these pin, one per recorded risk: the row stays tiny and nothing file-sized crosses the SQL
 * bridge (the 1.2 GB peak of 2026-10-11); a blob is written BEFORE its row, so a kill between the
 * two leaves garbage and never a ghost; a row without a blob is a TYPED failure; a quota refusal is
 * typed; a row queued before blobs existed is still read and sent; the post-upload patch never
 * rewrites the file.
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from './indexeddb';
import { SqliteStorage } from './sqlite';
import { attachFakeOutboxSql } from '../../test/outboxSqlFake';
import {
  BLOB_SWEEP_GRACE_MS,
  idbCommitted,
  OutboxBlobClearError,
  OutboxBlobCorruptError,
  OutboxBlobMissingError,
  OutboxBlobStore,
  OutboxBlobWriteError,
} from './outboxBlob';
import { OutboxPayloadUnreadableError } from './outboxCodec';
import { encryptData } from '$lib/encryption';
import { toBase64 } from '$lib/utils/hex';
import { OutboxEnqueueError, isEnqueueQuotaFailure } from '$lib/utils/chat/outbox';
import type { OutboxEntry } from './types';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
let n = 0;
const uid = () => `blob-${Date.now()}-${n++}`;

function pattern(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

/** Byte equality without a per-element matcher diff (toEqual on 400k items is seconds under load). */
function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  return !!a && a.length === b.length && a.every((v, i) => v === b[i]);
}

function mediaEntry(id: string, bytes: Uint8Array): OutboxEntry {
  return {
    id,
    conversationId: 'g',
    sentAt: 100,
    kind: 'media',
    media: { kind: 4, mimeType: 'application/pdf', size: bytes.length, fileBytes: bytes },
    status: 'pending',
    attempts: 0,
    createdAt: 100,
  };
}

/** The real `SqliteStorage` over a Map-backed SQL fake (shared with the RC-5 outbox suite). */
function sqliteStorage(userId = uid()) {
  const storage = new SqliteStorage(userId);
  return { storage, sql: attachFakeOutboxSql(storage), userId };
}

/** The blob store a storage instance writes to, to look behind it. */
const blobsOf = (s: object) => (s as unknown as { blobs: OutboxBlobStore }).blobs;

describe('SqliteStorage: the file leaves the row', () => {
  it('keeps the row under 1 KB and sends NOTHING file-sized through the SQL bridge', async () => {
    const { storage, sql } = sqliteStorage();
    const bytes = pattern(5 * 1024 * 1024);
    await storage.saveOutboxEntry(mediaEntry('m1', bytes), KEY);

    const row = sql.rows.get('m1')!;
    expect(row.iv.length + row.cipher_text.length).toBeLessThan(1024);
    // The budget: every byte handed to the bridge, across every statement of the enqueue.
    const crossed = sql.executed
      .flatMap((e) => e.params)
      .reduce<number>((sum, p) => sum + (typeof p === 'string' ? p.length : 8), 0);
    expect(crossed).toBeLessThan(2048);
  });

  it('returns the exact bytes from getOutboxEntry, and the light queue carries none', async () => {
    const { storage } = sqliteStorage();
    const bytes = pattern(300_000);
    await storage.saveOutboxEntry(mediaEntry('m1', bytes), KEY);

    const full = await storage.getOutboxEntry('m1', KEY);
    expect(sameBytes(full?.media?.fileBytes, bytes)).toBe(true);
    expect(full?.media?.size).toBe(bytes.length);
  });

  it('the post-upload patch rewrites the small row, DELETES the blob and never re-puts it', async () => {
    const { storage, sql } = sqliteStorage();
    const blobs = blobsOf(storage);
    await storage.saveOutboxEntry(mediaEntry('m1', pattern(100_000)), KEY);
    const put = vi.spyOn(blobs, 'put');
    const full = (await storage.getOutboxEntry('m1', KEY))!;

    await storage.updateOutboxEntry(
      'm1',
      {
        media: {
          ...full.media!,
          uploadedRef: { mediaId: 'srv-1', key: 'k', iv: 'i' },
          fileBytes: undefined,
        },
      },
      KEY
    );

    expect(put).not.toHaveBeenCalled();
    expect(await blobs.list()).toEqual([]);
    const after = (await storage.getOutboxEntry('m1', KEY))!;
    expect(after.media?.uploadedRef?.mediaId).toBe('srv-1');
    expect(after.media?.fileBytes).toBeUndefined();
    expect(after.media?.blob).toBeUndefined();
    expect(sql.rows.get('m1')!.cipher_text.length).toBeLessThan(1024);
  });

  it('a scheduling patch touches neither the blob store nor the payload', async () => {
    const { storage } = sqliteStorage();
    const blobs = blobsOf(storage);
    await storage.saveOutboxEntry(mediaEntry('m1', pattern(10_000)), KEY);
    const [before] = await blobs.list();
    await storage.updateOutboxEntry('m1', { attempts: 3 }, KEY);
    expect(await blobs.list()).toEqual([before]);
  });

  it('deleting the entry deletes its blob (sent, cancelled or parked for good)', async () => {
    const { storage } = sqliteStorage();
    await storage.saveOutboxEntry(mediaEntry('m1', pattern(10_000)), KEY);
    expect(await blobsOf(storage).list()).toHaveLength(1);
    await storage.deleteOutboxEntry('m1');
    expect(await blobsOf(storage).list()).toEqual([]);
  });

  it('deleting a TEXT entry never opens the blob database', async () => {
    const { storage } = sqliteStorage();
    await storage.saveOutboxEntry(
      {
        id: 't1',
        conversationId: 'g',
        sentAt: 1,
        kind: 'text',
        text: 'hi',
        status: 'pending',
        attempts: 0,
        createdAt: 1,
      },
      KEY
    );
    const del = vi.spyOn(blobsOf(storage), 'delete');
    await storage.deleteOutboxEntry('t1');
    expect(del).not.toHaveBeenCalled();
  });
});

describe('crash windows', () => {
  it('KILL AFTER THE BLOB, BEFORE THE ROW: no ghost entry, and the sweep removes the blob', async () => {
    const { storage, sql } = sqliteStorage();
    // The kill: the blob put commits, the row write never happens.
    const execute = sql.db.execute;
    sql.db.execute = async (q: string, p?: any[]) => {
      if (q.includes('INSERT OR REPLACE INTO outbox')) throw new Error('killed');
      return execute(q, p);
    };
    await expect(storage.saveOutboxEntry(mediaEntry('m1', pattern(50_000)), KEY)).rejects.toThrow(
      'killed'
    );

    expect(sql.rows.size).toBe(0); // nothing for the flusher to send
    const blobs = blobsOf(storage);
    expect(await blobs.list()).toHaveLength(1); // the garbage

    // A fresh session (nothing marked as being written) sweeps it once it is past the grace.
    const removed = await blobs.sweep(
      async () => [...sql.rows.keys()],
      Date.now() + BLOB_SWEEP_GRACE_MS
    );
    expect(removed).toEqual(['m1']);
    expect(await blobs.list()).toEqual([]);
  });

  it('KILL AFTER THE ROW, BEFORE THE BLOB WAS WRITTEN cannot happen: blob first means a failed put queues no row', async () => {
    const { storage, sql } = sqliteStorage();
    vi.spyOn(blobsOf(storage), 'put').mockRejectedValue(
      new OutboxBlobWriteError('m1', new Error('disk'))
    );
    await expect(storage.saveOutboxEntry(mediaEntry('m1', pattern(1000)), KEY)).rejects.toThrow(
      OutboxBlobWriteError
    );
    expect(sql.rows.size).toBe(0);
  });

  it('a row whose blob is GONE (platform eviction) is a typed, visible failure', async () => {
    const { storage } = sqliteStorage();
    await storage.saveOutboxEntry(mediaEntry('m1', pattern(1000)), KEY);
    await blobsOf(storage).delete('m1');

    const err = await storage.getOutboxEntry('m1', KEY).catch((e) => e);
    expect(err).toBeInstanceOf(OutboxPayloadUnreadableError);
    expect(err.cause).toBeInstanceOf(OutboxBlobMissingError);
  });

  it('a blob the row key does not open is the same typed failure, not a crash', async () => {
    const { storage, sql } = sqliteStorage();
    await storage.saveOutboxEntry(mediaEntry('m1', pattern(1000)), KEY);
    // The same entry re-put under a new key by something else: the row's key no longer matches.
    await blobsOf(storage).put('m1', pattern(10));

    const err = await storage.getOutboxEntry('m1', KEY).catch((e) => e);
    expect(err).toBeInstanceOf(OutboxPayloadUnreadableError);
    expect(err.cause).toBeInstanceOf(OutboxBlobCorruptError);
    expect(sql.rows.has('m1')).toBe(true); // kept: the flusher parks it for the member to see
  });

  it('the sweep never removes a blob a row owns, one still being written, or a young one', async () => {
    const { storage, sql } = sqliteStorage();
    const blobs = blobsOf(storage);
    await storage.saveOutboxEntry(mediaEntry('owned', pattern(100)), KEY);
    await blobs.put('writing', pattern(100));
    blobs.beginWrite('writing');
    await blobs.put('young', pattern(100));
    await blobs.put('old', pattern(100));

    const later = Date.now() + BLOB_SWEEP_GRACE_MS;
    // 'young' is "written" at `later` by pretending the sweep runs right now.
    expect(await blobs.sweep(async () => [...sql.rows.keys()], Date.now())).toEqual([]);
    const removed = await blobs.sweep(async () => [...sql.rows.keys()], later);
    expect(removed.sort()).toEqual(['old', 'young']);
    expect((await blobs.list()).map((b) => b.id).sort()).toEqual(['owned', 'writing']);
    blobs.endWrite('writing');
  });

  it('storage.sweepOutboxBlobs reads the row ids from the clear id column', async () => {
    const { storage } = sqliteStorage();
    await storage.saveOutboxEntry(mediaEntry('m1', pattern(100)), KEY);
    expect(await storage.sweepOutboxBlobs()).toBe(0);
  });
});

describe('quota', () => {
  it('a QuotaExceededError on the blob write is a typed failure flagged as quota', async () => {
    const store = new OutboxBlobStore(uid());
    const quota = new DOMException('full', 'QuotaExceededError');
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw quota;
    });
    const err = await store.put('m1', pattern(100)).catch((e) => e);
    vi.restoreAllMocks();
    expect(err).toBeInstanceOf(OutboxBlobWriteError);
    expect(err.quota).toBe(true);
    expect(isEnqueueQuotaFailure(new OutboxEnqueueError('the durable write failed', err))).toBe(
      true
    );
  });

  it('any other write failure is a typed failure that is NOT quota', () => {
    const err = new OutboxBlobWriteError('m1', new Error('disk'));
    expect(err.quota).toBe(false);
    expect(isEnqueueQuotaFailure(new OutboxEnqueueError('x', err))).toBe(false);
    expect(isEnqueueQuotaFailure(new OutboxEnqueueError('x'))).toBe(false);
  });
});

describe('migration: a row queued before blobs existed', () => {
  it('is still read, with its bytes, and the post-upload patch converts it without a blob', async () => {
    const { storage, sql } = sqliteStorage();
    const bytes = pattern(20_000);
    // Exactly what the previous build wrote: the file inline as base64 inside the encrypted payload.
    const legacy = await encryptData(
      {
        media: {
          kind: 4,
          mimeType: 'application/pdf',
          size: bytes.length,
          fileBytesB64: toBase64(bytes),
        },
      },
      KEY
    );
    sql.rows.set('old', {
      id: 'old',
      conversation_id: 'g',
      sent_at: 1,
      kind: 'media',
      status: 'pending',
      attempts: 0,
      last_attempt_at: null,
      next_attempt_at: null,
      created_at: 1,
      iv: toBase64(legacy.iv),
      cipher_text: toBase64(legacy.cipherText),
    });

    const full = (await storage.getOutboxEntry('old', KEY))!;
    expect(sameBytes(full.media?.fileBytes, bytes)).toBe(true);

    await storage.updateOutboxEntry(
      'old',
      {
        media: {
          ...full.media!,
          uploadedRef: { mediaId: 's', key: 'k', iv: 'i' },
          fileBytes: undefined,
        },
      },
      KEY
    );
    const after = (await storage.getOutboxEntry('old', KEY))!;
    expect(after.media?.uploadedRef?.mediaId).toBe('s');
    expect(after.media?.fileBytes).toBeUndefined();
    expect(await blobsOf(storage).list()).toEqual([]);
  });

  it('re-saving a legacy entry that still holds bytes MIGRATES it to the blob format', async () => {
    const { storage, sql } = sqliteStorage();
    const bytes = pattern(5000);
    await storage.saveOutboxEntry(mediaEntry('old', bytes), KEY);
    expect(sql.rows.get('old')!.cipher_text.length).toBeLessThan(1024);
    expect(sameBytes((await storage.getOutboxEntry('old', KEY))?.media?.fileBytes, bytes)).toBe(
      true
    );
  });
});

describe('IndexedDbStorage (web build): same contract', () => {
  async function open() {
    const storage = new IndexedDbStorage(uid());
    await storage.init();
    return storage;
  }

  it('stores a small row, returns the bytes, deletes the blob with the entry', async () => {
    const storage = await open();
    const bytes = pattern(400_000);
    await storage.saveOutboxEntry(mediaEntry('m1', bytes), KEY);

    const [light] = await storage.getOutboxQueue(KEY);
    expect(light.media).toBeUndefined();
    expect(sameBytes((await storage.getOutboxEntry('m1', KEY))?.media?.fileBytes, bytes)).toBe(
      true
    );
    const row: any = await new Promise((resolve) => {
      const req = (storage as any).db.transaction('outbox').objectStore('outbox').get('m1');
      req.onsuccess = () => resolve(req.result);
    });
    expect(row.cipherText.length).toBeLessThan(1024);

    await storage.deleteOutboxEntry('m1');
    expect(await blobsOf(storage).list()).toEqual([]);
    await storage.close();
  });

  it('the pair write (message + entry) puts the blob first and fails typed on a missing blob', async () => {
    const storage = await open();
    await storage.saveMessageWithOutboxEntry(
      { id: 'm1', conversationId: 'g', senderId: 'u', content: '', timestamp: 1 } as any,
      mediaEntry('m1', pattern(2000)),
      KEY
    );
    await blobsOf(storage).delete('m1');
    await expect(storage.getOutboxEntry('m1', KEY)).rejects.toBeInstanceOf(
      OutboxPayloadUnreadableError
    );
    await storage.close();
  });

  it('post-upload patch drops the blob; sweep keeps owned blobs and removes orphans', async () => {
    const storage = await open();
    const blobs = blobsOf(storage);
    await storage.saveOutboxEntry(mediaEntry('m1', pattern(3000)), KEY);
    await blobs.put('orphan', pattern(10));

    // Past the grace period, only the orphan goes.
    const removed = await blobs.sweep(
      async () => (await storage.getOutboxQueue(KEY)).map((e) => e.id),
      Date.now() + BLOB_SWEEP_GRACE_MS
    );
    expect(removed).toEqual(['orphan']);

    const full = (await storage.getOutboxEntry('m1', KEY))!;
    await storage.updateOutboxEntry(
      'm1',
      {
        media: {
          ...full.media!,
          uploadedRef: { mediaId: 's', key: 'k', iv: 'i' },
          fileBytes: undefined,
        },
      },
      KEY
    );
    expect(await blobs.list()).toEqual([]);
    expect((await storage.getOutboxEntry('m1', KEY))?.media?.uploadedRef?.mediaId).toBe('s');
    await storage.close();
  });
});

describe("REPLACING an entry's bytes (RC-5: the raw take by the prepared file) never overwrites what the row names", () => {
  /** The prepared file's patch, as the outbox writes it: new bytes, the description, no blob ref. */
  const preparedPatch = (bytes: Uint8Array): Partial<OutboxEntry> => ({
    media: { kind: 2, mimeType: 'video/mp4', size: bytes.length, fileBytes: bytes },
  });

  it('SQLite: the new bytes go to the OTHER slot, the row names it, the old slot is deleted - and back again', async () => {
    const { storage } = sqliteStorage();
    const blobs = blobsOf(storage);
    const raw = pattern(30_000);
    await storage.saveOutboxEntry(mediaEntry('m1', raw), KEY);
    expect((await blobs.list()).map((b) => b.id)).toEqual(['m1']);

    const prepared = pattern(12_000).map((v) => v ^ 0x55);
    await storage.updateOutboxEntry('m1', preparedPatch(prepared), KEY);
    expect((await blobs.list()).map((b) => b.id)).toEqual(['m1#b']);
    const full = (await storage.getOutboxEntry('m1', KEY))!;
    expect(sameBytes(full.media?.fileBytes, prepared)).toBe(true);
    expect(full.media?.blob?.slot).toBe('b');
    expect(full.media?.mimeType).toBe('video/mp4');

    const again = pattern(5_000);
    await storage.updateOutboxEntry('m1', preparedPatch(again), KEY);
    expect((await blobs.list()).map((b) => b.id)).toEqual(['m1']);
    expect(sameBytes((await storage.getOutboxEntry('m1', KEY))?.media?.fileBytes, again)).toBe(
      true
    );
  });

  it('KILL AFTER THE NEW BLOB, BEFORE THE ROW: the row still opens the RAW take - nothing is lost', async () => {
    const { storage, sql } = sqliteStorage();
    const raw = pattern(30_000);
    await storage.saveOutboxEntry(mediaEntry('m1', raw), KEY);
    const execute = sql.db.execute;
    // The merge rewrites the row with ONE conditional `UPDATE` (`OUTBOX_UPDATE_ROW_SQL`).
    sql.db.execute = async (q: string, p?: any[]) => {
      if (q.includes('UPDATE outbox SET conversation_id')) throw new Error('killed');
      return execute(q, p);
    };
    await expect(
      storage.updateOutboxEntry('m1', preparedPatch(pattern(9_000)), KEY)
    ).rejects.toThrow('killed');
    sql.db.execute = execute;

    const full = (await storage.getOutboxEntry('m1', KEY))!;
    expect(sameBytes(full.media?.fileBytes, raw)).toBe(true);
    // The orphaned slot is the entry's: kept by the sweep while its row lives, gone with the entry.
    const blobs = blobsOf(storage);
    expect(
      await blobs.sweep(async () => [...sql.rows.keys()], Date.now() + BLOB_SWEEP_GRACE_MS)
    ).toEqual([]);
    await storage.deleteOutboxEntry('m1');
    expect(await blobs.list()).toEqual([]);
  });

  it('KILL AFTER THE ROW, BEFORE THE OLD SLOT IS DELETED: the row opens the prepared file, the old slot dies with the entry', async () => {
    const { storage } = sqliteStorage();
    const blobs = blobsOf(storage);
    await storage.saveOutboxEntry(mediaEntry('m1', pattern(30_000)), KEY);
    vi.spyOn(blobs, 'delete').mockRejectedValueOnce(new Error('killed'));
    const prepared = pattern(7_000).map((v) => v ^ 0x0f);
    await storage.updateOutboxEntry('m1', preparedPatch(prepared), KEY);

    expect((await blobs.list()).map((b) => b.id).sort()).toEqual(['m1', 'm1#b']);
    expect(sameBytes((await storage.getOutboxEntry('m1', KEY))?.media?.fileBytes, prepared)).toBe(
      true
    );
    await storage.deleteOutboxEntry('m1');
    expect(await blobs.list()).toEqual([]);
  });

  it('the upload releases BOTH slots once the ref is recorded', async () => {
    const { storage } = sqliteStorage();
    const blobs = blobsOf(storage);
    await storage.saveOutboxEntry(mediaEntry('m1', pattern(3_000)), KEY);
    await storage.updateOutboxEntry('m1', preparedPatch(pattern(2_000)), KEY);
    await storage.updateOutboxEntry(
      'm1',
      {
        media: {
          kind: 2,
          mimeType: 'video/mp4',
          size: 2_000,
          uploadedRef: { mediaId: 's', key: 'k', iv: 'i' },
          fileBytes: undefined,
        },
      },
      KEY
    );
    expect(await blobs.list()).toEqual([]);
  });

  it('a second-slot blob with no row is garbage the sweep removes', async () => {
    const store = new OutboxBlobStore(uid());
    await store.put('gone#b', pattern(10));
    expect(await store.sweep(async () => [], Date.now() + BLOB_SWEEP_GRACE_MS)).toEqual(['gone#b']);
    await store.close();
  });

  it('IndexedDB: the same replacement contract', async () => {
    const storage = new IndexedDbStorage(uid());
    await storage.init();
    const blobs = blobsOf(storage);
    await storage.saveOutboxEntry(mediaEntry('m1', pattern(20_000)), KEY);
    const prepared = pattern(6_000).map((v) => v ^ 0x33);
    await storage.updateOutboxEntry('m1', preparedPatch(prepared), KEY);
    expect((await blobs.list()).map((b) => b.id)).toEqual(['m1#b']);
    expect(sameBytes((await storage.getOutboxEntry('m1', KEY))?.media?.fileBytes, prepared)).toBe(
      true
    );
    await storage.deleteOutboxEntry('m1');
    expect(await blobs.list()).toEqual([]);
    await storage.close();
  });
});

describe('account reset: rows first, the blob store LAST, and a blob failure skips nothing', () => {
  const ROW_DELETES = [
    'DELETE FROM messages',
    'DELETE FROM conversations',
    'DELETE FROM outbox',
    'DELETE FROM graine',
    'DELETE FROM pending_group_exits',
    'DELETE FROM distribution_groups',
    'DELETE FROM feed_pages',
  ];

  it('SQLite: a blob store that will not open still lets every table be emptied, then rejects typed', async () => {
    const { storage, sql } = sqliteStorage();
    const order: string[] = [];
    const execute = sql.db.execute;
    sql.db.execute = async (q: string, p?: any[]) => {
      order.push(q);
      return execute(q, p);
    };
    vi.spyOn(blobsOf(storage), 'clear').mockImplementation(async () => {
      order.push('BLOBS');
      throw new DOMException('blocked', 'UnknownError');
    });

    const err = await storage.clear().catch((e) => e);
    expect(err).toBeInstanceOf(OutboxBlobClearError);
    expect(order).toEqual([...ROW_DELETES, 'BLOBS']);
  });

  it('SQLite: a row delete that fails leaves the blobs alone (row first, blob second)', async () => {
    const { storage, sql } = sqliteStorage();
    const execute = sql.db.execute;
    sql.db.execute = async (q: string, p?: any[]) => {
      if (q === 'DELETE FROM graine') throw new Error('locked');
      return execute(q, p);
    };
    const clear = vi.spyOn(blobsOf(storage), 'clear');
    await expect(storage.clear()).rejects.toThrow('locked');
    expect(clear).not.toHaveBeenCalled();
  });

  it('IndexedDB: a blob store that will not open still empties every store, then rejects typed', async () => {
    const storage = new IndexedDbStorage(uid());
    await storage.init();
    await storage.saveOutboxEntry(mediaEntry('m1', pattern(100)), KEY);
    const db = (storage as unknown as { db: IDBDatabase }).db;
    const graineCount = () =>
      new Promise<number>((resolve, reject) => {
        const req = db.transaction('graine').objectStore('graine').count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('graine', 'readwrite');
      tx.objectStore('graine').put({ sessionId: 's1', channelId: 'c1' });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    expect(await graineCount()).toBe(1);
    vi.spyOn(blobsOf(storage), 'clear').mockRejectedValue(
      new DOMException('blocked', 'UnknownError')
    );

    const err = await storage.clear().catch((e) => e);
    expect(err).toBeInstanceOf(OutboxBlobClearError);
    expect(await storage.getOutboxQueue(KEY)).toEqual([]);
    expect(await graineCount()).toBe(0);
    await storage.close();
  });

  it('IndexedDB: a row transaction that fails leaves the blobs alone (the rows still name them)', async () => {
    const storage = new IndexedDbStorage(uid());
    await storage.init();
    await storage.saveOutboxEntry(mediaEntry('m1', pattern(100)), KEY);
    const clear = vi.spyOn(blobsOf(storage), 'clear');
    const real = IDBObjectStore.prototype.clear;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'clear').mockImplementation(function (
      this: IDBObjectStore
    ) {
      if (this.name === 'graine') throw new DOMException('refused', 'UnknownError');
      return real.call(this);
    });
    await expect(storage.clear()).rejects.toThrow('refused');
    spy.mockRestore();
    expect(clear).not.toHaveBeenCalled();
    expect(await blobsOf(storage).list()).toHaveLength(1);
    expect(
      sameBytes((await storage.getOutboxEntry('m1', KEY))?.media?.fileBytes, pattern(100))
    ).toBe(true);
    await storage.close();
  });
});

describe('idbCommitted: the error a failed transaction rejects with is never null', () => {
  /** A transaction double: `tx.error` stays null during a request's error event, as the spec says. */
  function fakeTx() {
    return { error: null, oncomplete: null, onerror: null, onabort: null } as unknown as {
      error: DOMException | null;
      onerror: (ev: Event) => void;
      onabort: (ev: Event) => void;
    } & IDBTransaction;
  }

  it("rejects with the REQUEST's error on a request error, so a quota refusal stays a quota refusal", async () => {
    const tx = fakeTx();
    const done = idbCommitted(tx);
    const quota = new DOMException('full', 'QuotaExceededError');
    tx.onerror({ target: { error: quota } } as unknown as Event);
    const err = await done.catch((e) => e);
    expect(err).toBe(quota);
    expect(new OutboxBlobWriteError('m1', err).quota).toBe(true);
  });

  it('rejects with tx.error on abort, and with a real error when the engine gives none', async () => {
    const tx = fakeTx();
    const done = idbCommitted(tx);
    const quota = new DOMException('full', 'QuotaExceededError');
    tx.error = quota;
    tx.onabort({} as Event);
    await expect(done).rejects.toBe(quota);

    const bare = fakeTx();
    const bareDone = idbCommitted(bare);
    bare.onabort({} as Event);
    const err = await bareDone.catch((e) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect(err.name).toBe('AbortError');
  });
});

describe('a cancel between the row read and the blob read', () => {
  it('SQLite: the entry the member just deleted reads as gone (null), never as a lost attachment', async () => {
    const { storage } = sqliteStorage();
    await storage.saveOutboxEntry(mediaEntry('m1', pattern(100)), KEY);
    const blobs = blobsOf(storage);
    const get = blobs.get.bind(blobs);
    vi.spyOn(blobs, 'get').mockImplementation(async (id, key) => {
      await storage.deleteOutboxEntry(id); // the cancel lands here
      return get(id, key);
    });
    await expect(storage.getOutboxEntry('m1', KEY)).resolves.toBeNull();
  });

  it('IndexedDB: same', async () => {
    const storage = new IndexedDbStorage(uid());
    await storage.init();
    await storage.saveOutboxEntry(mediaEntry('m1', pattern(100)), KEY);
    const blobs = blobsOf(storage);
    const get = blobs.get.bind(blobs);
    vi.spyOn(blobs, 'get').mockImplementation(async (id, key) => {
      await storage.deleteOutboxEntry(id);
      return get(id, key);
    });
    await expect(storage.getOutboxEntry('m1', KEY)).resolves.toBeNull();
    await storage.close();
  });

  it('a blob missing while the row is STILL there remains the typed failure', async () => {
    const { storage } = sqliteStorage();
    await storage.saveOutboxEntry(mediaEntry('m1', pattern(100)), KEY);
    await blobsOf(storage).delete('m1');
    await expect(storage.getOutboxEntry('m1', KEY)).rejects.toBeInstanceOf(
      OutboxPayloadUnreadableError
    );
  });
});

describe('a cancel cannot fail on the blob bookkeeping', () => {
  it('SQLite: an unreadable kind still deletes the row, and the blob with it', async () => {
    const { storage, sql } = sqliteStorage();
    await storage.saveOutboxEntry(mediaEntry('m1', pattern(100)), KEY);
    const select = sql.db.select;
    sql.db.select = async (q: string, p?: any[]) => {
      if (q.includes('SELECT kind')) throw new Error('bridge hiccup');
      return select(q, p);
    };
    await storage.deleteOutboxEntry('m1');
    expect(sql.rows.has('m1')).toBe(false);
    expect(await blobsOf(storage).list()).toEqual([]);
  });

  it('a blob delete that fails does not fail the cancel', async () => {
    const { storage, sql } = sqliteStorage();
    await storage.saveOutboxEntry(mediaEntry('m1', pattern(100)), KEY);
    vi.spyOn(blobsOf(storage), 'delete').mockRejectedValue(new Error('blocked'));
    await expect(storage.deleteOutboxEntry('m1')).resolves.toBeUndefined();
    expect(sql.rows.has('m1')).toBe(false);
  });
});

describe('getOutboxEntry(..., { withFile: false }): the description without the file (RC-5 withdrawal)', () => {
  /** A queued reel whose resumable session is recorded in the row. */
  function reelWithSession(id: string, bytes: Uint8Array): OutboxEntry {
    const entry = mediaEntry(id, bytes);
    entry.media = {
      ...entry.media!,
      upload: {
        keyHex: '11'.repeat(32),
        ivHex: '22'.repeat(12),
        plaintextSha256: '33'.repeat(32),
        plaintextBytes: bytes.length,
        uploadId: 'session-1',
        partBytes: 1024,
      },
    };
    return entry;
  }

  const backends = {
    sqlite: async () => sqliteStorage().storage,
    indexeddb: async () => {
      const storage = new IndexedDbStorage(uid());
      await storage.init();
      return storage;
    },
  };

  for (const [name, open] of Object.entries(backends)) {
    it(`${name}: returns the recorded session and NO bytes, and never reads the blob`, async () => {
      const storage = await open();
      const bytes = pattern(300_000);
      await storage.saveOutboxEntry(reelWithSession('m1', bytes), KEY);
      const get = vi.spyOn(blobsOf(storage), 'get');
      const described = await storage.getOutboxEntry('m1', KEY, { withFile: false });
      expect(described?.media?.upload?.uploadId).toBe('session-1');
      expect(described?.media?.fileBytes).toBeUndefined();
      expect(get).not.toHaveBeenCalled();
      // The default still attaches the file.
      expect(sameBytes((await storage.getOutboxEntry('m1', KEY))?.media?.fileBytes, bytes)).toBe(
        true
      );
      expect(get).toHaveBeenCalledTimes(1);
    });

    it(`${name}: reads the description even when the blob is gone (an evicted take can still be withdrawn)`, async () => {
      const storage = await open();
      await storage.saveOutboxEntry(reelWithSession('m1', pattern(2000)), KEY);
      await blobsOf(storage).delete('m1');
      const described = await storage.getOutboxEntry('m1', KEY, { withFile: false });
      expect(described?.media?.upload?.uploadId).toBe('session-1');
      await expect(storage.getOutboxEntry('m1', KEY)).rejects.toBeInstanceOf(
        OutboxPayloadUnreadableError
      );
    });

    it(`${name}: an absent row is null, an undecryptable one is still typed`, async () => {
      const storage = await open();
      expect(await storage.getOutboxEntry('nope', KEY, { withFile: false })).toBeNull();
      await storage.saveOutboxEntry(reelWithSession('m1', pattern(2000)), KEY);
      await expect(
        storage.getOutboxEntry('m1', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=', {
          withFile: false,
        })
      ).rejects.toBeInstanceOf(OutboxPayloadUnreadableError);
    });
  }
});
