import { describe, it, expect } from 'vitest';
import {
  SEEK_STEP_S,
  barLength,
  loadedSpans,
  playedFraction,
  clampFraction,
  formatVideoTime,
  scrubLength,
  videoKeyAction,
} from './videoPlayback';

const ranges = (...r: [number, number][]) => ({
  length: r.length,
  start: (i: number) => r[i][0],
  end: (i: number) => r[i][1],
});

describe('formatVideoTime', () => {
  it.each([
    [0, '0:00'],
    [7.9, '0:07'],
    [65, '1:05'],
    [3600 + 62, '1:01:02'],
  ])('%s s -> %s', (s, text) => expect(formatVideoTime(s)).toBe(text));

  it('draws an unknown duration (a stream, metadata not in) as 0:00, never NaN', () => {
    expect(formatVideoTime(Number.NaN)).toBe('0:00');
    expect(formatVideoTime(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('clampFraction', () => {
  it('clamps', () => {
    expect(clampFraction(1.4)).toBe(1);
    expect(clampFraction(-1)).toBe(0);
    expect(clampFraction(Number.NaN)).toBe(0);
  });
});

describe('loadedSpans - every loaded range, grey under the played part', () => {
  it('draws each range where it lies, after a seek too', () => {
    expect(loadedSpans(ranges([0, 20], [60, 80]), 100)).toEqual([
      { from: 0, to: 0.2 },
      { from: 0.6, to: 0.8 },
    ]);
  });

  it('clamps to the length and drops empty ranges', () => {
    expect(loadedSpans(ranges([0, 120], [5, 5]), 100)).toEqual([{ from: 0, to: 1 }]);
  });

  it('draws nothing while the length is unknown - a fraction of nothing', () => {
    expect(loadedSpans(ranges([0, 5]), 0)).toEqual([]);
    expect(loadedSpans(ranges([0, 5]), Number.NaN)).toEqual([]);
  });
});

describe('barLength - the line is fixed to the total from the first frame (owner, 2026-11-18)', () => {
  const none = ranges();
  it('takes the engine duration when it knows one', () => {
    expect(
      barLength({ duration: 61, declaredSeconds: 60, seekable: none, streamed: true })
    ).toEqual({
      seconds: 61,
      source: 'engine',
    });
  });

  it("takes the PUBLISHER's declared length while the engine knows none", () => {
    expect(
      barLength({
        duration: Infinity,
        declaredSeconds: 8,
        seekable: ranges([0, 2]),
        streamed: true,
      })
    ).toEqual({ seconds: 8, source: 'declared' });
  });

  it('a whole local file with no length reads its seekable end: every byte is here, it cannot grow', () => {
    expect(barLength({ duration: Infinity, seekable: ranges([0, 9]), streamed: false })).toEqual({
      seconds: 9,
      source: 'seekable',
    });
  });

  it('a STREAM with no length is unknown, never mapped onto what has loaded', () => {
    expect(barLength({ duration: Infinity, seekable: ranges([0, 9]), streamed: true })).toEqual({
      seconds: 0,
      source: 'unknown',
    });
  });

  it('THE PLAYED FRACTION NEVER DECREASES WHILE SEGMENTS ARRIVE', () => {
    // A declared 20 s reel: the playhead advances 0 -> 6 s while the loaded end grows 2 -> 20 s in steps,
    // and the engine's duration goes unknown -> 20 s mid-way (the tail read). Whatever the source, the
    // line's total is the same, so the fraction only ever rises.
    const loadedEnds = [2, 2, 4, 6, 6, 9, 13, 20, 20];
    const durations = [Infinity, Infinity, Infinity, Infinity, 20, 20, 20, 20, 20];
    let previous = -1;
    loadedEnds.forEach((end, i) => {
      const { seconds } = barLength({
        duration: durations[i],
        declaredSeconds: 20,
        seekable: ranges([0, end]),
        streamed: true,
      });
      const fraction = playedFraction(i * 0.75, seconds);
      expect(fraction, `step ${i}`).toBeGreaterThanOrEqual(previous);
      previous = fraction;
    });
  });

  it('the old mapping onto the loaded end is what REWOUND: the same steps, undeclared, would not hold', () => {
    // Documents the defect: against the loaded end, 3 s of 4 s loaded reads 75 %, then 3 s of 9 s reads 33 %.
    expect(
      barLength({ duration: Infinity, seekable: ranges([0, 4]), streamed: true }).seconds,
      'the line no longer takes that length'
    ).toBe(0);
  });
});

describe('videoKeyAction', () => {
  it('maps the conventional keys', () => {
    expect(videoKeyAction(' ')).toEqual({ kind: 'toggle-play' });
    expect(videoKeyAction('k')).toEqual({ kind: 'toggle-play' });
    expect(videoKeyAction('ArrowLeft')).toEqual({ kind: 'seek-by', seconds: -SEEK_STEP_S });
    expect(videoKeyAction('ArrowRight')).toEqual({ kind: 'seek-by', seconds: SEEK_STEP_S });
    expect(videoKeyAction('Home')).toEqual({ kind: 'seek-to', fraction: 0 });
    expect(videoKeyAction('End')).toEqual({ kind: 'seek-to', fraction: 1 });
    expect(videoKeyAction('m')).toEqual({ kind: 'toggle-mute' });
    expect(videoKeyAction('f')).toEqual({ kind: 'toggle-fullscreen' });
  });

  it('leaves every other key to the page', () => {
    expect(videoKeyAction('Escape')).toBeNull();
    expect(videoKeyAction('Tab')).toBeNull();
  });
});

describe('scrubLength', () => {
  it('is the duration when the engine knows one', () => {
    expect(scrubLength(61.4, ranges([0, 8]))).toBe(61.4);
  });

  it('is the end of what can be sought when the length is unknown (a stream not yet measured)', () => {
    expect(scrubLength(Number.POSITIVE_INFINITY, ranges([0, 8]))).toBe(8);
    expect(scrubLength(Number.NaN, ranges([0, 3], [5, 9]))).toBe(9);
  });

  it('is 0 when nothing is known: no line to map, nothing to seek', () => {
    expect(scrubLength(Number.POSITIVE_INFINITY, ranges())).toBe(0);
    expect(scrubLength(0, ranges([0, Number.POSITIVE_INFINITY]))).toBe(0);
  });
});
