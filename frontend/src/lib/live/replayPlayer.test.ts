/**
 * THE REPLAY PLAYER AGAINST FAKE MSE OBJECTS AND A MANUAL TIMER (docs/wiki/live-replays.md, WP-R4).
 *
 * Pinned: the first page and the key, the join at index 0 with the bounded lead; a seek takes the
 * LAST segment at or before the target and puts the playhead where the buffer says it landed; a seek
 * inside buffered media only moves the cursor; an identical init is appended once and a new one again
 * (a camera re-acquired); a replay trimmed to its last hours is rebased to zero under a
 * `timestampOffset`; the end of the list ends the stream; every refusal and failure has its state (a
 * `404` is "gone", a transport failure is a retry with a backoff, an unsupported engine and an
 * undecryptable replay are final); stop gives everything back. No sleep and no wall clock.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isTerminalReplayState,
  knownHoles,
  newMediaStart,
  ReplayPlayer,
  replayFailureOutcome,
  REPLAY_AHEAD_S,
  type ReplayMediaSourceLike,
  type ReplayPlayerDeps,
  type ReplaySourceBufferLike,
  type ReplayState,
} from './replayPlayer';
import { LiveRefusalError } from './api';
import { fragment, initSegment, join, readVideoDurations } from './fmp4.test-helper';
import { LiveSegmentOpenError } from './liveCrypto';
import { TransportFailureError } from '$lib/utils/transportFailure';
import type { LiveReplayPage, LiveReplaySegment } from './types';

const LIVE = '0b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';

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
/** A box holding `children` - a `moov` the players read the tracks of must frame. */
function parent(type: string, ...children: Uint8Array[]): Uint8Array {
  const b = concat(box(type), ...children);
  new DataView(b.buffer).setUint32(0, b.length);
  return b;
}
const init = (generation: number) =>
  concat(box('ftyp', 4), parent('moov', box('free', 8 + generation)));
const media = (index: number) => concat(box('moof', index), box('mdat', 8));
const indexOfMedia = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset).getUint32(0) - 8;
const generationOfInit = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset).getUint32(12) - 8 - 16;

/** A buffer that places segment `i` at `i * 2 + base - timestampOffset`, 2 s long, merging neighbours. */
class FakeBuffer extends EventTarget implements ReplaySourceBufferLike {
  updating = false;
  mode = 'sequence';
  timestampOffset = 0;
  base = 0;
  /** The length of the media one segment holds, in seconds. */
  len = 2;
  appends: string[] = [];
  /** Every append's bytes, as given. */
  data: Uint8Array[] = [];
  ranges: [number, number][] = [];
  removed: [number, number][] = [];
  get buffered() {
    const r = this.ranges;
    return { length: r.length, start: (i: number) => r[i][0], end: (i: number) => r[i][1] };
  }
  appendBuffer(data: Uint8Array<ArrayBuffer>): void {
    const type = String.fromCharCode(...data.subarray(4, 8));
    this.data.push(data.slice());
    if (type === 'ftyp') this.appends.push(`init${generationOfInit(data)}`);
    else {
      const i = indexOfMedia(data);
      this.appends.push(`m${i}`);
      const start = i * 2 + this.base + this.timestampOffset;
      this.add(start, start + this.len);
    }
    this.settle();
  }
  private add(s: number, e: number) {
    const next: [number, number][] = [];
    let cur: [number, number] = [s, e];
    for (const r of this.ranges) {
      if (r[1] < cur[0] - 0.001 || r[0] > cur[1] + 0.001) next.push(r);
      else cur = [Math.min(cur[0], r[0]), Math.max(cur[1], r[1])];
    }
    next.push(cur);
    this.ranges = next.sort((a, b) => a[0] - b[0]);
  }
  remove(start: number, end: number): void {
    this.removed.push([start, end]);
    this.ranges = this.ranges.flatMap(([s, e]) => {
      const out: [number, number][] = [];
      if (s < start) out.push([s, Math.min(e, start)]);
      if (e > end) out.push([Math.max(s, end), e]);
      return out;
    });
    this.settle();
  }
  private settle() {
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      this.dispatchEvent(new Event('updateend'));
    });
  }
}

class FakeSource extends EventTarget implements ReplayMediaSourceLike {
  readyState = 'open';
  duration = NaN;
  ended = 0;
  buffers: FakeBuffer[] = [];
  addSourceBuffer(): FakeBuffer {
    const b = new FakeBuffer();
    this.buffers.push(b);
    return b;
  }
  endOfStream() {
    this.ended++;
    this.readyState = 'ended';
  }
}

/** The replay on the server: `count` segments 2 s apart, pages of `pageSize`. */
function makePages(count: number, pageSize = 200, first = 0) {
  const all: LiveReplaySegment[] = Array.from({ length: count }, (_, i) => ({
    index: first + i,
    name: `seg-${first + i}`,
    bytes: 100,
    atMs: i * 2000,
  }));
  return (from?: number): LiveReplayPage => {
    const start = from ?? first;
    const rest = all.filter((s) => s.index >= start);
    const page = rest.slice(0, pageSize);
    return {
      liveId: LIVE,
      postId: 'post-1',
      key: 'k'.repeat(64),
      durationMs: count * 2000,
      expiresAt: '2026-11-12T10:00:00.000Z',
      serverNow: '2026-11-09T10:00:00.000Z',
      segments: page,
      nextFrom: rest.length > pageSize ? rest[pageSize].index : null,
    };
  };
}

let timers: { fn: () => void; ms: number }[];
let source: FakeSource;
let states: ReplayState[];
let video: {
  currentTime: number;
  paused: boolean;
  seeking: boolean;
  readyState: number;
  playbackRate: number;
  play: () => Promise<void>;
  pause: () => void;
};
let deps: ReplayPlayerDeps;
let detach: ReturnType<typeof vi.fn<() => void>>;
let generationOf: (index: number) => number;
let fetchReplay: ReturnType<typeof vi.fn<(id: string, from?: number) => Promise<LiveReplayPage>>>;

async function flush() {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

function makePlayer(onMeta?: (m: unknown) => void) {
  return new ReplayPlayer({
    liveId: LIVE,
    video,
    onState: (s) => states.push(s),
    onMeta,
    deps: { ...deps, attach: deps.attach },
  });
}
const buffer = () => source.buffers[0];

beforeEach(() => {
  timers = [];
  states = [];
  source = new FakeSource();
  detach = vi.fn();
  generationOf = () => 0;
  fetchReplay = vi.fn(async (_id: string, from?: number) => makePages(10)(from));
  video = {
    currentTime: 0,
    paused: true,
    seeking: false,
    readyState: 4,
    playbackRate: 1,
    play: vi.fn(async () => {
      video.paused = false;
    }),
    pause: vi.fn(() => {
      video.paused = true;
    }),
  };
  deps = {
    fetchReplay: ((id: string, from?: number) => fetchReplay(id, from)) as never,
    fetchSegment: vi.fn(async (_id: string, name: string) => {
      return new TextEncoder().encode(name).buffer as ArrayBuffer;
    }) as never,
    openSegment: vi.fn(async (_k: string, _id: string, index: number) =>
      concat(init(generationOf(index)), media(index))
    ) as never,
    mediaSource: () => ({
      name: 'MediaSource',
      create: () => source,
      isTypeSupported: () => true,
    }),
    attach: () => detach,
    schedule: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return () => timers.splice(timers.indexOf(t) >>> 0, 1);
    },
  };
});

describe('newMediaStart', () => {
  it('is the new range, the tail a range grew by, or null when nothing is new', () => {
    expect(newMediaStart([], [[0, 2]])).toBe(0);
    expect(newMediaStart([[0, 2]], [[0, 4]])).toBe(2);
    expect(
      newMediaStart(
        [[0, 2]],
        [
          [0, 2],
          [10, 12],
        ]
      )
    ).toBe(10);
    expect(newMediaStart([[0, 2]], [[0, 2]])).toBeNull();
    expect(
      newMediaStart(
        [
          [0, 2],
          [4, 6],
        ],
        [[0, 6]]
      )
    ).toBe(2);
  });
});

describe('replayFailureOutcome', () => {
  const refused = (kind: LiveRefusalError['kind']) =>
    new LiveRefusalError(404, null, kind, kind, null, null, null);
  it('reads a 404 as gone, a busy server and a transport failure as a retry, the rest as final', () => {
    expect(replayFailureOutcome(refused('not-found'))).toEqual({ stop: { kind: 'gone' } });
    expect(replayFailureOutcome(refused('unavailable'))).toBe('retry');
    expect(replayFailureOutcome(refused('rate-limited'))).toBe('retry');
    expect(replayFailureOutcome(new TransportFailureError(new Error('net')))).toBe('retry');
    expect(replayFailureOutcome(refused('refused'))).toEqual({
      stop: { kind: 'unavailable', reason: 'refused' },
    });
    expect(replayFailureOutcome(new TypeError('a defect'))).toEqual({
      stop: { kind: 'unavailable', reason: 'refused' },
    });
  });
  it('knows which states are final', () => {
    expect(isTerminalReplayState({ kind: 'gone' })).toBe(true);
    expect(isTerminalReplayState({ kind: 'playing' })).toBe(false);
  });
});

describe('ReplayPlayer', () => {
  it('opens from index 0, tells its facts, keeps a bounded lead and plays', async () => {
    const metas: unknown[] = [];
    const p = makePlayer((m) => metas.push(m));
    p.start();
    await flush();
    expect(metas).toEqual([
      {
        postId: 'post-1',
        durationMs: 20_000,
        expiresAt: '2026-11-12T10:00:00.000Z',
        serverNow: '2026-11-09T10:00:00.000Z',
      },
    ]);
    expect(source.duration).toBe(20);
    expect(buffer().mode).toBe('segments');
    // 12 s ahead of the playhead at 0: six 2 s segments, never the whole replay.
    expect(buffer().appends.filter((a) => a.startsWith('m'))).toEqual([
      'm0',
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
    ]);
    expect(buffer().ranges[0][1]).toBeGreaterThanOrEqual(REPLAY_AHEAD_S);
    expect(states.map((s) => s.kind)).toEqual(['connecting', 'playing']);
    expect(video.play).toHaveBeenCalled();
  });

  it('appends an identical init once and a new init again', async () => {
    generationOf = (i) => (i >= 3 ? 1 : 0);
    makePlayer().start();
    await flush();
    expect(buffer().appends.slice(0, 8)).toEqual([
      'init0',
      'm0',
      'm1',
      'm2',
      'init1',
      'm3',
      'm4',
      'm5',
    ]);
  });

  it('fetches more only as the playhead advances (timeupdate), and ends the stream at the end of the list', async () => {
    const p = makePlayer();
    p.start();
    await flush();
    video.currentTime = 6;
    p.noteTime();
    await flush();
    expect(buffer().appends.filter((a) => a.startsWith('m')).length).toBe(9);
    video.currentTime = 16;
    p.noteTime();
    await flush();
    expect(buffer().appends.filter((a) => a.startsWith('m')).length).toBe(10);
    expect(source.ended).toBe(1);
  });

  it('seeks outside the buffer to the LAST segment at or before the target and puts the playhead where it landed', async () => {
    fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(100)(from));
    const p = makePlayer();
    p.start();
    await flush();
    video.currentTime = 100.4; // 100.4 s: segment 50 starts at atMs 100 000
    p.noteSeeking();
    await flush();
    expect(buffer().appends).toContain('m50');
    expect(video.currentTime).toBeCloseTo(100.4, 1);
    // The cursor follows the placed segment: the next segments are 51.., not 6..
    const mediaAppends = buffer().appends.filter((a) => a.startsWith('m'));
    expect(mediaAppends.slice(-1)[0]).toBe('m56');
  });

  it('a seek into buffered media moves the cursor and fetches nothing it already holds', async () => {
    const p = makePlayer();
    p.start();
    await flush();
    const before = buffer().appends.length;
    video.currentTime = 3;
    p.noteSeeking();
    await flush();
    expect(buffer().appends.length).toBe(before + 2); // 3 s: 9 s ahead, so m6 and m7 bring it past 12 s
    expect(buffer().appends.slice(before)).toEqual(['m6', 'm7']);
  });

  describe('holes the live itself had (a camera flip, a background pause)', () => {
    /** A replay whose media has a gap of `gap` s after segment 7 (media [14, 16] ends at 16). */
    async function withHole(gap: number) {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(40)(from));
      const base = deps.openSegment;
      deps.openSegment = (async (k: string, id: string, index: number, sealed: ArrayBuffer) => {
        if (index === 8) buffer().base = gap;
        return (base as (...a: unknown[]) => Promise<Uint8Array>)(k, id, index, sealed);
      }) as never;
      const p = makePlayer();
      p.start();
      await flush();
      video.currentTime = 10; // the lead (12 s across the hole) brings the media on both sides in
      p.noteTime();
      await flush();
      return p;
    }

    for (const gap of [0.8, 17.6]) {
      describe(`a ${gap} s hole`, () => {
        it('is a known fact of the segment list, from the placements of the player', async () => {
          const p = await withHole(gap);
          expect(buffer().ranges.length).toBe(2);
          const inner = p as unknown as {
            segments: LiveReplaySegment[];
            placed: Map<number, number>;
            placedEnd: Map<number, number>;
          };
          expect(knownHoles(inner.segments, inner.placed, inner.placedEnd)).toEqual([
            [16, 16 + gap],
          ]);
        });

        it('a playhead stopped just before the edge is carried over it, with no timer', async () => {
          const p = await withHole(gap);
          video.currentTime = 15.5; // 0.5 s before the edge, as read on the Mi
          p.noteStall();
          expect(video.currentTime).toBeCloseTo(16 + gap, 5);
          expect(timers.length).toBe(0);
        });

        it('a playhead that reaches the edge crosses it without waiting for a stall', async () => {
          const p = await withHole(gap);
          video.currentTime = 16.02;
          p.noteTime();
          expect(video.currentTime).toBeCloseTo(16 + gap, 5);
        });

        it('a seek INTO the hole lands on the start of the next range', async () => {
          const p = await withHole(gap);
          video.currentTime = 16 + gap / 2;
          p.noteSeeking();
          await flush();
          expect(video.currentTime).toBeCloseTo(16 + gap, 5);
        });

        it('a wait with more than a segment of the range left is left to the engine', async () => {
          const p = await withHole(gap);
          video.currentTime = 14.4; // 1.6 s left in [0, 16]: content still ahead
          p.noteStall();
          expect(video.currentTime).toBe(14.4);
        });

        it('crossing does nothing while the video is seeking', async () => {
          const p = await withHole(gap);
          video.seeking = true;
          video.currentTime = 16.02;
          p.noteTime();
          p.noteStall();
          expect(video.currentTime).toBe(16.02);
        });

        it('a position just before the next range is on it, not in the hole: no second jump', async () => {
          const p = await withHole(gap);
          video.currentTime = 16 + gap - 0.005; // inside the engine's start tolerance
          p.noteTime();
          expect(video.currentTime).toBeCloseTo(16 + gap - 0.005, 6);
        });

        it('a wait well inside a range is still left to the engine', async () => {
          const p = await withHole(gap);
          video.currentTime = 12;
          p.noteStall();
          expect(video.currentTime).toBe(12);
        });
      });
    }
  });

  describe('what is not a hole', () => {
    const segs = Array.from({ length: 6 }, (_, i) => ({
      index: i,
      name: `s${i}`,
      bytes: 1,
      atMs: i * 2000,
    }));
    it('a region not loaded yet (neighbour not measured) is no hole', () => {
      const placed = new Map([
        [0, 0],
        [4, 8],
      ]);
      expect(knownHoles(segs, placed, new Map([[0, 2]]))).toEqual([]);
    });
    it('a region never loaded between two measured segments is no hole', () => {
      const placed = new Map([
        [0, 0],
        [2, 6],
      ]);
      expect(knownHoles(segs, placed, new Map([[0, 2]]))).toEqual([]);
    });
    it('a gap is a hole from the measures alone, whatever the buffer holds now', () => {
      const placed = new Map([
        [0, 0],
        [1, 5],
      ]);
      const ends = new Map([
        [0, 2],
        [1, 7],
      ]);
      expect(knownHoles(segs, placed, ends)).toEqual([[2, 5]]);
    });
    it('the leading gap before the first segment is a hole', () => {
      expect(knownHoles(segs, new Map([[0, 0.4]]), new Map([[0, 2.4]]))).toEqual([[0, 0.4]]);
      expect(knownHoles(segs, new Map([[0, 0.02]]), new Map([[0, 2]]))).toEqual([]);
    });
    it('a single-segment range between two holes is crossed on both sides', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(40)(from));
      const base = deps.openSegment;
      deps.openSegment = (async (k: string, id: string, index: number, sealed: ArrayBuffer) => {
        if (index === 8) buffer().base = 0.8; // hole 1 after m7 (ends at 16)
        if (index === 9) buffer().base = 1.6; // hole 2 after m8 alone ([16.8, 18.8])
        return (base as (...a: unknown[]) => Promise<Uint8Array>)(k, id, index, sealed);
      }) as never;
      const p = makePlayer();
      p.start();
      await flush();
      video.currentTime = 10;
      p.noteTime();
      await flush();
      video.currentTime = 18.3;
      p.noteStall();
      expect(video.currentTime).toBeCloseTo(19.6, 5);
    });
  });

  describe('the lead is counted across holes, and where a segment sits is never forgotten', () => {
    const mediaCount = () => buffer().appends.filter((a) => a.startsWith('m')).length;

    it('P1: a hole in the middle of the lead does not make the fill download the whole replay', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(200)(from));
      const base = deps.openSegment;
      deps.openSegment = (async (k: string, id: string, index: number, sealed: ArrayBuffer) => {
        if (index === 8) buffer().base = 0.8;
        return (base as (...a: unknown[]) => Promise<Uint8Array>)(k, id, index, sealed);
      }) as never;
      const p = makePlayer();
      p.start();
      await flush();
      video.currentTime = 10;
      p.noteTime();
      for (let i = 0; i < 5; i++) await flush();
      // 12 s of media ahead of 10 s across the hole: a handful of segments, never the 200.
      expect(mediaCount()).toBeLessThanOrEqual(14);
    });

    it('P2: a first segment at 0.4 s does not make the start download the whole replay', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(200)(from));
      const base = deps.openSegment;
      let first = true;
      deps.openSegment = (async (k: string, id: string, index: number, sealed: ArrayBuffer) => {
        if (first) {
          buffer().base = 0.4;
          first = false;
        }
        return (base as (...a: unknown[]) => Promise<Uint8Array>)(k, id, index, sealed);
      }) as never;
      makePlayer().start();
      for (let i = 0; i < 5; i++) await flush();
      expect(mediaCount()).toBeLessThanOrEqual(8);
      expect(states.at(-1)).toEqual({ kind: 'playing' });
    });

    it('P3: an 80 s pause is still crossed after the media beyond it was trimmed', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(100)(from));
      const base = deps.openSegment;
      deps.openSegment = (async (k: string, id: string, index: number, sealed: ArrayBuffer) => {
        if (index === 8) buffer().base = 80;
        return (base as (...a: unknown[]) => Promise<Uint8Array>)(k, id, index, sealed);
      }) as never;
      const p = makePlayer();
      p.start();
      await flush();
      for (const t of [4, 8, 12, 15.5]) {
        video.currentTime = t;
        p.noteTime();
        for (let i = 0; i < 5; i++) await flush();
      }
      // Whatever the buffer dropped, the hole is known from the measures: 16 -> 96.
      video.currentTime = 15.5;
      p.noteStall();
      expect(video.currentTime).toBeCloseTo(96, 5);
      // And the media there is fetched again when the engine's seek reports it.
      p.noteSeeking();
      await flush();
      expect(buffer().ranges.some(([s, e]) => 96 >= s - 0.01 && 96 < e)).toBe(true);
    });

    it('the fill re-fetches media the buffer dropped ahead of the playhead', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(100)(from));
      const p = makePlayer();
      p.start();
      await flush();
      const before = mediaCount();
      buffer().remove(4, 100); // the engine evicted everything past 4 s, the cursor is at 6
      await flush();
      video.currentTime = 2;
      p.noteTime();
      await flush();
      expect(mediaCount()).toBeGreaterThan(before);
      expect(buffer().ranges[0][1]).toBeGreaterThan(8);
    });
  });

  describe('a seek past the end of its segment, into a hole of the live', () => {
    /** Segments hold 1 s of media 2 s apart: every landing 1.5 s in is past the segment's end. */
    async function started(setup?: () => void) {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(100)(from));
      setup?.();
      const p = makePlayer();
      p.start();
      await flush();
      buffer().len = 1;
      return p;
    }
    const inRange = (t: number) => buffer().ranges.some(([s, e]) => t >= s - 0.01 && t < e);

    it('lands on the start of the next segment', async () => {
      const p = await started();
      video.currentTime = 101.7; // segment 50 holds [100, 101]; the target is 0.7 s past its end
      p.noteSeeking();
      await flush();
      expect(video.currentTime).toBeCloseTo(102, 1);
      expect(inRange(video.currentTime)).toBe(true);
    });

    it('never writes a position in no range when the next segment is a 404 skip', async () => {
      const ok = deps.fetchSegment;
      const p = await started(() => {
        deps.fetchSegment = vi.fn(async (id: string, name: string, signal?: AbortSignal) => {
          if (name === 'seg-51')
            throw new LiveRefusalError(404, 'LIVE_NOT_FOUND', 'x', 'not-found', null, null, null);
          return (ok as (...a: unknown[]) => Promise<ArrayBuffer>)(id, name, signal);
        }) as never;
      });
      video.currentTime = 101.7;
      p.noteSeeking();
      await flush();
      expect(inRange(video.currentTime)).toBe(true);
      expect(video.currentTime).toBeCloseTo(104, 1); // over the skipped 51, onto the media after it
    });

    it('never writes a position in no range when the next segment does not open', async () => {
      const ok = deps.openSegment;
      const p = await started(() => {
        deps.openSegment = vi.fn(async (k: string, id: string, index: number, sealed: unknown) => {
          if (index === 51) throw new LiveSegmentOpenError('unauthentic', 51, 1);
          return (ok as (...a: unknown[]) => Promise<Uint8Array>)(k, id, index, sealed);
        }) as never;
      });
      video.currentTime = 101.7;
      p.noteSeeking();
      await flush();
      expect(inRange(video.currentTime)).toBe(true);
      expect(video.currentTime).toBeCloseTo(104, 1); // over the skipped 51, onto the media after it
    });

    it('P4: a target segment already buffered is landed on from its measured place', async () => {
      const p = await started();
      video.currentTime = 101.2; // segment 50 is [100, 101]: past its end, 51 is taken and landed on
      p.noteSeeking();
      await flush();
      expect(inRange(video.currentTime)).toBe(true);
      // The engine's start tolerance puts the position outside every range, with 50 buffered and no
      // known hole after it (its end is forgotten here): take(50) reports null.
      const inner = p as unknown as { placedEnd: Map<number, number> };
      inner.placedEnd.delete(50);
      video.currentTime = 101.4;
      p.noteSeeking();
      await flush();
      expect(inRange(video.currentTime)).toBe(true);
    });

    it('lands on the next segment when it is already buffered (take reports null)', async () => {
      const p = await started();
      video.currentTime = 102.2; // segment 51 first: [102, 103] is buffered
      p.noteSeeking();
      await flush();
      video.currentTime = 101.7; // 50 is not placed: no known hole, a seek to segment 50
      p.noteSeeking();
      await flush();
      expect(video.currentTime).toBeCloseTo(102, 1);
      expect(inRange(video.currentTime)).toBe(true);
    });
  });

  describe('a segment skipped for good (404, does not open) is a hole like any other', () => {
    const mediaCount = () => buffer().appends.filter((a) => a.startsWith('m')).length;
    const skip404 = (names: string[]) => {
      const ok = deps.fetchSegment;
      deps.fetchSegment = vi.fn(async (id: string, name: string, signal?: AbortSignal) => {
        if (names.includes(name))
          throw new LiveRefusalError(404, 'LIVE_NOT_FOUND', 'x', 'not-found', null, null, null);
        return (ok as (...a: unknown[]) => Promise<ArrayBuffer>)(id, name, signal);
      }) as never;
    };
    const inRange = (t: number) => buffer().ranges.some(([s, e]) => t >= s - 0.01 && t < e);

    it('knownHoles pairs over a skipped segment, and a region not loaded still breaks the pairing', () => {
      const segs = Array.from({ length: 5 }, (_, i) => ({
        index: i,
        name: `s${i}`,
        bytes: 1,
        atMs: i * 2000,
      }));
      const placed = new Map([
        [0, 0],
        [2, 4],
        [4, 12],
      ]);
      const ends = new Map([
        [0, 2],
        [2, 6],
        [4, 14],
      ]);
      // 1 skipped: [2, 4] is a hole; 3 is neither measured nor skipped: nothing is known across it.
      expect(knownHoles(segs, placed, ends, new Set([1]))).toEqual([[2, 4]]);
    });

    it('Q1: one 404 inside the lead does not make the fill download the replay, nor again on each timeupdate', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(200)(from));
      skip404(['seg-3']);
      const p = makePlayer();
      p.start();
      await flush();
      expect(mediaCount()).toBeLessThanOrEqual(8);
      const counts: number[] = [];
      for (const t of [1, 2, 3, 4]) {
        video.currentTime = t;
        p.noteTime();
        await flush();
        counts.push(mediaCount());
      }
      expect(counts.at(-1)).toBeLessThanOrEqual(10);
    });

    it('Q8: a segment that does not open (twice) ahead of the playhead keeps the fill bounded', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(200)(from));
      const base = deps.openSegment;
      deps.openSegment = (async (k: string, id: string, index: number, sealed: ArrayBuffer) => {
        if (index === 3) throw new LiveSegmentOpenError('malformed', 3, 1);
        return (base as (...a: unknown[]) => Promise<Uint8Array>)(k, id, index, sealed);
      }) as never;
      makePlayer().start();
      await flush();
      expect(mediaCount()).toBeLessThanOrEqual(8);
    });

    it('a segment that opens on its second download is not skipped', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(40)(from));
      const base = deps.openSegment;
      let fails = 1;
      deps.openSegment = (async (k: string, id: string, index: number, sealed: ArrayBuffer) => {
        if (index === 2 && fails-- > 0) throw new LiveSegmentOpenError('malformed', 2, 1);
        return (base as (...a: unknown[]) => Promise<Uint8Array>)(k, id, index, sealed);
      }) as never;
      makePlayer().start();
      await flush();
      expect(buffer().appends).toContain('m2');
    });

    it('Q13: a stale seek during the second download of an open failure does not end the replay', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(100)(from));
      const ok = deps.fetchSegment;
      let calls30 = 0;
      deps.fetchSegment = vi.fn((id: string, name: string, signal?: AbortSignal) => {
        if (name === 'seg-30' && ++calls30 === 2) {
          return new Promise<ArrayBuffer>((_resolve, reject) =>
            signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError'))
            )
          );
        }
        return (ok as (...a: unknown[]) => Promise<ArrayBuffer>)(id, name, signal);
      }) as never;
      const base = deps.openSegment;
      deps.openSegment = (async (k: string, id: string, index: number, sealed: ArrayBuffer) => {
        if (index === 30) throw new LiveSegmentOpenError('malformed', 30, 1);
        return (base as (...a: unknown[]) => Promise<Uint8Array>)(k, id, index, sealed);
      }) as never;
      const p = makePlayer();
      p.start();
      await flush();
      video.currentTime = 60.2; // seek A: segment 30, its open fails, the second download hangs
      p.noteSeeking();
      await flush();
      video.currentTime = 3; // seek B, buffered: supersedes A, aborting the second download
      p.noteSeeking();
      await flush();
      expect(states.at(-1)).toEqual({ kind: 'playing' });
      expect(video.currentTime).toBe(3);
    });

    it('Q14: a 404 on the second download of an open failure skips the segment, not the replay', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(40)(from));
      const ok = deps.fetchSegment;
      let calls2 = 0;
      deps.fetchSegment = vi.fn(async (id: string, name: string, signal?: AbortSignal) => {
        if (name === 'seg-2' && ++calls2 === 2)
          throw new LiveRefusalError(404, 'LIVE_NOT_FOUND', 'x', 'not-found', null, null, null);
        return (ok as (...a: unknown[]) => Promise<ArrayBuffer>)(id, name, signal);
      }) as never;
      const base = deps.openSegment;
      deps.openSegment = (async (k: string, id: string, index: number, sealed: ArrayBuffer) => {
        if (index === 2) throw new LiveSegmentOpenError('malformed', 2, 1);
        return (base as (...a: unknown[]) => Promise<Uint8Array>)(k, id, index, sealed);
      }) as never;
      makePlayer().start();
      await flush();
      expect(states.some((s) => s.kind === 'gone')).toBe(false);
      expect(buffer().appends).toContain('m3');
    });

    it('Q10: a seek whose target and everything after it is skipped lands on the last existing segment before it', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(50)(from));
      skip404(Array.from({ length: 10 }, (_, i) => `seg-${40 + i}`));
      const p = makePlayer();
      p.start();
      await flush();
      video.currentTime = 90.2; // segment 45
      p.noteSeeking();
      await flush();
      expect(video.currentTime).toBeCloseTo(78, 1); // segment 39
    });

    it('Q15: skipped segments at the end of a page: the landing follows onto the next page', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) =>
        makePages(100, 50)(from)
      );
      skip404(['seg-48', 'seg-49', 'seg-50']);
      const p = makePlayer();
      p.start();
      await flush();
      video.currentTime = 97; // segment 48, the last listed page ends at 49
      p.noteSeeking();
      await flush();
      expect(video.currentTime).toBeCloseTo(102, 1); // segment 51, on the next page
    });

    it('the leading gap is read from the first MEASURED segment when the first ones are skipped', () => {
      const segs = Array.from({ length: 3 }, (_, i) => ({
        index: i,
        name: `s${i}`,
        bytes: 1,
        atMs: i * 2000,
      }));
      expect(knownHoles(segs, new Map([[2, 4]]), new Map([[2, 6]]), new Set([0, 1]))).toEqual([
        [0, 4],
      ]);
    });

    it('a skipped or held segment is not downloaded again by a seek', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(100)(from));
      skip404(['seg-50']);
      const p = makePlayer();
      p.start();
      await flush();
      video.currentTime = 100.2;
      p.noteSeeking();
      await flush();
      const fetchSegment = deps.fetchSegment as unknown as ReturnType<typeof vi.fn>;
      const calls = () => fetchSegment.mock.calls.filter((c) => c[1] === 'seg-50').length;
      const before = calls();
      video.currentTime = 100.4;
      p.noteSeeking();
      await flush();
      expect(calls()).toBe(before);
    });

    it('paging terminates by proof: a page that adds nothing but keeps a nextFrom ends the listing', async () => {
      let calls = 0;
      fetchReplay.mockImplementation(async (_id: string, from?: number) => {
        // A step bound so that the suite itself cannot hang on a runaway loop.
        if (++calls > 50) throw new Error('runaway paging');
        if (from === undefined) return { ...makePages(10)(0), nextFrom: 10 };
        return { ...makePages(10)(0), segments: [], nextFrom: 10 };
      });
      const p = makePlayer();
      p.start();
      await flush();
      video.currentTime = 100; // beyond the 10 listed segments: the seek lists the next page
      p.noteSeeking();
      for (let i = 0; i < 5; i++) await flush();
      expect(calls).toBeLessThanOrEqual(3);
      expect(states.some((s) => s.kind === 'unavailable')).toBe(false);
      expect(inRange(video.currentTime)).toBe(true);
    });

    it('paging terminates by proof: a nextFrom that does not move forward ends the listing', async () => {
      let calls = 0;
      fetchReplay.mockImplementation(async (_id: string, from?: number) => {
        if (++calls > 50) throw new Error('runaway paging');
        const all = makePages(20)(0).segments;
        if (from === undefined)
          return { ...makePages(20)(0), segments: all.slice(0, 10), nextFrom: 10 };
        // The same segments again and a cursor that stays where it was.
        return { ...makePages(20)(0), segments: all.slice(0, 10), nextFrom: 10 };
      });
      const p = makePlayer();
      p.start();
      await flush();
      video.currentTime = 100;
      p.noteSeeking();
      for (let i = 0; i < 5; i++) await flush();
      expect(calls).toBeLessThanOrEqual(3);
      expect(states.some((s) => s.kind === 'unavailable')).toBe(false);
    });

    /** Seeks to `seconds` and answers where the playhead landed and how many requests it waited on. */
    async function seekAndCount(p: ReplayPlayer, seconds: number) {
      const fetchSegment = deps.fetchSegment as unknown as ReturnType<typeof vi.fn>;
      const before = fetchSegment.mock.calls.length;
      let current = seconds;
      let requests = -1;
      Object.defineProperty(video, 'currentTime', {
        get: () => current,
        set: (t: number) => {
          current = t;
          requests = fetchSegment.mock.calls.length - before;
        },
      });
      p.noteSeeking();
      for (let i = 0; i < 40; i++) await flush();
      return { landed: current, requests };
    }

    it('R7b: a purge of 900 segments lands on the last existing segment before it, in O(log n) requests', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(1000)(from));
      skip404(Array.from({ length: 900 }, (_, i) => `seg-${100 + i}`));
      const p = makePlayer();
      p.start();
      await flush();
      const { landed, requests } = await seekAndCount(p, 1000); // segment 500, in the purge
      expect(landed).toBeCloseTo(198, 1); // segment 99, the last that exists
      expect(requests).toBeGreaterThan(0);
      expect(requests).toBeLessThanOrEqual(100);
    });

    it('R7d: a purge from segment 60 on lands on segment 59, never on the start of the replay', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(200)(from));
      skip404(Array.from({ length: 140 }, (_, i) => `seg-${60 + i}`));
      const p = makePlayer();
      p.start();
      await flush();
      const { landed, requests } = await seekAndCount(p, 300); // segment 150
      expect(landed).toBeCloseTo(118, 1); // segment 59
      expect(requests).toBeLessThanOrEqual(100);
    });

    it('R7e: a purge from segment 50 lands on segment 49', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(200)(from));
      skip404(Array.from({ length: 150 }, (_, i) => `seg-${50 + i}`));
      const p = makePlayer();
      p.start();
      await flush();
      const { landed } = await seekAndCount(p, 300);
      expect(landed).toBeCloseTo(98, 1); // segment 49
    });

    it('R9a: a replay whose first 40 segments are gone starts playing at segment 40', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(200)(from));
      skip404(Array.from({ length: 40 }, (_, i) => `seg-${i}`));
      makePlayer().start();
      for (let i = 0; i < 20; i++) await flush();
      expect(states.at(-1)).toEqual({ kind: 'playing' });
      expect(buffer().appends).toContain('m40');
      expect(states.some((s) => s.kind === 'gone')).toBe(false);
    });

    it('R9b: a purge in the middle is crossed into segment 100, and the stream is not ended inside it', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(200)(from));
      skip404(Array.from({ length: 60 }, (_, i) => `seg-${40 + i}`));
      const p = makePlayer();
      p.start();
      await flush();
      for (let t = 0; t <= 78; t += 6) {
        video.currentTime = t;
        p.noteTime();
        for (let i = 0; i < 20; i++) await flush();
      }
      expect(source.ended).toBe(0); // never declared inside the purge
      video.currentTime = 80; // the end of segment 39: the hole [80, 200) is known
      p.noteTime();
      for (let i = 0; i < 20; i++) await flush();
      expect(video.currentTime).toBeCloseTo(200, 1);
      expect(source.ended).toBe(0);
    });

    it('R9b: probing past a long purge costs O(log n) requests, not one per segment', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(1000)(from));
      skip404(Array.from({ length: 900 }, (_, i) => `seg-${50 + i}`));
      const p = makePlayer();
      p.start();
      await flush();
      const fetchSegment = deps.fetchSegment as unknown as ReturnType<typeof vi.fn>;
      for (let t = 0; t <= 98; t += 6) {
        video.currentTime = t;
        p.noteTime();
        for (let i = 0; i < 30; i++) await flush();
      }
      const missingRequests = fetchSegment.mock.calls.filter(
        (c) => Number(String(c[1]).slice(4)) >= 50 && Number(String(c[1]).slice(4)) < 950
      ).length;
      expect(missingRequests).toBeLessThanOrEqual(120); // 30 walked, then about 2 log2(900)
    });

    it('R8c: a replay in which no segment gives media stops on gone, never a black picture', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(100)(from));
      skip404(Array.from({ length: 100 }, (_, i) => `seg-${i}`));
      const p = makePlayer();
      p.start();
      for (let i = 0; i < 20; i++) await flush();
      expect(states.at(-1)).toEqual({ kind: 'gone' });
      void p;
    });

    it('the fill stops walking a 404 tail after a bounded number of requests, and does not resume on each timeupdate', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(300)(from));
      skip404(Array.from({ length: 290 }, (_, i) => `seg-${10 + i}`));
      const p = makePlayer();
      p.start();
      await flush();
      const fetchSegment = deps.fetchSegment as unknown as ReturnType<typeof vi.fn>;
      const missingRequests = () =>
        fetchSegment.mock.calls.filter((c) => Number(String(c[1]).slice(4)) >= 10).length;
      for (const t of [8, 14, 18, 19, 19.5]) {
        video.currentTime = t;
        p.noteTime();
        for (let i = 0; i < 20; i++) await flush();
      }
      expect(missingRequests()).toBeLessThanOrEqual(40); // 30 and the page of a retry, never ~290
    });

    it('a long tail of 404s is walked a bounded number of requests, then the seek lands backward', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(200)(from));
      skip404(Array.from({ length: 190 }, (_, i) => `seg-${10 + i}`));
      const p = makePlayer();
      p.start();
      await flush();
      const fetchSegment = deps.fetchSegment as unknown as ReturnType<typeof vi.fn>;
      const before = fetchSegment.mock.calls.length;
      // The seek is answered when the playhead is written: count the requests it waited on.
      let current = 200.2;
      let requestsAtLanding = -1;
      Object.defineProperty(video, 'currentTime', {
        get: () => current,
        set: (t: number) => {
          current = t;
          requestsAtLanding = fetchSegment.mock.calls.length - before;
        },
      });
      p.noteSeeking(); // segment 100, inside the purged run
      for (let i = 0; i < 20; i++) await flush();
      expect(requestsAtLanding).toBeGreaterThan(0);
      expect(requestsAtLanding).toBeLessThanOrEqual(70); // 1 + 30 forward + 30 backward, never ~190
      // Still answered: the nearest media held, inside a range.
      expect(inRange(video.currentTime)).toBe(true);
    });

    it("Q2/Q3: a stall before a skipped segment's gap is carried over it", async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(40)(from));
      skip404(['seg-3']); // media [6, 8] never arrives
      const p = makePlayer();
      p.start();
      await flush();
      video.currentTime = 5.5;
      p.noteStall();
      expect(video.currentTime).toBeCloseTo(8, 5);
    });

    it('Q7: nothing is downloaded behind the playhead after a seek into skipped segments', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(100)(from));
      skip404(['seg-50', 'seg-51']);
      const p = makePlayer();
      p.start();
      await flush();
      video.currentTime = 100.5;
      p.noteSeeking();
      await flush();
      const inner = p as unknown as { placed: Map<number, number> };
      const behind = [...inner.placed].filter(([i]) => i > 5 && i < 50);
      expect(behind).toEqual([]);
      expect(video.currentTime).toBeCloseTo(104, 1);
    });

    it('a seek whose target and next segments are all skipped to the end lands on the last existing segment before it', async () => {
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(100)(from));
      const names = Array.from({ length: 50 }, (_, i) => `seg-${50 + i}`);
      skip404(names);
      const p = makePlayer();
      p.start();
      await flush();
      video.currentTime = 150; // 404s from 50 to the last segment
      p.noteSeeking();
      for (let i = 0; i < 10; i++) await flush(); // ~50 sequential 404s
      // Never left unanswered: a position inside a range was written.
      expect(inRange(video.currentTime)).toBe(true);
      expect(video.currentTime).toBeCloseTo(98, 1); // segment 49, the last one that exists
    });
  });

  describe('the latest seek is the single source of truth', () => {
    /** Holds every segment fetch named in `held` until the test resolves (or the signal aborts) it. */
    function holdFetches(held: Set<string>) {
      const pending = new Map<string, () => void>();
      const signals = new Map<string, AbortSignal | undefined>();
      deps.fetchSegment = vi.fn((_id: string, name: string, signal?: AbortSignal) => {
        const bytes = new TextEncoder().encode(name).buffer as ArrayBuffer;
        if (!held.has(name)) return Promise.resolve(bytes);
        signals.set(name, signal);
        return new Promise<ArrayBuffer>((resolve, reject) => {
          pending.set(name, () => resolve(bytes));
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        });
      }) as never;
      return { pending, signals };
    }

    async function started(held: string[]) {
      const fetches = holdFetches(new Set(held));
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(100)(from));
      const p = makePlayer();
      p.start();
      await flush();
      return { p, ...fetches };
    }

    it('seek to A, seek to B while A loads, A resolves late: the playhead stays at B', async () => {
      const { p, pending } = await started(['seg-30', 'seg-60']);
      video.currentTime = 60.2; // A: segment 30
      p.noteSeeking();
      await flush();
      video.currentTime = 120.2; // B: segment 60
      p.noteSeeking();
      await flush();
      pending.get('seg-30')?.(); // a late answer for the older target (a no-op once aborted)
      await flush();
      expect(video.currentTime).toBeCloseTo(120.2, 1);
      pending.get('seg-60')?.();
      await flush();
      expect(buffer().appends).not.toContain('m30');
      expect(buffer().appends).toContain('m60');
      expect(video.currentTime).toBeCloseTo(120.2, 1);
    });

    it('cancels the download of the superseded seek', async () => {
      const { p, signals } = await started(['seg-30', 'seg-60']);
      video.currentTime = 60.2;
      p.noteSeeking();
      await flush();
      video.currentTime = 120.2;
      p.noteSeeking();
      await flush();
      expect(signals.get('seg-30')?.aborted).toBe(true);
      expect(signals.get('seg-60')?.aborted).toBe(false);
    });

    it('a seek back into buffered media while an older seek loads is not overwritten by it', async () => {
      const { p, pending } = await started(['seg-30']);
      video.currentTime = 60.2; // A: far, not buffered
      p.noteSeeking();
      await flush();
      video.currentTime = 3; // B: inside the first buffered range
      p.noteSeeking();
      await flush();
      pending.get('seg-30')?.();
      await flush();
      expect(video.currentTime).toBe(3);
      expect(buffer().appends).not.toContain('m30');
    });

    it('rapid repeated seeks: only the last target is served and the playhead is its own', async () => {
      const { p, pending } = await started(['seg-20', 'seg-30', 'seg-40', 'seg-50']);
      for (const t of [40.2, 60.2, 80.2, 100.2]) {
        video.currentTime = t;
        p.noteSeeking();
        await flush();
      }
      for (const n of ['seg-20', 'seg-30', 'seg-40', 'seg-50']) pending.get(n)?.();
      await flush();
      expect(video.currentTime).toBeCloseTo(100.2, 1);
      const appended = buffer().appends.filter((a) => a.startsWith('m'));
      for (const stale of ['m20', 'm30', 'm40']) expect(appended).not.toContain(stale);
      expect(appended).toContain('m50');
      expect(states.at(-1)).toEqual({ kind: 'playing' });
    });

    it('works on an engine without AbortSignal.any (iOS 16 WKWebView)', async () => {
      const saved = (AbortSignal as { any?: unknown }).any;
      delete (AbortSignal as { any?: unknown }).any;
      try {
        const { p, signals, pending } = await started(['seg-30', 'seg-60']);
        video.currentTime = 60.2;
        p.noteSeeking();
        await flush();
        video.currentTime = 120.2;
        p.noteSeeking();
        await flush();
        expect(signals.get('seg-30')?.aborted).toBe(true);
        pending.get('seg-60')?.();
        await flush();
        expect(buffer().appends).toContain('m60');
        expect(video.currentTime).toBeCloseTo(120.2, 1);
        expect(states.at(-1)).toEqual({ kind: 'playing' });
      } finally {
        (AbortSignal as { any?: unknown }).any = saved;
      }
    });

    it('a retryable failure of seek A then a seek B into buffered media does not leave reconnecting stuck', async () => {
      let failing = false;
      const ok = deps.fetchSegment;
      deps.fetchSegment = ((id: string, name: string, signal?: AbortSignal) =>
        failing
          ? Promise.reject(new TransportFailureError(new Error('net')))
          : ok(id, name, signal)) as never;
      fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(100)(from));
      const p = makePlayer();
      p.start();
      await flush();
      failing = true;
      video.currentTime = 60.2; // A: outside the buffer, fails retryably
      p.noteSeeking();
      await flush();
      expect(states.at(-1)).toEqual({ kind: 'reconnecting' });
      video.currentTime = 0; // B: buffered, with a full lead: no fetch needed
      p.noteSeeking();
      await flush();
      expect(states.at(-1)).toEqual({ kind: 'playing' });
      expect(video.currentTime).toBe(0);
    });

    it('loads the target segment first, then the ones ahead of it', async () => {
      const { p } = await started([]);
      video.currentTime = 100.4;
      p.noteSeeking();
      await flush();
      const after = buffer().appends.slice(buffer().appends.indexOf('m50'));
      expect(after.filter((a) => a.startsWith('m'))[0]).toBe('m50');
      expect(after).toContain('m51');
    });
  });

  it('rebases a replay trimmed to its last hours to zero under a timestampOffset', async () => {
    const pages = makePages(10, 200, 5000);
    fetchReplay.mockImplementation(async (_id: string, from?: number) => pages(from));
    // The media time of segment 5000 is 5000 * 2 s = 10 000 s: far from zero.
    makePlayer().start();
    await flush();
    expect(buffer().timestampOffset).toBeLessThan(-9_000);
    expect(buffer().ranges[0][0]).toBeCloseTo(0, 1);
    expect(buffer().removed.length).toBeGreaterThan(0);
  });

  it('a 404 on the first page is gone, and nothing plays', async () => {
    fetchReplay.mockRejectedValue(
      new LiveRefusalError(404, 'LIVE_NOT_FOUND', 'x', 'not-found', null, null, null)
    );
    makePlayer().start();
    await flush();
    expect(states.at(-1)).toEqual({ kind: 'gone' });
    expect(video.pause).toHaveBeenCalled();
  });

  it('a transport failure is retried after a backoff and the screen says reconnecting, then plays', async () => {
    fetchReplay.mockRejectedValueOnce(new TransportFailureError(new Error('net')));
    makePlayer().start();
    await flush();
    expect(states.at(-1)).toEqual({ kind: 'reconnecting' });
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(1000);
    timers.shift()!.fn();
    await flush();
    expect(states.at(-1)).toEqual({ kind: 'playing' });
  });

  it('an engine with no MediaSource is unsupported, final', async () => {
    deps.mediaSource = () => null;
    makePlayer().start();
    await flush();
    expect(states.at(-1)).toEqual({ kind: 'unavailable', reason: 'unsupported' });
  });

  it('three segments in a row that do not open make the replay undecryptable', async () => {
    deps.openSegment = vi.fn(async () => {
      throw new LiveSegmentOpenError('unauthentic', 0, 10);
    }) as never;
    makePlayer().start();
    await flush();
    expect(states.at(-1)).toEqual({ kind: 'unavailable', reason: 'undecryptable' });
  });

  it('a segment the server no longer has is skipped, and the rest plays', async () => {
    deps.fetchSegment = vi.fn(async (_id: string, name: string) => {
      if (name === 'seg-1')
        throw new LiveRefusalError(404, null, 'x', 'not-found', null, null, null);
      return new ArrayBuffer(4);
    }) as never;
    makePlayer().start();
    await flush();
    expect(buffer().appends).not.toContain('m1');
    expect(states.at(-1)).toEqual({ kind: 'playing' });
  });

  it('appends a fragment with its last video frame given the interval the camera ran at, counted once', async () => {
    // Chromium's recorder at 12.5 fps (7200 ticks at 90 kHz) writes the last frame as 1/30 s.
    const written = [...Array<number>(24).fill(7200), 3000];
    deps.openSegment = vi.fn(async (_k: string, _id: string, index: number) =>
      index === 0
        ? join(initSegment(), fragment({ videoDurations: written }))
        : concat(init(0), media(index))
    ) as never;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const p = makePlayer();
    p.start();
    await flush();
    const held = buffer().data.filter((d) => readVideoDurations(d).length === written.length);
    // Placed far past zero (its moof's size is its index here), it is appended twice: once, then
    // again after the rebase to zero - corrected both times, counted ONCE.
    expect(held.length).toBe(2);
    for (const f of held) expect(readVideoDurations(f).at(-1)).toBe(7200);
    p.stop();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(', 1 last frames held'));
    log.mockRestore();
  });

  it('a fragment whose trun overruns its box stops the replay on playback', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fragment({ videoDurations: [7200, 7200, 3000] });
    const trun = f.findIndex(
      (_, i) => f[i] === 0x74 && f[i + 1] === 0x72 && f[i + 2] === 0x75 && f[i + 3] === 0x6e
    );
    new DataView(f.buffer).setUint32(trun + 8, 500);
    deps.openSegment = vi.fn(async () => join(initSegment(), f)) as never;
    makePlayer().start();
    await flush();
    expect(states.at(-1)).toEqual({ kind: 'unavailable', reason: 'playback' });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('not framable'));
    errors.mockRestore();
  });

  it('a video error stops the player on playback', async () => {
    const p = makePlayer();
    p.start();
    await flush();
    p.noteMediaError();
    expect(states.at(-1)).toEqual({ kind: 'unavailable', reason: 'playback' });
  });

  it('a wait on a hole re-anchors, a wait inside buffered media is left alone', async () => {
    fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(100)(from));
    const p = makePlayer();
    p.start();
    await flush();
    const before = buffer().appends.length;
    video.currentTime = 4;
    p.noteStall();
    await flush();
    expect(buffer().appends.length).toBe(before);
    video.currentTime = 60;
    p.noteStall();
    await flush();
    expect(buffer().appends).toContain('m30');
  });

  it('stop gives the source back and ignores what is still in flight', async () => {
    const p = makePlayer();
    p.start();
    await flush();
    p.stop();
    await flush();
    expect(detach).toHaveBeenCalled();
    const seen = states.length;
    video.currentTime = 6;
    p.noteTime();
    await flush();
    expect(states).toHaveLength(seen);
    expect(buffer().appends.filter((a) => a.startsWith('m'))).toHaveLength(6);
  });

  it('pages beyond the first are listed as the cursor reaches them', async () => {
    fetchReplay.mockImplementation(async (_id: string, from?: number) => makePages(10, 4)(from));
    const p = makePlayer();
    p.start();
    await flush();
    expect(fetchReplay).toHaveBeenCalledWith(LIVE, undefined);
    expect(fetchReplay).toHaveBeenCalledWith(LIVE, 4);
    expect(buffer().appends).toContain('m5');
  });
});
