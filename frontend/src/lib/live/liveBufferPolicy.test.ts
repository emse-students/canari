/**
 * THE LIVE VIEWER'S BUFFER POLICY, AS NUMBERS: what a `waiting` means, and the target a measured
 * delivery cadence sets. The two cases of L-F1 (2026-10-26) are pinned: a seek's own wait is not a
 * stall, and a producer delivering in pairs every 4 s raises the target past 4 s. No clock: every
 * reading is a number this file hands in.
 */
import { describe, it, expect } from 'vitest';
import { classifyLiveWait, LiveBufferPolicy, type LiveTimeRanges } from './liveBufferPolicy';
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

  it('a wait INSIDE the newest range is not a time gap (no hole to cross)', () => {
    expect(classifyLiveWait(false, 2, ranges([0, 6]))).toEqual({ kind: 'starved' });
  });
});

describe('LiveBufferPolicy', () => {
  it('starts at the floor: one segment plus one poll, and joins on enough segments to hold it', () => {
    expect(LIVE_PLAYER_MIN_TARGET_BUFFER_MS).toBe(LIVE_SEGMENT_MS + LIVE_MANIFEST_POLL_MS);
    expect(LIVE_PLAYER_JOIN_SEGMENTS * LIVE_SEGMENT_MS).toBeGreaterThanOrEqual(
      LIVE_PLAYER_MIN_TARGET_BUFFER_MS
    );
    const p = new LiveBufferPolicy();
    expect(p.targetMs).toBe(LIVE_PLAYER_MIN_TARGET_BUFFER_MS);
    expect(p.maxBehindMs).toBe(LIVE_PLAYER_MIN_TARGET_BUFFER_MS + LIVE_PLAYER_DRIFT_SLACK_MS);
  });

  it('the first delivery anchors and measures nothing', () => {
    const p = new LiveBufferPolicy();
    expect(p.delivered(5_000)).toEqual({ gapMs: null, targetMs: 3_000, grew: false });
  });

  it('a regular 2 s producer stays at the floor', () => {
    const p = new LiveBufferPolicy();
    // A segment every 2 s, learnt up to a poll late: gaps of 1 to 3 s.
    for (const t of [0, 2_000, 5_000, 6_000, 8_000, 11_000]) p.delivered(t);
    expect(p.targetMs).toBe(3_000);
  });

  it('pairs every 4 s raise the target to the longest gap, and say so once', () => {
    const p = new LiveBufferPolicy();
    p.delivered(0);
    expect(p.delivered(4_000)).toEqual({ gapMs: 4_000, targetMs: 4_000, grew: true });
    expect(p.delivered(4_300).grew).toBe(false); // the pair's second half, a poll apart
    expect(p.delivered(8_700)).toEqual({ gapMs: 4_400, targetMs: 4_400, grew: true });
    expect(p.maxBehindMs).toBe(4_400 + LIVE_PLAYER_DRIFT_SLACK_MS);
  });

  it('forgets a long gap once the window has moved past it', () => {
    const p = new LiveBufferPolicy(3);
    p.delivered(0);
    p.delivered(6_000); // one slow fetch
    expect(p.targetMs).toBe(6_000);
    p.delivered(8_000);
    p.delivered(10_000);
    expect(p.targetMs).toBe(6_000); // still one of the last three
    p.delivered(12_000);
    expect(p.targetMs).toBe(3_000); // gone: back to the floor
  });

  it('an interrupted gap is never measured: the next delivery only anchors', () => {
    const p = new LiveBufferPolicy();
    p.delivered(0);
    p.interrupt('retry');
    expect(p.delivered(20_000)).toEqual({ gapMs: null, targetMs: 3_000, grew: false });
    expect(p.delivered(22_000).gapMs).toBe(2_000);
  });

  it('a reset forgets every gap', () => {
    const p = new LiveBufferPolicy();
    p.delivered(0);
    p.delivered(5_000);
    p.reset();
    expect(p.targetMs).toBe(3_000);
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
