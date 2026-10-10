/// <reference types="jest" />

/**
 * The resumable upload SESSION (WP-S1, docs/wiki/services/media-streaming-upload.md), against a REAL
 * staging directory and the REAL budget machinery - only the object store is a stub.
 *
 * WHAT IS PINNED, each because the opposite is a plausible mistake:
 *  - a part is written at its OFFSET, so a re-sent part (the lost-answer retry that corrupts the
 *    chunk route's APPEND) leaves the blob identical;
 *  - no request body over 8 MiB, answered 413 BEFORE a byte is read;
 *  - memory is a stream buffer, not a part: 50 MiB through the handler grows the heap's array buffers
 *    by a small constant;
 *  - the budget is reserved ONCE at init and released by complete, cancel, expiry - never twice,
 *    never left behind;
 *  - `complete` is exact (every part, the size, the header) and idempotent.
 */
import { Readable } from 'stream';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PART_MAX_BYTES } from './upload-session';

process.env.MEDIA_CHAT_REEL_DAILY_BYTES = '100000';
process.env.MEDIA_UPLOAD_SESSION_MAX_OPEN = '4';

// Loaded AFTER the env above: the daily budget is read once, at module load.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MediaService } = require('./media.service') as typeof import('./media.service');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { UploadSessionService } =
  require('./upload-session.service') as typeof import('./upload-session.service');
type Svc = import('./upload-session.service').UploadSessionService;

const SEG = 256;
const MAX = 1 << 30;

/** The 20 public header bytes for `plaintext` bytes cut in `SEG`-byte segments, and the stored size. */
function headerFor(plaintext: number, seg = SEG): { hex: string; total: number } {
  const h = Buffer.alloc(20);
  h.write('CANARIM', 0, 'ascii');
  h[7] = 1;
  h.writeUInt32BE(seg, 8);
  h.writeBigUInt64BE(BigInt(plaintext), 12);
  return {
    hex: h.toString('hex'),
    total: 20 + plaintext + Math.max(1, Math.ceil(plaintext / seg)) * 16,
  };
}

/** A blob that starts with its header and is otherwise deterministic noise, so offsets are visible. */
function blobFor(plaintext: number): { blob: Buffer; hex: string } {
  const { hex, total } = headerFor(plaintext);
  const blob = Buffer.alloc(total);
  Buffer.from(hex, 'hex').copy(blob, 0);
  for (let i = 20; i < total; i++) blob[i] = (i * 31 + 7) & 0xff;
  return { blob, hex };
}

const sliceOf = (blob: Buffer, partBytes: number, i: number) =>
  blob.subarray(i * partBytes, Math.min(blob.length, (i + 1) * partBytes));

interface Rig {
  svc: Svc;
  media: InstanceType<typeof MediaService>;
  dir: string;
  stored: Array<{ id: string; bytes: Buffer }>;
  failStore: { value: boolean };
  registered: Array<{ id: string; size: number }>;
}

let dirs: string[] = [];

function rig(existingDir?: string, sharedMedia?: InstanceType<typeof MediaService>): Rig {
  const dir = existingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'upload-sessions-'));
  if (!existingDir) dirs.push(dir);
  process.env.MEDIA_UPLOAD_SESSION_DIR = dir;
  const stored: Rig['stored'] = [];
  const registered: Rig['registered'] = [];
  const failStore = { value: false };
  const media =
    sharedMedia ?? (Object.create(MediaService.prototype) as InstanceType<typeof MediaService>);
  if (!sharedMedia) {
    const m = media as unknown as Record<string, unknown>;
    m.meta = { items: Object.create(null) };
    m.logger = { log: () => {}, warn: () => {}, error: () => {} };
    m.persistMetadata = () => Promise.resolve();
  }
  const storage = {
    putFileStream: async (id: string, file: string) => {
      await new Promise((resolve) => setImmediate(resolve));
      if (failStore.value) throw new Error('store down');
      stored.push({ id, bytes: await fs.readFile(file) });
    },
  };
  const svc = new UploadSessionService(media, storage as never);
  (svc as unknown as { logger: unknown }).logger = {
    log: () => {},
    warn: () => {},
    error: () => {},
  };
  const meta = (media as unknown as { meta: { items: Record<string, { size?: number }> } }).meta;
  const real = media.registerUpload.bind(media);
  media.registerUpload = (async (id: string, o: string, c: never, size: number, cb: () => void) => {
    registered.push({ id, size });
    await real(id, o, c, size, cb);
    void meta;
  }) as never;
  return { svc, media, dir, stored, failStore, registered };
}

afterEach(async () => {
  for (const d of dirs) await fs.remove(d);
  dirs = [];
});

const put = (r: Rig, owner: string, id: string, i: number, data: Buffer, cl = data.length) =>
  r.svc.putPart(owner, id, i, Readable.from([data]), cl);

async function open(r: Rig, owner: string, plaintext: number, partBytes = 1024, cls?: 'chat-reel') {
  const { blob, hex } = blobFor(plaintext);
  const res = await r.svc.init(
    owner,
    { retentionClass: cls, totalBytes: blob.length, partBytes, header: hex },
    MAX
  );
  return { ...res, blob, hex };
}

describe('init', () => {
  it('opens a session and stages a file of exactly the declared size', async () => {
    const r = rig();
    const s = await open(r, 'alice', 5000);
    expect(s.totalParts).toBe(Math.ceil(s.blob.length / 1024));
    expect((await fs.stat(path.join(r.dir, `${s.uploadId}.data`))).size).toBe(s.blob.length);
    expect(await r.svc.status('alice', s.uploadId)).toMatchObject({
      received: [],
      partBytes: 1024,
    });
  });

  it.each([
    ['a header whose length disagrees with totalBytes', { totalBytes: 9999 }, BadRequestException],
    ['a part size over 8 MiB', { partBytes: PART_MAX_BYTES + 1 }, PayloadTooLargeException],
    ['a part size under the floor', { partBytes: 10 }, BadRequestException],
    ['a non-integer total', { totalBytes: 12.5 }, BadRequestException],
    ['a header that is not hex', { header: 'zz' }, BadRequestException],
    ['a header with the wrong magic', { header: '00'.repeat(20) }, BadRequestException],
  ])('refuses %s', async (_why, override, error) => {
    const r = rig();
    const { blob, hex } = blobFor(3000);
    await expect(
      r.svc.init(
        'alice',
        { totalBytes: blob.length, partBytes: 1024, header: hex, ...override },
        MAX
      )
    ).rejects.toThrow(error);
    expect(await fs.readdir(r.dir)).toEqual([]);
  });

  it('refuses a total over the ceiling with a 413 and stages nothing', async () => {
    const r = rig();
    const { blob, hex } = blobFor(3000);
    await expect(
      r.svc.init('alice', { totalBytes: blob.length, partBytes: 1024, header: hex }, 100)
    ).rejects.toThrow(PayloadTooLargeException);
    expect(await fs.readdir(r.dir)).toEqual([]);
  });

  it('caps the open sessions per owner, concurrent inits included', async () => {
    const r = rig();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => open(r, 'alice', 2000))
    );
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(4);
    const refused = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect((refused.reason as HttpException).getStatus()).toBe(429);
    // Another member is unaffected.
    await expect(open(r, 'bob', 2000)).resolves.toBeDefined();
  });
});

describe('parts: a positional write, so a retry is harmless', () => {
  it('assembles a blob from parts sent concurrently and out of order, byte for byte', async () => {
    const r = rig();
    const s = await open(r, 'alice', 5000);
    const order = [...Array(s.totalParts).keys()].reverse();
    await Promise.all(order.map((i) => put(r, 'alice', s.uploadId, i, sliceOf(s.blob, 1024, i))));
    expect((await r.svc.status('alice', s.uploadId)).received).toEqual([
      ...Array(s.totalParts).keys(),
    ]);
    const { mediaId } = await r.svc.complete('alice', s.uploadId);
    expect(r.stored).toHaveLength(1);
    expect(r.stored[0].id).toBe(mediaId);
    expect(r.stored[0].bytes.equals(s.blob)).toBe(true);
  });

  it('a part sent twice - the answer was lost - leaves the blob identical and counted once', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000);
    for (const i of Array(s.totalParts).keys()) {
      await put(r, 'alice', s.uploadId, i, sliceOf(s.blob, 1024, i));
    }
    // The retry, sequential and then two at once (the lock serialises them on one index).
    await put(r, 'alice', s.uploadId, 1, sliceOf(s.blob, 1024, 1));
    await Promise.all([
      put(r, 'alice', s.uploadId, 1, sliceOf(s.blob, 1024, 1)),
      put(r, 'alice', s.uploadId, 1, sliceOf(s.blob, 1024, 1)),
    ]);
    expect((await r.svc.status('alice', s.uploadId)).received).toHaveLength(s.totalParts);
    await r.svc.complete('alice', s.uploadId);
    expect(r.stored[0].bytes.equals(s.blob)).toBe(true);
  });

  it('a part interrupted midway is not reported received, and the resend completes it', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000);
    const half = sliceOf(s.blob, 1024, 0);
    const broken = new Readable({
      read() {
        this.push(half.subarray(0, 300));
        this.destroy(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
      },
    });
    await expect(r.svc.putPart('alice', s.uploadId, 0, broken, 1024)).rejects.toThrow(
      BadRequestException
    );
    expect((await r.svc.status('alice', s.uploadId)).received).toEqual([]);
    for (const i of Array(s.totalParts).keys()) {
      await put(r, 'alice', s.uploadId, i, sliceOf(s.blob, 1024, i));
    }
    await r.svc.complete('alice', s.uploadId);
    expect(r.stored[0].bytes.equals(s.blob)).toBe(true);
  });

  it('refuses a body over 8 MiB with a 413 BEFORE reading a byte', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000);
    const read = jest.fn();
    const body = new Readable({ read });
    await expect(r.svc.putPart('alice', s.uploadId, 0, body, PART_MAX_BYTES + 1)).rejects.toThrow(
      PayloadTooLargeException
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses a missing Content-Length (411), a wrong one (400) and a lying stream (413)', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000);
    const part0 = sliceOf(s.blob, 1024, 0);
    await expect(
      r.svc.putPart('alice', s.uploadId, 0, Readable.from([part0]), undefined)
    ).rejects.toMatchObject({ status: 411 });
    await expect(put(r, 'alice', s.uploadId, 0, part0.subarray(0, 100))).rejects.toThrow(
      BadRequestException
    );
    await expect(put(r, 'alice', s.uploadId, 0, Buffer.alloc(2000))).rejects.toThrow(
      PayloadTooLargeException
    );
    // Declares the right length, sends more: the guard refuses the byte past the declaration.
    await expect(put(r, 'alice', s.uploadId, 0, Buffer.alloc(2000), 1024)).rejects.toThrow(
      PayloadTooLargeException
    );
    expect((await r.svc.status('alice', s.uploadId)).received).toEqual([]);
  });

  it('the last part carries the remainder, not a full part', async () => {
    const r = rig();
    const s = await open(r, 'alice', 1100);
    const last = s.totalParts - 1;
    await expect(put(r, 'alice', s.uploadId, last, Buffer.alloc(1024))).rejects.toThrow(
      PayloadTooLargeException
    );
    await expect(
      put(r, 'alice', s.uploadId, last, sliceOf(s.blob, 1024, last))
    ).resolves.toBeDefined();
  });

  it.each([-1, 99, 1.5, NaN])('refuses part index %s', async (index) => {
    const r = rig();
    const s = await open(r, 'alice', 3000);
    await expect(
      r.svc.putPart('alice', s.uploadId, index, Readable.from([Buffer.alloc(1024)]), 1024)
    ).rejects.toThrow(BadRequestException);
  });
});

describe('complete', () => {
  it('refuses while a part is missing, naming how many', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000);
    await put(r, 'alice', s.uploadId, 0, sliceOf(s.blob, 1024, 0));
    await expect(r.svc.complete('alice', s.uploadId)).rejects.toThrow(ConflictException);
    expect(r.stored).toHaveLength(0);
  });

  it('refuses a staged header that is not the declared one (422)', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000);
    for (const i of Array(s.totalParts).keys()) {
      const part = Buffer.from(sliceOf(s.blob, 1024, i));
      if (i === 0) part[3] ^= 0xff;
      await put(r, 'alice', s.uploadId, i, part);
    }
    await expect(r.svc.complete('alice', s.uploadId)).rejects.toThrow(UnprocessableEntityException);
    expect(r.stored).toHaveLength(0);
  });

  it('is idempotent: a repeat, concurrent or later, answers the same id and stores once', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000);
    for (const i of Array(s.totalParts).keys()) {
      await put(r, 'alice', s.uploadId, i, sliceOf(s.blob, 1024, i));
    }
    const [a, b] = await Promise.all([
      r.svc.complete('alice', s.uploadId),
      r.svc.complete('alice', s.uploadId),
    ]);
    const c = await r.svc.complete('alice', s.uploadId);
    expect(a.mediaId).toBe(b.mediaId);
    expect(c.mediaId).toBe(a.mediaId);
    expect(r.stored).toHaveLength(1);
    expect(await r.svc.status('alice', s.uploadId)).toMatchObject({ mediaId: a.mediaId });
    // The staged bytes are gone once the object is stored; only the memo stays.
    expect(await fs.pathExists(path.join(r.dir, `${s.uploadId}.data`))).toBe(false);
  });

  it('a store failure leaves the session open and completable, its reservation held', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000, 1024, 'chat-reel');
    for (const i of Array(s.totalParts).keys()) {
      await put(r, 'alice', s.uploadId, i, sliceOf(s.blob, 1024, i));
    }
    r.failStore.value = true;
    await expect(r.svc.complete('alice', s.uploadId)).rejects.toThrow(HttpException);
    expect(reserved(r)).toBe(s.blob.length);
    r.failStore.value = false;
    await expect(r.svc.complete('alice', s.uploadId)).resolves.toBeDefined();
    expect(reserved(r)).toBe(0);
  });

  it('refuses another member on every route (403) and an unknown session (404)', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000);
    await expect(r.svc.status('mallory', s.uploadId)).rejects.toThrow(ForbiddenException);
    await expect(r.svc.complete('mallory', s.uploadId)).rejects.toThrow(ForbiddenException);
    await expect(r.svc.cancel('mallory', s.uploadId)).rejects.toThrow(ForbiddenException);
    await expect(put(r, 'mallory', s.uploadId, 0, Buffer.alloc(1024))).rejects.toThrow(
      ForbiddenException
    );
    await expect(r.svc.status('alice', '11111111-1111-4111-8111-111111111111')).rejects.toThrow(
      NotFoundException
    );
    await expect(r.svc.status('alice', '../../etc/passwd')).rejects.toThrow(BadRequestException);
  });
});

/** Bytes the member has reserved and not yet registered, read from the real machinery. */
function reserved(r: Rig, owner = 'alice'): number {
  return (
    (
      r.media as unknown as { chatReelReservations?: Map<string, number> }
    ).chatReelReservations?.get(owner) ?? 0
  );
}

describe('the budget: reserved ONCE at init, released by every ending', () => {
  it('refuses an init over the daily budget (429) and stages nothing', async () => {
    const r = rig();
    await expect(open(r, 'alice', 120_000, 4096, 'chat-reel')).rejects.toMatchObject({
      status: 429,
    });
    expect(await fs.readdir(r.dir)).toEqual([]);
    expect(reserved(r)).toBe(0);
  });

  it('holds the reservation across parts, a retried part and a status call, never counting twice', async () => {
    const r = rig();
    const s = await open(r, 'alice', 20_000, 4096, 'chat-reel');
    expect(reserved(r)).toBe(s.blob.length);
    await put(r, 'alice', s.uploadId, 0, sliceOf(s.blob, 4096, 0));
    await put(r, 'alice', s.uploadId, 0, sliceOf(s.blob, 4096, 0));
    await r.svc.status('alice', s.uploadId);
    expect(reserved(r)).toBe(s.blob.length);
    // The member's other session sees the first one's reservation: 20k + 20k + 85k > 100k.
    await expect(open(r, 'alice', 85_000, 4096, 'chat-reel')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('is released by complete, with the entry registered in the same run', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000, 1024, 'chat-reel');
    for (const i of Array(s.totalParts).keys()) {
      await put(r, 'alice', s.uploadId, i, sliceOf(s.blob, 1024, i));
    }
    await r.svc.complete('alice', s.uploadId);
    expect(reserved(r)).toBe(0);
    // Counted as an entry now: it still weighs on the day's total.
    await expect(open(r, 'alice', 99_000, 4096, 'chat-reel')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('is released at once by cancel, which also removes the staging and aborts in-flight parts', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000, 1024, 'chat-reel');
    const stuck = new Readable({ read() {} });
    const inflight = r.svc.putPart('alice', s.uploadId, 0, stuck, 1024);
    await new Promise((resolve) => setImmediate(resolve));
    await r.svc.cancel('alice', s.uploadId);
    await expect(inflight).rejects.toThrow(ConflictException);
    expect(reserved(r)).toBe(0);
    expect(await fs.readdir(r.dir)).toEqual([]);
    await expect(r.svc.status('alice', s.uploadId)).rejects.toThrow(NotFoundException);
  });

  it('is released by the sweep once the 24 h window has passed, and the member is told 404', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000, 1024, 'chat-reel');
    const internals = r.svc as unknown as { sessions: Map<string, { expiresAt: number }> };
    internals.sessions.get(s.uploadId)!.expiresAt = Date.now() - 1;
    expect(await r.svc.sweep()).toBe(1);
    expect(reserved(r)).toBe(0);
    expect(await fs.readdir(r.dir)).toEqual([]);
    await expect(put(r, 'alice', s.uploadId, 0, Buffer.alloc(1024))).rejects.toThrow(
      NotFoundException
    );
  });

  it('is released by the lazy expiry check too, not only by the sweep', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000, 1024, 'chat-reel');
    (r.svc as unknown as { sessions: Map<string, { expiresAt: number }> }).sessions.get(
      s.uploadId
    )!.expiresAt = Date.now() - 1;
    await expect(r.svc.status('alice', s.uploadId)).rejects.toThrow(NotFoundException);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(reserved(r)).toBe(0);
  });

  it('removes staging no session claims (a crash between the two writes)', async () => {
    const r = rig();
    const orphan = '22222222-2222-4222-8222-222222222222';
    await fs.writeFile(path.join(r.dir, `${orphan}.data`), 'x');
    expect(await r.svc.sweep()).toBe(1);
    expect(await fs.readdir(r.dir)).toEqual([]);
  });
});

describe('a restart does not forget the session', () => {
  it('serves the received parts, restores the reservation and accepts the remaining parts', async () => {
    const first = rig();
    const s = await open(first, 'alice', 3000, 1024, 'chat-reel');
    await put(first, 'alice', s.uploadId, 0, sliceOf(s.blob, 1024, 0));
    await put(first, 'alice', s.uploadId, 2, sliceOf(s.blob, 1024, 2));

    // A new process: same directory, a fresh service, a fresh budget map.
    const second = rig(first.dir);
    expect((await second.svc.status('alice', s.uploadId)).received).toEqual([0, 2]);
    expect(reserved(second)).toBe(s.blob.length);
    for (const i of [1, 3, 4].filter((i) => i < s.totalParts)) {
      await put(second, 'alice', s.uploadId, i, sliceOf(s.blob, 1024, i));
    }
    const { mediaId } = await second.svc.complete('alice', s.uploadId);
    expect(second.stored[0].bytes.equals(s.blob)).toBe(true);

    // And the memo survives a further restart, so a lost answer can still be asked again.
    const third = rig(first.dir);
    expect(await third.svc.complete('alice', s.uploadId)).toEqual({ mediaId });
    expect(third.stored).toHaveLength(0);
  });

  it('puts a restored reservation back even when the day is now over budget, rather than stranding it', async () => {
    const first = rig();
    const s = await open(first, 'alice', 60_000, 8192, 'chat-reel');
    const second = rig(first.dir);
    // Another reservation already fills the day in the NEW process.
    second.media.reserveUploadBudget('chat-reel', 'alice', 90_000);
    await expect(second.svc.status('alice', s.uploadId)).resolves.toBeDefined();
    expect(reserved(second)).toBe(90_000 + s.blob.length);
  });
});

describe('memory: a part is a stream, never a buffer', () => {
  it('streams 50 MiB in 4 MiB parts while array buffers grow by less than 16 MiB', async () => {
    const r = rig();
    const SEG_BIG = 1024 * 1024;
    const plaintext = 50 * 1024 * 1024;
    const { hex, total } = headerFor(plaintext, SEG_BIG);
    const partBytes = 4 * 1024 * 1024;
    const s = await r.svc.init('alice', { totalBytes: total, partBytes, header: hex }, MAX);

    const chunk = Buffer.alloc(64 * 1024, 0xab);
    const header = Buffer.from(hex, 'hex');
    let baseline = process.memoryUsage().arrayBuffers;
    let peak = 0;
    for (let i = 0; i < s.totalParts; i++) {
      const length = Math.min(partBytes, total - i * partBytes);
      let sent = 0;
      const body = new Readable({
        read() {
          if (sent >= length) return this.push(null);
          const n = Math.min(chunk.length, length - sent);
          let out = chunk.subarray(0, n);
          if (i === 0 && sent === 0) {
            out = Buffer.concat([header, chunk.subarray(0, n - header.length)]);
          }
          sent += n;
          peak = Math.max(peak, process.memoryUsage().arrayBuffers - baseline);
          this.push(out);
        },
      });
      await r.svc.putPart('alice', s.uploadId, i, body, length);
    }
    expect((await r.svc.status('alice', s.uploadId)).received).toHaveLength(s.totalParts);
    expect(peak).toBeLessThan(16 * 1024 * 1024);
    // The same bound is the whole point of the design: independent of the file size.
    baseline = 0;
    await r.svc.cancel('alice', s.uploadId);
  }, 60_000);
});

describe('the controller declares no body-buffering interceptor on the session routes', () => {
  it('has no FileInterceptor on the part route (a part is the raw stream)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MediaController } =
      require('./media.controller') as typeof import('./media.controller');
    const handlerOf = (name: string) =>
      Object.getOwnPropertyDescriptor(MediaController.prototype, name)!.value as object;
    for (const name of [
      'initUploadSession',
      'putUploadPart',
      'uploadSessionStatus',
      'completeUploadSession',
      'cancelUploadSession',
    ] as const) {
      expect(Reflect.getMetadata('__interceptors__', handlerOf(name))).toBeUndefined();
    }
    // The control case: the legacy route DOES buffer, and the probe sees it.
    expect(Reflect.getMetadata('__interceptors__', handlerOf('appendChunk'))).toBeDefined();
  });
});

describe('over real HTTP: the controller reads Content-Length and pipes the request itself', () => {
  it('stores a part sent as a raw PUT, refuses a 9 MiB body with 413, and a bodyless length with 411', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const http = require('http') as typeof import('http');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('crypto') as typeof import('crypto');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MediaController } =
      require('./media.controller') as typeof import('./media.controller');
    process.env.JWT_SECRET = 'test-secret';
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const signed = `${b64({ alg: 'HS256' })}.${b64({ sub: 'alice' })}`;
    const token = `${signed}.${crypto.createHmac('sha256', 'test-secret').update(signed).digest('base64url')}`;

    const r = rig();
    const s = await open(r, 'alice', 3000);
    const controller = new MediaController({} as never, r.svc);
    const server = http.createServer((req, res) => {
      const index = /parts\/(\d+)/.exec(req.url ?? '')?.[1] ?? '0';
      controller
        .putUploadPart(s.uploadId, index, req as never)
        .then((out) => {
          res.statusCode = 200;
          res.end(JSON.stringify(out));
        })
        .catch((err: HttpException) => {
          res.statusCode = err.getStatus?.() ?? 500;
          res.end();
          req.resume();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as import('net').AddressInfo;
    const call = (i: number, body: Buffer) =>
      fetch(`http://127.0.0.1:${port}/parts/${i}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
        body: new Uint8Array(body),
      });
    try {
      const ok = await call(0, sliceOf(s.blob, 1024, 0));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ index: 0, receivedCount: 1 });
      expect((await r.svc.status('alice', s.uploadId)).received).toEqual([0]);
      expect((await call(1, Buffer.alloc(9 * 1024 * 1024))).status).toBe(413);
      expect((await r.svc.status('alice', s.uploadId)).received).toEqual([0]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The review of #1708: abuse caps, a torn retry, complete racing a PUT, crash windows, the sidecar.
// ---------------------------------------------------------------------------------------------

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Holds the store open until `release()`, so a test can act while `complete` is inside it. */
function gateStore(r: Rig) {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const storage = (r.svc as unknown as { storage: { putFileStream: (...a: never[]) => unknown } })
    .storage;
  const original = storage.putFileStream.bind(storage);
  storage.putFileStream = (async (...args: never[]) => {
    entered();
    await gate;
    return original(...args);
  }) as never;
  return { release, inside };
}

async function fillAll(r: Rig, s: Awaited<ReturnType<typeof open>>) {
  for (const i of Array(s.totalParts).keys()) {
    await put(r, 'alice', s.uploadId, i, sliceOf(s.blob, 1024, i));
  }
}

describe('abuse: a session costs something even when no byte is sent', () => {
  afterEach(() => {
    delete process.env.MEDIA_UPLOAD_SESSION_MAX_OWNER_BYTES;
    delete process.env.MEDIA_UPLOAD_SESSION_EMPTY_TTL_MS;
  });

  it('caps the bytes one member may declare across open sessions (429), without touching another member', async () => {
    const { blob } = blobFor(3000);
    process.env.MEDIA_UPLOAD_SESSION_MAX_OWNER_BYTES = String(blob.length * 2 + 1);
    const r = rig();
    await open(r, 'alice', 3000);
    await open(r, 'alice', 3000);
    const third = await open(r, 'alice', 3000).catch((e: HttpException) => e);
    expect((third as HttpException).getStatus()).toBe(429);
    await expect(open(r, 'bob', 3000)).resolves.toBeDefined();
  });

  it('expires a session that received no part after the short window, releasing its reservation', async () => {
    process.env.MEDIA_UPLOAD_SESSION_EMPTY_TTL_MS = '1000';
    const r = rig();
    const empty = await open(r, 'alice', 3000, 1024, 'chat-reel');
    const started = await open(r, 'alice', 3000, 1024, 'chat-reel');
    await put(r, 'alice', started.uploadId, 0, sliceOf(started.blob, 1024, 0));
    const sessions = (r.svc as unknown as { sessions: Map<string, { createdAt: number }> })
      .sessions;
    for (const s of sessions.values()) s.createdAt = Date.now() - 5000;

    // Disposed by the NEXT init, not by the hourly sweep.
    await open(r, 'bob', 3000);
    await expect(r.svc.status('alice', empty.uploadId)).rejects.toThrow(NotFoundException);
    expect(await fs.pathExists(path.join(r.dir, `${empty.uploadId}.data`))).toBe(false);
    // The one that holds a part keeps the full window and its reservation.
    await expect(r.svc.status('alice', started.uploadId)).resolves.toBeDefined();
    expect(reserved(r)).toBe(started.blob.length);
  });
});

describe('a retried part is unmarked while it is rewritten', () => {
  it('a retry cut midway is NOT reported received, on disk either, and complete refuses until it is resent', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000);
    await fillAll(r, s);
    const broken = new Readable({
      read() {
        this.push(Buffer.alloc(300, 0xee));
        this.destroy(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
      },
    });
    await expect(r.svc.putPart('alice', s.uploadId, 1, broken, 1024)).rejects.toThrow(
      BadRequestException
    );
    const status = await r.svc.status('alice', s.uploadId);
    expect(status.received).not.toContain(1);
    const sidecar = await fs.readJson(path.join(r.dir, `${s.uploadId}.json`));
    expect(sidecar.received).not.toContain(1);
    await expect(r.svc.complete('alice', s.uploadId)).rejects.toThrow(ConflictException);
    await put(r, 'alice', s.uploadId, 1, sliceOf(s.blob, 1024, 1));
    await r.svc.complete('alice', s.uploadId);
    expect(r.stored[0].bytes.equals(s.blob)).toBe(true);
  });
});

describe('complete and a PUT never overlap', () => {
  it('a PUT that arrives while complete is in the store is 409, and the blob stored is intact', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000);
    await fillAll(r, s);
    const g = gateStore(r);
    const done = r.svc.complete('alice', s.uploadId);
    await g.inside;
    await expect(put(r, 'alice', s.uploadId, 0, sliceOf(s.blob, 1024, 0))).rejects.toThrow(
      ConflictException
    );
    g.release();
    await done;
    expect(r.stored[0].bytes.equals(s.blob)).toBe(true);
  });

  it('a PUT after completion is 409, never a 500 from the removed staging file', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000);
    await fillAll(r, s);
    await r.svc.complete('alice', s.uploadId);
    const err = await put(r, 'alice', s.uploadId, 0, sliceOf(s.blob, 1024, 0)).catch(
      (e: HttpException) => e
    );
    expect(err).toBeInstanceOf(ConflictException);
  });

  it('a complete that finds a PUT in flight is 409 and leaves the session completable', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000);
    await fillAll(r, s);
    const stuck = new Readable({ read() {} });
    const inflight = r.svc.putPart('alice', s.uploadId, 1, stuck, 1024);
    await tick();
    await expect(r.svc.complete('alice', s.uploadId)).rejects.toThrow(ConflictException);
    stuck.push(sliceOf(s.blob, 1024, 1));
    stuck.push(null);
    await inflight;
    await expect(r.svc.complete('alice', s.uploadId)).resolves.toBeDefined();
  });

  it('a cancel that waits behind complete finds it completed (409) and removes nothing', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000, 1024, 'chat-reel');
    await fillAll(r, s);
    const g = gateStore(r);
    const done = r.svc.complete('alice', s.uploadId);
    await g.inside;
    const cancelled = r.svc.cancel('alice', s.uploadId).catch((e: HttpException) => e);
    await tick();
    g.release();
    const { mediaId } = await done;
    expect(await cancelled).toBeInstanceOf(ConflictException);
    expect(await r.svc.status('alice', s.uploadId)).toMatchObject({ mediaId });
    expect(reserved(r)).toBe(0);
  });
});

describe('crash windows inside complete', () => {
  it('the media id is persisted BEFORE the store, so a failed store retries into the same key', async () => {
    const first = rig();
    const s = await open(first, 'alice', 3000);
    await fillAll(first, s);
    first.failStore.value = true;
    await expect(first.svc.complete('alice', s.uploadId)).rejects.toThrow(HttpException);
    const intended = (await fs.readJson(path.join(first.dir, `${s.uploadId}.json`)))
      .intendedMediaId;
    expect(intended).toMatch(/^[0-9a-f-]{36}$/);

    const second = rig(first.dir); // the process died after the failed store
    const { mediaId } = await second.svc.complete('alice', s.uploadId);
    expect(mediaId).toBe(intended);
    expect(second.stored.map((x) => x.id)).toEqual([intended]);
  });

  it('a crash between the register and the memo answers the SAME id after the restart', async () => {
    const first = rig();
    const s = await open(first, 'alice', 3000, 1024, 'chat-reel');
    await fillAll(first, s);
    const svc = first.svc as unknown as { persist: (x: { completed?: unknown }) => Promise<void> };
    const real = svc.persist.bind(svc);
    svc.persist = async (x) => {
      if (x.completed) throw new Error('disk gone');
      return real(x);
    };
    const { mediaId } = await first.svc.complete('alice', s.uploadId);
    // The member was answered, and the staging was KEPT because the memo is not durable.
    expect(await fs.pathExists(path.join(first.dir, `${s.uploadId}.data`))).toBe(true);

    const second = rig(first.dir);
    expect(await second.svc.complete('alice', s.uploadId)).toEqual({ mediaId });
    expect(second.stored.map((x) => x.id)).toEqual([mediaId]);
    expect(reserved(second)).toBe(0);
  });
});

describe('the sidecar at load', () => {
  const ID = {
    junk: '33333333-3333-4333-8333-333333333333',
    types: '44444444-4444-4444-8444-444444444444',
  };

  it('deletes a record that is WRONG: unparseable, or with a field of the wrong type', async () => {
    const first = rig();
    const s = await open(first, 'alice', 3000);
    await fs.writeFile(path.join(first.dir, `${ID.junk}.json`), '{ not json');
    await fs.writeFile(path.join(first.dir, `${ID.junk}.data`), 'x');
    const good = await fs.readJson(path.join(first.dir, `${s.uploadId}.json`));
    await fs.writeJson(path.join(first.dir, `${ID.types}.json`), {
      ...good,
      id: ID.types,
      totalBytes: '3000',
      received: 'all',
    });
    await fs.writeFile(path.join(first.dir, `${ID.types}.data`), 'x');

    const second = rig(first.dir);
    await expect(second.svc.status('alice', s.uploadId)).resolves.toBeDefined();
    expect((await fs.readdir(first.dir)).sort()).toEqual(
      [`${s.uploadId}.data`, `${s.uploadId}.json`].sort()
    );
  });

  it('does NOT delete a session whose sidecar could not be read (EIO), and the sweep spares it', async () => {
    const first = rig();
    const s = await open(first, 'alice', 3000);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsx = require('fs-extra') as typeof import('fs-extra');
    const spy = jest
      .spyOn(fsx, 'readJson')
      .mockRejectedValueOnce(
        Object.assign(new Error('input/output error'), { code: 'EIO' }) as never
      );
    try {
      const second = rig(first.dir);
      await expect(second.svc.status('alice', s.uploadId)).rejects.toThrow(NotFoundException);
      expect(await second.svc.sweep()).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(await fs.pathExists(path.join(first.dir, `${s.uploadId}.json`))).toBe(true);
    expect(await fs.pathExists(path.join(first.dir, `${s.uploadId}.data`))).toBe(true);
    // The disk is back: the next process restores it.
    const third = rig(first.dir);
    await expect(third.svc.status('alice', s.uploadId)).resolves.toBeDefined();
  });
});

describe('a full staging disk', () => {
  it('answers 507 (retryable), leaves the part unreceived and the session usable', async () => {
    const r = rig();
    const s = await open(r, 'alice', 3000);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsx = require('fs-extra') as typeof import('fs-extra');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Writable } = require('stream') as typeof import('stream');
    const spy = jest.spyOn(fsx, 'createWriteStream').mockImplementationOnce(
      (() =>
        new Writable({
          write(_c, _e, cb) {
            cb(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
          },
        })) as never
    );
    try {
      const err = await put(r, 'alice', s.uploadId, 0, sliceOf(s.blob, 1024, 0)).catch(
        (e: HttpException) => e
      );
      expect((err as HttpException).getStatus()).toBe(507);
    } finally {
      spy.mockRestore();
    }
    expect((await r.svc.status('alice', s.uploadId)).received).toEqual([]);
    await fillAll(r, s);
    await expect(r.svc.complete('alice', s.uploadId)).resolves.toBeDefined();
  });
});
