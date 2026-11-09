// @vitest-environment happy-dom
/**
 * A navigation link preloads its route the first time it is on screen, and never again in the same
 * document - however many times the bar is re-drawn by a navigation (`routeCodePreload.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preloadCode = vi.fn((_path: string) => Promise.resolve());
vi.mock('$app/navigation', () => ({ preloadCode: (path: string) => preloadCode(path) }));
vi.mock('$app/paths', () => ({ match: (path: string) => Promise.resolve({ id: path }) }));

import { preloadRouteOnView } from './preloadRouteOnView';
import { resetRouteCodePreloadsForTests } from '$lib/navigation/routeCodePreload';
import { flushMacrotask } from '../../test/flush';

class FakeObserver {
  static all: FakeObserver[] = [];
  disconnected = false;
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit
  ) {
    FakeObserver.all.push(this);
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
  enter() {
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
}

const original = globalThis.IntersectionObserver;
beforeEach(() => {
  FakeObserver.all = [];
  preloadCode.mockClear();
  globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
});
afterEach(() => {
  globalThis.IntersectionObserver = original;
  resetRouteCodePreloadsForTests();
});

describe('preloadRouteOnView', () => {
  it('preloads nothing until the link is on screen', () => {
    preloadRouteOnView(document.createElement('a'), '/communities');
    expect(preloadCode).not.toHaveBeenCalled();
  });

  it('preloads once when the link appears, and a re-drawn bar does not preload it again', async () => {
    const first = preloadRouteOnView(document.createElement('a'), '/communities');
    FakeObserver.all[0].enter();
    await Promise.resolve();
    first.destroy();
    // A navigation re-draws the bar: a new link for the same route, on screen at once.
    preloadRouteOnView(document.createElement('a'), '/communities');
    FakeObserver.all[1].enter();
    await Promise.resolve();
    expect(preloadCode).toHaveBeenCalledTimes(1);
    expect(preloadCode).toHaveBeenCalledWith('/communities');
  });

  it('makes one attempt per drawn link: a failure is retried by the link drawn again, not by itself', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    preloadCode.mockRejectedValueOnce(new Error('offline'));
    const first = preloadRouteOnView(document.createElement('a'), '/chat');
    FakeObserver.all[0].enter();
    await flushMacrotask();
    // One-shot: the observer let go, so a visible link cannot loop on a failure.
    FakeObserver.all[0].enter();
    await flushMacrotask();
    expect(preloadCode).toHaveBeenCalledTimes(1);
    first.destroy();
    preloadRouteOnView(document.createElement('a'), '/chat');
    FakeObserver.all[1].enter();
    await flushMacrotask();
    expect(preloadCode).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('follows a changed route and stops observing when the link goes', async () => {
    const action = preloadRouteOnView(document.createElement('a'), '/posts');
    action.update('/chat');
    FakeObserver.all[0].enter();
    await flushMacrotask();
    expect(preloadCode).toHaveBeenCalledWith('/chat');
    action.destroy();
    expect(FakeObserver.all[0].disconnected).toBe(true);
  });
});
