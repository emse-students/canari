// @vitest-environment happy-dom
import { createThreadGlide, glideTravel, observeThreadGrowth } from './threadGrowthObserver';

/**
 * THE THREAD'S GLIDE, AGAINST A LAYOUT THAT COUNTS IT IN ITS OVERFLOW (review of #3490, B1, S5, S6).
 *
 * Blink adds a transformed row to the scroller's scrollable overflow: measured in Chrome on
 * 2026-11-13, `scrollHeight` grows by `max(0, offset - padding-bottom)` while a child is translated
 * down by `offset` (keyboard-and-send-motion.md). The model below does the same, so a pin taken
 * during a glide lands past the real bottom unless the glide is taken off first - which is what the
 * observer must do. The animations are fakes driven by a test clock; their progress is linear, and
 * the observer reads it back from `getComputedTiming`, as it reads the eased one in a browser.
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

const DURATION = 220;
let now = 0;

interface FakeAnimation {
  px: number;
  start: number;
  seek: number;
  cancelled: boolean;
  finishListeners: (() => void)[];
  currentTime: number;
  effect: { getComputedTiming: () => { progress: number | null } };
  cancel: () => void;
  addEventListener: (type: string, listener: () => void) => void;
}
let animations: FakeAnimation[] = [];

function fakeAnimate(keyframes: Keyframe[], options: KeyframeAnimationOptions): FakeAnimation {
  const px = Number(/translateY\((-?[\d.]+)px\)/.exec(String(keyframes[0].transform))?.[1]);
  expect(options.duration).toBe(DURATION);
  expect(options.easing).toBe('cubic-bezier(0.42, 0, 0.58, 1)');
  const a: FakeAnimation = {
    px,
    start: now,
    seek: 0,
    cancelled: false,
    finishListeners: [],
    get currentTime() {
      return now - a.start + a.seek;
    },
    set currentTime(t: number) {
      a.seek = t - (now - a.start);
    },
    effect: {
      getComputedTiming: () => {
        const t = a.currentTime;
        return { progress: a.cancelled || t >= DURATION ? null : t / DURATION };
      },
    },
    cancel: () => {
      a.cancelled = true;
    },
    addEventListener: (type, listener) => {
      if (type === 'finish') a.finishListeners.push(listener);
    },
  } as FakeAnimation;
  animations.push(a);
  return a;
}

/** The offset the live glide draws the rows at (every row shares it). */
function drawnOffset(): number {
  const live = animations.filter((a) => !a.cancelled && a.currentTime < DURATION);
  if (live.length === 0) return 0;
  const a = live[live.length - 1];
  return a.px * (1 - a.currentTime / DURATION);
}

const PADDING = 40;

function makeThread(heights: number[], box: number) {
  const scroller = document.createElement('div');
  const layout = { heights: [] as number[], box, scrollTop: 0 };
  const content = () => layout.heights.reduce((s, h) => s + h, 0) + PADDING;
  const layoutReach = () => Math.max(0, content() - layout.box);
  // What the browser reports: the layout plus what a transformed row adds past the padding.
  const scrollHeight = () => content() + Math.max(0, drawnOffset() - PADDING);
  Object.defineProperties(scroller, {
    scrollHeight: { get: scrollHeight },
    clientHeight: { get: () => layout.box },
    scrollTop: {
      get: () => layout.scrollTop,
      set: (v: number) => {
        layout.scrollTop = Math.min(Math.max(0, v), scrollHeight() - layout.box);
      },
    },
  });
  scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  const addRow = (height: number, inner = '') => {
    const i = layout.heights.length;
    layout.heights.push(height);
    const row = document.createElement('div');
    row.id = `msg-${i}`;
    row.innerHTML = inner;
    Object.defineProperty(row, 'offsetTop', {
      get: () => layout.heights.slice(0, i).reduce((s, h) => s + h, 0),
    });
    row.getBoundingClientRect = () =>
      ({ bottom: row.offsetTop + layout.heights[i] - layout.scrollTop }) as DOMRect;
    (row as unknown as { animate: typeof fakeAnimate }).animate = fakeAnimate;
    scroller.appendChild(row);
    return row;
  };
  for (const h of heights) addRow(h);
  document.body.appendChild(scroller);
  return { scroller, layout, layoutReach, addRow };
}

/** Lets the MutationObserver deliver. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ManualResizeObserver);
  document.body.innerHTML = '';
  document.documentElement.style.setProperty('--motion-thread-glide', `${DURATION}ms`);
  document.documentElement.style.setProperty(
    '--motion-ease-in-out',
    'cubic-bezier(0.42, 0, 0.58, 1)'
  );
  animations = [];
  now = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const atBottom = () => ({ wasNearBottom: true, isLoadingOlder: false, isEntering: false });
const live = () => animations.filter((a) => !a.cancelled);

describe('observeThreadGrowth - the glide of an arrival', () => {
  it('a box change mid-glide pins to the LAYOUT bottom and resumes the glide on the same frame', async () => {
    const { scroller, layout, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const stop = observeThreadGrowth(scroller, atBottom);

    addRow(70);
    await flush();
    expect(scroller.scrollTop).toBe(layoutReach());
    expect(live().every((a) => a.px === 70)).toBe(true);
    expect(live()).toHaveLength(21);

    // A quarter in: the rows are drawn 52.5 px low, 12.5 px past the padding.
    now = 55;
    expect(scroller.scrollHeight).toBeGreaterThan(
      layout.heights.reduce((s, h) => s + h, 0) + PADDING
    );
    layout.box -= 100;
    fireResize();

    // Pinned to where the rows really end - not 12.5 px further, which rose them too far.
    expect(scroller.scrollTop).toBe(layoutReach());
    // The glide is back, from the same point of its curve.
    expect(live().every((a) => a.px === 70 && a.currentTime === 55)).toBe(true);
    stop();
  });

  it('a second arrival mid-glide starts from where the rows are drawn, plus its own row (S5)', async () => {
    const { scroller, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const stop = observeThreadGrowth(scroller, atBottom);
    addRow(70);
    await flush();
    now = 110; // half way: 35 px left
    addRow(70);
    await flush();
    expect(scroller.scrollTop).toBe(layoutReach());
    expect(new Set(live().map((a) => a.px))).toEqual(new Set([105]));
    expect(live().every((a) => a.currentTime === 0)).toBe(true);
    stop();
  });

  it('a finished glide is gone: a later change does not replay it', async () => {
    const { scroller, layout, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const stop = observeThreadGrowth(scroller, atBottom);
    addRow(70);
    await flush();
    now = DURATION;
    for (const a of live()) for (const listener of a.finishListeners) listener();
    const count = animations.length;
    layout.box -= 100;
    fireResize();
    expect(animations.length).toBe(count);
    expect(scroller.scrollTop).toBe(layoutReach());
    stop();
  });
});

describe('observeThreadGrowth - the bubble waits only for a glide that played (S6)', () => {
  const bubble = '<div class="motion-bubble-in">hi</div>';

  it('marks the arriving bubble when the thread glides for it', async () => {
    const { scroller, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const stop = observeThreadGrowth(scroller, atBottom);
    const row = addRow(70, bubble);
    await flush();
    expect(row.querySelector('.motion-bubble-in')?.hasAttribute('data-glide-entrance')).toBe(true);
    stop();
  });

  it('leaves it a plain fade for a batch, and for a reader scrolled up', async () => {
    const { scroller, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const stop = observeThreadGrowth(scroller, atBottom);
    const batch = addRow(300, bubble); // more than half the pane: a jump
    await flush();
    expect(batch.querySelector('[data-glide-entrance]')).toBeNull();
    stop();

    const reading = makeThread(Array(20).fill(60), 400);
    reading.scroller.scrollTop = 0;
    const stopReading = observeThreadGrowth(reading.scroller, () => ({
      ...atBottom(),
      wasNearBottom: false,
    }));
    const below = reading.addRow(70, bubble);
    await flush();
    expect(below.querySelector('[data-glide-entrance]')).toBeNull();
    stopReading();
  });
});

describe('createThreadGlide', () => {
  it('suspend reports what was left to draw and cancels every row; play seeks', () => {
    const { scroller } = makeThread(Array(3).fill(60), 400);
    const glide = createThreadGlide(scroller);
    expect(glide.suspend()).toBeNull();
    expect(glide.play(80)).toBe(true);
    now = 165;
    const held = glide.suspend();
    expect(held).toEqual({ px: 80, remaining: 20, time: 165 });
    expect(animations.every((a) => a.cancelled)).toBe(true);
    expect(glide.play(held!.px, held!.time)).toBe(true);
    expect(live().every((a) => a.currentTime === 165)).toBe(true);
    glide.stop();
    expect(live()).toHaveLength(0);
  });

  it('plays nothing when the motion tokens do not resolve', () => {
    document.documentElement.style.removeProperty('--motion-thread-glide');
    const { scroller } = makeThread(Array(3).fill(60), 400);
    expect(createThreadGlide(scroller).play(80)).toBe(false);
    expect(animations).toHaveLength(0);
  });

  it('a new arrival glides from the held offset plus its own row', () => {
    expect(glideTravel(null, 70)).toBe(70);
    expect(glideTravel({ px: 70, remaining: 35, time: 110 }, 70)).toBe(105);
  });
});
