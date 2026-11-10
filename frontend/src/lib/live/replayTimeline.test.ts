import { describe, expect, it } from 'vitest';
import {
  isReplay,
  replayFileName,
  replaySaveMegabytes,
  replayCoverOf,
  replayTimeLeft,
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
