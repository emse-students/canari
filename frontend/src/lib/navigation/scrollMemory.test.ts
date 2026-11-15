// @vitest-environment happy-dom
/**
 * A PAGE IS REOPENED WHERE IT WAS LEFT, ON A BACK (owner report, 2026-11-15).
 *
 * The box the app scrolls in is not the window, so SvelteKit never restored it. These pin the three
 * facts the layout relies on: only a positive offset is kept per address, a restore waits for the
 * content instead of a clock, and the reader's own scroll or the next navigation ends the wait.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelRestore, recallScroll, rememberLeaving, restoreOnReturn } from './scrollMemory';

const url = (p: string) => new URL(`http://x${p}`);

/** A scroller whose scrollable height the test controls, and a ResizeObserver it can fire. */
function scroller(height: { scroll: number }) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { get: () => height.scroll });
  Object.defineProperty(el, 'clientHeight', { get: () => 800 });
  document.body.appendChild(el);
  return el;
}

const live: FakeResizeObserver[] = [];
class FakeResizeObserver {
  active = true;
  constructor(private cb: () => void) {
    live.push(this);
  }
  observe() {}
  disconnect() {
    this.active = false;
  }
  fire() {
    if (this.active) this.cb();
  }
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver);
const fireResize = () => live.forEach((o) => o.fire());

afterEach(() => {
  cancelRestore();
  live.length = 0;
  document.body.innerHTML = '';
});

describe('rememberLeaving / recallScroll', () => {
  it('keys a page by path and query, and forgets a page left at the top', () => {
    rememberLeaving(url('/posts?feed=all#a'), 1200);
    expect(recallScroll(url('/posts?feed=all'))).toBe(1200);
    expect(recallScroll(url('/posts'))).toBeUndefined();
    rememberLeaving(url('/posts?feed=all'), 0);
    expect(recallScroll(url('/posts?feed=all'))).toBeUndefined();
  });
});

describe('restoreOnReturn', () => {
  it('has nothing to do for a first visit', () => {
    expect(restoreOnReturn(url('/never-seen'), scroller({ scroll: 5000 }))).toBe(false);
  });

  it('applies the offset at once when the content is already tall enough', () => {
    rememberLeaving(url('/a'), 1200);
    const el = scroller({ scroll: 5000 });
    expect(restoreOnReturn(url('/a'), el)).toBe(true);
    expect(el.scrollTop).toBe(1200);
  });

  it('waits for the content, then applies it - by a resize, not by a timer', () => {
    rememberLeaving(url('/b'), 1200);
    const height = { scroll: 800 };
    const el = scroller(height);
    restoreOnReturn(url('/b'), el);
    expect(el.scrollTop).toBe(0);
    fireResize();
    expect(el.scrollTop).toBe(0);
    height.scroll = 3000;
    fireResize();
    expect(el.scrollTop).toBe(1200);
  });

  it('ends when the reader scrolls by themselves', () => {
    rememberLeaving(url('/c'), 1200);
    const height = { scroll: 800 };
    const el = scroller(height);
    restoreOnReturn(url('/c'), el);
    el.dispatchEvent(new Event('touchstart'));
    height.scroll = 3000;
    fireResize();
    expect(el.scrollTop).toBe(0);
  });

  it('ends when a navigation begins', () => {
    rememberLeaving(url('/d'), 1200);
    const height = { scroll: 800 };
    const el = scroller(height);
    restoreOnReturn(url('/d'), el);
    cancelRestore();
    height.scroll = 3000;
    fireResize();
    expect(el.scrollTop).toBe(0);
  });
});
