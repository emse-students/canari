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
const init = (generation: number) => concat(box('ftyp', 4), box('moov', 16 + generation));
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
  appends: string[] = [];
  ranges: [number, number][] = [];
  removed: [number, number][] = [];
  get buffered() {
    const r = this.ranges;
    return { length: r.length, start: (i: number) => r[i][0], end: (i: number) => r[i][1] };
  }
  appendBuffer(data: Uint8Array<ArrayBuffer>): void {
    const type = String.fromCharCode(...data.subarray(4, 8));
    if (type === 'ftyp') this.appends.push(`init${generationOfInit(data)}`);
    else {
      const i = indexOfMedia(data);
      this.appends.push(`m${i}`);
      const start = i * 2 + this.base + this.timestampOffset;
      this.add(start, start + 2);
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
