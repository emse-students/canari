// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { fireResize, useResizeObserverStub } from '../../../test/resizeObserverStub';
import { watchClampOverflow } from './clampOverflow';

useResizeObserverStub();

/** A box whose `scrollHeight` is counted, so a read is an observable event. */
function box(scroll: number, client: number) {
  const el = document.createElement('div');
  const reads = vi.fn(() => scroll);
  Object.defineProperty(el, 'scrollHeight', { get: reads });
  Object.defineProperty(el, 'clientHeight', { get: () => client });
  return { el, reads };
}

describe('watchClampOverflow - the observer answers first, nothing is read in the mount', () => {
  it('reads nothing while mounting, then answers on the observer callback', () => {
    const { el, reads } = box(500, 100);
    const seen: boolean[] = [];
    watchClampOverflow(el, (o) => seen.push(o));
    expect(reads).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    fireResize();
    expect(seen).toEqual([true]);
  });

  it('a box that fits reports no overflow', () => {
    const { el } = box(100, 100);
    const seen: boolean[] = [];
    watchClampOverflow(el, (o) => seen.push(o));
    fireResize();
    expect(seen).toEqual([false]);
  });

  it('a teardown disconnects: later callbacks read nothing', () => {
    const { el, reads } = box(500, 100);
    const seen: boolean[] = [];
    const stop = watchClampOverflow(el, (o) => seen.push(o));
    stop();
    fireResize();
    expect(reads).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('without ResizeObserver (server rendering) it watches nothing and tears down cleanly', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const { el, reads } = box(500, 100);
    const stop = watchClampOverflow(el, () => {});
    expect(reads).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });
});
