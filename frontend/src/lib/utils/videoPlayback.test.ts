import { describe, it, expect } from 'vitest';
import {
  SEEK_STEP_S,
  bufferedFraction,
  clampFraction,
  formatVideoTime,
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

describe('bufferedFraction', () => {
  it('reads the range under the playhead, not a later one past a hole', () => {
    // Played 0-20 s, then a seek buffered 60-80 s; the playhead is at 10 s.
    expect(bufferedFraction(ranges([0, 20], [60, 80]), 10, 100)).toBe(0.2);
  });

  it('with nothing under the playhead, nothing ahead of it is buffered', () => {
    expect(bufferedFraction(ranges([60, 80]), 10, 100)).toBe(0.1);
  });

  it('is 0 while the duration is unknown', () => {
    expect(bufferedFraction(ranges([0, 5]), 1, Number.NaN)).toBe(0);
  });

  it('clamps', () => {
    expect(clampFraction(1.4)).toBe(1);
    expect(clampFraction(-1)).toBe(0);
    expect(clampFraction(Number.NaN)).toBe(0);
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
