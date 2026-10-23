import { describe, it, expect } from 'vitest';
import { callElapsedMs, formatCallDuration } from './callClock';

describe('the call timer is a function of timestamps', () => {
  it('reads zero before the media path connected', () => {
    expect(callElapsedMs(null, null, 5_000)).toBe(0);
  });

  it('runs from connectedAt to now, whatever happened in between', () => {
    // A minute "in the pocket": no tick ran, the first read after it is still right.
    expect(callElapsedMs(1_000, null, 61_000)).toBe(60_000);
  });

  it('stops at endedAt once the call ended', () => {
    expect(callElapsedMs(1_000, 31_000, 999_000)).toBe(30_000);
  });

  it('never goes negative when a clock reads behind connectedAt', () => {
    expect(callElapsedMs(10_000, null, 9_000)).toBe(0);
  });
});

describe('formatCallDuration', () => {
  it.each([
    [0, '00:00'],
    [999, '00:00'],
    [1_000, '00:01'],
    [133_000, '02:13'],
    [3_599_000, '59:59'],
    [3_600_000, '1:00:00'],
    [3_723_000, '1:02:03'],
    [-5, '00:00'],
  ])('%i ms reads %s', (ms, text) => {
    expect(formatCallDuration(ms)).toBe(text);
  });
});
