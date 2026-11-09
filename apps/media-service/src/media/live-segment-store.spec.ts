/**
 * The live segments' own store (live replays WP-R3, docs/wiki/live-replays.md, D2: replays are never
 * in backups). What is load-bearing:
 *  - a segment is stored, read and deleted on the `live_segments` directory, never in the object
 *    store the backup reads - and the object store REFUSES a `live/` key, so no path can put one there;
 *  - the purge's proof (a re-listing that answers 0) and the reaper's folder listing hold on a disk,
 *    which means the folder of a purged live goes with its last segment;
 *  - the boot drain empties what an older release left in the object store, and only that prefix;
 *  - the storage panel's live line is read from this store, and a `live/` key in the bucket is an
 *    accusation (`untracked`), not a live segment.
 * The store runs on a real temporary directory; the object store is a stub.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LiveSegmentStore } from './live-segment-store';
import { LiveSegmentsService } from './live-segments.service';
import { MediaService } from './media.service';
import type { StorageService, StoredObject } from './storage.service';

const LIVE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SEG_A = '33333333-3333-4333-8333-333333333333';
const SEG_B = '44444444-4444-4444-8444-444444444444';
const CHAT_BLOB = '55555555-5555-4555-8555-555555555555';

const quiet = <T>(svc: T): T => {
  (svc as unknown as { logger: unknown }).logger = {
    log: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  };
  return svc;
};

/** The object store as a map, with a switch that makes every call fail like an outage. */
function objectStore(initial: Record<string, string> = {}) {
  const objects = new Map(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]));
  const state = { down: false };
  const stub = {
    listObjects: async (prefix = ''): Promise<StoredObject[]> => {
      if (state.down) throw new Error('garage unreachable');
      return [...objects.entries()]
        .filter(([id]) => id.startsWith(prefix))
        .map(([id, data]) => ({ id, size: data.length, lastModifiedMs: null }));
    },
    delete: async (id: string) => void objects.delete(id),
  };
  return { objects, state, stub: stub as unknown as StorageService };
}

let root: string;
const saved = process.env.LIVE_SEGMENTS_DIR;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-store-spec-'));
  process.env.LIVE_SEGMENTS_DIR = root;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (saved === undefined) delete process.env.LIVE_SEGMENTS_DIR;
  else process.env.LIVE_SEGMENTS_DIR = saved;
});

async function store(): Promise<LiveSegmentStore> {
  const s = quiet(new LiveSegmentStore());
  await s.onModuleInit();
  return s;
}

const filesUnder = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    : [];

describe('LiveSegmentStore', () => {
  it('stores a segment as a file under LIVE_SEGMENTS_DIR and reads it back whole', async () => {
    const s = await store();
    const key = `live/${LIVE}/${SEG_A}`;
    await s.put(key, Buffer.from('sealed'), 6);
    expect(filesUnder(path.join(root, 'live'))).toEqual([key]);
    expect(await s.size(key)).toBe(6);
    const chunks: Buffer[] = [];
    for await (const c of (await s.get(key))!) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('sealed');
    expect(await s.size(`live/${LIVE}/${SEG_B}`)).toBeNull();
    expect(await s.get(`live/${LIVE}/${SEG_B}`)).toBeNull();
  });

  it('leaves nothing in staging after a store, and empties a staging a crash left behind at boot', async () => {
    const s = await store();
    await s.put(`live/${LIVE}/${SEG_A}`, Buffer.from('a'), 1);
    expect(fs.readdirSync(path.join(root, '.staging'))).toEqual([]);
    fs.writeFileSync(path.join(root, '.staging', 'half-written'), 'x');
    await store();
    expect(fs.readdirSync(path.join(root, '.staging'))).toEqual([]);
  });

  it('refuses a key outside live/, a key that walks out of its root, and a size that lies', async () => {
    const s = await store();
    await expect(s.put(CHAT_BLOB, Buffer.from('x'), 1)).rejects.toThrow(/live\//);
    await expect(s.put(`live/../${CHAT_BLOB}`, Buffer.from('x'), 1)).rejects.toThrow(/outside/);
    await expect(s.put(`live/${LIVE}/${SEG_A}`, Buffer.from('xy'), 1)).rejects.toThrow(/declared/);
    expect(filesUnder(root)).toEqual([]);
  });

  it('deletes idempotently, and the folder of a live goes with its last segment', async () => {
    const s = await store();
    await s.put(`live/${LIVE}/${SEG_A}`, Buffer.from('a'), 1);
    await s.put(`live/${LIVE}/${SEG_B}`, Buffer.from('b'), 1);
    await s.delete(`live/${LIVE}/${SEG_A}`);
    expect(await s.listPrefixes('live/')).toEqual([`live/${LIVE}/`]);
    await s.delete(`live/${LIVE}/${SEG_B}`);
    await s.delete(`live/${LIVE}/${SEG_B}`);
    expect(await s.listPrefixes('live/')).toEqual([]);
  });

  it('lists every segment under a prefix with its size, and one folder per live', async () => {
    const s = await store();
    await s.put(`live/${LIVE}/${SEG_A}`, Buffer.from('aa'), 2);
    await s.put(`live/${LIVE}/${SEG_B}`, Buffer.from('b'), 1);
    await s.put(`live/${OTHER}/${SEG_A}`, Buffer.from('ccc'), 3);
    const all = await s.listObjects('live/');
    expect(Object.fromEntries(all.map((o) => [o.id, o.size]))).toEqual({
      [`live/${LIVE}/${SEG_A}`]: 2,
      [`live/${LIVE}/${SEG_B}`]: 1,
      [`live/${OTHER}/${SEG_A}`]: 3,
    });
    expect((await s.listObjects(`live/${OTHER}/`)).map((o) => o.id)).toEqual([
      `live/${OTHER}/${SEG_A}`,
    ]);
    expect((await s.listPrefixes('live/')).sort()).toEqual(
      [`live/${LIVE}/`, `live/${OTHER}/`].sort()
    );
    await expect(s.listPrefixes('')).rejects.toThrow(/live\//);
  });
});

describe('LiveSegmentsService over the live store', () => {
  it('purges one live and proves it by a re-listing, and the reaper no longer sees its folder', async () => {
    const svc = quiet(new LiveSegmentsService(await store(), objectStore().stub));
    await svc.store(LIVE, SEG_A, Buffer.from('a'));
    await svc.store(LIVE, SEG_B, Buffer.from('b'));
    await svc.store(OTHER, SEG_A, Buffer.from('c'));
    expect((await svc.listLives()).sort()).toEqual([LIVE, OTHER].sort());
    await expect(svc.purge(LIVE)).resolves.toEqual({ deleted: 2, failed: 0, remaining: 0 });
    expect(await svc.listLives()).toEqual([OTHER]);
    expect((await svc.listSegments()).map((o) => o.id)).toEqual([`live/${OTHER}/${SEG_A}`]);
  });

  it('writes nothing to the backed-up object store', async () => {
    const objects = objectStore({ [CHAT_BLOB]: 'chat' });
    const svc = quiet(new LiveSegmentsService(await store(), objects.stub));
    await svc.store(LIVE, SEG_A, Buffer.from('a'));
    expect([...objects.objects.keys()]).toEqual([CHAT_BLOB]);
  });

  it('drains the live/ objects an older release left in the object store, and nothing else', async () => {
    const objects = objectStore({
      [`live/${LIVE}/${SEG_A}`]: 'old',
      [`live/${OTHER}/${SEG_B}`]: 'old',
      [CHAT_BLOB]: 'chat',
    });
    const svc = quiet(new LiveSegmentsService(await store(), objects.stub));
    await expect(svc.drainObjectStore()).resolves.toBe(2);
    expect([...objects.objects.keys()]).toEqual([CHAT_BLOB]);
    await expect(svc.drainObjectStore()).resolves.toBe(0);
  });

  it('logs a failed drain and lets the boot go on', async () => {
    const objects = objectStore({ [`live/${LIVE}/${SEG_A}`]: 'old' });
    objects.state.down = true;
    const svc = new LiveSegmentsService(await store(), objects.stub);
    const errors: string[] = [];
    (svc as unknown as { logger: unknown }).logger = {
      log: () => {},
      error: (m: string) => errors.push(m),
    };
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(errors.join('\n')).toMatch(/\[LIVE_STORE\].*failed/);
  });
});

describe('the storage panel live line', () => {
  it('is read from the live store, and a live/ key in the bucket is untracked, not a segment', async () => {
    const service = Object.create(MediaService.prototype) as MediaService;
    const internals = service as unknown as Record<string, unknown>;
    internals.meta = { items: {} };
    internals.storage = {
      listObjects: async () => [{ id: `live/${LIVE}/${SEG_A}`, size: 7, lastModifiedMs: null }],
    };
    internals.sweepIntervalMs = 60_000;
    const stats = await service.getStorageStats([
      { id: `live/${OTHER}/${SEG_A}`, size: 5, lastModifiedMs: null },
      { id: `live/${OTHER}/${SEG_B}`, size: 6, lastModifiedMs: null },
    ]);
    expect(stats.liveSegmentCount).toBe(2);
    expect(stats.liveSegmentBytes).toBe(11);
    expect(stats.untrackedCount).toBe(1);
    expect(stats.totalBytes).toBe(7);
  });
});
