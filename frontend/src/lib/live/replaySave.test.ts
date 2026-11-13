import { describe, expect, it, vi } from 'vitest';
import { loadReplayList, saveReplay, type SaveReplayDeps } from './replaySave';
import { LiveRefusalError } from './api';
import { LiveSegmentOpenError } from './liveCrypto';
import type { LiveReplayPage, LiveReplaySegment } from './types';

function box(type: string, payload = 0): Uint8Array {
  const b = new Uint8Array(8 + payload);
  new DataView(b.buffer).setUint32(0, 8 + payload);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  return b;
}
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const init = (g: number) => concat(box('ftyp', 4), box('moov', 16 + g));
const media = (i: number) => concat(box('moof', i), box('mdat', 8));

const segs = (n: number): LiveReplaySegment[] =>
  Array.from({ length: n }, (_, i) => ({ index: i, name: `s${i}`, bytes: 10, atMs: i * 2000 }));
const list = (n: number) => ({ liveId: 'live', postId: 'abcdef12-0', key: 'k', segments: segs(n) });

function makeDeps(over: Partial<SaveReplayDeps> & { gen?: (i: number) => number } = {}) {
  const staged: { session: string; bytes: number; offset: number }[] = [];
  const committed: { session: string; name: string }[] = [];
  const downloads: { name: string; size: number }[] = [];
  let n = 0;
  const { gen, ...rest } = over;
  const deps: SaveReplayDeps = {
    fetchReplay: vi.fn() as never,
    fetchSegment: vi.fn(async () => new ArrayBuffer(4)) as never,
    openSegment: vi.fn(async (_k: string, _l: string, i: number) =>
      concat(init(gen?.(i) ?? 0), media(i))
    ) as never,
    hasNativeGallery: () => true,
    newSession: () => `session-${++n}`,
    stage: vi.fn(async (session, bytes, offset) => {
      staged.push({ session, bytes: bytes.byteLength, offset });
      return offset + bytes.byteLength;
    }),
    commit: vi.fn(async (session, name) => {
      committed.push({ session, name });
      return 'saved' as const;
    }),
    discard: vi.fn(async (_s, cause) => {
      throw cause;
    }),
    saveBlobAs: vi.fn(async (blob, name) => {
      downloads.push({ name, size: blob.size });
      return true;
    }),
    ...rest,
  };
  return { deps, staged, committed, downloads };
}

describe('saveReplay', () => {
  it('writes ONE file segment by segment: the first init once, every fragment after it, offsets continuing', async () => {
    const { deps, staged, committed } = makeDeps();
    const r = await saveReplay(list(3), '2026-11-09T10:00:00Z', deps);
    expect(r).toEqual({ outcome: 'saved', parts: 1 });
    const first = init(0).byteLength + media(0).byteLength;
    expect(staged.map((s) => s.bytes)).toEqual([first, media(1).byteLength, media(2).byteLength]);
    expect(staged.map((s) => s.offset)).toEqual([0, first, first + media(1).byteLength]);
    expect(new Set(staged.map((s) => s.session)).size).toBe(1);
    expect(committed).toEqual([
      { session: 'session-1', name: 'canari-replay-2026-11-09-abcdef12.mp4' },
    ]);
  });

  it('closes the file and starts a second part when the init changes', async () => {
    const { deps, staged, committed } = makeDeps({ gen: (i) => (i >= 2 ? 1 : 0) });
    const r = await saveReplay(list(4), '2026-11-09T10:00:00Z', deps);
    expect(r.parts).toBe(2);
    expect(committed.map((c) => c.name)).toEqual([
      'canari-replay-2026-11-09-abcdef12.mp4',
      'canari-replay-2026-11-09-abcdef12-2.mp4',
    ]);
    const second = staged.filter((s) => s.session === 'session-2');
    expect(second[0].offset).toBe(0);
    expect(second[0].bytes).toBe(init(1).byteLength + media(2).byteLength);
  });

  it('stops at a refused gallery access and writes nothing more', async () => {
    const { deps, committed } = makeDeps({
      gen: (i) => (i >= 2 ? 1 : 0),
      commit: vi.fn(async () => 'denied' as const),
    });
    const r = await saveReplay(list(4), '2026-11-09T10:00:00Z', deps);
    expect(r.outcome).toBe('denied');
    expect(r.parts).toBe(1);
    expect(committed).toHaveLength(0);
    expect(deps.stage).toHaveBeenCalledTimes(2);
  });

  it('skips a segment the server no longer has', async () => {
    const { deps, staged } = makeDeps({
      fetchSegment: vi.fn(async (_l: string, name: string) => {
        if (name === 's1') {
          throw new LiveRefusalError(404, null, 'x', 'not-found', null, null, null);
        }
        return new ArrayBuffer(4);
      }) as never,
    });
    await saveReplay(list(3), '2026-11-09T10:00:00Z', deps);
    expect(staged).toHaveLength(2);
  });

  it('a first segment that does not open is the error, not a skipped hole', async () => {
    const { deps } = makeDeps({
      openSegment: vi.fn(async () => {
        throw new LiveSegmentOpenError('unauthentic', 0, 4);
      }) as never,
    });
    await expect(saveReplay(list(3), '2026-11-09T10:00:00Z', deps)).rejects.toBeInstanceOf(
      LiveSegmentOpenError
    );
  });

  it('discards the staged file and rethrows when a stage fails', async () => {
    const { deps } = makeDeps({
      stage: vi.fn(async () => {
        throw new Error('disk');
      }),
    });
    await expect(saveReplay(list(2), '2026-11-09T10:00:00Z', deps)).rejects.toThrow('disk');
    expect(deps.discard).toHaveBeenCalledWith('session-1', expect.any(Error));
  });

  it('on the web hands each part to the download, never to the gallery', async () => {
    const { deps, downloads, staged } = makeDeps({
      hasNativeGallery: () => false,
      gen: (i) => (i >= 1 ? 1 : 0),
    });
    const r = await saveReplay(list(2), '2026-11-09T10:00:00Z', deps);
    expect(r).toEqual({ outcome: 'downloaded', parts: 2 });
    expect(staged).toHaveLength(0);
    expect(downloads.map((d) => d.name)).toEqual([
      'canari-replay-2026-11-09-abcdef12.mp4',
      'canari-replay-2026-11-09-abcdef12-2.mp4',
    ]);
  });
});

describe('loadReplayList', () => {
  it('reads every page by nextFrom', async () => {
    const page = (from: number, next: number | null): LiveReplayPage => ({
      liveId: 'live',
      postId: 'p',
      key: 'k',
      durationMs: 1,
      expiresAt: '',
      serverNow: '',
      segments: segs(2).map((s) => ({ ...s, index: s.index + from })),
      nextFrom: next,
    });
    const fetchReplay = vi.fn(async (_l: string, from?: number) =>
      from === undefined ? page(0, 2) : page(from, null)
    );
    const l = await loadReplayList('live', { fetchReplay: fetchReplay as never });
    expect(l.segments.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(fetchReplay).toHaveBeenNthCalledWith(1, 'live', undefined);
    expect(fetchReplay).toHaveBeenNthCalledWith(2, 'live', 2);
  });
});
