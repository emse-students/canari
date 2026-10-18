/**
 * Live segments in the media store (WP-L3, docs/wiki/services/lives.md): the keys are two uuids
 * and nothing else, the purge deletes ONE live's prefix and answers a re-listing, and the three
 * routes are closed while `LIVE_ENABLED` is off.
 */
import { Readable } from 'node:stream';
import { BadRequestException, HttpStatus } from '@nestjs/common';
import {
  LIVE_SEGMENT_MAX_BYTES,
  LiveSegmentsService,
  isLiveEnabled,
} from './live-segments.service';
import { MediaController } from './media.controller';
import type { StorageService, StoredObject } from './storage.service';

const LIVE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SEG_A = '33333333-3333-4333-8333-333333333333';
const SEG_B = '44444444-4444-4444-8444-444444444444';

/** A bucket in memory, with a set of keys whose delete the store refuses. */
function bucket() {
  const objects = new Map<string, Buffer>();
  const undeletable = new Set<string>();
  const storage = {
    put: async (id: string, data: Buffer) => void objects.set(id, data),
    size: async (id: string) => objects.get(id)?.length ?? null,
    get: async (id: string) => (objects.has(id) ? Readable.from([objects.get(id)!]) : null),
    delete: async (id: string) => {
      if (undeletable.has(id)) throw new Error('AccessDenied');
      objects.delete(id);
    },
    listObjects: async (prefix = ''): Promise<StoredObject[]> =>
      [...objects.entries()]
        .filter(([id]) => id.startsWith(prefix))
        .map(([id, data]) => ({ id, size: data.length, lastModifiedMs: null })),
    listPrefixes: async (prefix: string): Promise<string[]> => [
      ...new Set(
        [...objects.keys()]
          .filter((id) => id.startsWith(prefix))
          .map((id) => prefix + id.slice(prefix.length).split('/')[0] + '/')
      ),
    ],
  };
  return {
    objects,
    undeletable,
    svc: new LiveSegmentsService(storage as unknown as StorageService),
  };
}

async function statusOf(p: () => unknown): Promise<number> {
  try {
    await p();
  } catch (e) {
    return (e as { getStatus: () => number }).getStatus();
  }
  return HttpStatus.OK;
}

describe('LiveSegmentsService', () => {
  it('keys a segment by two uuids and refuses anything else, so no id can walk out of its prefix', () => {
    expect(LiveSegmentsService.key(LIVE, SEG_A)).toBe(`live/${LIVE}/${SEG_A}`);
    for (const [live, name] of [
      ['..', SEG_A],
      [LIVE, '../other'],
      [LIVE, `${SEG_A}/x`],
      ['', SEG_A],
    ]) {
      expect(() => LiveSegmentsService.key(live, name)).toThrow(BadRequestException);
    }
  });

  it('stores and reads a segment back, and answers 404 for one it does not hold', async () => {
    const { svc } = bucket();
    await svc.store(LIVE, SEG_A, Buffer.from('sealed'));
    const { size, stream } = await svc.read(LIVE, SEG_A);
    expect(size).toBe(6);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('sealed');
    expect(await statusOf(() => svc.read(LIVE, SEG_B))).toBe(HttpStatus.NOT_FOUND);
  });

  it("purges ONE live's prefix and proves it empty by listing it again", async () => {
    const { svc, objects } = bucket();
    await svc.store(LIVE, SEG_A, Buffer.from('a'));
    await svc.store(LIVE, SEG_B, Buffer.from('b'));
    await svc.store(OTHER, SEG_A, Buffer.from('c'));
    objects.set('11111111-1111-4111-8111-111111111111', Buffer.from('a chat blob'));
    await expect(svc.purge(LIVE)).resolves.toEqual({ deleted: 2, failed: 0, remaining: 0 });
    expect([...objects.keys()].sort()).toEqual(
      [`live/${OTHER}/${SEG_A}`, '11111111-1111-4111-8111-111111111111'].sort()
    );
    // Idempotent: a second purge finds nothing.
    await expect(svc.purge(LIVE)).resolves.toEqual({ deleted: 0, failed: 0, remaining: 0 });
  });

  it('counts a refused delete and reports what remains, never throwing it', async () => {
    const { svc, undeletable } = bucket();
    await svc.store(LIVE, SEG_A, Buffer.from('a'));
    await svc.store(LIVE, SEG_B, Buffer.from('b'));
    undeletable.add(`live/${LIVE}/${SEG_B}`);
    await expect(svc.purge(LIVE)).resolves.toEqual({ deleted: 1, failed: 1, remaining: 1 });
  });

  it('lists one id per live folder, and leaves a folder that is not a live alone', async () => {
    const { svc, objects } = bucket();
    await svc.store(LIVE, SEG_A, Buffer.from('a'));
    await svc.store(LIVE, SEG_B, Buffer.from('b'));
    await svc.store(OTHER, SEG_A, Buffer.from('c'));
    objects.set('live/not-a-uuid/x', Buffer.from('?'));
    objects.set(SEG_A, Buffer.from('a chat blob'));
    expect((await svc.listLives()).sort()).toEqual([LIVE, OTHER].sort());
  });
});

describe('the live routes of MediaController', () => {
  const saved = { live: process.env.LIVE_ENABLED, secret: process.env.INTERNAL_SECRET };
  afterEach(() => {
    process.env.LIVE_ENABLED = saved.live;
    process.env.INTERNAL_SECRET = saved.secret;
    if (saved.live === undefined) delete process.env.LIVE_ENABLED;
    if (saved.secret === undefined) delete process.env.INTERNAL_SECRET;
  });

  function rig() {
    const b = bucket();
    const controller = new MediaController({} as never, {} as never, b.svc);
    return { ...b, controller };
  }
  const file = (n: number) => ({ buffer: Buffer.alloc(n, 1), size: n });

  it('answers 404 on the store and the read while LIVE_ENABLED is not exactly "true"', async () => {
    process.env.INTERNAL_SECRET = 's3cret';
    const { controller } = rig();
    for (const value of [undefined, 'false', '1', 'TRUE']) {
      if (value === undefined) delete process.env.LIVE_ENABLED;
      else process.env.LIVE_ENABLED = value;
      expect(isLiveEnabled()).toBe(false);
      expect(
        await statusOf(() => controller.storeLiveSegment(LIVE, SEG_A, file(1), 's3cret'))
      ).toBe(HttpStatus.NOT_FOUND);
      expect(
        await statusOf(() => controller.downloadLiveSegment(LIVE, SEG_A, {} as never, {} as never))
      ).toBe(HttpStatus.NOT_FOUND);
    }
  });

  it('stores only for the internal secret, and only a body within the bound', async () => {
    process.env.LIVE_ENABLED = 'true';
    process.env.INTERNAL_SECRET = 's3cret';
    const { controller, objects } = rig();
    expect(await statusOf(() => controller.storeLiveSegment(LIVE, SEG_A, file(1), 'wrong'))).toBe(
      HttpStatus.FORBIDDEN
    );
    expect(
      await statusOf(() =>
        controller.storeLiveSegment(LIVE, SEG_A, file(LIVE_SEGMENT_MAX_BYTES + 1), 's3cret')
      )
    ).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    await expect(controller.storeLiveSegment(LIVE, SEG_A, file(3), 's3cret')).resolves.toEqual({
      ok: true,
    });
    expect(objects.has(`live/${LIVE}/${SEG_A}`)).toBe(true);
  });

  it('purges for the internal secret even with the switch off: a live started before is still deleted', async () => {
    process.env.LIVE_ENABLED = 'true';
    process.env.INTERNAL_SECRET = 's3cret';
    const { controller, svc } = rig();
    await svc.store(LIVE, SEG_A, Buffer.from('a'));
    process.env.LIVE_ENABLED = 'false';
    expect(await statusOf(() => controller.purgeLive({ liveId: LIVE }, 'wrong'))).toBe(
      HttpStatus.FORBIDDEN
    );
    await expect(controller.purgeLive({ liveId: LIVE }, 's3cret')).resolves.toEqual({
      deleted: 1,
      failed: 0,
      remaining: 0,
    });
  });

  it('lists the live folders for the internal secret only, whatever the switch says', async () => {
    process.env.LIVE_ENABLED = 'false';
    process.env.INTERNAL_SECRET = 's3cret';
    const { controller, svc } = rig();
    await svc.store(LIVE, SEG_A, Buffer.from('a'));
    expect(await statusOf(() => controller.listLives('wrong'))).toBe(HttpStatus.FORBIDDEN);
    await expect(controller.listLives('s3cret')).resolves.toEqual({ liveIds: [LIVE] });
  });
});
