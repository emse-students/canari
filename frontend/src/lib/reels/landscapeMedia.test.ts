import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Log } from '$lib/utils/Log';
import { isLandscapeMedia, resetLandscapeMediaLogForTest } from './landscapeMedia';

beforeEach(() => {
  resetLandscapeMediaLogForTest();
  vi.restoreAllMocks();
});

describe('isLandscapeMedia', () => {
  it('is true for a file wider than tall', () => {
    expect(isLandscapeMedia({ mediaId: 'a', width: 1920, height: 1080 })).toBe(true);
  });

  it('is false for a portrait or square file', () => {
    expect(isLandscapeMedia({ mediaId: 'a', width: 720, height: 1280 })).toBe(false);
    expect(isLandscapeMedia({ mediaId: 'a', width: 800, height: 800 })).toBe(false);
  });

  it('is false, and said once per media, when the dimensions are missing or unusable', () => {
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
    expect(isLandscapeMedia({ mediaId: 'm1' })).toBe(false);
    expect(isLandscapeMedia({ mediaId: 'm1', width: 1920 })).toBe(false);
    expect(isLandscapeMedia({ mediaId: 'm2', width: 0, height: 0 })).toBe(false);
    expect(isLandscapeMedia({ mediaId: 'm3', width: Number.NaN, height: 10 })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('decides per media: a landscape file does not colour the next one', () => {
    expect(isLandscapeMedia({ mediaId: 'a', width: 1920, height: 1080 })).toBe(true);
    expect(isLandscapeMedia({ mediaId: 'b', width: 1080, height: 1920 })).toBe(false);
  });
});
