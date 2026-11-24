/// <reference types="jest" />

/**
 * AN ERASED OWNER REGISTERS NOTHING (docs/wiki/services/media-service.md#an-erased-owner-registers-nothing-2026-11-24).
 *
 * The account erasure records the owner (a digest) before it reads the index, and every path that
 * registers an object reads that record in the same synchronous run as the entry it would write.
 * Pinned, each because the opposite is a plausible mistake:
 *  - the closing test of the backlog entry, on the single-request upload: after the erasure an upload
 *    by ALICE is refused, nothing is stored and no entry names her;
 *  - an upload whose bytes are being stored when the erasure lands ends REFUSED (its object deleted),
 *    one registered before ends ERASED - never kept;
 *  - every other registering path (form file, public image, chunked init and complete) refuses too;
 *  - the record outlives the erasure by the derived window, and longer while an upload admitted
 *    before it still runs; it survives a restart, and an index entry that is not a digest is dropped.
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import { MediaService } from './media.service';
import { OWNER_ERASED, erasedOwnerKey, erasedOwnerKeptMs } from './erased-owners';

type Entry = { ownerId?: string; purgedAt?: number; publicAsset?: boolean };

type Internals = {
  meta: { items: Record<string, Entry>; erasedOwners?: Record<string, number> };
  storage: Record<string, unknown>;
  logger: Record<'log' | 'debug' | 'warn' | 'error', (msg: string) => void>;
  persistMetadata: () => Promise<void>;
  uploadLocks: Map<string, Promise<void>>;
  forgetLapsedErasedOwners: (now: number) => number;
  loadMetadata: () => void;
  chunkTempPath: (id: string) => string;
};

/** A service over a recording store: `stored` is what the bucket holds now. */
function build() {
  const service = Object.create(MediaService.prototype) as MediaService;
  const internals = service as unknown as Internals;
  const stored = new Set<string>();
  const warned: string[] = [];
  const gate = { held: undefined as Promise<void> | undefined, reached: () => {} };
  const write = async (id: string) => {
    gate.reached();
    if (gate.held) await gate.held;
    stored.add(id);
  };
  internals.meta = { items: Object.create(null) as Record<string, Entry> };
  internals.storage = {
    put: (id: string) => write(id),
    putFileStream: (id: string) => write(id),
    delete: async (id: string) => void stored.delete(id),
  };
  internals.logger = {
    log: () => {},
    debug: () => {},
    warn: (msg) => void warned.push(msg),
    error: () => {},
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
  return { service, internals, stored, warned, naming, holdStore };
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
  it('a form file', async () => {
    const { service, stored, naming } = build();
    await service.removeAllOwnedBy('alice');
    await expect(service.uploadFormFile(Buffer.from('%PDF-1.4'), 'alice')).rejects.toMatchObject(
      refusal
    );
    expect(stored.size).toBe(0);
    expect(naming('alice')).toEqual([]);
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
    await service.removeAllOwnedBy('alice');
    store.release();

    await expect(completing).rejects.toMatchObject(refusal);
    expect(stored.size).toBe(0);
    expect(await fs.pathExists(internals.chunkTempPath(id))).toBe(false);
    expect(naming('alice')).toEqual([]);
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
