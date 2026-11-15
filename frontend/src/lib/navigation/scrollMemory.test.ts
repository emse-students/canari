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
  SCROLL_ANCHOR_ATTRIBUTE,
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

  it('the feed marks each card with its post id as the anchor', () => {
    const page = readFileSync(resolve(__dirname, '../../routes/posts/+page.svelte'), 'utf8');
    expect(page).toContain(`${SCROLL_ANCHOR_ATTRIBUTE}={post.id}`);
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

/**
 * A feed with real geometry: card `i` is `heights[i]` tall, the box's top is at 100, and a card's
 * rect follows the box's `scrollTop` the way a browser's does.
 */
function feed(heights: number[]) {
  const model = { heights };
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientHeight', { get: () => 800 });
  Object.defineProperty(el, 'scrollHeight', {
    get: () => model.heights.reduce((a, b) => a + b, 0),
  });
  el.getBoundingClientRect = () => ({ top: 100, bottom: 900 }) as DOMRect;
  document.body.appendChild(el);
  const cards: HTMLElement[] = [];
  const draw = (count: number) => {
    for (let i = cards.length; i < count; i++) {
      const card = document.createElement('div');
      card.setAttribute(SCROLL_ANCHOR_ATTRIBUTE, `p${i}`);
      card.getBoundingClientRect = () => {
        const above = model.heights.slice(0, i).reduce((a, b) => a + b, 0);
        const top = 100 + above - el.scrollTop;
        return { top, bottom: top + model.heights[i] } as DOMRect;
      };
      el.appendChild(card);
      cards.push(card);
    }
  };
  /** Distance of card `i` from the top of the box. */
  const offsetOf = (i: number) => cards[i].getBoundingClientRect().top - 100;
  return { el, model, draw, offsetOf };
}

describe('the place is an anchor, not only a distance (1.7.0-alpha.2: left at 1500, back at 1726)', () => {
  it('records the first card whose bottom is below the top of the box, and its distance', () => {
    const f = feed(Array(20).fill(300));
    f.draw(20);
    f.el.scrollTop = 1560; // 60 px into card 5
    rememberLeaving(2, 1560, f.el);
    const g = feed(Array(20).fill(300));
    g.draw(20);
    restoreOnReturn(2, g.el);
    expect(g.el.scrollTop).toBe(1560);
    expect(g.offsetOf(5)).toBe(-60);
  });

  it('puts the SAME post back when the content above it is taller than when it was left', () => {
    const left = feed(Array(20).fill(300));
    left.draw(20);
    left.el.scrollTop = 1500;
    rememberLeaving(1, 1500, left.el);
    const seenAt = left.offsetOf(5);
    document.body.innerHTML = '';
    // Back: the five cards above arrive 45 px taller (225 px in all), as images and posters settle.
    const back = feed([345, 345, 345, 345, 345, ...Array(15).fill(300)]);
    back.draw(20);
    restoreOnReturn(1, back.el);
    expect(back.el.scrollTop).toBe(1725); // the offset alone would have been 1500
    expect(back.offsetOf(5)).toBe(seenAt);
  });

  it('waits for the anchor to be drawn, even when the page is already tall enough', async () => {
    const left = feed(Array(20).fill(300));
    left.draw(20);
    left.el.scrollTop = 1500;
    rememberLeaving(1, 1500, left.el);
    document.body.innerHTML = '';
    const back = feed(Array(20).fill(300));
    back.draw(3); // tall (6000 px of model) but card 5 is not mounted yet
    restoreOnReturn(1, back.el);
    expect(back.el.scrollTop).toBe(0);
    back.draw(8);
    await flush();
    expect(back.offsetOf(5)).toBe(0);
  });

  it('keeps the anchor aligned while the content above it still changes, then ends when quiet', async () => {
    const left = feed(Array(20).fill(300));
    left.draw(20);
    left.el.scrollTop = 1500;
    rememberLeaving(1, 1500, left.el);
    document.body.innerHTML = '';
    const back = feed(Array(20).fill(300));
    back.draw(20);
    restoreOnReturn(1, back.el);
    expect(back.offsetOf(5)).toBe(0);
    back.model.heights[0] = 526; // a poster above settles AFTER the first alignment
    resized();
    expect(back.offsetOf(5)).toBe(0);
    frame();
    frame();
    expect(live.every((o) => !o.active)).toBe(true);
    const quiet = back.el.scrollTop;
    back.model.heights[0] = 700;
    resized(); // the restore is over: a later change is not followed
    expect(back.el.scrollTop).toBe(quiet);
  });

  it('a wheel, touch or key from the reader ends the following', () => {
    const left = feed(Array(20).fill(300));
    left.draw(20);
    left.el.scrollTop = 1500;
    rememberLeaving(1, 1500, left.el);
    document.body.innerHTML = '';
    const back = feed(Array(20).fill(300));
    back.draw(20);
    restoreOnReturn(1, back.el);
    back.el.dispatchEvent(new Event('touchstart'));
    expect(live.every((o) => !o.active)).toBe(true);
  });

  it('falls back to the offset when the anchored post is gone (deleted meanwhile)', () => {
    const left = feed(Array(20).fill(300));
    left.draw(20);
    left.el.scrollTop = 1500;
    rememberLeaving(1, 1500, left.el);
    document.body.innerHTML = '';
    const back = feed(Array(20).fill(300));
    back.draw(20);
    back.el.querySelector(`[${SCROLL_ANCHOR_ATTRIBUTE}="p5"]`)?.remove();
    restoreOnReturn(1, back.el);
    resized();
    frame();
    frame();
    expect(back.el.scrollTop).toBe(1500);
  });
});
