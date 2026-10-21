/// <reference types="jest" />

import { PostCardCache } from './post-card-cache';

const buf = (n: number) => Buffer.alloc(n, 1);

describe('PostCardCache', () => {
  it('renders once per key and serves the remembered bytes afterwards', async () => {
    const cache = new PostCardCache(1000);
    const render = jest.fn(() => Promise.resolve(buf(100)));
    const a = await cache.getOrRender('k', render);
    const b = await cache.getOrRender('k', render);
    expect(b).toBe(a);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('single-flights a burst: concurrent callers share one render', async () => {
    const cache = new PostCardCache(1000);
    let release!: (b: Buffer) => void;
    const render = jest.fn(
      () =>
        new Promise<Buffer>((resolve) => {
          release = resolve;
        })
    );
    const burst = [1, 2, 3, 4].map(() => cache.getOrRender('k', render));
    release(buf(10));
    const results = await Promise.all(burst);
    expect(render).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1);
  });

  it('shares a failed render with its burst but does not remember it', async () => {
    const cache = new PostCardCache(1000);
    const render = jest
      .fn<Promise<Buffer | null>, []>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(buf(10));
    expect(await cache.getOrRender('k', render)).toBeNull();
    expect(await cache.getOrRender('k', render)).not.toBeNull();
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('stays within its byte budget by dropping the least recently used entry', async () => {
    const cache = new PostCardCache(250);
    await cache.getOrRender('a', () => Promise.resolve(buf(100)));
    await cache.getOrRender('b', () => Promise.resolve(buf(100)));
    // Touch `a`, so `b` is now the oldest.
    await cache.getOrRender('a', () => Promise.reject(new Error('a should be cached')));
    await cache.getOrRender('c', () => Promise.resolve(buf(100)));
    expect(cache.size).toBeLessThanOrEqual(250);
    const again = jest.fn(() => Promise.resolve(buf(100)));
    await cache.getOrRender('a', again);
    expect(again).not.toHaveBeenCalled();
    await cache.getOrRender('b', again);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('serves a card bigger than the whole budget without keeping it', async () => {
    const cache = new PostCardCache(50);
    const render = jest.fn(() => Promise.resolve(buf(100)));
    await cache.getOrRender('big', render);
    await cache.getOrRender('big', render);
    expect(render).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });
});
