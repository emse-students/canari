/**
 * A VIDEO ON A LINK SLOWER THAN THE MEDIA STOPS ONCE, NOT TWENTY-NINE TIMES (slow-link chantier,
 * gap 6: a reel at ~318 KB/s on the owner's ~262 KB/s link).
 *
 * The model: an element whose buffer grows by what is appended and whose playhead advances on a
 * fake clock, and a link that delivers each range at a set rate on that clock. The element behaves
 * as an engine does: it resumes as soon as it has data past its playhead, so a stream that appends
 * each segment as it lands stalls once per segment. The stalls are COUNTED, before (the rule this
 * change replaced, played by {@link referencePump} on the same model) and after (the real stream).
 *
 * The reader is a plain one (no cipher: what is under test is when bytes land and when they are
 * appended), but the ranges go through the real `httpRangeSource`, where the link is measured.
 */
import { vi } from 'vitest';
import { SEGMENTED_MEDIA_SEGMENT_BYTES } from '$lib/mediaSegmented';
import type { MediaRef } from '$lib/media';
import type { CiphertextRangeSource } from './segmentedMediaReader';
import type { MediaSourceConstructor } from './segmentedMediaStream';
import { flushMacrotask, settleUntilStable } from '../../test/flush';

vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));

const SEG = SEGMENTED_MEDIA_SEGMENT_BYTES;

/** How many segments the served video has - set by each run. */
let servedSegments = 0;

vi.mock('./segmentedMediaReader', async (importActual) => {
  const actual = await importActual<typeof import('./segmentedMediaReader')>();
  return {
    ...actual,
    // The opening read carries segment 0, as the real reader's does.
    openSegmentedMedia: async (
      source: CiphertextRangeSource,
      _k: string,
      _iv: string,
      signal?: AbortSignal
    ) => {
      const head = await source.read(0, SEG, signal);
      return {
        segmentCount: servedSegments,
        readSegment: async (index: number, s?: AbortSignal) =>
          index === 0 ? head.buffer : (await source.read(index * SEG, (index + 1) * SEG, s)).buffer,
      };
    },
  };
});

const {
  openSegmentedStream,
  FEED_STREAM_PACING,
  STREAM_HOLD_EVENT,
  streamProgressOf,
  holdTargetSeconds,
  linkIsSlow,
} = await import('./segmentedMediaStream');

/** The reel of the owner's report: ~318 KB/s of media. */
const MEDIA = 318_000;
/** The owner's link. */
const SLOW_LINK = 262_000;
/** A link that outruns the media six times over. */
const FAST_LINK = 2_000_000;
/** The clock's step, seconds. */
const DT = 0.5;

/** The element: a buffer from 0, a playhead that advances while it has data, stalls counted. */
class ModelElement extends EventTarget {
  paused = false;
  currentTime = 0;
  bufferedEnd = 0;
  state: 'starting' | 'playing' | 'stalled' | 'ended' = 'starting';
  stalls = 0;
  startedAt: number | null = null;
  constructor(readonly duration: number) {
    super();
  }
  get buffered() {
    const end = this.bufferedEnd;
    return { length: end > 0 ? 1 : 0, start: () => 0, end: () => end } as unknown as TimeRanges;
  }
  /** Advances the playhead by `dt` at `now`, as an engine would. */
  step(now: number, dt: number) {
    const EPS = 1e-6;
    if (
      (this.state === 'starting' || this.state === 'stalled') &&
      this.bufferedEnd - this.currentTime > EPS
    ) {
      if (this.state === 'starting') this.startedAt = now;
      this.state = 'playing';
      this.dispatchEvent(new Event('playing'));
    }
    if (this.state !== 'playing') return;
    this.currentTime = Math.min(this.currentTime + dt, this.bufferedEnd);
    this.dispatchEvent(new Event('timeupdate'));
    if (this.currentTime >= this.duration - EPS) {
      this.state = 'ended';
    } else if (this.currentTime >= this.bufferedEnd - EPS) {
      this.state = 'stalled';
      this.stalls += 1;
      this.dispatchEvent(new Event('waiting'));
    }
  }
}

/** The element the fake source buffer feeds - one run at a time. */
let target: ModelElement | null = null;
let appends = 0;

class ModelSourceBuffer extends EventTarget {
  updating = false;
  appendBuffer(bytes: ArrayBuffer) {
    target!.bufferedEnd += bytes.byteLength / MEDIA;
    appends += 1;
    queueMicrotask(() => this.dispatchEvent(new Event('updateend')));
  }
}

class ModelMediaSource extends EventTarget {
  static isTypeSupported = () => true;
  readyState: 'closed' | 'open' | 'ended' = 'closed';
  duration = Number.NaN;
  constructor() {
    super();
    queueMicrotask(() => {
      this.readyState = 'open';
      this.dispatchEvent(new Event('sourceopen'));
    });
  }
  addSourceBuffer() {
    return new ModelSourceBuffer();
  }
  endOfStream() {
    this.readyState = 'ended';
  }
}

interface RunResult {
  stalls: number;
  startedAt: number | null;
  endedAt: number | null;
  holdsSeen: number[];
}

/** A link delivering one range at a time at `rate` bytes per second, on the fake clock. */
function modelLink(rate: number, clock: { now: number }) {
  const pending: Array<{ due: number; resolve: () => void }> = [];
  let busyUntil = 0;
  let calls = 0;
  const fetch = vi.fn((_url: string, init: RequestInit) => {
    calls += 1;
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec((init.headers as Record<string, string>).Range)!;
    const bytes = Math.min(Number(b) + 1, servedSegments * SEG) - Number(a);
    busyUntil = Math.max(clock.now, busyUntil) + bytes / rate;
    const due = busyUntil;
    return new Promise<Response>((resolve) =>
      pending.push({
        due,
        resolve: () =>
          resolve({
            status: 206,
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(bytes)),
          } as unknown as Response),
      })
    );
  });
  return {
    fetch,
    calls: () => calls,
    /** Answers every range due by now. */
    deliver(): number {
      let delivered = 0;
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].due <= clock.now + 1e-9) {
          pending.splice(i, 1)[0].resolve();
          delivered += 1;
        }
      }
      return delivered;
    },
  };
}

/** Opens the REAL stream over `segments` of media on a link at `rate`, its element asked to play. */
async function startStream(segments: number, rate: number) {
  servedSegments = segments;
  appends = 0;
  const clock = { now: 0 };
  const link = modelLink(rate, clock);
  vi.stubGlobal('fetch', link.fetch);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:model');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const duration = (segments * SEG) / MEDIA;
  const ref: MediaRef = {
    type: 'video',
    mediaId: 'reel',
    key: '00',
    iv: '00',
    mimeType: 'video/mp4;codecs=avc1.42E01E',
    size: segments * SEG,
    durationMs: duration * 1000,
    encoding: 'segmented-v1',
  };
  const element = new ModelElement(duration);
  target = element;
  const holdsSeen: number[] = [];
  element.addEventListener(STREAM_HOLD_EVENT, () => {
    const hold = streamProgressOf('blob:model')?.hold;
    if (hold) holdsSeen.push(hold.percent);
  });
  const handle = openSegmentedStream(
    ref,
    'https://media.test',
    {
      kind: 'stream',
      MediaSourceCtor: ModelMediaSource as unknown as MediaSourceConstructor,
      managed: false,
    },
    FEED_STREAM_PACING,
    () => clock.now * 1000
  );
  handle.attach(element);
  // A card on screen is asked to play before it has a byte: the engine says `waiting`.
  element.dispatchEvent(new Event('play'));
  element.dispatchEvent(new Event('waiting'));
  const signature = () =>
    `${link.calls()}|${appends}|${streamProgressOf('blob:model')?.hold?.percent}`;
  // The opening read is asked at t = 0, as the reference's is.
  await settleUntilStable(signature);
  /** One tick of the clock: the link answers, the stream acts, the element plays. */
  const tick = async () => {
    clock.now += DT;
    if (link.deliver() > 0) await settleUntilStable(signature);
    element.step(clock.now, DT);
    await settleUntilStable(signature);
  };
  return { element, handle, tick, holdsSeen, duration, clock, signature, link };
}

/** Plays `segments` of media over a link at `rate` through the REAL stream; returns what happened. */
async function runStream(segments: number, rate: number): Promise<RunResult> {
  const { element, handle, tick, holdsSeen, duration, clock } = await startStream(segments, rate);
  let endedAt: number | null = null;
  for (let steps = 0; steps < (4 * (duration + (segments * SEG) / rate)) / DT; steps++) {
    await tick();
    if (element.state === 'ended') {
      endedAt = clock.now;
      break;
    }
  }
  handle.close();
  await flushMacrotask();
  return { stalls: element.stalls, startedAt: element.startedAt, endedAt, holdsSeen };
}

/**
 * THE RULE THIS CHANGE REPLACED, on the same model: the head whatever happens, then one segment at a
 * time while the element plays with less than the pacing's lookahead ahead, each appended as it
 * lands.
 */
function referencePump(segments: number, rate: number): RunResult {
  const duration = (segments * SEG) / MEDIA;
  const element = new ModelElement(duration);
  let next = 0;
  let due: number | null = null;
  let now = 0;
  let endedAt: number | null = null;
  const ahead = () => element.bufferedEnd - element.currentTime;
  for (let steps = 0; endedAt === null && steps < 100_000; steps++) {
    if (
      due === null &&
      next < segments &&
      (next < FEED_STREAM_PACING.headSegments || ahead() < FEED_STREAM_PACING.aheadSeconds)
    ) {
      due = now + SEG / rate;
    }
    now += DT;
    if (due !== null && due <= now + 1e-9) {
      element.bufferedEnd += SEG / MEDIA;
      next += 1;
      due = null;
      if (next < segments && ahead() < FEED_STREAM_PACING.aheadSeconds)
        due = Math.max(now, 0) + SEG / rate;
    }
    element.step(now, DT);
    if (element.state === 'ended') endedAt = now;
  }
  return { stalls: element.stalls, startedAt: element.startedAt, endedAt, holdsSeen: [] };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  target = null;
});

describe('the hold rule', () => {
  it('is the chantier rule: buffered >= remaining x (1 - link / media), with its margin', () => {
    const unfetched = 20 * SEG;
    const target = holdTargetSeconds({
      unfetchedBytes: unfetched,
      linkBytesPerSecond: SLOW_LINK,
      mediaBytesPerSecond: MEDIA,
      capSeconds: Infinity,
    });
    // With B = target / safety, R = B + U / m: B = R (1 - l / m).
    const b = target / 1.1;
    const r = b + unfetched / MEDIA;
    expect(b).toBeCloseTo(r * (1 - SLOW_LINK / MEDIA), 6);
  });

  it('asks nothing of a link that keeps up, or once everything is fetched, and stops at its cap', () => {
    const base = { linkBytesPerSecond: SLOW_LINK, mediaBytesPerSecond: MEDIA, capSeconds: 30 };
    expect(
      holdTargetSeconds({ ...base, unfetchedBytes: 50 * SEG, linkBytesPerSecond: MEDIA })
    ).toBe(0);
    expect(holdTargetSeconds({ ...base, unfetchedBytes: 0 })).toBe(0);
    expect(holdTargetSeconds({ ...base, unfetchedBytes: 500 * SEG })).toBe(30);
  });

  it('calls a link slow below 1x the media and fast again only from 1.15x (hysteresis)', () => {
    expect(linkIsSlow(0.99, false)).toBe(true);
    expect(linkIsSlow(1.05, false)).toBe(false);
    // Hovering between the two marks: whatever it was, it stays.
    expect(linkIsSlow(1.05, true)).toBe(true);
    expect(linkIsSlow(1.15, true)).toBe(false);
    expect(linkIsSlow(null, true)).toBe(true);
  });
});

describe('a reel played over the model link', { timeout: 60_000 }, () => {
  // ~99 s of media; ~120 s to download on the owner's link.
  const SEGMENTS = 30;

  it('on a link slower than the media: from one stall per segment to at most one', async () => {
    const before = referencePump(SEGMENTS, SLOW_LINK);
    const after = await runStream(SEGMENTS, SLOW_LINK);
    console.info(
      `[slow-link model] stalls before ${before.stalls}, after ${after.stalls}; start ${before.startedAt} s -> ${after.startedAt} s; end ${before.endedAt} s -> ${after.endedAt} s`
    );
    expect(before.stalls).toBeGreaterThanOrEqual(20);
    expect(after.stalls).toBeLessThanOrEqual(1);
    expect(after.endedAt, 'it plays to the end').not.toBeNull();
    // The same bytes on the same link: it ends when the stalling rule does, plus at most the
    // hold's margin (what is still buffered when the last byte lands).
    const duration = (SEGMENTS * SEG) / MEDIA;
    expect(after.endedAt!).toBeLessThanOrEqual(before.endedAt! + 0.1 * duration);
    // The hold was shown, and its percentage only ever went up.
    expect(after.holdsSeen.length).toBeGreaterThan(0);
    expect([...after.holdsSeen].sort((a, b) => a - b)).toEqual(after.holdsSeen);
    expect(streamProgressOf('blob:model')).toBeUndefined();
  });

  it('a paused element is held by nobody: what was kept from it goes in at once', async () => {
    const { element, handle, tick, signature, link } = await startStream(12, SLOW_LINK);
    // Until two segments have landed and are held: the third is on the wire.
    for (let i = 0; i < 200 && link.calls() < 3; i++) await tick();
    expect(streamProgressOf('blob:model')?.hold).not.toBeNull();
    expect(appends).toBe(0);
    element.paused = true;
    element.dispatchEvent(new Event('pause'));
    await settleUntilStable(signature);
    expect(streamProgressOf('blob:model')?.hold).toBeNull();
    expect(appends, 'the two held segments are appended').toBe(2);
    handle.close();
  });

  it('on a link faster than the media: starts at once, with no stall and no added delay', async () => {
    const before = referencePump(SEGMENTS, FAST_LINK);
    const after = await runStream(SEGMENTS, FAST_LINK);
    expect(after.stalls).toBe(0);
    expect(after.holdsSeen).toEqual([]);
    expect(after.startedAt).not.toBeNull();
    // The first segment lands in about half a second here, and plays on the step it lands.
    expect(after.startedAt).toBe(before.startedAt);
    expect(after.startedAt!).toBeLessThanOrEqual(SEG / FAST_LINK + DT);
  });
});
