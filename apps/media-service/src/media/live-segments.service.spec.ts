/**
 * Live segments in the media store (WP-L3, docs/wiki/services/lives.md): the keys are two uuids
 * and nothing else, the purge deletes ONE live's prefix and answers a re-listing, and the three
 * routes are closed while `LIVE_ENABLED` is off - and the two segment routes while the runtime kill
 * switch (`platform_config.lives_mode`, relayed by social-service) is not `on`.
 */
import { Readable, Writable } from 'node:stream';
import { BadRequestException, HttpStatus } from '@nestjs/common';
import {
  LIVE_SEGMENT_MAX_BYTES,
  LiveSegmentsService,
  isLiveEnabled,
} from './live-segments.service';
import { MediaController } from './media.controller';
import { livesModeUrl } from './lives-mode';
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

  it('deletes the NAMED segments of one live only, idempotently, and counts a refusal without throwing', async () => {
    const { svc, objects, undeletable } = bucket();
    await svc.store(LIVE, SEG_A, Buffer.from('a'));
    await svc.store(LIVE, SEG_B, Buffer.from('b'));
    await svc.store(OTHER, SEG_A, Buffer.from('c'));
    await expect(svc.deleteSegments(LIVE, [SEG_A])).resolves.toEqual({
      deleted: [SEG_A],
      failed: [],
    });
    expect([...objects.keys()].sort()).toEqual([`live/${LIVE}/${SEG_B}`, `live/${OTHER}/${SEG_A}`]);
    // A pass repeated after a crash: the object is already gone and that is no failure.
    await expect(svc.deleteSegments(LIVE, [SEG_A])).resolves.toEqual({
      deleted: [SEG_A],
      failed: [],
    });
    undeletable.add(`live/${LIVE}/${SEG_B}`);
    await expect(svc.deleteSegments(LIVE, [SEG_B])).resolves.toEqual({
      deleted: [],
      failed: [SEG_B],
    });
    await expect(svc.deleteSegments(LIVE, ['not-a-uuid'])).rejects.toThrow(/uuid/);
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

/** What social-service's relay answers next: a mode, a status, or a transport failure. */
type Relay = { mode: unknown } | { status: number } | Error;

/** Replaces `fetch` with social-service's relay answering `relay()`; returns the spy. */
function relayAnswering(relay: () => Relay) {
  return jest.spyOn(global, 'fetch').mockImplementation(async () => {
    const answer = relay();
    if (answer instanceof Error) throw answer;
    if ('status' in answer) return new Response('{}', { status: answer.status });
    return new Response(JSON.stringify(answer), { status: 200 });
  });
}

describe('the live routes of MediaController', () => {
  const saved = { live: process.env.LIVE_ENABLED, secret: process.env.INTERNAL_SECRET };
  /** The kill switch, OPEN unless a test closes it, so the deploy-lock cases read on their own. */
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = relayAnswering(() => ({ mode: 'on' }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
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
  /** The request of a segment fetch, as Express hands it: only the raw URL is read. */
  const at = (url: string) => ({ originalUrl: url }) as never;
  const canonical = (live: string, name: string) => at(`/api/media/public/live/${live}/${name}`);

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
        await statusOf(() =>
          controller.downloadLiveSegment(LIVE, SEG_A, canonical(LIVE, SEG_A), {} as never)
        )
      ).toBe(HttpStatus.NOT_FOUND);
    }
  });

  it('serves a stored segment with NO request and NO token - the public route nginx caches (WP-L4)', async () => {
    process.env.LIVE_ENABLED = 'true';
    const { controller, svc } = rig();
    await svc.store(LIVE, SEG_A, Buffer.from('sealed'));
    const headers: Record<string, unknown> = {};
    const chunks: Buffer[] = [];
    const res = new Writable({
      write(chunk: Buffer, _enc: string, done: () => void) {
        chunks.push(chunk);
        done();
      },
    });
    Object.assign(res, {
      setHeader: (name: string, value: unknown) => void (headers[name] = value),
    });
    const finished = new Promise((resolve) => res.on('finish', resolve));
    await controller.downloadLiveSegment(LIVE, SEG_A, canonical(LIVE, SEG_A), res as never);
    await finished;
    expect(Buffer.concat(chunks).toString()).toBe('sealed');
    expect(headers['Content-Type']).toBe('application/octet-stream');
    expect(headers['Content-Length']).toBe(6);
    // nginx owns the header every client sees; this route states no cache policy of its own.
    expect(headers['Cache-Control']).toBeUndefined();
    expect(
      await statusOf(() =>
        controller.downloadLiveSegment(LIVE, SEG_B, canonical(LIVE, SEG_B), res as never)
      )
    ).toBe(HttpStatus.NOT_FOUND);
  });

  it('answers 404 to every spelling but the canonical one, before the store is asked (review of #2105)', async () => {
    process.env.LIVE_ENABLED = 'true';
    const { controller, svc } = rig();
    await svc.store(LIVE, SEG_A, Buffer.from('sealed'));
    let asked = 0;
    const read = svc.read.bind(svc);
    svc.read = async (...a: Parameters<typeof read>) => {
      asked += 1;
      return read(...a);
    };
    const UP_LIVE = LIVE.toUpperCase().replace(/^1/, 'A');
    const upper = '33333333-3333-4333-8333-33333333333A';
    // Each is what Express 5 would route here (case-insensitive, trailing slash optional) and what
    // nginx neither caches nor rate-limits.
    for (const [live, name, url] of [
      [LIVE, upper, `/api/media/public/live/${LIVE}/${upper}`],
      [UP_LIVE, SEG_A, `/api/media/public/live/${UP_LIVE}/${SEG_A}`],
      [LIVE, SEG_A, `/api/media/public/live/${LIVE}/${SEG_A}/`],
      [LIVE, SEG_A, `/api/media/PUBLIC/live/${LIVE}/${SEG_A}`],
      [LIVE, SEG_A, `/api/media/public/live/${LIVE}/${SEG_A}?x=1`],
      [LIVE, SEG_A, `/api/media/public/live/${LIVE}/%33${SEG_A.slice(1)}`],
      [LIVE, SEG_A, `/api/media/public//live/${LIVE}/${SEG_A}`],
    ]) {
      expect(
        await statusOf(() => controller.downloadLiveSegment(live, name, at(url), {} as never))
      ).toBe(HttpStatus.NOT_FOUND);
    }
    expect(asked).toBe(0);
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

  it('trims for the internal secret, with the switch off too, and refuses a malformed call', async () => {
    process.env.LIVE_ENABLED = 'true';
    process.env.INTERNAL_SECRET = 's3cret';
    const { controller, svc } = rig();
    await svc.store(LIVE, SEG_A, Buffer.from('a'));
    process.env.LIVE_ENABLED = 'false';
    const call = { liveId: LIVE, names: [SEG_A] };
    expect(await statusOf(() => controller.deleteLiveSegments(call, 'wrong'))).toBe(
      HttpStatus.FORBIDDEN
    );
    expect(
      await statusOf(() => controller.deleteLiveSegments({ liveId: LIVE, names: [] }, 's3cret'))
    ).toBe(HttpStatus.BAD_REQUEST);
    expect(
      await statusOf(() => controller.deleteLiveSegments({ liveId: LIVE, names: [1] }, 's3cret'))
    ).toBe(HttpStatus.BAD_REQUEST);
    await expect(controller.deleteLiveSegments(call, 's3cret')).resolves.toEqual({
      deleted: [SEG_A],
      failed: [],
    });
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

  /** A response that records what the download route writes, for the one served case below. */
  function sink() {
    const chunks: Buffer[] = [];
    const res = new Writable({
      write(chunk: Buffer, _enc: string, done: () => void) {
        chunks.push(chunk);
        done();
      },
    });
    Object.assign(res, { setHeader: () => undefined });
    const finished = new Promise((resolve) => res.on('finish', resolve));
    return { res, chunks, finished };
  }

  describe('the runtime kill switch (platform_config.lives_mode)', () => {
    beforeEach(() => {
      process.env.LIVE_ENABLED = 'true';
      process.env.INTERNAL_SECRET = 's3cret';
    });

    it('answers 404 on the store and the read while the switch is off, and stores nothing', async () => {
      fetchSpy.mockRestore();
      fetchSpy = relayAnswering(() => ({ mode: 'off' }));
      const { controller, svc, objects } = rig();
      await svc.store(LIVE, SEG_A, Buffer.from('sealed'));
      expect(
        await statusOf(() => controller.storeLiveSegment(LIVE, SEG_B, file(1), 's3cret'))
      ).toBe(HttpStatus.NOT_FOUND);
      expect(objects.has(`live/${LIVE}/${SEG_B}`)).toBe(false);
      expect(
        await statusOf(() =>
          controller.downloadLiveSegment(LIVE, SEG_A, canonical(LIVE, SEG_A), {} as never)
        )
      ).toBe(HttpStatus.NOT_FOUND);
    });

    it('asks social-service on EVERY request, with the internal secret, so a flip holds from the next one', async () => {
      const modes = ['on', 'off'];
      fetchSpy.mockRestore();
      fetchSpy = relayAnswering(() => ({ mode: modes.shift() }));
      const { controller, svc } = rig();
      await svc.store(LIVE, SEG_A, Buffer.from('sealed'));
      const { res, chunks, finished } = sink();
      await controller.downloadLiveSegment(LIVE, SEG_A, canonical(LIVE, SEG_A), res as never);
      await finished;
      expect(Buffer.concat(chunks).toString()).toBe('sealed');
      expect(
        await statusOf(() =>
          controller.downloadLiveSegment(LIVE, SEG_A, canonical(LIVE, SEG_A), {} as never)
        )
      ).toBe(HttpStatus.NOT_FOUND);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://social-service:3014/api/internal/lives/mode');
      expect((init.headers as Record<string, string>)['x-internal-secret']).toBe('s3cret');
    });

    it.each([
      ['an unreachable relay', new Error('ECONNREFUSED'), HttpStatus.SERVICE_UNAVAILABLE],
      ['a refused relay', { status: 403 }, HttpStatus.SERVICE_UNAVAILABLE],
      ['a relay down', { status: 500 }, HttpStatus.SERVICE_UNAVAILABLE],
    ])(
      'refuses on %s - a switch that cannot be read is not read as open',
      async (_c, relay, status) => {
        fetchSpy.mockRestore();
        fetchSpy = relayAnswering(() => relay as Relay);
        const { controller, svc } = rig();
        await svc.store(LIVE, SEG_A, Buffer.from('sealed'));
        expect(
          await statusOf(() => controller.storeLiveSegment(LIVE, SEG_B, file(1), 's3cret'))
        ).toBe(status);
        expect(
          await statusOf(() =>
            controller.downloadLiveSegment(LIVE, SEG_A, canonical(LIVE, SEG_A), {} as never)
          )
        ).toBe(status);
      }
    );

    it.each(['ON', 'true', '', null])(
      'refuses (throws) on an unknown relayed value %p',
      async (mode) => {
        fetchSpy.mockRestore();
        fetchSpy = relayAnswering(() => ({ mode }));
        const { controller } = rig();
        await expect(controller.storeLiveSegment(LIVE, SEG_B, file(1), 's3cret')).rejects.toThrow(
          /unknown lives mode/
        );
      }
    );

    it('never reaches social-service for a caller refused anyway: a wrong secret, a non-canonical path', async () => {
      const { controller } = rig();
      expect(await statusOf(() => controller.storeLiveSegment(LIVE, SEG_A, file(1), 'wrong'))).toBe(
        HttpStatus.FORBIDDEN
      );
      expect(
        await statusOf(() =>
          controller.downloadLiveSegment(
            LIVE,
            SEG_A,
            at(`/api/media/public/live/${LIVE}/${SEG_A}/`),
            {} as never
          )
        )
      ).toBe(HttpStatus.NOT_FOUND);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});

describe('livesModeUrl', () => {
  const saved = process.env.SOCIAL_SERVICE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.SOCIAL_SERVICE_URL;
    else process.env.SOCIAL_SERVICE_URL = saved;
  });

  it.each([
    ['http://social:1', 'http://social:1/api/internal/lives/mode'],
    ['http://social:1/', 'http://social:1/api/internal/lives/mode'],
    ['http://social:1/api', 'http://social:1/api/internal/lives/mode'],
    ['http://social:1/api/', 'http://social:1/api/internal/lives/mode'],
  ])('inserts the global prefix exactly once for %s', (base, url) => {
    process.env.SOCIAL_SERVICE_URL = base;
    expect(livesModeUrl()).toBe(url);
  });
});
