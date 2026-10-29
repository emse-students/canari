/**
 * THE LIVE VIEWER'S BUFFER POLICY, AS NUMBERS: what a `waiting` means, the longest wait the shape of
 * the deliveries bounds, the anchor one poll past it, and when a delivery re-anchors. Pinned: L-F1
 * (2026-10-26: a seek's own wait is not a stall, pairs raise the target) and LIVE-STALL-1
 * (`1.5.1-alpha.7`, 2026-10-29): W4's twenty recorded deliveries replayed, one stall under the rule
 * this replaced and none under this one. No clock: every reading is a number this file hands in.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyLiveWait,
  formatLiveRanges,
  LiveBufferPolicy,
  mediaAheadS,
  type LiveDeliveryShape,
  type LiveTimeRanges,
} from './liveBufferPolicy';
import {
  LIVE_MANIFEST_POLL_MS,
  LIVE_PLAYER_DRIFT_SLACK_MS,
  LIVE_PLAYER_JOIN_SEGMENTS,
  LIVE_PLAYER_MIN_TARGET_BUFFER_MS,
  LIVE_SEGMENT_MS,
} from './constants';

const ranges = (...r: [number, number][]): LiveTimeRanges => ({
  length: r.length,
  start: (i) => r[i][0],
  end: (i) => r[i][1],
});

/** A delivery of `segments` regular 2 s segments. */
const of = (segments: number): LiveDeliveryShape => ({
  segments,
  mediaMs: segments * LIVE_SEGMENT_MS,
});

describe('classifyLiveWait', () => {
  it("a wait while the engine seeks is the seek's own, whatever is buffered", () => {
    // L-F1: `stalled at 7.99` in the same millisecond as `seek ... at 9.99`.
    expect(classifyLiveWait(true, 7.99, ranges([0, 9.99]))).toEqual({ kind: 'seeking' });
    expect(classifyLiveWait(true, 0, null)).toEqual({ kind: 'seeking' });
  });

  it('media buffered past a hole ahead is a time gap, crossed to the start of the newest range', () => {
    expect(classifyLiveWait(false, 4, ranges([0, 4], [34, 36]))).toEqual({
      kind: 'time-gap',
      to: 34,
    });
  });

  it('nothing playable ahead is a starved buffer', () => {
    expect(classifyLiveWait(false, 4, ranges([0, 4]))).toEqual({ kind: 'starved' });
    expect(classifyLiveWait(false, 0, null)).toEqual({ kind: 'starved' });
    expect(classifyLiveWait(false, 0, ranges())).toEqual({ kind: 'starved' });
  });

  it("a wait with media ahead in its own range is the engine's own wait, never a stall (LIVE-STALL-1, alpha.8)", () => {
    // W4: waiting at 55.56, the delivery before it had left one range to 58.19.
    const w4 = classifyLiveWait(false, 55.56, ranges([40.11, 58.19]));
    expect(w4.kind).toBe('held');
    expect(w4.kind === 'held' && w4.ahead).toBeCloseTo(2.63, 5);
    // In an older range with a newer one past a hole: still held, nothing to cross yet.
    expect(classifyLiveWait(false, 2, ranges([0, 6], [34, 36]))).toEqual({
      kind: 'held',
      ahead: 4,
    });
  });

  it('a wait with under half a second left in its range is a dry buffer, or a hole to cross', () => {
    expect(classifyLiveWait(false, 5.7, ranges([0, 6]))).toEqual({ kind: 'starved' });
    expect(classifyLiveWait(false, 3.7, ranges([0, 4], [34, 36]))).toEqual({
      kind: 'time-gap',
      to: 34,
    });
  });
});

describe('mediaAheadS and formatLiveRanges', () => {
  it('reads the media ahead in the range holding the playhead, none in a hole', () => {
    expect(mediaAheadS(1, ranges([0, 4], [34, 36]))).toBe(3);
    expect(mediaAheadS(10, ranges([0, 4], [34, 36]))).toBe(0);
    expect(mediaAheadS(4, ranges([0, 4]))).toBe(0);
    expect(mediaAheadS(1, null)).toBe(0);
  });

  it('prints every range, so a hole ahead of the playhead is on the line', () => {
    expect(formatLiveRanges(ranges([40.11, 55.56], [56.18, 58.19]))).toBe(
      '[40.11-55.56 56.18-58.19]'
    );
    expect(formatLiveRanges(ranges())).toBe('[]');
    expect(formatLiveRanges(null)).toBe('[]');
  });
});

describe('LiveBufferPolicy', () => {
  it('starts at the floor: a wait of one segment plus one poll, anchored one poll past it, and joins on enough segments to hold that', () => {
    expect(LIVE_PLAYER_MIN_TARGET_BUFFER_MS).toBe(LIVE_SEGMENT_MS + LIVE_MANIFEST_POLL_MS);
    const p = new LiveBufferPolicy();
    expect(p.longestWaitMs).toBe(3_000);
    expect(p.targetMs).toBe(4_000);
    expect(p.maxBehindMs).toBe(4_000 + LIVE_PLAYER_DRIFT_SLACK_MS);
    expect(LIVE_PLAYER_JOIN_SEGMENTS * LIVE_SEGMENT_MS).toBeGreaterThanOrEqual(p.targetMs);
  });

  it('the first delivery anchors and measures nothing, its size included (the join is a backlog)', () => {
    const p = new LiveBufferPolicy();
    expect(p.delivered(5_000, of(2))).toEqual({ gapMs: null, targetMs: 4_000, grew: false });
    expect(p.longestWaitMs).toBe(3_000);
  });

  it('a regular 2 s producer stays at the floor', () => {
    const p = new LiveBufferPolicy();
    // A segment every 2 s, learnt up to a poll late: gaps of 1 to 3 s.
    for (const t of [0, 2_000, 5_000, 6_000, 8_000, 11_000]) p.delivered(t, of(1));
    expect(p.longestWaitMs).toBe(3_000);
    expect(p.targetMs).toBe(4_000);
  });

  it('a PAIR bounds the wait at the delivery that shows it - two segments plus a poll - before any gap proves it', () => {
    const p = new LiveBufferPolicy();
    p.delivered(0, of(1));
    // LIVE-STALL-1's first pair: a gap of 3663 ms, 4.02 s of media. The rule this replaced read 3663.
    expect(p.delivered(3_663, { segments: 2, mediaMs: 4_020 })).toEqual({
      gapMs: 3_663,
      targetMs: 2 * 2_010 + LIVE_MANIFEST_POLL_MS + LIVE_MANIFEST_POLL_MS,
      grew: true,
    });
    expect(p.longestWaitMs).toBe(5_020);
    // A longer gap than the bound still raises it: the bound is a floor, never a cap.
    p.delivered(9_163, of(2));
    expect(p.longestWaitMs).toBe(5_500);
  });

  it("a delivery whose media cannot be read from the buffer's growth sizes nothing", () => {
    const p = new LiveBufferPolicy();
    p.delivered(0);
    // A re-acquired camera: the end moved by its time away, not by the segments.
    p.delivered(2_000, { segments: 1, mediaMs: null });
    p.delivered(4_000, { segments: 1, mediaMs: 0 });
    expect(p.longestWaitMs).toBe(3_000);
  });

  it('re-anchors a buffer SHORTER than the longest wait, and one past the target and its slack', () => {
    const p = new LiveBufferPolicy();
    p.delivered(0);
    p.delivered(4_000, of(2)); // wait 5000, target 6000, slack to 10000
    expect(p.reanchor(3_990)).toBe('short'); // W4's 3.99 s that the next 4223 ms gap drained
    expect(p.reanchor(5_000)).toBeNull();
    expect(p.reanchor(10_000)).toBeNull();
    expect(p.reanchor(10_001)).toBe('drift');
  });

  it("a producer's ordinary group is played; a backlog longer than the slack behind is jumped", () => {
    const p = new LiveBufferPolicy();
    // At the floor (target 4 s, at most 8 s behind): 4 segments are 8 s, the fifth is a backlog.
    expect(p.isBacklog(3)).toBe(false); // LIVE-WEB-2's end: three at once, two of them dropped
    expect(p.isBacklog(4)).toBe(false);
    expect(p.isBacklog(5)).toBe(true);
    // The longest segment measured sizes it.
    p.delivered(0);
    p.delivered(2_000, { segments: 1, mediaMs: 4_000 });
    expect(p.isBacklog(3)).toBe(true); // 12 s > the 10 s behind a 4 s segment allows
  });

  it('forgets a long gap and a group once the window has moved past them', () => {
    const p = new LiveBufferPolicy(3);
    p.delivered(0);
    p.delivered(6_000, of(1)); // one slow fetch
    expect(p.longestWaitMs).toBe(6_000);
    p.delivered(8_000, of(1));
    p.delivered(10_000, of(1));
    expect(p.longestWaitMs).toBe(6_000); // still one of the last three
    p.delivered(12_000, of(1));
    expect(p.longestWaitMs).toBe(3_000); // gone: back to the floor
  });

  it('an interrupted gap is never measured: the next delivery only anchors', () => {
    const p = new LiveBufferPolicy();
    p.delivered(0);
    p.interrupt('retry');
    expect(p.delivered(20_000, of(3))).toEqual({ gapMs: null, targetMs: 4_000, grew: false });
    expect(p.delivered(22_000).gapMs).toBe(2_000);
  });

  it('a reset forgets every gap and group', () => {
    const p = new LiveBufferPolicy();
    p.delivered(0);
    p.delivered(5_000, of(2));
    p.reset();
    expect(p.longestWaitMs).toBe(3_000);
    expect(p.delivered(9_000).gapMs).toBeNull();
  });

  it('a clock read backwards is a zero gap, never a negative one', () => {
    const p = new LiveBufferPolicy();
    p.delivered(1_000);
    expect(p.delivered(500).gapMs).toBe(0);
  });

  it('refuses a window that is not a positive integer', () => {
    expect(() => new LiveBufferPolicy(0)).toThrow(RangeError);
    expect(() => new LiveBufferPolicy(1.5)).toThrow(RangeError);
  });
});

/**
 * LIVE-STALL-1's W4, `1.5.1-alpha.7` on dev (2026-10-29), its twenty deliveries as its console wrote
 * them (`delivery of N appended of N taken`): the gap since the previous one in ms, the segments, and
 * the media they added (the buffered end's growth) in ms. Replayed from the state the first left -
 * 3.85 s ahead - with the video playing at the wall's pace between appends, which reproduces every
 * recorded "ahead" of that console to 0.02 s up to its stall.
 */
const W4: [gapMs: number, segments: number, mediaMs: number][] = [
  [1226, 1, 2010],
  [3663, 2, 4020],
  [1372, 1, 2000],
  [2286, 1, 2020],
  [3790, 2, 4010],
  [2546, 1, 2010],
  [1751, 1, 2010],
  [4118, 2, 4010],
  [1441, 1, 2010],
  [2996, 1, 2010],
  [4223, 2, 4010],
  [3980, 2, 4020],
  [3909, 2, 4020],
  [4383, 2, 4020],
  [1641, 1, 2000],
  [4084, 2, 4020],
  [3855, 2, 4020],
  [3507, 2, 4010],
  [3656, 2, 4020],
  [2307, 1, 2000],
];

interface Replay {
  /** The deliveries (by index in {@link W4}) the video ran dry before. */
  stalls: number[];
  /** The media ahead the video had as each delivery from the second on landed, in ms. */
  aheadBeforeMs: number[];
}

/**
 * Plays {@link W4}: before each delivery the video has spent the gap; under nothing left it stalled
 * (and the stall re-anchors); after it, `seekAt` says where to re-anchor (ms ahead) or null.
 */
function replay(seekAt: (aheadMs: number, stalled: boolean) => number | null): Replay {
  let ahead = 3_850;
  const out: Replay = { stalls: [], aheadBeforeMs: [] };
  W4.slice(1).forEach(([gap, , media], i) => {
    let before = ahead - gap;
    out.aheadBeforeMs.push(before);
    const stalled = before < 0;
    if (stalled) {
      out.stalls.push(i + 1);
      before = 0;
    }
    ahead = before + media;
    ahead = seekAt(ahead, stalled) ?? ahead;
  });
  return out;
}

describe('LIVE-STALL-1, replayed', () => {
  it('the rule this replaced - target the longest gap seen, applied only at a stall or past its slack - stalls where the rig did', () => {
    const gaps = [W4[0][0]];
    let next = 1;
    const result = replay((ahead, stalled) => {
      gaps.push(W4[next++][0]);
      const target = Math.max(LIVE_PLAYER_MIN_TARGET_BUFFER_MS, ...gaps);
      return stalled || ahead > target + LIVE_PLAYER_DRIFT_SLACK_MS ? target : null;
    });
    // The rig's one stall: 3.99 s ahead, then a 4223 ms gap (delivery 10). The 1x replay also runs
    // dry 10 ms before delivery 13, where the rig's video, slowed 70 ms by its stall seek, did not.
    expect(result.stalls[0]).toBe(10);
    expect(result.stalls).toEqual([10, 13]);
  });

  it('this policy - the longest wait bounded from the delivery shape, a short buffer re-anchored at once - never stalls', () => {
    const p = new LiveBufferPolicy();
    let clock = 0;
    p.delivered(clock);
    let next = 1;
    const anchors: number[] = [];
    const result = replay((ahead, stalled) => {
      const at = next++;
      const [gap, segments, media] = W4[at];
      clock += gap;
      p.delivered(clock, { segments, mediaMs: media });
      if (!stalled && p.reanchor(ahead) === null) return null;
      anchors.push(at);
      return p.targetMs;
    });
    expect(result.stalls).toEqual([]);
    // ONE re-anchor, at the first pair (4.21 s ahead, a 5020 ms wait): a backward seek of 1.8 s,
    // then none - the anchor's poll of margin absorbs the phase jitter of every later delivery.
    expect(anchors).toEqual([1]);
    // Two segments of the longest measured (2020 ms, delivery 3) plus a poll - above every gap.
    expect(p.longestWaitMs).toBe(5_040);
    // After it, the video never came within a second of running dry (least: 1.36 s, before the
    // 4383 ms gap) - a margin the 70 ms a seek cost the rig's video cannot take away.
    expect(Math.min(...result.aheadBeforeMs.slice(1))).toBeGreaterThan(1_000);
  });
});
