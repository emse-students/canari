/**
 * The session's first-frame posters: made once per reel, bounded, and a failed decode leaves the
 * slide on its placeholder rather than throwing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureReelPoster,
  REEL_POSTER_MAX,
  reelPosterUrl,
  resetReelPostersForTest,
} from './reelPosters.svelte';

let made = 0;
let revoked: string[] = [];

beforeEach(() => {
  made = 0;
  revoked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ blob: async () => new Blob(['v'], { type: 'video/mp4' }) }))
  );
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:poster-${++made}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => void revoked.push(u));
});

afterEach(() => {
  resetReelPostersForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const jpeg = async () => new Blob(['j'], { type: 'image/jpeg' });

describe('reel posters', () => {
  it('keeps the first frame of a decrypted reel under its media id', async () => {
    expect(reelPosterUrl('m1')).toBeNull();
    await captureReelPoster('m1', 'blob:video', jpeg);
    expect(reelPosterUrl('m1')).toBe('blob:poster-1');
  });

  it('decodes a reel once, however many slides ask', async () => {
    const capture = vi.fn(jpeg);
    await Promise.all([
      captureReelPoster('m1', 'blob:video', capture),
      captureReelPoster('m1', 'blob:video', capture),
    ]);
    await captureReelPoster('m1', 'blob:video', capture);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('a frame the engine cannot decode leaves no poster and does not throw', async () => {
    await captureReelPoster('m1', 'blob:video', async () => null);
    expect(reelPosterUrl('m1')).toBeNull();
    await captureReelPoster('m2', 'blob:video', async () => {
      throw new Error('decoder');
    });
    expect(reelPosterUrl('m2')).toBeNull();
  });

  it(`keeps ${REEL_POSTER_MAX} posters and revokes the oldest`, async () => {
    for (let i = 0; i <= REEL_POSTER_MAX; i++) await captureReelPoster(`m${i}`, 'blob:v', jpeg);
    expect(reelPosterUrl('m0')).toBeNull();
    expect(revoked).toEqual(['blob:poster-1']);
    expect(reelPosterUrl(`m${REEL_POSTER_MAX}`)).toBe(`blob:poster-${REEL_POSTER_MAX + 1}`);
  });
});
