/**
 * THE LIVE PLAYER'S STATE MACHINE AGAINST FAKE MSE OBJECTS AND A MANUAL CLOCK.
 *
 * Segments have the broadcaster's shape (#2115): each is SELF-CONTAINED, the recorder's init then
 * one fragment, and a camera re-acquired mid-live writes a NEW init and moves the timestamps forward.
 *
 * Pinned: the join on the newest two segments; an identical init appended once, a new one appended again;
 * a time gap crossed at the stall; the poll in index order; the catch-up to the NEWEST window (the
 * server's `?from=` answers the oldest); every refusal mapped to its screen (`full` never confused
 * with a retry, a `404` once the key was served read as the end); every final screen pausing; the
 * seat given back on close and never by a stale run; append failures counted on their own; a video
 * error stopping the player; the buffer policy (L-F1): a seek's own `waiting` is no stall, a paired
 * cadence raises the target, an outage never does, a stall latched while a poll awaits its segments
 * is re-anchored on them (LIVE-STALL-1), and each delivery says what it did to the buffer. No sleep and no wall clock: the timer is a queue
 * this file runs by hand, the policy's clock a number it sets, and the other times are the
 * manifest's database times.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LivePlayer,
  liveSourceBufferType,
  type LiveMediaSourceLike,
  type LiveSourceBufferLike,
  type LivePlayerDeps,
} from './livePlayer';
import { LiveRefusalError } from './api';
import { LiveSegmentOpenError, openLiveSegment, sealLiveSegment } from './liveCrypto';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { liveFailureOutcome, type LiveViewerState } from './liveViewerState';
import type { LiveManifest, LiveView } from './types';

const LIVE = '0b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';
const STARTED = Date.parse('2026-10-19T10:00:00.000Z');

/** One ISO-BMFF box of `type` with `payload` bytes of zeros. */
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
/** The recorder's init; `generation` is a camera acquisition (its `moov` differs). */
const init = (generation: number) => concat(box('ftyp', 4), box('moov', 16 + generation));
/** A media fragment; its size carries its index so an append can be read back. */
const media = (index: number) => concat(box('moof', index), box('mdat', 8));
const indexOfMedia = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset).getUint32(0) - 8;
const generationOfInit = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset).getUint32(12) - 8 - 16;

/**
 * A source buffer: every media append adds 2 s to the last range, settled in a microtask. A
 * `gapNext` opens a NEW range that many seconds later - the forward jump of a re-acquire.
 */
class FakeBuffer extends EventTarget implements LiveSourceBufferLike {
  updating = false;
  mode = 'sequence';
  appends: string[] = [];
  ranges: [number, number][] = [];
  removed: [number, number][] = [];
  gapNext = 0;
  /** Appends that throw, as one after a SourceBuffer error does. */
  failing = false;
  get buffered() {
    const r = this.ranges;
    return { length: r.length, start: (i: number) => r[i][0], end: (i: number) => r[i][1] };
  }
  get end() {
    return this.ranges.at(-1)?.[1] ?? 0;
  }
  appendBuffer(data: Uint8Array<ArrayBuffer>): void {
    if (this.failing) throw new DOMException('closed', 'InvalidStateError');
    const type = String.fromCharCode(...data.subarray(4, 8));
    if (type === 'ftyp') this.appends.push(`init${generationOfInit(data)}`);
    else {
      this.appends.push(`m${indexOfMedia(data)}`);
      const last = this.ranges.at(-1);
      if (!last) this.ranges.push([0, 2]);
      else if (this.gapNext > 0) {
        this.ranges.push([last[1] + this.gapNext, last[1] + this.gapNext + 2]);
        this.gapNext = 0;
      } else last[1] += 2;
    }
    this.settle();
  }
  remove(start: number, end: number): void {
    this.removed.push([start, end]);
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

class FakeSource extends EventTarget implements LiveMediaSourceLike {
  readyState = 'closed';
  buffers: FakeBuffer[] = [];
  addSourceBuffer(): LiveSourceBufferLike {
    const b = new FakeBuffer();
    this.buffers.push(b);
    return b;
  }
}

/** A live on the server: `count` segments stored, the manifest window of 10, two database times. */
class FakeLive {
  count = 0;
  serverNow = STARTED;
  lastSegmentAt: number | null = null;
  /** The manifest's viewer count, as the seat script answers it. */
  viewers: number | null = 1;
  /** The index from which the camera was re-acquired (a new init), or Infinity. */
  reacquiredAt = Infinity;
  liveErrors: unknown[] = [];
  manifestErrors: unknown[] = [];
  openErrors = new Set<number>();

  push(n = 1) {
    for (let i = 0; i < n; i++) {
      this.count++;
      this.serverNow += 2_000;
      this.lastSegmentAt = this.serverNow;
    }
  }
  /** As the server answers: the newest 10, or the OLDEST 10 from `from`. */
  manifest(from?: number): LiveManifest {
    const all = Array.from({ length: this.count }, (_, index) => ({
      index,
      name: `seg-${index}`,
      bytes: 100,
    }));
    const segments =
      from === undefined ? all.slice(-10) : all.filter((s) => s.index >= from).slice(0, 10);
    return {
      liveId: LIVE,
      nextIndex: this.count,
      lastSegmentAt:
        this.lastSegmentAt === null ? null : new Date(this.lastSegmentAt).toISOString(),
      serverNow: new Date(this.serverNow).toISOString(),
      segments,
      viewers: this.viewers,
    };
  }
  /** One self-contained segment: its init, then its fragment. */
  plain(index: number): Uint8Array<ArrayBuffer> {
    return concat(init(index >= this.reacquiredAt ? 1 : 0), media(index));
  }
}

const refusal = (kind: LiveRefusalError['kind'], status = 503, viewerCap: number | null = null) =>
  new LiveRefusalError(status, null, kind, kind, viewerCap, null, null);

let live: FakeLive;
let timers: { fn: () => void; ms: number }[];
let source: FakeSource | null;
let states: LiveViewerState[];
let elapsed: number[];
let viewerCounts: (number | null)[];
let video: {
  currentTime: number;
  paused: boolean;
  seeking: boolean;
  play: () => Promise<void>;
  pause: () => void;
};
/** The monotonic clock the buffer policy reads; moved by hand, never by the wall. */
let clock: number;
let deps: LivePlayerDeps;
let detach: ReturnType<typeof vi.fn<() => void>>;

async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

/** Runs the one pending timer (the player keeps at most one) and lets its work finish. */
async function tickTimer() {
  const next = timers.shift();
  expect(next, 'a timer is pending').toBeDefined();
  next!.fn();
  await flush();
  return next!.ms;
}

function makePlayer() {
  return new LivePlayer({
    liveId: LIVE,
    video,
    onState: (s) => states.push(s),
    onElapsed: (ms) => elapsed.push(ms),
    onViewers: (count) => viewerCounts.push(count),
    deps,
  });
}

const buffer = () => source!.buffers[0];
const kinds = () => states.map((s) => s.kind);

beforeEach(() => {
  live = new FakeLive();
  timers = [];
  source = null;
  states = [];
  elapsed = [];
  viewerCounts = [];
  detach = vi.fn<() => void>();
  clock = 0;
  video = {
    currentTime: 0,
    paused: true,
    seeking: false,
    play: vi.fn(async () => {
      video.paused = false;
    }),
    pause: vi.fn(() => {
      video.paused = true;
    }),
  };
  deps = {
    fetchLive: vi.fn(async (): Promise<LiveView> => {
      const e = live.liveErrors.shift();
      if (e) throw e;
      return {
        id: LIVE,
        broadcasterId: 'b',
        associationId: null,
        startedAt: new Date(STARTED).toISOString(),
        lastSegmentAt: null,
        nextIndex: live.count,
        key: 'ab'.repeat(32),
      };
    }),
    fetchManifest: vi.fn(async (_id: string, from?: number) => {
      const e = live.manifestErrors.shift();
      if (e) throw e;
      return live.manifest(from);
    }),
    fetchSegment: vi.fn(async (_id: string, name: string) => {
      const index = Number(name.slice(4));
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, index);
      return b.buffer;
    }),
    openSegment: vi.fn(async (_k: string, _id: string, index: number) => {
      if (live.openErrors.has(index)) throw new LiveSegmentOpenError('unauthentic', index, 0);
      return live.plain(index);
    }),
    leaveSeat: vi.fn(async () => {}),
    mediaSource: () => ({
      name: 'MediaSource',
      create: () => {
        source = new FakeSource();
        return source;
      },
      isTypeSupported: () => true,
    }),
    attach: vi.fn((s: LiveMediaSourceLike) => {
      queueMicrotask(() => {
        (s as FakeSource).readyState = 'open';
        s.dispatchEvent(new Event('sourceopen'));
      });
      return detach;
    }),
    schedule: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return () => {
        const i = timers.indexOf(t);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    now: () => clock,
  };
});

async function joined(segments = 3) {
  live.push(segments);
  const p = makePlayer();
  p.start();
  await flush();
  return p;
}

describe('the join', () => {
  it('joins on the newest two segments: their init once, their fragments, the smallest target behind the edge', async () => {
    await joined(6); // 0..5
    expect(buffer().mode).toBe('segments');
    expect(buffer().appends).toEqual(['init0', 'm4', 'm5']);
    expect(vi.mocked(deps.fetchManifest).mock.calls.map((c) => c[1])).toEqual([undefined]);
    expect(video.currentTime).toBe(1); // the one range is [0, 4]: edge 4 - target 3 (2 s + a poll)
    expect(video.play).toHaveBeenCalled();
    expect(kinds()).toEqual(['connecting', 'playing']);
    expect(elapsed.at(-1)).toBe(12_000);
    expect(timers.map((t) => t.ms)).toEqual([1_000]);
  });

  it("tells the screen each manifest's viewer count - the join's and every poll's, no extra request", async () => {
    live.viewers = 2;
    await joined(3);
    expect(viewerCounts).toEqual([2]);
    live.viewers = 5;
    live.push(1);
    await tickTimer();
    live.viewers = null;
    await tickTimer();
    expect(viewerCounts).toEqual([2, 5, null]);
    expect(deps.fetchManifest).toHaveBeenCalledTimes(3);
  });

  it('a failed poll hands the screen NO count, never the last one', async () => {
    live.viewers = 4;
    await joined(3);
    expect(viewerCounts).toEqual([4]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    live.manifestErrors.push(refusal('seats-unavailable'));
    await tickTimer();
    expect(kinds().at(-1)).toBe('reconnecting');
    expect(viewerCounts.at(-1)).toBeNull();
  });

  it("joining after a re-acquire takes the newest segments' OWN init, never segment 0", async () => {
    live.reacquiredAt = 2;
    await joined(4); // 0, 1 on the first camera; 2, 3 on the second
    expect(buffer().appends).toEqual(['init1', 'm2', 'm3']);
    expect(deps.fetchSegment).toHaveBeenCalledTimes(2);
  });

  it('waits at the poll pace while the live has no segment yet', async () => {
    makePlayer().start();
    await flush();
    expect(kinds()).toEqual(['connecting']);
    live.push(2);
    await tickTimer();
    expect(buffer().appends).toEqual(['init0', 'm0', 'm1']);
    expect(kinds()).toEqual(['connecting', 'playing']);
  });

  it('a first segment with no init cannot be played', async () => {
    deps.openSegment = vi.fn(async (_k: string, _id: string, index: number) => media(index));
    await joined(2);
    expect(states.at(-1)).toEqual({ kind: 'unavailable', reason: 'playback' });
    expect(deps.leaveSeat).toHaveBeenCalledWith(LIVE);
  });

  it('a segment with a box no reader can frame stops the viewer on playback', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A size-0 box ("to the end of the file") cannot be framed in a live stream.
    deps.openSegment = vi.fn(async () => concat(box('ftyp', 4), new Uint8Array(8)));
    await joined(2);
    expect(states.at(-1)).toEqual({ kind: 'unavailable', reason: 'playback' });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('not framable'));
    errors.mockRestore();
  });

  it('never takes a seat on an engine with no MediaSource', async () => {
    deps.mediaSource = () => null;
    makePlayer().start();
    await flush();
    expect(deps.fetchLive).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ kind: 'unavailable', reason: 'unsupported' });
  });

  it('plays segments sealed with the real v1 seal, opened by the real opener', async () => {
    const key = 'ab'.repeat(32);
    // WebCrypto settles outside the microtask queue: every crypto promise is awaited by name, so
    // the test waits for exactly the work it started - no sleep, no polling.
    const pending: Promise<unknown>[] = [];
    const track = <T>(p: Promise<T>): Promise<T> => {
      pending.push(p);
      return p;
    };
    deps.fetchSegment = vi.fn((_id: string, name: string) => {
      const index = Number(name.slice(4));
      return track(sealLiveSegment(key, LIVE, index, live.plain(index)).then((s) => s.buffer));
    });
    deps.openSegment = (...args) => track(openLiveSegment(...args));
    live.push(4);
    makePlayer().start();
    for (let round = 0; round < 10; round++) {
      await flush();
      await Promise.all(pending.splice(0));
    }
    expect(buffer().appends).toEqual(['init0', 'm2', 'm3']);
    expect(states.at(-1)).toEqual({ kind: 'playing' });
  });

  it('quotes the codecs of the recorder mime for addSourceBuffer', () => {
    expect(liveSourceBufferType('video/mp4;codecs=avc1.42E01F,mp4a.40.2')).toBe(
      'video/mp4; codecs="avc1.42E01F,mp4a.40.2"'
    );
  });
});

describe('the poll', () => {
  it('appends new segments in index order; an identical init is appended once', async () => {
    await joined();
    live.push(2); // 3, 4
    await tickTimer();
    expect(vi.mocked(deps.fetchManifest).mock.calls.at(-1)?.[1]).toBe(3);
    expect(buffer().appends).toEqual(['init0', 'm1', 'm2', 'm3', 'm4']);
    expect(timers.map((t) => t.ms)).toEqual([1_000]);
  });

  it('a re-acquired camera: its NEW init is appended, and the time gap is crossed at the stall', async () => {
    const p = await joined(); // 0..2, joined on 1 and 2: range [0, 4]
    live.reacquiredAt = 3;
    buffer().gapNext = 30; // the broadcaster's timestamps moved forward by its time away
    live.push(1);
    await tickTimer();
    expect(buffer().appends).toEqual(['init0', 'm1', 'm2', 'init1', 'm3']);
    expect(buffer().ranges).toEqual([
      [0, 4],
      [34, 36],
    ]);
    expect(states.at(-1)).toEqual({ kind: 'playing' });
    // The video reaches the end of the first range and waits: it is sent across at once.
    video.currentTime = 4;
    p.noteStall();
    expect(video.currentTime).toBe(34);
    // The next segment carries the new init again: not re-appended, and no further seek.
    live.push(1);
    video.currentTime = 35;
    await tickTimer();
    expect(buffer().appends).toEqual(['init0', 'm1', 'm2', 'init1', 'm3', 'm4']);
    expect(video.currentTime).toBe(35);
    expect(states.at(-1)).toEqual({ kind: 'playing' });
  });

  it('jumps to the newest and seeks to the edge when a few segments behind', async () => {
    await joined();
    live.push(5); // 3..7
    video.currentTime = 1;
    await tickTimer();
    expect(buffer().appends).toEqual(['init0', 'm1', 'm2', 'm7']);
    expect(video.currentTime).toBe(3); // end 6 - target 3
  });

  it('far behind, asks for the NEWEST window rather than the oldest one from its index', async () => {
    await joined();
    live.push(30); // 3..32; `?from=3` answers 3..12
    await tickTimer();
    expect(
      vi
        .mocked(deps.fetchManifest)
        .mock.calls.slice(-2)
        .map((c) => c[1])
    ).toEqual([3, undefined]);
    expect(buffer().appends).toEqual(['init0', 'm1', 'm2', 'm32']);
  });

  it('seeks back to the edge at the first segment after a stall', async () => {
    const p = await joined();
    live.push(1);
    await tickTimer();
    p.noteStall();
    video.currentTime = 0.5;
    live.push(1);
    await tickTimer();
    expect(video.currentTime).toBe(5); // end 8 - target 3
  });

  it('plays again after a pause from outside, at the next segment', async () => {
    await joined();
    video.paused = true;
    live.push(1);
    await tickTimer();
    expect(video.paused).toBe(false);
  });

  it('trims what was played long ago', async () => {
    await joined();
    live.push(2);
    video.currentTime = 40;
    await tickTimer();
    expect(buffer().removed).toEqual([[0, 30]]);
  });

  it('says reconnecting while the broadcaster is quiet, on the database clock', async () => {
    await joined();
    live.serverNow += 7_000; // 7 s without a segment, by the server's own clock
    await tickTimer();
    expect(states.at(-1)).toEqual({ kind: 'reconnecting', reason: 'broadcaster' });
    live.push(1);
    await tickTimer();
    expect(states.at(-1)).toEqual({ kind: 'playing' });
  });
});

describe('the buffer policy (L-F1)', () => {
  it("the wait of the player's OWN seek is no stall: the next delivery does not seek again", async () => {
    const p = await joined(); // range [0, 4], seeked to 1
    // The engine fires `waiting` while it completes the join's seek (L-F1: "stalled at" logged in
    // the same millisecond as the seek, at exactly its target).
    video.seeking = true;
    p.noteStall();
    video.seeking = false;
    video.currentTime = 1.7; // it played on
    clock = 1_000;
    live.push(1);
    await tickTimer();
    expect(buffer().ranges).toEqual([[0, 6]]);
    expect(video.currentTime).toBe(1.7); // 4.3 s behind, inside the target and its slack: no seek
  });

  it('a producer that delivers in PAIRS every 4 s raises the target to 4 s, then plays them without a stall', async () => {
    const p = await joined(); // range [0, 4], seeked to 1, the first delivery at clock 0
    // The 2 s target of old ran dry here: the video reaches the end of what it holds and waits.
    video.currentTime = 4;
    p.noteStall();
    clock = 4_000;
    live.push(2); // the pair: 3, 4
    await tickTimer();
    expect(buffer().ranges).toEqual([[0, 8]]);
    expect(video.currentTime).toBe(4); // the stall's re-anchor: end 8 - the MEASURED 4 s
    // The next pair, 4 s later: the video played 3.9 s and never ran dry, so nothing seeks.
    video.currentTime = 7.9;
    clock = 8_000;
    live.push(2);
    await tickTimer();
    expect(buffer().ranges).toEqual([[0, 12]]);
    expect(video.currentTime).toBe(7.9);
  });

  it('a stall latched WHILE the poll awaits its segments is re-anchored on them, never cleared without a seek (LIVE-STALL-1)', async () => {
    // The segment fetch is held open by the test: the interleaving is chosen, not timed.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const plainFetch = deps.fetchSegment;
    deps.fetchSegment = vi.fn(async (id: string, name: string, signal?: AbortSignal) => {
      if (Number(name.slice(4)) >= 3) await held;
      return plainFetch(id, name, signal);
    });
    const p = await joined(); // range [0, 4], seeked to 1, the first delivery at clock 0
    clock = 2_000;
    live.push(1); // 3
    await tickTimer(); // the manifest answered; segment 3 is still on its way
    expect(buffer().appends).toEqual(['init0', 'm1', 'm2']);
    // The video runs dry while the fetch is awaited: the stall latches mid-poll.
    video.currentTime = 4;
    p.noteStall();
    release();
    await flush();
    expect(buffer().ranges).toEqual([[0, 6]]);
    // The stall's re-anchor, on the media that just arrived: end 6 - target 3. The old player read
    // the latch BEFORE the fetch, saw none, did not seek (2 s behind is no drift) and cleared it.
    expect(video.currentTime).toBe(3);
    // And the latch was spent by that re-anchor: the next delivery, inside the target, seeks no more.
    video.currentTime = 4.5;
    clock = 4_000;
    live.push(1);
    await tickTimer();
    expect(video.currentTime).toBe(4.5);
  });

  it('says once per delivery what it did to the buffer: the segments, the end, the playhead, the media ahead', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await joined(); // range [0, 4], seeked to 1
    video.currentTime = 2.5;
    clock = 2_000;
    live.push(2); // 3, 4
    await tickTimer();
    const lines = debug.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('delivery of'));
    expect(lines).toEqual([
      `[LIVE] viewer ${LIVE}: delivery of 2 appended of 2 taken (3-4), gap 2000 ms: end 4.00 -> 8.00, at 2.50 -> 2.50, ahead 1.50 -> 5.50 s`,
    ]);
    // A poll that brings nothing says nothing.
    await tickTimer();
    expect(debug.mock.calls.filter((c) => String(c[0]).includes('delivery of'))).toHaveLength(1);
    // A segment skipped inside the range: the line says how many were appended of how many taken.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    live.openErrors.add(5);
    live.push(2); // 5 (does not open), 6
    await tickTimer();
    expect(
      debug.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('delivery of'))[1]
    ).toBe(
      `[LIVE] viewer ${LIVE}: delivery of 1 appended of 2 taken (5-6), gap 0 ms: end 8.00 -> 10.00, at 2.50 -> 2.50, ahead 5.50 -> 7.50 s`
    );
    errors.mockRestore();
    debug.mockRestore();
  });

  it('a stall with nothing buffered to re-anchor on stays latched, and the next delivery that brings media spends it', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = await joined(); // range [0, 4]
    buffer().ranges = []; // everything evicted: no edge to seek to
    video.currentTime = 1.5;
    p.noteStall(); // starved: latched
    live.openErrors.add(3);
    live.push(1); // 3 does not open: the poll appends nothing
    await tickTimer();
    const said = () => debug.mock.calls.map((c) => String(c[0]));
    expect(said()).toContain(`[LIVE] viewer ${LIVE}: no media buffered - no seek (stall)`);
    expect(video.currentTime).toBe(1.5);
    // The latch was kept: the next delivery re-anchors on what it brings, as a STALL.
    live.push(1); // 4 -> range [0, 2]
    await tickTimer();
    expect(video.currentTime).toBe(0); // max(start 0, end 2 - target 3)
    const stallSeeks = () => said().filter((l) => l.includes('seek to the live edge (stall)'));
    expect(stallSeeks()).toHaveLength(1);
    // And that seek spent it: a delivery inside the target and its slack seeks no more.
    video.currentTime = 1.5;
    live.push(1); // 5 -> range [0, 4]
    await tickTimer();
    expect(video.currentTime).toBe(1.5);
    expect(stallSeeks()).toHaveLength(1);
    errors.mockRestore();
    debug.mockRestore();
  });

  it('a stall latched during the trim stays latched, and the NEXT delivery re-anchors on it', async () => {
    const p = await joined();
    buffer().ranges = [[0, 70]]; // a long live: enough behind the playhead to trim
    video.currentTime = 68;
    const fake = buffer();
    const remove = fake.remove.bind(fake);
    // The video runs dry while the trim is awaited - after this poll's seek decision.
    fake.remove = (start: number, end: number) => {
      p.noteStall();
      remove(start, end);
    };
    live.push(1); // 3 -> range [0, 72], 4 s behind: inside the target and its slack
    await tickTimer();
    expect(fake.removed).toEqual([[0, 58]]);
    expect(video.currentTime).toBe(68); // nothing seeked after the trim
    fake.remove = remove;
    live.push(1); // 4 -> range [0, 74], 6 s behind: still no drift, so only the latch can seek
    await tickTimer();
    expect(video.currentTime).toBe(71); // the stall's re-anchor: end 74 - target 3
  });

  it("a poll's own outage is never read as the producer's cadence", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = await joined();
    live.manifestErrors.push(new TransportFailureError(new TypeError('Failed to fetch')));
    await tickTimer(); // the poll fails: reconnecting
    expect(kinds().at(-1)).toBe('reconnecting');
    clock = 20_000; // 20 s without media, by the viewer's own fault
    video.currentTime = 4;
    p.noteStall();
    live.push(1);
    await tickTimer(); // the retry brings a segment
    expect(buffer().ranges).toEqual([[0, 6]]);
    expect(video.currentTime).toBe(3); // end 6 - the floor of 3 s, never 20
  });

  it("a quiet broadcaster's absence is never read as its cadence", async () => {
    const p = await joined();
    live.serverNow += 7_000; // quiet on the database clock
    clock = 7_000;
    await tickTimer();
    expect(states.at(-1)).toEqual({ kind: 'reconnecting', reason: 'broadcaster' });
    video.currentTime = 4;
    p.noteStall();
    clock = 9_000;
    live.push(1);
    await tickTimer();
    expect(video.currentTime).toBe(3); // end 6 - the floor of 3 s, never 9
  });
});

describe('every refusal has its screen', () => {
  it('full is the "live complet" screen, holds no seat, and the reader may retry', async () => {
    live.push(2);
    live.liveErrors.push(refusal('full', 503, 24));
    const p = makePlayer();
    p.start();
    await flush();
    expect(states.at(-1)).toEqual({ kind: 'full', viewerCap: 24 });
    expect(timers).toHaveLength(0); // never hammered
    p.stop();
    expect(deps.leaveSeat).not.toHaveBeenCalled();
    p.retry();
    await flush();
    expect(states.at(-1)).toEqual({ kind: 'playing' });
  });

  it('seats-unavailable and rate-limited reconnect with a growing backoff, never "complet"', async () => {
    await joined();
    live.manifestErrors.push(refusal('seats-unavailable'), refusal('rate-limited', 429));
    await tickTimer(); // poll -> seats-unavailable
    expect(states.at(-1)).toEqual({ kind: 'reconnecting', reason: 'network' });
    expect(await tickTimer()).toBe(1_000); // retry 1 -> rate-limited
    expect(timers[0].ms).toBe(2_000);
    await tickTimer(); // retry 2 answers
    expect(states.at(-1)).toEqual({ kind: 'playing' });
    expect(kinds()).not.toContain('full');
  });

  it('a transport failure on the key reconnects, then plays', async () => {
    live.push(2);
    live.liveErrors.push(new TransportFailureError('offline'));
    makePlayer().start();
    await flush();
    expect(states.at(-1)).toEqual({ kind: 'reconnecting', reason: 'network' });
    await tickTimer();
    expect(states.at(-1)).toEqual({ kind: 'playing' });
  });

  it('ended stops the player cleanly: paused, no timer, no seat request', async () => {
    await joined();
    live.manifestErrors.push(refusal('ended', 410));
    await tickTimer();
    expect(states.at(-1)).toEqual({ kind: 'ended', cut: false });
    expect(video.pause).toHaveBeenCalled();
    expect(timers).toHaveLength(0);
    expect(deps.leaveSeat).not.toHaveBeenCalled();
  });

  it('not-found after the join is the end (the row is deleted at the end)', async () => {
    await joined();
    live.manifestErrors.push(refusal('not-found', 404));
    await tickTimer();
    expect(states.at(-1)).toEqual({ kind: 'ended', cut: false });
  });

  it('not-found once the key was served, before any segment, is the end too', async () => {
    makePlayer().start(); // on air, no segment yet: the key is held, the join waits
    await flush();
    live.manifestErrors.push(refusal('not-found', 404));
    await tickTimer();
    expect(states.at(-1)).toEqual({ kind: 'ended', cut: false });
  });

  it.each([
    ['not-found', 404],
    ['removed', 403],
    ['disabled', 404],
  ] as const)('%s before the key is the neutral unavailable screen', async (kind, status) => {
    live.liveErrors.push(refusal(kind, status));
    makePlayer().start();
    await flush();
    expect(states.at(-1)).toEqual({ kind: 'unavailable', reason: kind });
  });

  it('a removal mid-live pauses the picture behind the screen and gives the seat back', async () => {
    await joined();
    video.paused = false;
    live.manifestErrors.push(refusal('removed', 403));
    await tickTimer();
    expect(states.at(-1)).toEqual({ kind: 'unavailable', reason: 'removed' });
    expect(video.paused).toBe(true);
    expect(deps.leaveSeat).toHaveBeenCalledWith(LIVE);
  });

  it('a joining segment that does not open stops on undecryptable and gives the seat back', async () => {
    live.openErrors.add(1);
    await joined(2);
    expect(states.at(-1)).toEqual({ kind: 'unavailable', reason: 'undecryptable' });
    expect(deps.leaveSeat).toHaveBeenCalledWith(LIVE);
  });

  it('one media segment that does not open is skipped; three in a row stop', async () => {
    await joined();
    live.openErrors.add(3);
    live.push(2); // 3 fails, 4 plays
    await tickTimer();
    expect(buffer().appends).toEqual(['init0', 'm1', 'm2', 'm4']);
    for (const i of [5, 6, 7]) live.openErrors.add(i);
    live.push(2); // 5, 6
    await tickTimer();
    expect(states.at(-1)?.kind).toBe('playing');
    live.push(1); // 7: the third in a row
    await tickTimer();
    expect(states.at(-1)).toEqual({ kind: 'unavailable', reason: 'undecryptable' });
  });

  it('three failed appends in a row stop, although every segment opened', async () => {
    await joined();
    buffer().failing = true;
    live.push(1);
    await tickTimer();
    live.push(1);
    await tickTimer();
    expect(states.at(-1)?.kind).toBe('playing');
    live.push(1);
    await tickTimer();
    expect(states.at(-1)).toEqual({ kind: 'unavailable', reason: 'playback' });
    expect(timers).toHaveLength(0);
  });

  it('a video error stops the player at once', async () => {
    const p = await joined();
    p.noteMediaError();
    expect(states.at(-1)).toEqual({ kind: 'unavailable', reason: 'playback' });
    expect(timers).toHaveLength(0);
  });

  it('a segment the server no longer has is skipped, not fatal', async () => {
    await joined();
    vi.mocked(deps.fetchSegment).mockRejectedValueOnce(refusal('not-found', 404));
    live.push(2);
    await tickTimer();
    expect(buffer().appends).toEqual(['init0', 'm1', 'm2', 'm4']);
    expect(states.at(-1)?.kind).toBe('playing');
  });
});

describe('a refusal the chat heard (WP-L6)', () => {
  it.each([
    ['ended', 410],
    ['not-found', 404],
    ['removed', 403],
  ] as const)(
    "a chat write's %s stops on the screen the player's own poll would show",
    async (kind, status) => {
      const p = await joined();
      const error = refusal(kind, status);
      const outcome = liveFailureOutcome(error, true);
      p.refusedElsewhere(error);
      expect(outcome).not.toBe('retry');
      expect(states.at(-1)).toEqual((outcome as { stop: unknown }).stop);
      const pending = timers.length;
      await flush();
      expect(timers).toHaveLength(pending);
    }
  );

  it("a chat 410 with endReason 'cut' stops on the cut screen", async () => {
    const p = await joined();
    p.refusedElsewhere(
      new LiveRefusalError(410, 'LIVE_ENDED', '', 'ended', null, null, null, 'cut')
    );
    expect(states.at(-1)).toEqual({ kind: 'ended', cut: true });
  });

  it("a refusal that is only a retry (429, no answer) is not the chat's to act on", async () => {
    const p = await joined();
    const before = states.length;
    p.refusedElsewhere(refusal('rate-limited', 429));
    expect(states).toHaveLength(before);
    expect(states.at(-1)!.kind).toBe('playing');
  });

  it('after a stop, it does nothing', async () => {
    const p = await joined();
    p.stop();
    const before = states.length;
    p.refusedElsewhere(refusal('ended', 410));
    expect(states).toHaveLength(before);
  });
});

describe('closing', () => {
  it('cancels the poll, detaches the source and gives the seat back', async () => {
    const p = await joined();
    p.stop();
    expect(timers).toHaveLength(0);
    expect(detach).toHaveBeenCalled();
    expect(deps.leaveSeat).toHaveBeenCalledWith(LIVE);
  });

  /** A `fetchLive` that answers only when released. */
  function gatedKey() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = deps.fetchLive;
    deps.fetchLive = vi.fn(async (id: string) => {
      await gate;
      return original(id);
    });
    return () => release();
  }

  it('a key that arrives after the close gives its seat straight back', async () => {
    live.push(2);
    const release = gatedKey();
    const p = makePlayer();
    p.start();
    await flush();
    p.stop();
    release();
    await flush();
    expect(deps.leaveSeat).toHaveBeenCalledTimes(1);
    expect(deps.fetchManifest).not.toHaveBeenCalled();
  });

  it('a stale key never gives back the seat a newer run holds', async () => {
    live.push(2);
    const release = gatedKey();
    const p = makePlayer();
    p.start();
    await flush();
    p.stop(); // nothing held yet: no request
    p.start(); // a newer run (a back-forward restore), waiting on the same gate
    release();
    await flush();
    expect(deps.leaveSeat).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ kind: 'playing' });
  });

  it('an append of a run closed meanwhile is not reported as a failure', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = await joined();
    buffer().failing = true;
    live.push(1);
    const step = timers.shift()!;
    step.fn();
    p.stop();
    await flush();
    expect(errors).not.toHaveBeenCalledWith(
      expect.stringContaining('append failed'),
      expect.anything()
    );
    errors.mockRestore();
  });

  /** A segment download that never answers on its own, and rejects as `fetch` does on an abort. */
  function hangingSegments() {
    const signals: (AbortSignal | undefined)[] = [];
    deps.fetchSegment = vi.fn(
      (_id: string, _name: string, signal?: AbortSignal) =>
        new Promise<ArrayBuffer>((_resolve, reject) => {
          signals.push(signal);
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        })
    );
    return signals;
  }

  it('a close aborts the segment download in flight, and reports nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const signals = hangingSegments();
    live.push(2);
    const p = makePlayer();
    p.start();
    await flush();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    p.stop();
    await flush();
    expect(signals[0]?.aborted).toBe(true);
    expect(errors).not.toHaveBeenCalled();
    expect(timers).toHaveLength(0);
    errors.mockRestore();
  });

  it('a retry aborts the old run download; the new run fetches with a fresh signal', async () => {
    const signals = hangingSegments();
    live.push(2);
    const p = makePlayer();
    p.start();
    await flush();
    p.retry();
    await flush();
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(states.at(-1)?.kind).toBe('connecting');
  });
});

describe('the live chat riding the poll (WP-L6, C3)', () => {
  function chatHook() {
    let n = 0;
    return {
      onKey: vi.fn(),
      query: vi.fn(() => ({ messagesAfter: n, reactionsAfter: n })),
      receive: vi.fn(() => {
        n++;
      }),
    };
  }

  function chatPlayer(chat: ReturnType<typeof chatHook>) {
    return new LivePlayer({ liveId: LIVE, video, onState: (s) => states.push(s), deps, chat });
  }

  it('hands the chat the key, then ONE manifest request a tick carries its cursors and its block', async () => {
    const chat = chatHook();
    live.push(3);
    chatPlayer(chat).start();
    await flush();
    expect(chat.onKey).toHaveBeenCalledWith('ab'.repeat(32));
    expect(vi.mocked(deps.fetchManifest).mock.calls).toEqual([
      [LIVE, undefined, { messagesAfter: 0, reactionsAfter: 0 }],
    ]);
    live.push(1);
    await tickTimer();
    expect(vi.mocked(deps.fetchManifest).mock.calls.at(-1)).toEqual([
      LIVE,
      3,
      { messagesAfter: 1, reactionsAfter: 1 },
    ]);
    expect(chat.receive).toHaveBeenCalledTimes(2);
    // No second timer: the player still keeps exactly one.
    expect(timers).toHaveLength(1);
  });

  it('the catch-up fetch of the newest window asks no chat, so a block is never answered twice', async () => {
    const chat = chatHook();
    live.push(3);
    chatPlayer(chat).start();
    await flush();
    live.push(30);
    await tickTimer();
    const calls = vi.mocked(deps.fetchManifest).mock.calls.slice(-2);
    expect(calls[0][2]).toEqual({ messagesAfter: 1, reactionsAfter: 1 });
    expect(calls[1]).toEqual([LIVE]);
    expect(chat.query).toHaveBeenCalledTimes(2);
    expect(chat.receive).toHaveBeenCalledTimes(2);
  });

  it('chats while the live has no segment yet, at the same pace', async () => {
    const chat = chatHook();
    chatPlayer(chat).start();
    await flush();
    await tickTimer();
    expect(chat.receive).toHaveBeenCalledTimes(2);
  });

  it('a stopped player asks nothing more of the chat', async () => {
    const chat = chatHook();
    live.push(3);
    const p = chatPlayer(chat);
    p.start();
    await flush();
    p.stop();
    expect(timers).toHaveLength(0);
    expect(chat.query).toHaveBeenCalledTimes(1);
  });

  it('without a chat, the manifest is asked exactly as before', async () => {
    await joined(3);
    expect(vi.mocked(deps.fetchManifest).mock.calls).toEqual([[LIVE]]);
  });
});
