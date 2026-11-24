/// <reference types="jest" />

/**
 * AN ERASED OWNER REGISTERS NOTHING (docs/wiki/services/media-service.md#an-erased-owner-registers-nothing-2026-11-24).
 *
 * The account erasure records the owner (a keyed pseudonym) and the time of the call before it
 * reads the index, and every path that registers an object reads that record in the same
 * synchronous run as the entry it would write, refusing a credential minted before the call.
 * Pinned, each because the opposite is a plausible mistake:
 *  - the closing test of the backlog entry, on the single-request upload: after the erasure an upload
 *    by ALICE is refused, nothing is stored and no entry names her;
 *  - an upload whose bytes are being stored when the erasure lands ends REFUSED (its object deleted),
 *    one registered before ends ERASED - never kept;
 *  - every other registering path (form file, public image, chunked init and complete) refuses too;
 *  - a person who came back under the same id (a token minted after the call) is NOT refused;
 *  - a refused object whose delete fails is owed, kept in the index and retried by the sweep;
 *  - a completed legacy chunk upload's memo naming the owner goes with the erasure;
 *  - the record outlives the erasure by the derived window, and longer while an upload admitted
 *    before it still runs; it survives a restart, and an index entry that is not a digest is dropped.
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import { MediaService } from './media.service';
import { OWNER_ERASED, erasedOwnerKey, erasedOwnerKeptMs } from './erased-owners';

// The record is keyed by an HMAC under this secret (erased-owners.ts).
process.env.JWT_SECRET ??= 'test-erasure-key';

type Entry = {
  ownerId?: string;
  purgedAt?: number;
  publicAsset?: boolean;
  deletePending?: true;
};

type Internals = {
  meta: { items: Record<string, Entry>; erasedOwners?: Record<string, number> };
  storage: Record<string, unknown>;
  logger: Record<'log' | 'debug' | 'warn' | 'error', (msg: string) => void>;
  persistMetadata: () => Promise<void>;
  uploadLocks: Map<string, Promise<void>>;
  forgetLapsedErasedOwners: (now: number) => number;
  retryPendingDeletes: () => Promise<number>;
  runSweep: () => Promise<void>;
  loadMetadata: () => void;
  chunkTempPath: (id: string) => string;
};

/** A service over a recording store: `stored` is what the bucket holds now. */
function build() {
  const service = Object.create(MediaService.prototype) as MediaService;
  const internals = service as unknown as Internals;
  const stored = new Set<string>();
  const warned: string[] = [];
  const errored: string[] = [];
  const gate = { held: undefined as Promise<void> | undefined, reached: () => {} };
  /** While set, the store refuses every delete (an outage). */
  const deletes = { failing: false };
  const write = async (id: string) => {
    gate.reached();
    if (gate.held) await gate.held;
    stored.add(id);
  };
  internals.meta = { items: Object.create(null) as Record<string, Entry> };
  internals.storage = {
    put: (id: string) => write(id),
    putFileStream: (id: string) => write(id),
    delete: async (id: string) => {
      if (deletes.failing) throw new Error('store unreachable');
      stored.delete(id);
    },
  };
  internals.logger = {
    log: () => {},
    debug: () => {},
    warn: (msg) => void warned.push(msg),
    error: (msg) => void errored.push(msg),
  };
  internals.uploadLocks = new Map();
  internals.persistMetadata = () => Promise.resolve();
  const naming = (owner: string) =>
    Object.values(internals.meta.items).filter((e) => e.ownerId === owner);
  /** Holds the next store write until `release` is called; resolves `reached` when it starts. */
  const holdStore = () => {
    let release!: () => void;
    gate.held = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (gate.reached = resolve));
    return {
      reached,
      release: () => {
        gate.held = undefined;
        release();
      },
    };
  };
  return { service, internals, stored, warned, errored, naming, holdStore, deletes };
}

const refusal = { status: 410, response: { code: OWNER_ERASED } };
/** Shaped like a real account id (authentik's hashed subject is long): the log keeps a prefix only. */
const ALICE = 'a11ce9f0c4d2b6e8a11ce9f0c4d2b6e8';

describe('the single-request upload of an erased owner', () => {
  it('THE CLOSING TEST: after the erasure, an upload by ALICE is refused, nothing is stored, no entry names her', async () => {
    const { service, stored, naming, warned } = build();
    await service.upload(Buffer.alloc(10), ALICE, 'ephemeral');
    expect(naming(ALICE)).toHaveLength(1);

    await expect(service.removeAllOwnedBy(ALICE)).resolves.toEqual({ deleted: 1, failed: 0 });

    await expect(service.upload(Buffer.alloc(10), ALICE, 'ephemeral')).rejects.toMatchObject(
      refusal
    );
    expect(stored.size).toBe(0);
    expect(naming(ALICE)).toEqual([]);
    // The refusal accuses, and names no full id.
    expect(warned.some((w) => w.startsWith('[ERASED_OWNER] upload refused'))).toBe(true);
    expect(warned.join('\n')).not.toContain(ALICE);
    // Another member is untouched.
    await expect(service.upload(Buffer.alloc(10), 'bob')).resolves.toBeDefined();
  });

  it('INTERLEAVED: the erasure landing while the bytes are stored ends refused, the object deleted', async () => {
    const { service, stored, naming, holdStore } = build();
    const store = holdStore();
    const uploading = service.upload(Buffer.alloc(10), 'alice', 'archive');
    await store.reached;

    await service.removeAllOwnedBy('alice'); // finds nothing registered yet
    store.release();

    await expect(uploading).rejects.toMatchObject(refusal);
    expect(stored.size).toBe(0);
    expect(naming('alice')).toEqual([]);
  });

  it('A PERSON WHO CAME BACK: a token minted after the call is accepted, one minted at or before is refused', async () => {
    const { service, internals, stored, naming } = build();
    await service.removeAllOwnedBy(ALICE);
    const erasedAt = internals.meta.erasedOwners?.[erasedOwnerKey(ALICE)] ?? 0;
    // `iat` is whole seconds: a token of the second before the call is the erased account's.
    const before = (Math.floor(erasedAt / 1000) - 1) * 1000;
    const after = (Math.floor(erasedAt / 1000) + 2) * 1000;

    await expect(
      service.upload(Buffer.alloc(10), ALICE, 'ephemeral', before)
    ).rejects.toMatchObject(refusal);
    await expect(
      service.upload(Buffer.alloc(10), ALICE, 'ephemeral', undefined)
    ).rejects.toMatchObject(refusal); // a credential that cannot be dated is the old one
    expect(stored.size).toBe(0);

    const mediaId = await service.upload(Buffer.alloc(10), ALICE, 'ephemeral', after);
    expect(stored.has(mediaId)).toBe(true);
    expect(naming(ALICE)).toHaveLength(1);
    // The same holds on the chunked path the old clients use.
    await expect(
      service.initChunkedUpload(ALICE, undefined, undefined, 1e8, after)
    ).resolves.toBeDefined();
  });

  it('INTERLEAVED: an upload registered before the erasure reads the index ends erased', async () => {
    const { service, stored, naming } = build();
    const mediaId = await service.upload(Buffer.alloc(10), 'alice', 'archive');
    const erasing = service.removeAllOwnedBy('alice');
    await expect(erasing).resolves.toEqual({ deleted: 1, failed: 0 });
    expect(stored.has(mediaId)).toBe(false);
    expect(naming('alice')).toEqual([]);
  });
});

describe('every other path that registers an object refuses an erased owner', () => {
  it('a form file: dated by the forwarded token, undated is old', async () => {
    const { service, internals, stored, naming } = build();
    await service.removeAllOwnedBy('alice');
    const erasedAt = internals.meta.erasedOwners?.[erasedOwnerKey('alice')] ?? 0;
    await expect(service.uploadFormFile(Buffer.from('%PDF-1.4'), 'alice')).rejects.toMatchObject(
      refusal
    );
    await expect(
      service.uploadFormFile(Buffer.from('%PDF-1.4'), 'alice', erasedAt - 1000)
    ).rejects.toMatchObject(refusal);
    expect(stored.size).toBe(0);
    expect(naming('alice')).toEqual([]);
    // A person who came back answers a form with a file like anyone.
    const back = (Math.floor(erasedAt / 1000) + 2) * 1000;
    await expect(
      service.uploadFormFile(Buffer.from('%PDF-1.4'), 'alice', back)
    ).resolves.toMatchObject({ sizeBytes: 8 });
    expect(naming('alice')).toHaveLength(1);
  });

  it('a public image: it records no owner, but would be cited by nothing', async () => {
    const { service, stored, internals } = build();
    await service.removeAllOwnedBy('alice');
    await expect(
      service.uploadPublicAsset(Buffer.alloc(4), 'image/webp', 'alice')
    ).rejects.toMatchObject(refusal);
    expect(stored.size).toBe(0);
    expect(Object.keys(internals.meta.items)).toEqual([]);
  });

  it('a chunked init stages nothing, and a chunked complete of a session opened before removes its staging', async () => {
    const { service, internals, stored, naming } = build();
    const before = await service.initChunkedUpload('alice', undefined, undefined, 1e8);
    await service.appendChunk(before, Buffer.alloc(16), 1e8, 'alice');
    const staging = internals.chunkTempPath(before);
    expect(await fs.pathExists(staging)).toBe(true);

    await service.removeAllOwnedBy('alice');

    await expect(service.initChunkedUpload('alice')).rejects.toMatchObject(refusal);
    await expect(service.completeChunkedUpload(before, 1e8, 'alice')).rejects.toMatchObject(
      refusal
    );
    expect(await fs.pathExists(staging)).toBe(false);
    expect(stored.size).toBe(0);
    expect(naming('alice')).toEqual([]);
  });

  it('a chunked complete whose bytes are being stored when the erasure lands: refused, object and staging gone', async () => {
    const { service, internals, stored, naming, holdStore } = build();
    const id = await service.initChunkedUpload('alice', undefined, undefined, 1e8);
    await service.appendChunk(id, Buffer.alloc(16), 1e8, 'alice');
    const store = holdStore();
    const completing = service.completeChunkedUpload(id, 1e8, 'alice');
    await store.reached;
    // The record is written in the erasure's first synchronous run; ending the open session then
    // waits for the session's lock, which the completion holds until its store returns.
    const erasing = service.removeAllOwnedBy('alice');
    store.release();

    await expect(completing).rejects.toMatchObject(refusal);
    await expect(erasing).resolves.toMatchObject({ failed: 0 });
    expect(stored.size).toBe(0);
    expect(await fs.pathExists(internals.chunkTempPath(id))).toBe(false);
    expect(naming('alice')).toEqual([]);
  });
});

describe('what the erasure leaves nobody to end', () => {
  it('a refused object whose delete fails is OWED: an ownerless tombstone the sweep retries, never trimmed', async () => {
    const { service, internals, stored, holdStore, deletes } = build();
    const store = holdStore();
    const uploading = service.upload(Buffer.alloc(10), 'alice', 'archive');
    await store.reached;
    await service.removeAllOwnedBy('alice');
    deletes.failing = true;
    store.release();
    await expect(uploading).rejects.toMatchObject(refusal);

    const [mediaId] = [...stored];
    expect(mediaId).toBeDefined();
    const owed = internals.meta.items[mediaId];
    expect(owed).toMatchObject({ deletePending: true });
    expect(owed.ownerId).toBeUndefined();
    expect(owed.purgedAt).toBeDefined();

    // Still failing: retried, still owed.
    await expect(internals.retryPendingDeletes()).resolves.toBe(0);
    expect(internals.meta.items[mediaId]?.deletePending).toBe(true);
    // Not trimmed with the old tombstones while owed, however old.
    internals.meta.items[mediaId] = { ...owed, purgedAt: 1 };
    await internals.runSweep();
    expect(internals.meta.items[mediaId]?.deletePending).toBe(true);

    // The store recovers: the sweep's retry confirms it, and the object is gone.
    deletes.failing = false;
    await internals.runSweep();
    expect(stored.has(mediaId)).toBe(false);
    expect(internals.meta.items[mediaId]?.deletePending).toBeUndefined();
  });

  it('a refusal stays a 410 when the owed delete cannot be written to the index yet', async () => {
    const { service, internals, stored, holdStore, deletes, errored } = build();
    const store = holdStore();
    const uploading = service.upload(Buffer.alloc(10), 'alice', 'archive');
    await store.reached;
    await service.removeAllOwnedBy('alice');
    deletes.failing = true;
    internals.persistMetadata = () => Promise.reject(new Error('disk full'));
    store.release();

    await expect(uploading).rejects.toMatchObject(refusal);
    const [mediaId] = [...stored];
    expect(internals.meta.items[mediaId]).toMatchObject({ deletePending: true });
    expect(errored.some((e) => e.includes('could not be written to the index yet'))).toBe(true);
  });

  it("a completed chunk upload's memo naming the erased owner goes; another member's stays", async () => {
    const { service, internals } = build();
    const complete = async (owner: string) => {
      const id = await service.initChunkedUpload(owner, undefined, undefined, 1e8);
      await service.appendChunk(id, Buffer.alloc(16), 1e8, owner);
      await service.completeChunkedUpload(id, 1e8, owner);
      return `${internals.chunkTempPath(id)}.done`;
    };
    const alicesMemo = await complete('alice');
    const bobsMemo = await complete('bob');
    expect(await fs.pathExists(alicesMemo)).toBe(true);

    await expect(service.removeAllOwnedBy('alice')).resolves.toMatchObject({ failed: 0 });

    expect(await fs.pathExists(alicesMemo)).toBe(false);
    expect(await fs.pathExists(bobsMemo)).toBe(true);
  });
});

describe('the record', () => {
  it('is kept past its window while an upload admitted before the erasure still runs, then dropped', async () => {
    const { service, internals, holdStore } = build();
    const store = holdStore();
    const uploading = service.upload(Buffer.alloc(10), 'alice');
    await store.reached;
    await service.removeAllOwnedBy('alice');
    const key = erasedOwnerKey('alice');
    const lapsed = (internals.meta.erasedOwners?.[key] ?? 0) + erasedOwnerKeptMs();

    expect(internals.forgetLapsedErasedOwners(lapsed - 1)).toBe(0); // inside its window
    expect(internals.forgetLapsedErasedOwners(lapsed)).toBe(0); // past it, but the upload runs
    expect(internals.meta.erasedOwners?.[key]).toBeDefined();

    store.release();
    await expect(uploading).rejects.toMatchObject(refusal);
    expect(internals.forgetLapsedErasedOwners(lapsed)).toBe(1);
    expect(internals.meta.erasedOwners?.[key]).toBeUndefined();
  });

  it('is NOT held past its window by an upload of a person who came back', async () => {
    const { service, internals, holdStore } = build();
    await service.removeAllOwnedBy('alice');
    const key = erasedOwnerKey('alice');
    const erasedAt = internals.meta.erasedOwners?.[key] ?? 0;
    const store = holdStore();
    const back = (Math.floor(erasedAt / 1000) + 2) * 1000;
    const uploading = service.upload(Buffer.alloc(10), 'alice', 'ephemeral', back);
    await store.reached;
    // The record would not refuse this upload, so it does not keep the record either.
    expect(internals.forgetLapsedErasedOwners(erasedAt + erasedOwnerKeptMs())).toBe(1);
    store.release();
    await expect(uploading).resolves.toBeDefined();
  });

  it('runs from the LATEST erasure call: the final pass extends it', async () => {
    const { service, internals } = build();
    const key = erasedOwnerKey('alice');
    await service.removeAllOwnedBy('alice');
    const first = internals.meta.erasedOwners?.[key] ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.removeAllOwnedBy('alice');
    expect(internals.meta.erasedOwners?.[key]).toBeGreaterThan(first);
  });

  it('survives a restart, and an entry that is not a digest with a time is dropped at load', async () => {
    const { service } = build();
    // The real write: temp file then rename, under this spec file's temporary working directory.
    const internals = service as unknown as Internals;
    delete (internals as Partial<Internals>).persistMetadata;
    fs.ensureDirSync(path.join(process.cwd(), 'media_meta')); // the constructor's job
    await service.removeAllOwnedBy('alice');

    const file = path.join(process.cwd(), 'media_meta', 'media_metadata.json');
    const onDisk = (await fs.readJson(file)) as { erasedOwners: Record<string, unknown> };
    expect(JSON.stringify(onDisk)).not.toContain('alice');
    onDisk.erasedOwners['not-a-digest'] = 1;
    onDisk.erasedOwners[erasedOwnerKey('bob')] = 'yesterday';
    await fs.writeJson(file, onDisk);

    const restarted = build();
    restarted.internals.loadMetadata();
    expect(Object.keys(restarted.internals.meta.erasedOwners ?? {})).toEqual([
      erasedOwnerKey('alice'),
    ]);
    await expect(restarted.service.upload(Buffer.alloc(1), 'alice')).rejects.toMatchObject(refusal);
  });
});
