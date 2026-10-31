/**
 * A ROUTE'S CODE IS PRELOADED ONCE PER DOCUMENT (2026-10-15). SvelteKit's viewport preload re-ran
 * every bottom-bar route's loaders after each navigation, and each run resolved ~250 dependency URLs
 * in Vite's preload helper: 60-118 ms of main thread per tab tap on the Mi 9T, for modules loaded
 * since boot. `routeCodePreload.ts` holds why a memo is correct; these pin what it remembers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', () => ({ preloadCode: vi.fn(() => Promise.resolve()) }));
vi.mock('$app/paths', () => ({
  match: vi.fn((path: string) => Promise.resolve({ id: path })),
}));

import { preloadRouteCodeOnce, resetRouteCodePreloadsForTests } from './routeCodePreload';

afterEach(() => resetRouteCodePreloadsForTests());

describe('preloadRouteCodeOnce', () => {
  it('asks the router once per route, however many callers and navigations ask again', async () => {
    const preload = vi.fn((_path: string) => Promise.resolve());
    await preloadRouteCodeOnce('/communities', preload);
    await preloadRouteCodeOnce('/communities', preload);
    await preloadRouteCodeOnce('/communities', preload);
    expect(preload).toHaveBeenCalledTimes(1);
  });

  it('joins a preload still in flight instead of starting a second one', () => {
    let finish: () => void = () => {};
    const preload = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const first = preloadRouteCodeOnce('/chat', preload);
    const second = preloadRouteCodeOnce('/chat', preload);
    expect(second).toBe(first);
    expect(preload).toHaveBeenCalledTimes(1);
    finish();
  });

  it('keeps each route apart', async () => {
    const preload = vi.fn((_path: string) => Promise.resolve());
    await preloadRouteCodeOnce('/posts', preload);
    await preloadRouteCodeOnce('/chat', preload);
    expect(preload.mock.calls.map(([path]) => path)).toEqual(['/posts', '/chat']);
  });

  it('forgets a failed preload, so the next caller retries it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const preload = vi
      .fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('chunk gone'))
      .mockResolvedValueOnce(undefined);
    await expect(preloadRouteCodeOnce('/dashboard', preload)).rejects.toThrow('chunk gone');
    expect(warn).toHaveBeenCalledWith(
      '[RoutePreload] code preload failed, the next caller retries:',
      '/dashboard',
      expect.any(Error)
    );
    await preloadRouteCodeOnce('/dashboard', preload);
    await preloadRouteCodeOnce('/dashboard', preload);
    expect(preload).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("defaults to SvelteKit's own preloadCode", async () => {
    const { preloadCode } = await import('$app/navigation');
    await preloadRouteCodeOnce('/notifications');
    expect(preloadCode).toHaveBeenCalledWith('/notifications');
  });
});
