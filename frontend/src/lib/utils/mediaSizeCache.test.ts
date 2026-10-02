import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hashMediaKey,
  MAX_ENTRIES,
  measuredMediaSize,
  recordMeasuredMediaSize,
  resetMediaSizeCacheForTests,
} from './mediaSizeCache';

const GIF = 'https://static.klipy.com/ii/abc/def.gif';

describe('mediaSizeCache', () => {
  beforeEach(() => {
    localStorage.clear();
    resetMediaSizeCacheForTests();
  });
  afterEach(() => localStorage.clear());

  it('answers nothing for a medium this device never drew', () => {
    expect(measuredMediaSize(GIF)).toBeNull();
    expect(measuredMediaSize(undefined)).toBeNull();
  });

  it('survives a restart: a measurement is read back from storage by a fresh session', () => {
    recordMeasuredMediaSize(GIF, 498, 280);
    resetMediaSizeCacheForTests();
    expect(measuredMediaSize(GIF)).toEqual({ width: 498, height: 280 });
  });

  it('never stores the key readable - a GIF URL is message content', () => {
    recordMeasuredMediaSize(GIF, 498, 280);
    const stored = Object.values({ ...localStorage }).join('');
    expect(stored).not.toContain('klipy');
    expect(stored).toContain(hashMediaKey(GIF));
  });

  it('refuses an unusable measurement', () => {
    recordMeasuredMediaSize(GIF, 0, 280);
    expect(measuredMediaSize(GIF)).toBeNull();
  });

  it('is bounded, the oldest measurement leaving first', () => {
    for (let i = 0; i <= MAX_ENTRIES; i++) recordMeasuredMediaSize(`media-${i}`, 10, 10);
    expect(measuredMediaSize('media-0')).toBeNull();
    expect(measuredMediaSize(`media-${MAX_ENTRIES}`)).toEqual({ width: 10, height: 10 });
  });

  it('starts empty on a corrupt stored value rather than throwing', () => {
    localStorage.setItem('canari_media_sizes_v1', '{not json');
    resetMediaSizeCacheForTests();
    expect(measuredMediaSize(GIF)).toBeNull();
  });
});
