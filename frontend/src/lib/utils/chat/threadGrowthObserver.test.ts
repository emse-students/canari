// @vitest-environment happy-dom
import { isPinnedToBottom, stickToBottomAfterScroll } from './threadAnchor';
import { motionMs, observeThreadGrowth } from './threadGrowthObserver';

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
  // A row's place is read from where it stands NOW, so a prepend moves every row below it.
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
  const makeRow = (id: string) => {
    const row = document.createElement('div');
    row.id = `msg-${id}`;
    const index = () => layout.rows.indexOf(row);
    Object.defineProperty(row, 'offsetTop', { get: () => topOf(index()) });
    row.getBoundingClientRect = () =>
      ({ bottom: topOf(index()) + layout.heights[index()] - layout.scrollTop }) as DOMRect;
    return row;
  };
  layout.heights.forEach((_, i) => {
    const row = makeRow(String(i));
    scroller.appendChild(row);
    layout.rows.push(row);
  });
  document.body.appendChild(scroller);
  /** Re-clamps after a change, as layout does, then delivers the observer callback. */
  const relayout = () => {
    layout.scrollTop = Math.min(layout.scrollTop, reach());
    fireResize();
  };
  /** Older rows land ABOVE the first one, as a store page does; `scrollTop` is left where it was. */
  const prepend = (older: number[]) => {
    const rows = older.map((_, i) => makeRow(`old-${layout.rows.length}-${i}`));
    layout.rows.unshift(...rows);
    layout.heights.unshift(...older);
    scroller.prepend(...rows);
  };
  return { scroller, layout, relayout, reach, prepend };
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

/**
 * THE PHOTO DM THAT LANDS ON OLDER MESSAGES (chat.md, "the flag is only ever the reader's", 2026-11-21).
 *
 * The stick-to-bottom flag is written by a scroll measurement that runs in an animation callback,
 * BEFORE the frame's `ResizeObserver` entries. A thread that SHRINKS in one frame (photos under a
 * shorter `svh` ceiling: the browser clamps `scrollTop`, the observer pins it) and GROWS BACK in the
 * next is measured in the second frame as: a `scrollTop` lower than the last measurement, and
 * further than the slack from the bottom - which `stickToBottomAfterScroll` reads as the reader
 * going UP. The flag fell, every later change was `keep-row`, and the reader stayed
 * 429-643 px above the newest rows with the scroll-down arrow up (reproduced in Chrome, 2026-11-21).
 * The pane's own placements (`onPlaced`) are the baseline the measurement compares against.
 */
describe('observeThreadGrowth - a thread that shrinks then grows back under a reader at the bottom', () => {
  const PHOTOS = [36, 37, 38];
  const heights = () => Array.from({ length: 40 }, (_, i) => (PHOTOS.includes(i) ? 567 : 60));

  /** One run; `baselineFromPlacements` is the fix (the old baseline is the last measurement). */
  function replay(baselineFromPlacements: boolean) {
    const { scroller, layout, relayout, reach } = makeThread(heights(), 945);
    scroller.scrollTop = reach();
    let nearBottom = true;
    let lastMeasured: number | null = scroller.scrollTop;
    const measure = () => {
      nearBottom = stickToBottomAfterScroll({
        pinned: isPinnedToBottom(scroller),
        scrollTop: scroller.scrollTop,
        wasNearBottom: nearBottom,
        previousScrollTop: lastMeasured,
      });
      lastMeasured = scroller.scrollTop;
    };
    const stop = observeThreadGrowth(
      scroller,
      () => ({ wasNearBottom: nearBottom, isLoadingOlder: false, isEntering: false }),
      null,
      baselineFromPlacements ? (top) => (lastMeasured = top) : undefined
    );
    // Frame A: the box loses the keyboard and every photo its ceiling (60svh of a shorter viewport).
    layout.box -= KEYBOARD;
    for (const i of PHOTOS) layout.heights[i] -= Math.round(0.6 * KEYBOARD);
    relayout();
    // Frame B: the ceiling is restored (the held viewport height). The scroll measurement of the
    // pin made in A runs HERE, after B's layout and before B's observers.
    for (const i of PHOTOS) layout.heights[i] += Math.round(0.6 * KEYBOARD);
    layout.scrollTop = Math.min(layout.scrollTop, reach());
    measure();
    relayout();
    stop();
    return {
      nearBottom,
      distance: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    };
  }

  it('keeps the flag and ends at the bottom', () => {
    expect(replay(true)).toEqual({ nearBottom: true, distance: 0 });
  });

  it('the last measurement as a baseline reads the thread own move as the reader leaving', () => {
    const run = replay(false);
    expect(run.nearBottom).toBe(false);
    expect(run.distance).toBeGreaterThan(0);
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

describe('observeThreadGrowth - a conversation being entered', () => {
  /**
   * THE NOTIFICATION-TAP OPEN (owner's Android 1.6.8 reading, 2026-11-09). The entry pins to the
   * bottom, then - before the conversation is settled - the push previews are upgraded in place
   * (same count, taller reply bubbles) and the early-drawn rows above the fresh page are withdrawn.
   * Every one of those changes must leave the newest row in view; while `entering` held, the
   * observer answered `keep-row` and the anchor compensated nothing, so the growth was simply
   * dropped and the new rows sat below the fold.
   */
  it('keeps the newest row in view through same-count upgrades and a withdrawal at the top', () => {
    const heights = Array.from({ length: 40 }, () => 60);
    const { scroller, layout, relayout, reach } = makeThread(heights, 711);
    scroller.scrollTop = reach();
    // `isNearBottom` as a scroll measured during the hidden entry may leave it: the entry owns
    // the position, and its position is the bottom whatever the flag says.
    const stop = observeThreadGrowth(scroller, () => ({
      wasNearBottom: false,
      isLoadingOlder: false,
      isEntering: true,
    }));
    const newestVisible = () => {
      const newest = layout.rows.at(-1)!;
      return newest.getBoundingClientRect().bottom <= scroller.clientHeight;
    };

    // Two previews become reply bubbles: the count does not move, the rows grow.
    layout.heights[38] += 90;
    relayout();
    layout.heights[39] += 90;
    relayout();
    expect(scroller.scrollTop).toBe(reach());
    expect(newestVisible()).toBe(true);

    // `[HISTORY] 3 early-drawn row(s) below the fresh page withdrawn`: the oldest rows go.
    for (const i of [0, 1, 2]) {
      layout.heights[i] = 0;
      layout.rows[i].remove();
    }
    relayout();
    expect(scroller.scrollTop).toBe(reach());
    expect(isPinnedToBottom(scroller)).toBe(true);
    expect(newestVisible()).toBe(true);
    stop();
  });
});

/**
 * AN OLDER PAGE LANDING WHILE THE PANE CHANGED UNDER IT (the photo DM of 2026-11-14,
 * docs/wiki/frontend/modules/chat.md, the flag is only ever the reader's).
 * `loadOlderGroups` used to restore `scrollTop` itself, from offsets captured BEFORE awaiting the
 * store: a keyboard rising meanwhile (and the thread taken to its end for it) was undone by that
 * write, and the reader landed one keyboard height up, on older messages. The observer's row anchor
 * is what keeps the reader's place across a prepend - the window-step prepend never had any other -
 * so the store's page is left to it too.
 */
describe('observeThreadGrowth - an older page prepended', () => {
  const loading = () => ({ wasNearBottom: true, isLoadingOlder: true, isEntering: false });

  it('keeps the reader on the rows they were reading', () => {
    const { scroller, layout, prepend } = makeThread(rowsWithPhoto(), 711);
    scroller.scrollTop = 300;
    const stop = observeThreadGrowth(scroller, loading);
    const reading = layout.rows[8];
    const before = reading.getBoundingClientRect().bottom;
    prepend([60, 60, 60, 60, 60]);
    // The prepend is a DOM mutation: the observer runs from its MutationObserver, in a microtask.
    return Promise.resolve().then(() => {
      expect(reading.getBoundingClientRect().bottom).toBe(before);
      stop();
    });
  });

  it('a keyboard rise during the load: the reader at the end follows it, and stays there', async () => {
    const { scroller, layout, relayout, reach, prepend } = makeThread(rowsWithPhoto(), 711);
    scroller.scrollTop = reach();
    const stop = observeThreadGrowth(scroller, loading);
    // The keyboard rises while the store is read: the box alone moved, and the reader follows it.
    layout.box -= KEYBOARD;
    relayout();
    expect(scroller.scrollTop).toBe(reach());
    prepend([60, 60, 60, 60, 60]);
    await Promise.resolve();
    expect(scroller.scrollTop).toBe(reach());
    stop();
  });

  it('a keyboard rise landing in the same change as the prepend: the reader at the end stays there', async () => {
    const { scroller, layout, relayout, reach, prepend } = makeThread(rowsWithPhoto(), 711);
    scroller.scrollTop = reach();
    const stop = observeThreadGrowth(scroller, loading);
    layout.box -= KEYBOARD;
    prepend([60, 60, 60, 60, 60]);
    // One delivery for both: the mutation's microtask runs after the box has already changed.
    await Promise.resolve();
    relayout();
    expect(scroller.scrollTop).toBe(reach());
    stop();
  });
});

describe('motionMs', () => {
  it('reads the authored millisecond form', () => {
    expect(motionMs('220ms')).toBe(220);
    expect(motionMs(' 220ms ')).toBe(220);
  });

  it('reads the second form Chromium normalises the token to, leading dot included', () => {
    expect(motionMs('.22s')).toBe(220);
    expect(motionMs('0.22s')).toBe(220);
    expect(motionMs('1s')).toBe(1000);
    expect(motionMs('1.5s')).toBe(1500);
  });

  it('refuses what is not a time', () => {
    expect(motionMs('')).toBeNull();
    expect(motionMs('220')).toBeNull();
    expect(motionMs('fast')).toBeNull();
  });
});
