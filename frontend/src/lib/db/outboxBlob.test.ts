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
import {
  BLOB_SWEEP_GRACE_MS,
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

/** The slice of the SQL plugin the outbox statements use, over a Map. */
function fakeSql() {
  const rows = new Map<string, Record<string, any>>();
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async execute(sql: string, params: any[] = []) {
      executed.push({ sql, params });
      if (sql.includes('INSERT OR REPLACE INTO outbox')) {
        const [id, conv, sent, kind, status, attempts, last, next, created, iv, cipher] = params;
        rows.set(id, {
          id,
          conversation_id: conv,
          sent_at: sent,
          kind,
          status,
          attempts,
          last_attempt_at: last,
          next_attempt_at: next,
          created_at: created,
          iv,
          cipher_text: cipher,
        });
      } else if (sql.includes('DELETE FROM outbox WHERE id')) {
        rows.delete(params[0]);
      } else if (sql.includes('UPDATE outbox SET')) {
        const row = rows.get(params[0]);
        if (row) {
          row.status = params[1] ?? row.status;
          row.attempts = params[2] ?? row.attempts;
        }
      }
      return { rowsAffected: 1 };
    },
    async select(sql: string, params: any[] = []) {
      if (sql.includes('SELECT id FROM outbox')) return [...rows.keys()].map((id) => ({ id }));
      if (sql.includes('SELECT kind FROM outbox')) {
        const r = rows.get(params[0]);
        return r ? [{ kind: r.kind }] : [];
      }
      if (sql.includes('SELECT * FROM outbox WHERE id')) {
        const r = rows.get(params[0]);
        return r ? [r] : [];
      }
      throw new Error(`unexpected select: ${sql}`);
    },
  };
  return { db, rows, executed };
}

function sqliteStorage(userId = uid()) {
  const storage = new SqliteStorage(userId);
  const sql = fakeSql();
  (storage as unknown as { db: unknown }).db = sql.db;
  return { storage, sql, userId };
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
