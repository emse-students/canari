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
import { Log } from '$lib/utils/Log';
import { resetEntryMemory } from './historyEntry';
import { resetPageScroll, scrollPageToTop } from './scrollToTop';
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
  targets = new Set<Element>();
  observe(target: Element) {
    this.targets.add(target);
  }
  disconnect() {
    this.active = false;
  }
  /** A resize of `target` reaches the callback only if THIS observer watches `target`. */
  fire(target?: Element) {
    if (this.active && (!target || this.targets.has(target))) this.cb();
  }
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver);
const resized = () => live.forEach((o) => o.fire());
/** The browser's behaviour: only an element someone observes reports its resize. */
const resizedAt = (target: Element) => live.forEach((o) => o.fire(target));
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
 * A feed with real geometry: box > list > cards, card `i` is `heights[i]` tall, the box's top is at
 * 100, and a card's rect follows the box's `scrollTop` the way a browser's does. The box has a FIXED
 * height, as `.page-scroll-wrap` does: only the list, or a card, can report a resize.
 */
function feed(heights: number[]) {
  const model = { heights };
  const el = document.createElement('div');
  const list = document.createElement('div');
  el.appendChild(list);
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
      list.appendChild(card);
      cards.push(card);
    }
  };
  /** Distance of card `i` from the top of the box. */
  const offsetOf = (i: number) => cards[i].getBoundingClientRect().top - 100;
  return { el, list, model, draw, offsetOf };
}

/** A feed left at `top` (anchored on card 5 at 1500), then a fresh one on return. */
function leaveAndReturn(back: number[] = Array(20).fill(300), top = 1500) {
  const left = feed(Array(20).fill(300));
  left.draw(20);
  left.el.scrollTop = top;
  rememberLeaving(1, top, left.el);
  document.body.innerHTML = '';
  const returned = feed(back);
  return returned;
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

  it('reads O(log n) rects at leave time, not one per card', () => {
    const f = feed(Array(400).fill(300));
    f.draw(400);
    let reads = 0;
    f.list.querySelectorAll('div').forEach((c) => {
      const rect = (c as HTMLElement).getBoundingClientRect;
      (c as HTMLElement).getBoundingClientRect = () => {
        reads += 1;
        return rect.call(c);
      };
    });
    f.el.scrollTop = 60000;
    rememberLeaving(1, 60000, f.el);
    expect(reads).toBeLessThan(20);
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
    const back = leaveAndReturn();
    back.draw(3); // tall (6000 px of model) but card 5 is not mounted yet
    restoreOnReturn(1, back.el);
    expect(back.el.scrollTop).toBe(0);
    back.draw(8);
    await flush();
    expect(back.offsetOf(5)).toBe(0);
  });

  it('follows a poster settling with NO DOM change: the observed LIST reports it, not the fixed box', () => {
    const back = leaveAndReturn();
    back.draw(20);
    restoreOnReturn(1, back.el);
    expect(back.offsetOf(5)).toBe(0);
    back.model.heights[0] = 526; // a poster above settles AFTER the first alignment
    // The box has a fixed height and reports nothing: the restore must watch the list and the anchor.
    const watching = live.flatMap((o) => [...o.targets]);
    expect(watching).toContain(back.list);
    expect(watching).toContain(back.list.children[5]);
    resizedAt(back.list);
    expect(back.offsetOf(5)).toBe(0);
  });

  it('follows a card growing in place: the anchor itself is observed', () => {
    const back = leaveAndReturn();
    back.draw(20);
    restoreOnReturn(1, back.el);
    back.model.heights[4] = 400;
    resizedAt(back.list.children[5]);
    expect(back.offsetOf(5)).toBe(0);
  });

  it('follows an image or a poster that finishes loading (a capture-phase load on the box)', () => {
    const back = leaveAndReturn();
    back.draw(20);
    restoreOnReturn(1, back.el);
    back.model.heights[2] = 500;
    back.list.children[2].dispatchEvent(new Event('load'));
    expect(back.offsetOf(5)).toBe(0);
    back.model.heights[1] = 450;
    back.list.children[1].dispatchEvent(new Event('loadedmetadata'));
    expect(back.offsetOf(5)).toBe(0);
  });

  it.each(['wheel', 'keydown', 'pointerdown', 'touchstart'])(
    'a %s from the reader ends the following',
    (type) => {
      const back = leaveAndReturn();
      back.draw(20);
      restoreOnReturn(1, back.el);
      expect(live.some((o) => o.active)).toBe(true);
      back.el.dispatchEvent(new Event(type));
      expect(live.every((o) => !o.active)).toBe(true);
    }
  );

  it('a scroll event while following is the restore itself: ignored', () => {
    const back = leaveAndReturn();
    back.draw(20);
    restoreOnReturn(1, back.el);
    back.el.dispatchEvent(new Event('scroll'));
    expect(live.some((o) => o.active)).toBe(true);
    back.model.heights[0] = 400;
    resizedAt(back.list);
    expect(back.offsetOf(5)).toBe(0);
  });

  it('a tap on the tab or a change of feed tab ends the restore instead of fighting it', () => {
    const back = leaveAndReturn();
    back.draw(20);
    back.el.className = 'page-scroll-wrap';
    restoreOnReturn(1, back.el);
    expect(back.el.scrollTop).toBe(1500);
    scrollPageToTop('tab-retap');
    expect(live.every((o) => !o.active)).toBe(true);
    back.el.scrollTop = 0;
    back.model.heights[0] = 400;
    resizedAt(back.list);
    expect(back.el.scrollTop).toBe(0);

    const again = leaveAndReturn();
    again.draw(20);
    again.el.className = 'page-scroll-wrap';
    restoreOnReturn(1, again.el);
    resetPageScroll();
    expect(live.filter((o) => o.active)).toHaveLength(0);
  });

  it('falls back to the offset when the anchored post is gone, and says so naming the anchor', () => {
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
    const back = leaveAndReturn();
    back.draw(20);
    back.el.querySelector(`[${SCROLL_ANCHOR_ATTRIBUTE}="p5"]`)?.remove();
    restoreOnReturn(1, back.el);
    resized();
    frame();
    frame();
    expect(back.el.scrollTop).toBe(1500);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toContain('anchor p5 never appeared');
    warn.mockRestore();
  });

  it('does not warn when the anchor was found', () => {
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
    const back = leaveAndReturn();
    back.draw(20);
    restoreOnReturn(1, back.el);
    frame();
    frame();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the restore has no proof of alignment: an event ends it, never the page looking right', () => {
  it('a subtree that keeps mutating (a live dot, a counter) stays aligned and costs no frame loop', async () => {
    const back = leaveAndReturn();
    back.draw(20);
    restoreOnReturn(1, back.el);
    for (let i = 0; i < 5; i++) {
      back.list.appendChild(document.createElement('span')); // a mutation in EVERY frame
      await flush();
      frame();
    }
    expect(frameQueue.length).toBe(0);
    expect(back.offsetOf(5)).toBe(0);
  });

  it('content arriving FAR AFTER the page looked aligned (a preview answering late) is still absorbed', () => {
    const back = leaveAndReturn();
    back.draw(20);
    restoreOnReturn(1, back.el);
    for (let i = 0; i < 50; i++) frame(); // however many frames pass, nothing ends it
    expect(back.offsetOf(5)).toBe(0);
    back.model.heights[3] = 300 + 11; // 11 px of preview lands above the anchor, late
    resizedAt(back.list);
    expect(back.offsetOf(5)).toBe(0);
    back.model.heights[1] = 300 + 8;
    resizedAt(back.list);
    expect(back.offsetOf(5)).toBe(0);
  });

  it('a FOREIGN scroll while following (find-in-page, a focus, a screen reader) drops it, no yank back', () => {
    const back = leaveAndReturn();
    back.draw(20);
    restoreOnReturn(1, back.el);
    back.el.scrollTop = 4000; // nobody the restore wrote
    back.el.dispatchEvent(new Event('scroll'));
    expect(live.every((o) => !o.active)).toBe(true);
    back.model.heights[0] = 700;
    resizedAt(back.list);
    expect(back.el.scrollTop).toBe(4000);
  });

  it('its own scroll event is not foreign', () => {
    const back = leaveAndReturn();
    back.draw(20);
    restoreOnReturn(1, back.el);
    back.el.dispatchEvent(new Event('scroll'));
    expect(live.some((o) => o.active)).toBe(true);
  });

  it('only the reader ends it: after a touch, a late change is not followed', () => {
    const back = leaveAndReturn();
    back.draw(20);
    restoreOnReturn(1, back.el);
    back.el.dispatchEvent(new Event('touchstart'));
    expect(live.every((o) => !o.active)).toBe(true);
    const where = back.el.scrollTop;
    back.model.heights[0] = 700;
    resizedAt(back.list);
    expect(back.el.scrollTop).toBe(where);
  });

  it('an anchor removed AFTER it was aligned ends the restore: no warning, no jump to the offset', async () => {
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
    const back = leaveAndReturn();
    back.draw(20);
    restoreOnReturn(1, back.el);
    const aligned = back.el.scrollTop;
    back.list.children[5].remove();
    await flush(); // the mutation reports it and starts the one frame loop
    frame();
    expect(live.every((o) => !o.active)).toBe(true);
    expect(back.el.scrollTop).toBe(aligned);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('an id with control characters and quotes is found without throwing', () => {
    const f = feed(Array(20).fill(300));
    f.draw(20);
    f.list.children[5].setAttribute(SCROLL_ANCHOR_ATTRIBUTE, 'a\u0001"bc]');
    f.el.scrollTop = 1500;
    rememberLeaving(1, 1500, f.el);
    const g = feed(Array(20).fill(300));
    g.draw(20);
    g.list.children[5].setAttribute(SCROLL_ANCHOR_ATTRIBUTE, 'a\u0001"bc]');
    expect(() => restoreOnReturn(1, g.el)).not.toThrow();
    expect(g.offsetOf(5)).toBe(0);
  });

  it('removes every listener it added, the capture-phase load ones and the reader inputs included', () => {
    const back = leaveAndReturn();
    back.draw(20);
    const added: string[] = [];
    const removed: string[] = [];
    const track = (t: EventTarget, name: string) => {
      const add = t.addEventListener.bind(t);
      const rem = t.removeEventListener.bind(t);
      t.addEventListener = ((type: string, fn: never, opts?: boolean | { capture?: boolean }) => {
        added.push(`${name}:${type}:${typeof opts === 'boolean' ? opts : !!opts?.capture}`);
        add(type, fn, opts);
      }) as typeof t.addEventListener;
      t.removeEventListener = ((
        type: string,
        fn: never,
        opts?: boolean | { capture?: boolean }
      ) => {
        removed.push(`${name}:${type}:${typeof opts === 'boolean' ? opts : !!opts?.capture}`);
        rem(type, fn, opts);
      }) as typeof t.removeEventListener;
    };
    track(back.el, 'box');
    track(document, 'document');
    restoreOnReturn(1, back.el);
    expect(added).toContain('box:load:true');
    expect(added).toContain('document:keydown:false');
    cancelRestore();
    expect(removed.sort()).toEqual(added.sort());
  });

  it('a key aimed at the DOCUMENT (focus on the body) ends it too', () => {
    const back = leaveAndReturn();
    back.draw(20);
    restoreOnReturn(1, back.el);
    document.dispatchEvent(new Event('keydown'));
    expect(live.every((o) => !o.active)).toBe(true);
  });
});
