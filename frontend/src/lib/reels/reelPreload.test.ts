/**
 * A preload never leaves a reel fetched twice: stopped early it aborts, finished it gives its hold
 * back, and a result arriving after the stop is returned at once. Driven by the order the test
 * resolves the cache's promise, never by a clock.
 */
import { describe, expect, it, vi } from 'vitest';
import { ReelPreload, type ReelPreloadCache } from './reelPreload';
import type { MediaRef } from '$lib/media';

vi.mock('$lib/utils/apiUrl', () => ({ mediaUrl: () => 'https://media.test' }));

const ref = {
  type: 'video',
  mediaId: 'm-1',
  key: 'k',
  iv: 'i',
  mimeType: 'video/mp4',
  size: 1,
} as MediaRef;

function cache() {
  let resolve: (url: string) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  let signal: AbortSignal | null = null;
  const c: ReelPreloadCache = {
    acquire: vi.fn((_r, _b, s: AbortSignal) => {
      signal = s;
      s.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      return new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
      });
    }),
    release: vi.fn(),
  };
  return { c, resolve: (u: string) => resolve(u), signal: () => signal };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ReelPreload', () => {
  it('fetches through the cache at once', () => {
    const { c } = cache();
    new ReelPreload(ref, c);
    expect(c.acquire).toHaveBeenCalledWith(ref, 'https://media.test', expect.any(AbortSignal));
  });

  it('a stop before the video is in aborts the fetch and holds nothing', async () => {
    const { c, signal } = cache();
    const p = new ReelPreload(ref, c);
    p.stop();
    await flush();
    expect(signal()?.aborted).toBe(true);
    expect(c.release).not.toHaveBeenCalled();
    expect(p.ready).toBe(false);
  });

  it('a stop after the video is in gives the hold back, once', async () => {
    const { c, resolve } = cache();
    const p = new ReelPreload(ref, c);
    resolve('blob:x');
    await flush();
    expect(p.ready).toBe(true);
    p.stop();
    p.stop();
    expect(c.release).toHaveBeenCalledTimes(1);
  });
});
