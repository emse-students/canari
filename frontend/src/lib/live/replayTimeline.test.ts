import { describe, expect, it } from 'vitest';
import {
  isReplay,
  replayFileName,
  replaySaveMegabytes,
  replayCoverOf,
  replayTimeLeft,
  mediaStartsMs,
  measuredPositionAt,
  segmentPositionAt,
} from './replayTimeline';
import type { LiveReplaySegment } from './types';

const seg = (index: number, atMs: number, bytes = 100): LiveReplaySegment => ({
  index,
  name: `s${index}`,
  bytes,
  atMs,
});
const list = [seg(10, 0), seg(11, 2000), seg(12, 4100), seg(14, 8000)];

describe('segmentPositionAt', () => {
  it('is the LAST segment at or before the target', () => {
    expect(segmentPositionAt(list, 0)).toBe(0);
    expect(segmentPositionAt(list, 1999)).toBe(0);
    expect(segmentPositionAt(list, 2000)).toBe(1);
    expect(segmentPositionAt(list, 7999)).toBe(2);
  });
  it('clamps before the first and past the last, and says -1 for nothing', () => {
    expect(segmentPositionAt(list, -50)).toBe(0);
    expect(segmentPositionAt(list, 1e9)).toBe(3);
    expect(segmentPositionAt([], 5)).toBe(-1);
  });
  it('P4: a later segment measured EARLIER in media time: the measured extent answers, the flattened estimate cannot', () => {
    const segs = Array.from({ length: 20 }, (_, i) => seg(i, i * 2000));
    // Segment 5 begins at 50 s, then segment 8 is measured at 16 s (a rebase): out of order.
    const placed = new Map([
      [0, 0],
      [5, 50],
      [8, 16],
    ]);
    const placedEnd = new Map([
      [0, 2],
      [5, 52],
      [8, 18],
    ]);
    // The running maximum flattens everything from segment 5 on at 50 s: the estimate picks the run's LAST
    // member, never segment 5 that holds the target.
    expect(segmentPositionAt(segs, 50_500, placed)).toBe(19);
    expect(measuredPositionAt(segs, placed, placedEnd, 50.5)).toBe(5);
    expect(measuredPositionAt(segs, placed, placedEnd, 17)).toBe(8);
    expect(measuredPositionAt(segs, placed, placedEnd, 30)).toBe(-1);
  });
  it('P2: an unmeasured segment between two measured ones keeps the starts monotonic and the lookup right', () => {
    // Segments 11 and 12 arrive 8 s late (an upload stall); the arrival times stay ascending.
    const at = (i: number) =>
      i <= 10 ? i * 2000 : 31_000 + (i - 12) * 2000 - (i === 11 ? 1000 : 0);
    const segs = Array.from({ length: 30 }, (_, i) => seg(i, at(i)));
    const placed = new Map<number, number>();
    for (let i = 0; i <= 30; i++) if (i !== 11) placed.set(i, i * 2);
    const starts = mediaStartsMs(segs, placed);
    for (let k = 1; k < starts.length; k++) expect(starts[k]).toBeGreaterThanOrEqual(starts[k - 1]);
    expect(starts[10]).toBe(20_000);
    expect(starts[12]).toBe(24_000);
    expect(starts[11]).toBeGreaterThan(20_000);
    expect(starts[11]).toBeLessThan(24_000);
    expect(segmentPositionAt(segs, 25_000, placed)).toBe(12);
  });
  it('looks up in MEDIA time once segments are measured: media running ahead of arrival time', () => {
    // 1770 ms of arrival per 2 s of media; segments 0 and 1 measured at 0 s and 2 s.
    const segs = Array.from({ length: 100 }, (_, i) => seg(i, i * 1770));
    const placed = new Map([
      [0, 0],
      [1, 2],
    ]);
    expect(segmentPositionAt(segs, 100_400, placed)).toBe(50); // by arrival time it would be 56
    expect(segmentPositionAt(segs, 100_400)).toBe(56); // nothing measured: arrival time is the statement
  });
});

describe('replayTimeLeft', () => {
  const now = '2026-11-09T10:00:00.000Z';
  it('rounds down to the coarsest whole unit', () => {
    expect(replayTimeLeft('2026-11-12T10:00:00.000Z', now)).toEqual({ unit: 'day', count: 3 });
    expect(replayTimeLeft('2026-11-11T09:59:59.000Z', now)).toEqual({ unit: 'day', count: 1 });
    expect(replayTimeLeft('2026-11-09T15:30:00.000Z', now)).toEqual({ unit: 'hour', count: 5 });
    expect(replayTimeLeft('2026-11-09T10:12:30.000Z', now)).toEqual({ unit: 'minute', count: 12 });
  });
  it('is never zero while time remains, and null once it is up or unreadable', () => {
    expect(replayTimeLeft('2026-11-09T10:00:10.000Z', now)).toEqual({ unit: 'minute', count: 1 });
    expect(replayTimeLeft(now, now)).toBeNull();
    expect(replayTimeLeft('2026-11-09T09:00:00.000Z', now)).toBeNull();
    expect(replayTimeLeft('garbage', now)).toBeNull();
  });
});

describe('save helpers', () => {
  it('announces the size in whole MB, at least one', () => {
    expect(replaySaveMegabytes([seg(0, 0, 150_000_000), seg(1, 1, 150_000_000)])).toBe(300);
    expect(replaySaveMegabytes([seg(0, 0, 10)])).toBe(1);
  });
  it('names the parts of a save', () => {
    expect(replayFileName('abcdef12-0000', '2026-11-09T10:00:00Z', 1)).toBe(
      'canari-replay-2026-11-09-abcdef12.mp4'
    );
    expect(replayFileName('abcdef12-0000', '2026-11-09T10:00:00Z', 2)).toBe(
      'canari-replay-2026-11-09-abcdef12-2.mp4'
    );
  });
  it('knows a replay row', () => {
    expect(isReplay({ kind: 'replay' })).toBe(true);
    expect(isReplay({ kind: 'reel' })).toBe(false);
    expect(isReplay({})).toBe(false);
  });
});

describe('replayCoverOf', () => {
  it('keys the cover by the LIVE, and is null without a poster, its key or a live', () => {
    const poster = { name: 'n', ageMs: 0 };
    expect(replayCoverOf({ liveId: 'l1', poster, posterKey: 'k' })).toEqual({
      id: 'l1',
      poster,
      posterKey: 'k',
    });
    expect(replayCoverOf({ liveId: 'l1', poster: null, posterKey: null })).toBeNull();
    expect(replayCoverOf({ liveId: 'l1', poster, posterKey: null })).toBeNull();
    expect(replayCoverOf({ liveId: null, poster, posterKey: 'k' })).toBeNull();
  });
});
