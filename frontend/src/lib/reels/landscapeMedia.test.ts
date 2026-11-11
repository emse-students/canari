import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Log } from '$lib/utils/Log';
import {
  isLandscapeMedia,
  reportUnusableDimensions,
  resetLandscapeMediaLogForTest,
} from './landscapeMedia';

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

  it('is false without usable dimensions, and never logs (it is pure)', () => {
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
    expect(isLandscapeMedia({ mediaId: 'm1' })).toBe(false);
    expect(isLandscapeMedia({ mediaId: 'm1', width: 1920 })).toBe(false);
    expect(isLandscapeMedia({ mediaId: 'm2', width: 0, height: 0 })).toBe(false);
    expect(isLandscapeMedia({ mediaId: 'm3', width: Number.NaN, height: 10 })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('decides per media: a landscape file does not colour the next one', () => {
    expect(isLandscapeMedia({ mediaId: 'a', width: 1920, height: 1080 })).toBe(true);
    expect(isLandscapeMedia({ mediaId: 'b', width: 1080, height: 1920 })).toBe(false);
  });
});

describe('reportUnusableDimensions', () => {
  it('says it once per media, and nothing for a usable one', () => {
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
    reportUnusableDimensions({ mediaId: 'm1' });
    reportUnusableDimensions({ mediaId: 'm1', width: 1920 });
    reportUnusableDimensions({ mediaId: 'm2', width: 0, height: 0 });
    reportUnusableDimensions({ mediaId: 'ok', width: 10, height: 20 });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
