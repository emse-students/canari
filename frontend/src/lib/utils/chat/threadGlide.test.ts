// @vitest-environment happy-dom
import { Log } from '$lib/utils/Log';
import {
  attachThreadRide,
  createThreadGlide,
  describeGlideFall,
  GLIDE_TRACE_MAX_LINES,
  glideTravel,
  observeThreadGrowth,
  pinThreadToEnd,
  takeThreadGlideOff,
} from './threadGrowthObserver';

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

function makeThread(heights: number[], box: number, padding = PADDING) {
  const scroller = document.createElement('div');
  const layout = { heights: [] as number[], box, scrollTop: 0 };
  const content = () => layout.heights.reduce((s, h) => s + h, 0) + padding;
  const layoutReach = () => Math.max(0, content() - layout.box);
  // What the browser reports: the layout plus what a transformed row adds past the padding.
  const scrollHeight = () => content() + Math.max(0, drawnOffset() - padding);
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
  // A row's place is read from where it stands NOW in the scroller, so a prepend moves every row.
  let made = 0;
  const addRow = (height: number, inner = '', at: 'end' | 'start' = 'end') => {
    const row = document.createElement('div');
    row.id = `msg-${made++}`;
    row.innerHTML = inner;
    const index = () => Array.prototype.indexOf.call(scroller.children, row) as number;
    Object.defineProperty(row, 'offsetTop', {
      get: () => layout.heights.slice(0, index()).reduce((s, h) => s + h, 0),
    });
    row.getBoundingClientRect = () =>
      ({ bottom: row.offsetTop + layout.heights[index()] - layout.scrollTop }) as DOMRect;
    (row as unknown as { animate: typeof fakeAnimate }).animate = fakeAnimate;
    if (at === 'start') {
      layout.heights.unshift(height);
      scroller.prepend(row);
    } else {
      layout.heights.push(height);
      scroller.appendChild(row);
    }
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

  it('a keyboard ride takes a glide in flight off for good: nothing resumes it', async () => {
    const { scroller, layout, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const stop = observeThreadGrowth(scroller, atBottom);
    expect(takeThreadGlideOff(scroller)).toBe(false); // nothing in flight yet
    addRow(70);
    await flush();
    now = 55;
    expect(takeThreadGlideOff(scroller)).toBe(true);
    expect(live()).toHaveLength(0);
    // The ride's layout change reaches the observer: it pins, and leaves the rows to the ride.
    layout.box -= 100;
    fireResize();
    expect(scroller.scrollTop).toBe(layoutReach());
    expect(live()).toHaveLength(0);
    stop();
    expect(takeThreadGlideOff(scroller)).toBe(false); // a thread no longer followed
  });

  /** A keyboard ride's animations on the rows, `progress` of the way through its eased curve. */
  function rideAt(progress: () => number | null) {
    const cancelled: boolean[] = [];
    const animation = {
      effect: { getComputedTiming: () => ({ progress: progress() }) },
      cancel: () => cancelled.push(true),
    } as unknown as Animation;
    return { animation, cancelled };
  }

  it('an arrival mid keyboard ride: the ride yields, the glide takes the rows from its offset (F8)', async () => {
    const { scroller, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const stop = observeThreadGrowth(scroller, atBottom);
    // A rise: the rows started 300 px below their place and are 60% of the way up - drawn 120 low.
    const ride = rideAt(() => 0.6);
    attachThreadRide(scroller, 300, [ride.animation]);
    addRow(70);
    await flush();
    expect(ride.cancelled).toEqual([true]);
    // The glide starts where the ride drew them, plus the new row: nothing jumps.
    expect(new Set(live().map((a) => a.px))).toEqual(new Set([190]));
    stop();
  });

  it('a fall mid ride: the glide starts ABOVE the rows when the ride drew them higher than the row (F8)', async () => {
    const { scroller, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const stop = observeThreadGrowth(scroller, atBottom);
    const ride = rideAt(() => 0.5); // started 300 px above, half way down: drawn 150 high
    attachThreadRide(scroller, -300, [ride.animation]);
    addRow(70);
    await flush();
    expect(new Set(live().map((a) => a.px))).toEqual(new Set([-80]));
    stop();
  });

  it('a change with no arrival leaves the ride alone; an ended ride is not taken on (F8)', async () => {
    const { scroller, layout, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const stop = observeThreadGrowth(scroller, atBottom);
    const ride = rideAt(() => 0.5);
    attachThreadRide(scroller, 300, [ride.animation]);
    layout.box -= 100;
    fireResize();
    expect(ride.cancelled).toEqual([]);
    expect(live()).toHaveLength(0);
    // The ride ended (no progress): the arrival glides its own row only.
    const ended = rideAt(() => null);
    attachThreadRide(scroller, 300, [ended.animation]);
    addRow(70);
    await flush();
    expect(new Set(live().map((a) => a.px))).toEqual(new Set([70]));
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

describe('observeThreadGrowth - a change above a reader at the end (owner, 1.8.0, 2026-11-25)', () => {
  it('the entry widen mounting older rows pins the end and plays no glide', async () => {
    // Ten 60 px rows per widen step, under a reader at the end of a 400 px pane: before the fix each
    // step glided 200 px of history across the screen, and the steps chained into one descent.
    const { scroller, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const stop = observeThreadGrowth(scroller, atBottom);
    for (let step = 0; step < 3; step++) {
      for (let i = 0; i < 10; i++) addRow(20, '', 'start');
      await flush();
      expect(scroller.scrollTop).toBe(layoutReach());
    }
    expect(animations).toHaveLength(0);
    stop();
  });

  it('an arrival after it still glides, by its own height only', async () => {
    const { scroller, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const stop = observeThreadGrowth(scroller, atBottom);
    addRow(20, '', 'start');
    addRow(70);
    await flush();
    expect(scroller.scrollTop).toBe(layoutReach());
    expect(new Set(live().map((a) => a.px))).toEqual(new Set([70]));
    stop();
  });

  it('a glide that ends tells the caller once; one replaced mid-way does not', async () => {
    const { scroller, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    let ends = 0;
    const stop = observeThreadGrowth(scroller, atBottom, null, undefined, () => ends++);
    addRow(70);
    await flush();
    const first = live();
    now = 100;
    addRow(70); // replaces the first glide: its rows are taken on by the second
    await flush();
    for (const a of first) for (const listener of a.finishListeners) listener();
    await flush();
    expect(ends).toBe(0);
    now = 100 + DURATION;
    for (const a of live()) for (const listener of a.finishListeners) listener();
    await flush();
    expect(ends).toBe(1);
    stop();
  });

  it('a glide the keyboard ride takes off is an end: told once, after the task', async () => {
    const { scroller, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    let ends = 0;
    const stop = observeThreadGrowth(scroller, atBottom, null, undefined, () => ends++);
    addRow(70);
    await flush();
    now = 50;
    expect(takeThreadGlideOff(scroller)).toBe(true);
    expect(ends).toBe(0); // not inside the ride's own task
    await flush();
    expect(ends).toBe(1);
    expect(takeThreadGlideOff(scroller)).toBe(false);
    await flush();
    expect(ends).toBe(1);
    stop();
  });

  it('a glide found past its end by a change is an end; a teardown tells nothing', async () => {
    const { scroller, layout, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    let ends = 0;
    const stop = observeThreadGrowth(scroller, atBottom, null, undefined, () => ends++);
    addRow(70);
    await flush();
    now = DURATION + 10; // past its end, `finish` not delivered yet
    layout.box -= 50;
    fireResize();
    await flush();
    expect(ends).toBe(1);

    addRow(70);
    await flush();
    stop(); // teardown mid-glide
    await flush();
    expect(ends).toBe(1);
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

/**
 * THE SILENT, BOUNDED TRACE OF `follow()` PASSES INSIDE A GLIDE (iPhone 12 image arrival, chat.md):
 * nothing is written at pass time; a fall inside a glide reads the buffered passes and scroll moves.
 */
describe('observeThreadGrowth - the trace of the passes inside a glide', () => {
  const traceLogs = (spies: ReturnType<typeof vi.spyOn>[]) =>
    spies.flatMap((s) => s.mock.calls.filter((call: unknown[]) => call[0] === 'threadGrowth'));
  const spyAll = () => [vi.spyOn(Log, 'i'), vi.spyOn(Log, 'w')];

  it('writes NOTHING at pass time, whatever the passes: arrival, second pass, end of the glide', async () => {
    const spies = spyAll();
    const { scroller, layout, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const stop = observeThreadGrowth(scroller, atBottom);
    expect(describeGlideFall(scroller)).toBeNull(); // no glide, no pass
    addRow(70);
    await flush();
    now = 55;
    layout.heights[layout.heights.length - 1] += 120;
    fireResize();
    now = 400;
    for (const a of live()) a.finishListeners.forEach((l) => l());
    expect(traceLogs(spies)).toHaveLength(0);
    expect(spies[0]).not.toHaveBeenCalled();
    expect(describeGlideFall(scroller)).toBeNull(); // the glide ended: no fall to blame on it
    stop();
    spies.forEach((s) => s.mockRestore());
  });

  it('a fall inside the glide gets the buffered passes, read at clean points, with the cached previous end', async () => {
    const { scroller, layout, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const stop = observeThreadGrowth(scroller, atBottom);
    addRow(70);
    await flush();
    now = 55;
    layout.heights[layout.heights.length - 1] += 120; // the image took its size
    fireResize();
    const lines = describeGlideFall(scroller) ?? [];
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      /^the fall came inside a glide of 70px, 55ms in; 2 follow pass\(es\), 0 write\(s\) outside follow and 0 scroll move\(s\)/
    );
    expect(lines[1]).toMatch(
      /^glide pass 1 \(rows, \+0ms\): top\/height\/box previous end none, suspended \d+\/\d+\/400, pinned \d+\/\d+\/400; held none;/
    );
    expect(lines[2]).toMatch(
      /^glide pass 2 \(box, \+55ms\): .*previous end 910\/1310\/400, suspended 910\/1430\/400, pinned 1030\/1430\/400; held 70px with 53px left; .*replay 70px at 55ms$/
    );
    stop();
  });

  it("a scroll move after the last pass (the async case) is buffered with its delta; the pin's own is not", async () => {
    const { scroller, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const stop = observeThreadGrowth(scroller, atBottom);
    addRow(70);
    await flush();
    now = 20;
    scroller.dispatchEvent(new Event('scroll')); // the pin's own event: top is where the pass left it
    now = 60;
    scroller.scrollTop = layoutReach() - 180;
    scroller.dispatchEvent(new Event('scroll'));
    const lines = describeGlideFall(scroller) ?? [];
    expect(lines[0]).toContain('1 follow pass(es), 0 write(s) outside follow and 1 scroll move(s)');
    expect(lines[lines.length - 1]).toMatch(/^glide scroll move \+60ms: top \d+ \(-180\)$/);
    // The listener is armed for the glide only: once it ends a scroll records nothing.
    now = 400;
    for (const a of live()) a.finishListeners.forEach((l) => l());
    await flush();
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    expect(describeGlideFall(scroller)).toBeNull();
    stop();
  });

  it('keeps the last passes in a ring of the cap, counts the dropped ones exactly, and a new glide starts over', async () => {
    const { scroller, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const stop = observeThreadGrowth(scroller, atBottom);
    addRow(70);
    await flush();
    const extra = GLIDE_TRACE_MAX_LINES + 4;
    for (let i = 0; i < extra; i++) {
      now = 10 + i;
      fireResize();
    }
    const lines = describeGlideFall(scroller) ?? [];
    expect(lines).toHaveLength(1 + GLIDE_TRACE_MAX_LINES);
    expect(lines[0]).toContain(`${extra + 1} follow pass(es) (5 older dropped)`);
    expect(lines[1]).toMatch(/^glide pass 6 /);

    now = 1000;
    for (const a of live()) a.finishListeners.forEach((l) => l());
    addRow(70);
    await flush();
    const again = describeGlideFall(scroller) ?? [];
    expect(again[0]).toContain('1 follow pass(es), 0 write(s) outside follow and 0 scroll move(s)');
    stop();
  });

  it('counts only the passes it recorded: a refused replay is not a pass', async () => {
    const { scroller, addRow, layoutReach } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const stop = observeThreadGrowth(scroller, atBottom);
    addRow(70);
    await flush();
    // The motion tokens stop resolving: the replay of the next pass is refused (play false).
    document.documentElement.style.removeProperty('--motion-thread-glide');
    now = 30;
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
    fireResize();
    warn.mockRestore();
    expect(describeGlideFall(scroller)).toBeNull(); // the glide was cancelled and not replayed
    stop();
  });

  it('a glide cancelled and not replayed is an end: the listener is disarmed and onGlideEnd fires once', async () => {
    const { scroller, addRow, layoutReach } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const ended = vi.fn();
    const stop = observeThreadGrowth(scroller, atBottom, null, undefined, ended);
    addRow(70);
    await flush();
    expect(ended).not.toHaveBeenCalled();
    document.documentElement.style.removeProperty('--motion-thread-glide');
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
    now = 30;
    fireResize(); // suspend cancels the glide, play is refused
    warn.mockRestore();
    expect(ended).toHaveBeenCalledTimes(1);
    // Disarmed: a scroll after the end records nothing, and there is no glide to blame anyway.
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    expect(describeGlideFall(scroller)).toBeNull();
    stop();
  });

  it('peek reads the running glide without touching it', async () => {
    const { scroller, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const glide = createThreadGlide(scroller);
    expect(glide.peek()).toBeNull();
    glide.play(80);
    now = 44;
    const before = live().length;
    expect(glide.peek()).toEqual({ px: 80, time: 44 });
    expect(glide.peek()).toEqual({ px: 80, time: 44 });
    expect(live()).toHaveLength(before);
    expect(animations.every((a) => !a.cancelled)).toBe(true);
    now = 300; // past its end with no finish delivered: nothing is drawn
    expect(glide.peek()).toBeNull();
    void addRow;
  });
});

/**
 * ONE WRITER AT THE END, AGAINST THE LAYOUT (iPhone 12, iOS 27, an image arriving at a pinned DM,
 * chat.md, 2026-11-25). The composer band is the scroller's `padding-bottom` (86 px on the phone), so
 * a row taller than it, gliding, inflates `scrollHeight` by `offset - padding`. The pane's own pin
 * (`ChatArea.scrollToBottom`, a tick after the observer's pass) read that inflation and wrote past the
 * end; the next pass's clamp then read as a fall. `pinThreadToEnd` is that pin, made as `follow()`
 * makes its own.
 */
describe('pinThreadToEnd - the pane pins the layout end, never the glide overflow', () => {
  const COMPOSER = 86;
  const IMAGE = 300;
  // A phone's pane: a 300 px row is a glide there (under half the pane).
  const PANE = 700;

  async function imageArriving() {
    const t = makeThread(Array(30).fill(60), PANE, COMPOSER);
    t.scroller.scrollTop = t.layoutReach();
    const placed: number[] = [];
    const ended = vi.fn();
    const stop = observeThreadGrowth(t.scroller, atBottom, null, (top) => placed.push(top), ended);
    t.addRow(IMAGE);
    await flush();
    return { ...t, placed, ended, stop };
  }

  it('an arrival plus the pane pin leaves scrollTop at the layout end, and nothing is placed past it', async () => {
    const { scroller, layout, layoutReach, placed, stop } = await imageArriving();
    expect(live().length).toBeGreaterThan(0);
    expect(live().every((a) => a.px === IMAGE)).toBe(true);
    // The fall's precondition, as on the phone: the glide inflates the overflow past the padding.
    now = 5;
    expect(scroller.scrollHeight - layout.box - layoutReach()).toBeCloseTo(
      IMAGE * (1 - 5 / DURATION) - COMPOSER
    );

    // The new-message effect's pin, a tick after the observer's pass, inside the glide.
    placed.push(pinThreadToEnd(scroller, 'new-message'));
    expect(scroller.scrollTop).toBe(layoutReach());

    // The image takes its size: the box pass finds the pane where it was put - no clamp, no fall.
    now = 50;
    fireResize();
    expect(scroller.scrollTop).toBe(layoutReach());
    expect(placed.length).toBeGreaterThan(1);
    for (const top of placed) expect(top).toBeLessThanOrEqual(layoutReach());
    stop();
  });

  it('a pin mid-glide replays the glide at the same time and distance', async () => {
    const { scroller, layoutReach, ended, stop } = await imageArriving();
    now = 55;
    const before = live().length;
    expect(pinThreadToEnd(scroller, 'new-message')).toBe(layoutReach());
    expect(live()).toHaveLength(before);
    expect(live().every((a) => a.px === IMAGE && a.currentTime === 55)).toBe(true);
    await flush();
    expect(ended).not.toHaveBeenCalled();
    stop();
  });

  it('a pin whose replay is refused is the glide end, told once', async () => {
    const { scroller, layoutReach, ended, stop } = await imageArriving();
    document.documentElement.style.removeProperty('--motion-thread-glide');
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
    now = 30;
    expect(pinThreadToEnd(scroller, 'new-message')).toBe(layoutReach());
    warn.mockRestore();
    await flush();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(live()).toHaveLength(0);
    stop();
  });

  it('the trace prints the pin between the passes it fell between, in time order', async () => {
    const { scroller, layout, stop } = await imageArriving();
    now = 20;
    pinThreadToEnd(scroller, 'new-message');
    now = 50;
    layout.heights[layout.heights.length - 1] += 10;
    fireResize();
    const lines = describeGlideFall(scroller) ?? [];
    expect(lines[0]).toContain('2 follow pass(es), 1 write(s) outside follow and 0 scroll move(s)');
    expect(lines[1]).toMatch(/^glide pass 1 \(rows, \+0ms\)/);
    expect(lines[2]).toMatch(
      /^glide write by new-message \(\+20ms\): top\/height\/box \d+\/\d+\/700$/
    );
    expect(lines[3]).toMatch(/^glide pass 2 \(box, \+50ms\)/);
    stop();
  });

  it('a thread no observer follows is written to its end, and the missing observer is accused', () => {
    const { scroller, layoutReach } = makeThread(Array(30).fill(60), PANE, COMPOSER);
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
    expect(pinThreadToEnd(scroller, 'new-message')).toBe(layoutReach());
    expect(warn).toHaveBeenCalledWith(
      'threadGrowth',
      'new-message pinned a pane no growth observer follows'
    );
    warn.mockRestore();
    expect(animations).toHaveLength(0);
  });

  it('prints the lines in recording order, though a second arrival restarts the glide clock', async () => {
    const { scroller, layoutReach, addRow } = makeThread(Array(20).fill(60), 400);
    scroller.scrollTop = layoutReach();
    const stop = observeThreadGrowth(scroller, atBottom);
    addRow(70);
    await flush();
    now = 55;
    pinThreadToEnd(scroller, 'new-message');
    now = 110;
    addRow(70); // the second arrival: a new glide, its clock back at 0
    await flush();
    now = 130;
    fireResize(); // 20 ms into the new glide
    now = 140;
    pinThreadToEnd(scroller, 'new-message');
    const lines = (describeGlideFall(scroller) ?? []).slice(1);
    expect(
      lines.map((l) => /^glide (pass \d+|write by \S+) \(?[a-z, ]*\+(\d+)ms/.exec(l)?.slice(1))
    ).toEqual([
      ['pass 1', '0'],
      ['write by new-message', '55'],
      ['pass 2', '110'],
      ['pass 3', '20'],
      ['write by new-message', '30'],
    ]);
    stop();
  });
});
