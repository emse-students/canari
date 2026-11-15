// @vitest-environment happy-dom
/**
 * A PAGE IS REOPENED WHERE IT WAS LEFT, ON A BACK (owner report, 2026-11-15; review of #3648).
 *
 * The box the app scrolls in is not the window, so SvelteKit never restored it. These pin what the
 * layout relies on: an offset per history ENTRY, a restore that waits for the content AND for the
 * placeholders to leave, and that always ends - applied, settled shorter, scrolled by the reader, or
 * cancelled by the next navigation - with no clock anywhere.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetEntryMemory } from './historyEntry';
import {
  LOADING_SKELETON_ATTRIBUTE,
  cancelRestore,
  recallScroll,
  rememberLeaving,
  restoreOnReturn,
} from './scrollMemory';

/** A scroller whose scrollable height the test controls. */
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
const resized = () => live.forEach((o) => o.fire());
/** requestAnimationFrame as a queue the test drains, one frame at a time. */
let frameQueue: (() => void)[] = [];
vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frameQueue.push(cb));
const frame = () => {
  const run = frameQueue;
  frameQueue = [];
  run.forEach((cb) => cb());
};
/** happy-dom delivers MutationObserver callbacks as microtasks. */
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  cancelRestore();
  resetEntryMemory();
  live.length = 0;
  frameQueue = [];
  document.body.innerHTML = '';
});

describe('rememberLeaving / recallScroll', () => {
  it('keys an ENTRY, so two entries of one address keep two offsets, and forgets the top', () => {
    rememberLeaving(1, 1200);
    rememberLeaving(2, 300);
    expect(recallScroll(1)).toBe(1200);
    expect(recallScroll(2)).toBe(300);
    rememberLeaving(1, 0);
    expect(recallScroll(1)).toBeUndefined();
    rememberLeaving(undefined, 500);
    expect(recallScroll(undefined)).toBeUndefined();
  });
});

describe('restoreOnReturn', () => {
  it('has nothing to do for an entry never left scrolled', () => {
    expect(restoreOnReturn(99, scroller({ scroll: 5000 }))).toBe(false);
  });

  it('applies the offset at once when the content is tall enough and nothing is loading', () => {
    rememberLeaving(1, 1200);
    const el = scroller({ scroll: 5000 });
    expect(restoreOnReturn(1, el)).toBe(true);
    expect(el.scrollTop).toBe(1200);
  });

  it('does NOT trust a tall skeleton: it waits until the placeholders are gone', async () => {
    rememberLeaving(1, 1200);
    const el = scroller({ scroll: 5000 });
    el.innerHTML = '<div data-loading-skeleton class="animate-pulse"></div>';
    restoreOnReturn(1, el);
    expect(el.scrollTop).toBe(0);
    el.innerHTML = '<article>cards</article>';
    await flush();
    expect(el.scrollTop).toBe(1200);
  });

  it('is NOT held by a live card, a stuck image loader or a busy button (review #2 of #3648)', () => {
    rememberLeaving(1, 1200);
    const el = scroller({ scroll: 5000 });
    el.innerHTML =
      '<article><span class="animate-pulse"></span><img aria-busy="true"><button aria-busy="true"></button></article>';
    expect(restoreOnReturn(1, el)).toBe(true);
    expect(el.scrollTop).toBe(1200);
  });

  it('every list skeleton of the app declares the marker', () => {
    const read = (f: string) => readFileSync(resolve(__dirname, '../../routes', f), 'utf8');
    for (const f of [
      'posts/+page.svelte',
      'notifications/+page.svelte',
      'directory/+page.svelte',
      'admin/moderation/+page.svelte',
      'posts/[postId]/+page.svelte',
    ]) {
      expect(read(f), f).toContain(LOADING_SKELETON_ATTRIBUTE);
    }
  });

  it('waits for the content to grow, then applies', () => {
    rememberLeaving(1, 1200);
    const height = { scroll: 800 };
    const el = scroller(height);
    restoreOnReturn(1, el);
    height.scroll = 3000;
    resized();
    expect(el.scrollTop).toBe(1200);
  });

  it('ENDS when the page settled shorter: two quiet frames after a change, never for ever', () => {
    rememberLeaving(1, 5000);
    const height = { scroll: 2000 };
    const el = scroller(height);
    restoreOnReturn(1, el);
    resized(); // a change, no placeholder, not tall enough: wait for the page to stop changing
    frame();
    expect(el.scrollTop).toBe(0);
    frame();
    expect(el.scrollTop).toBe(5000); // the browser clamps it to the page; the raw assignment here
    height.scroll = 9000;
    resized(); // the observers are disconnected: a late growth is not followed
    expect(live.every((o) => !o.active)).toBe(true);
  });

  it('a page still growing keeps invalidating the settle check (cards mounted a frame at a time)', () => {
    rememberLeaving(1, 5000);
    const height = { scroll: 2000 };
    const el = scroller(height);
    restoreOnReturn(1, el);
    resized();
    frame();
    height.scroll = 3000;
    resized(); // grew again before the second frame
    frame();
    expect(el.scrollTop).toBe(0);
    height.scroll = 6000;
    resized(); // now tall enough: applied at once
    expect(el.scrollTop).toBe(5000);
  });

  it('ends on ANY scroll event the reader started (wheel, scrollbar, key alike)', () => {
    rememberLeaving(1, 1200);
    const height = { scroll: 800 };
    const el = scroller(height);
    restoreOnReturn(1, el);
    el.dispatchEvent(new Event('scroll'));
    height.scroll = 3000;
    resized();
    expect(el.scrollTop).toBe(0);
  });

  it('ends when a navigation begins', () => {
    rememberLeaving(1, 1200);
    const height = { scroll: 800 };
    const el = scroller(height);
    restoreOnReturn(1, el);
    cancelRestore();
    height.scroll = 3000;
    resized();
    expect(el.scrollTop).toBe(0);
  });
});
