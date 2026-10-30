// @vitest-environment happy-dom
import { isPinnedToBottom } from './threadAnchor';
import { observeThreadGrowth } from './threadGrowthObserver';

/**
 * THE OBSERVER DRIVEN THROUGH A KEYBOARD RISE ON A THREAD THAT GREW AFTER IT OPENED.
 *
 * happy-dom lays nothing out, so the scroller is a small layout model: rows stacked in document
 * order, `scrollTop` clamped to the reach like a browser does, and a `ResizeObserver` the test fires
 * by hand - the order a real frame delivers (box first, then the WebView's resize shrinking every
 * `svh` length) is the order measured on the Mi 9T, 2026-10-30.
 */

let fireResize: () => void = () => {};

class ManualResizeObserver {
  constructor(callback: () => void) {
    fireResize = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

interface Layout {
  rows: HTMLElement[];
  heights: number[];
  box: number;
  scrollTop: number;
}

/** A scroller whose metrics follow `layout`, with one `[id^="msg-"]` row per height. */
function makeThread(heights: number[], box: number) {
  const scroller = document.createElement('div');
  const layout: Layout = { rows: [], heights: [...heights], box, scrollTop: 0 };
  const topOf = (i: number) => layout.heights.slice(0, i).reduce((a, b) => a + b, 0);
  const scrollHeight = () => layout.heights.reduce((a, b) => a + b, 0);
  const reach = () => Math.max(0, scrollHeight() - layout.box);
  Object.defineProperties(scroller, {
    scrollHeight: { get: scrollHeight },
    clientHeight: { get: () => layout.box },
    scrollTop: {
      get: () => layout.scrollTop,
      set: (v: number) => {
        layout.scrollTop = Math.min(Math.max(0, v), reach());
      },
    },
  });
  scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  layout.heights.forEach((_, i) => {
    const row = document.createElement('div');
    row.id = `msg-${i}`;
    Object.defineProperty(row, 'offsetTop', { get: () => topOf(i) });
    row.getBoundingClientRect = () =>
      ({ bottom: topOf(i) + layout.heights[i] - layout.scrollTop }) as DOMRect;
    scroller.appendChild(row);
    layout.rows.push(row);
  });
  document.body.appendChild(scroller);
  /** Re-clamps after a change, as layout does, then delivers the observer callback. */
  const relayout = () => {
    layout.scrollTop = Math.min(layout.scrollTop, reach());
    fireResize();
  };
  return { scroller, layout, relayout, reach };
}

/** Text rows of 60 px, a photo of 567 px (60svh of a 945 px WebView) at index 10. */
const PHOTO = 10;
const KEYBOARD = 357;
const rowsWithPhoto = () => Array.from({ length: 40 }, (_, i) => (i === PHOTO ? 567 : 60));

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ManualResizeObserver);
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('observeThreadGrowth - a reader at the bottom', () => {
  it('stays at the bottom through late growth, the keyboard rise and the photo shrinking under it', () => {
    const { scroller, layout, relayout, reach } = makeThread(rowsWithPhoto(), 711);
    let nearBottom = true;
    scroller.scrollTop = reach();
    const stop = observeThreadGrowth(scroller, () => ({
      wasNearBottom: nearBottom,
      isLoadingOlder: false,
      isEntering: false,
    }));

    // Content grows AFTER the thread opened: a message's medium settles taller.
    layout.heights[18] += 240;
    relayout();
    expect(scroller.scrollTop).toBe(reach());
    nearBottom = isPinnedToBottom(scroller);

    // The keyboard's first frame: the pane's box loses the keyboard.
    layout.box -= KEYBOARD;
    relayout();
    expect(scroller.scrollTop).toBe(reach());
    nearBottom = isPinnedToBottom(scroller);

    // The WebView's own resize: every svh length shrinks, the photo by 0.6 x the keyboard.
    layout.heights[PHOTO] -= Math.round(0.6 * KEYBOARD);
    relayout();
    expect(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight).toBe(0);
    stop();
  });
});

describe('observeThreadGrowth - a reader in history', () => {
  it('keeps the row at the top of the viewport through the same changes', () => {
    const { scroller, layout, relayout } = makeThread(rowsWithPhoto(), 711);
    // The reader has gone up: the row after the photo is at the top of the viewport.
    const rowTop = (i: number) => layout.rows[i].getBoundingClientRect().bottom - layout.heights[i];
    scroller.scrollTop = layout.rows[PHOTO + 1].offsetTop;
    expect(isPinnedToBottom(scroller)).toBe(false);
    const stop = observeThreadGrowth(scroller, () => ({
      wasNearBottom: false,
      isLoadingOlder: false,
      isEntering: false,
    }));
    const before = rowTop(PHOTO + 1);

    layout.heights[18] += 240;
    relayout();
    layout.box -= KEYBOARD;
    relayout();
    layout.heights[PHOTO] -= Math.round(0.6 * KEYBOARD);
    relayout();

    expect(rowTop(PHOTO + 1)).toBe(before);
    stop();
  });
});
