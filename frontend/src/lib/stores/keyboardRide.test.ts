// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureKeyboardRide,
  fallRefusal,
  followKeyboardRides,
  KEYBOARD_RIDE_EVENT,
  linearEasing,
  parseKeyboardFall,
  releaseThreadGlides,
  rideDistancePx,
  ridePhaseMs,
  rideKeyframes,
  startKeyboardRide,
  UIKIT_KEYBOARD_CURVE_EASING,
  uikitCurveEasing,
} from './keyboardRide';

const glide = vi.hoisted(() => ({
  takeOff: vi.fn((_scroller: Element) => false),
  attachRide: vi.fn((_scroller: Element, _fromPx: number, _animations: Animation[]) => {}),
}));
vi.mock('$lib/utils/chat/threadGrowthObserver', () => ({
  takeThreadGlideOff: glide.takeOff,
  attachThreadRide: glide.attachRide,
}));

describe('keyboardRide - what the iOS shell may send', () => {
  it('takes the keyboard animation parameters as they come from UIKit', () => {
    expect(parseKeyboardFall({ durationMs: 250, curve: 7, fromPx: 301 })).toEqual({
      durationMs: 250,
      curve: 7,
      fromPx: 301,
    });
    expect(parseKeyboardFall({ durationMs: 0, curve: 7, fromPx: 301 })?.durationMs).toBe(0);
  });

  it('refuses anything else, so the shell just resizes', () => {
    for (const bad of [
      null,
      250,
      { durationMs: -1, curve: 7, fromPx: 301 },
      { durationMs: Number.NaN, curve: 7, fromPx: 301 },
      { durationMs: 250, curve: 7.5, fromPx: 301 },
      { durationMs: '250', curve: 7, fromPx: 301 },
      { durationMs: 250, curve: 7 },
      { durationMs: 250, curve: 7, fromPx: -3 },
    ])
      expect(parseKeyboardFall(bad)).toBeNull();
  });

  it("maps UIKit's curves, the keyboard's 7 to its one named easing, and nothing else", () => {
    expect(uikitCurveEasing(0)).toBe('ease-in-out');
    expect(uikitCurveEasing(1)).toBe('ease-in');
    expect(uikitCurveEasing(2)).toBe('ease-out');
    expect(uikitCurveEasing(3)).toBe('linear');
    expect(uikitCurveEasing(7)).toBe(UIKIT_KEYBOARD_CURVE_EASING);
    expect(uikitCurveEasing(4)).toBeNull();
  });
});

describe('keyboardRide - which falls are ridden, and which refusals are worth a WARN', () => {
  const ok = { easing: 'ease-out', reducedMotion: false, isOpen: true, openThresholdPx: 100 };
  const spec = { durationMs: 250, curve: 7, fromPx: 301 };

  it('rides an ordinary fall', () => {
    expect(fallRefusal(spec, ok)).toBeNull();
  });

  it('is silent for ordinary use: an instant fall, a hardware shortcut bar, reduced motion', () => {
    expect(fallRefusal({ ...spec, durationMs: 0 }, ok)?.level).toBe('silent');
    expect(fallRefusal({ ...spec, fromPx: 55 }, { ...ok, isOpen: false })?.level).toBe('silent');
    expect(fallRefusal(spec, { ...ok, reducedMotion: true })?.level).toBe('silent');
  });

  it('warns for a broken contract: an unknown curve, a page already full height', () => {
    expect(fallRefusal(spec, { ...ok, easing: null })?.level).toBe('warn');
    expect(fallRefusal(spec, { ...ok, isOpen: false })?.level).toBe('warn');
  });
});

describe('keyboardRide - the geometry', () => {
  it('a piece rides the distance IT moved, signed, and nothing for a rounding', () => {
    expect(rideDistancePx(508, 787)).toBe(279); // down: a fall
    expect(rideDistancePx(787, 508)).toBe(-279); // up: an Android rise
    expect(rideDistancePx(508, 508.6)).toBeNull();
    expect(rideDistancePx(508, 507.4)).toBeNull();
  });

  it('starts translated back by the distance, either way, and ends with no transform left', () => {
    expect(rideKeyframes(279)).toEqual([
      { transform: 'translateY(-279px)' },
      { transform: 'none' },
    ]);
    expect(rideKeyframes(-279)).toEqual([
      { transform: 'translateY(279px)' },
      { transform: 'none' },
    ]);
  });
});

describe('keyboardRide - the easing built from the numbers the Android shell sends', () => {
  it('is a CSS linear() of the points, rounded to four decimals', () => {
    expect(linearEasing([0, 0.123456, 1])).toBe('linear(0, 0.1235, 1)');
    expect(linearEasing([0, 1.0625, 1])).toBe('linear(0, 1.0625, 1)'); // an overshoot is kept
  });

  it('takes 2 to 64 points, all finite, and nothing else', () => {
    expect(linearEasing([0, 1])).toBe('linear(0, 1)');
    expect(linearEasing(Array(64).fill(1))).not.toBeNull();
    for (const bad of [
      [0],
      Array(65).fill(1),
      [0, Number.NaN],
      [0, Number.POSITIVE_INFINITY],
      [0, '1'],
      'linear(0, 1)',
      null,
      undefined,
    ]) {
      expect(linearEasing(bad)).toBeNull();
    }
  });
});

describe('keyboardRide - capture before the resize, each piece rides its own move', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  /** A box whose top `moveTo` can change between the capture and the ride. */
  function at(el: HTMLElement, top: number) {
    let current = top;
    vi.spyOn(el, 'getBoundingClientRect').mockImplementation(
      () => ({ top: current, bottom: current }) as DOMRect
    );
    return (next: number) => (current = next);
  }

  function rider(kind: 'box' | 'last-row') {
    const el = document.createElement('div');
    el.dataset.keyboardRide = kind;
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() }));
    (el as unknown as { animate: typeof animate }).animate = animate;
    document.body.append(el);
    return { el, animate };
  }

  function thread() {
    const t = rider('last-row');
    const row = document.createElement('div');
    t.el.append(document.createElement('div'), row);
    return { ...t, row };
  }

  it('the composer rides its move; a thread shorter than its box does not move and does not ride', () => {
    const composer = rider('box');
    const short = thread();
    const moveComposer = at(composer.el, 508);
    at(short.row, 120); // content stacked at the top: the bottom pin has nothing to scroll
    const capture = captureKeyboardRide(document, 250, 'ease-out')!;
    moveComposer(787);
    const ride = startKeyboardRide(capture);
    expect(ride?.distances).toEqual([279]);
    expect(composer.animate).toHaveBeenCalledWith(rideKeyframes(279), {
      duration: 250,
      easing: 'ease-out',
    });
    expect(short.animate).not.toHaveBeenCalled();
  });

  it('a thread overflowing by less than the keyboard rides only its overflow', () => {
    const composer = rider('box');
    const t = thread();
    const moveComposer = at(composer.el, 508);
    const moveRow = at(t.row, 470);
    const capture = captureKeyboardRide(document, 250, 'ease-out')!;
    moveComposer(787);
    moveRow(470 + 90); // overflowed by 90: the pin scrolled it down by 90, not by 279
    const ride = startKeyboardRide(capture);
    expect(ride?.distances).toEqual([279, 90]);
    expect(t.animate).toHaveBeenCalledWith(rideKeyframes(90), {
      duration: 250,
      easing: 'ease-out',
    });
  });

  it('a thread at its bottom with a long past rides the whole move, and the ride is announced', async () => {
    const composer = rider('box');
    const t = thread();
    const moveComposer = at(composer.el, 508);
    const moveRow = at(t.row, 470);
    const capture = captureKeyboardRide(document, 250, 'ease-out')!;
    moveComposer(787);
    moveRow(749);
    const heard = vi.fn();
    window.addEventListener(KEYBOARD_RIDE_EVENT, heard, { once: true });
    expect(startKeyboardRide(capture)?.distances).toEqual([279, 279]);
    expect(heard).toHaveBeenCalledTimes(1);
    await expect(
      (heard.mock.calls[0][0] as CustomEvent<{ finished: Promise<unknown> }>).detail.finished
    ).resolves.toBeDefined();
  });

  it('an Android ride moves a thread by its ROWS, never its box, and the composer by its box', () => {
    const composer = rider('box');
    const t = thread();
    const moveComposer = at(composer.el, 787);
    const moveRow = at(t.row, 749);
    const childAnimates = Array.from(t.el.children).map((child) => {
      const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() }));
      (child as unknown as { animate: typeof animate }).animate = animate;
      return animate;
    });
    const capture = captureKeyboardRide(document, 285, 'linear(0, 1)', 'rows')!;
    moveComposer(508); // the rise: both moved UP by the keyboard
    moveRow(470);
    expect(startKeyboardRide(capture)?.distances).toEqual([-279, -279]);
    const timing = { duration: 285, easing: 'linear(0, 1)' };
    expect(composer.animate).toHaveBeenCalledWith(rideKeyframes(-279), timing);
    expect(t.animate).not.toHaveBeenCalled();
    for (const animate of childAnimates) {
      expect(animate).toHaveBeenCalledWith(rideKeyframes(-279), timing);
    }
  });

  it('capture only reads; the glide in flight is taken off AFTER, and for a thread riding its rows only', () => {
    const t = thread();
    const order: string[] = [];
    vi.spyOn(t.row, 'getBoundingClientRect').mockImplementation(() => {
      order.push('read');
      return { top: 470, bottom: 470 } as DOMRect;
    });
    glide.takeOff.mockImplementation(() => {
      order.push('take-off');
      return true;
    });
    const rows = captureKeyboardRide(document, 285, 'linear(0, 1)', 'rows')!;
    expect(glide.takeOff).not.toHaveBeenCalled();
    releaseThreadGlides(rows);
    expect(glide.takeOff).toHaveBeenCalledWith(t.el);
    expect(order).toEqual(['read', 'take-off']);
    glide.takeOff.mockClear();
    releaseThreadGlides(captureKeyboardRide(document, 250, 'ease-out')!);
    expect(glide.takeOff).not.toHaveBeenCalled();
    glide.takeOff.mockReset();
    glide.takeOff.mockImplementation(() => false);
  });

  it('reads every probe before the first animation starts (D3)', () => {
    const order: string[] = [];
    const a = rider('box');
    const b = rider('box');
    let top = 500;
    for (const r of [a, b]) {
      vi.spyOn(r.el, 'getBoundingClientRect').mockImplementation(() => {
        order.push('read');
        return { top, bottom: top } as DOMRect;
      });
      r.animate.mockImplementation(() => {
        order.push('animate');
        return { finished: Promise.resolve(), cancel: vi.fn() };
      });
    }
    const capture = captureKeyboardRide(document, 285, 'linear(0, 1)')!;
    order.length = 0;
    top = 200;
    startKeyboardRide(capture);
    expect(order).toEqual(['read', 'read', 'animate', 'animate']);
  });

  it("an Android ride starts at the keyboard's phase: its first frame is as far in as the keyboard (D1)", () => {
    const composer = rider('box');
    const move = at(composer.el, 787);
    // The announcement arrived at t = 1000; the layout reactions let the ride start at t = 1068.
    const capture = captureKeyboardRide(document, 285, 'linear(0, 1)', 'rows', 1000)!;
    move(429);
    const ride = startKeyboardRide(capture, () => 1068)!;
    expect(ride.phaseMs).toBe(68);
    expect(composer.animate).toHaveBeenCalledWith(rideKeyframes(-358), {
      duration: 285,
      easing: 'linear(0, 1)',
    });
    // Its start IS the keyboard's: whichever frame first draws it draws the keyboard's phase there.
    // A delay of -68 measured now would draw 68 ms in on the NEXT frame, a frame behind the keys.
    expect(composer.animate.mock.results[0].value.startTime).toBe(1000);
  });

  it('a ride that could only start after the keyboard landed does not animate: the piece just stands', () => {
    const composer = rider('box');
    const move = at(composer.el, 787);
    const capture = captureKeyboardRide(document, 285, 'linear(0, 1)', 'rows', 1000)!;
    move(429);
    expect(startKeyboardRide(capture, () => 1285)).toBeNull();
    expect(composer.animate).not.toHaveBeenCalled();
    expect(ridePhaseMs(capture, 1284)).toBe(284);
    // A clock read before the arrival (never in a browser) is the start, never a negative phase.
    expect(ridePhaseMs(capture, 990)).toBe(0);
  });

  it('the iOS fall has no arrival time: it starts at 0, whatever the clock says', () => {
    const composer = rider('box');
    const move = at(composer.el, 508);
    const capture = captureKeyboardRide(document, 250, 'ease-out')!;
    move(787);
    expect(startKeyboardRide(capture, () => 1e9)?.phaseMs).toBe(0);
    expect(composer.animate).toHaveBeenCalledWith(rideKeyframes(279), {
      duration: 250,
      easing: 'ease-out',
    });
    // Left pending: it starts with the frame that first draws it.
    expect(composer.animate.mock.results[0].value.startTime).toBeUndefined();
  });

  it('a box that shrinks as it rises rides by its BOTTOM: on the keys from the first frame (the comments drawer)', () => {
    // Mi 9T: the drawer is 60dvh (567 px) at rest; with the 358 px keyboard its max-height caps it at
    // ~510. Before: 378..945. After the layout: 77..587.
    const drawer = rider('box');
    let rect = { top: 378, bottom: 945 };
    vi.spyOn(drawer.el, 'getBoundingClientRect').mockImplementation(() => rect as DOMRect);
    const capture = captureKeyboardRide(document, 285, 'linear(0, 1)', 'rows', 1000)!;
    rect = { top: 77, bottom: 587 };
    startKeyboardRide(capture, () => 1000);
    // First frame: translated back by 358, its bottom at 587 + 358 = 945 - where the keys' top is at
    // phase 0. By its top it rode 301 and its bottom stood 57 px above the keys, the scrim under it.
    expect(drawer.animate).toHaveBeenCalledWith(rideKeyframes(-358), expect.anything());
  });

  it('a box that keeps its height rides the same distance by either edge (the composer band)', () => {
    const band = rider('box');
    let rect = { top: 880, bottom: 945 };
    vi.spyOn(band.el, 'getBoundingClientRect').mockImplementation(() => rect as DOMRect);
    const capture = captureKeyboardRide(document, 285, 'linear(0, 1)')!;
    rect = { top: 522, bottom: 587 };
    expect(startKeyboardRide(capture)?.distances).toEqual([522 - 880]);
  });

  it('a thread riding its rows registers the ride with its observer, from its starting offset (F8)', () => {
    const t = thread();
    for (const child of t.el.children) {
      (child as unknown as { animate: () => unknown }).animate = () => ({
        finished: Promise.resolve(),
        cancel: vi.fn(),
      });
    }
    const moveRow = at(t.row, 749);
    const capture = captureKeyboardRide(document, 285, 'linear(0, 1)', 'rows')!;
    moveRow(391);
    startKeyboardRide(capture);
    expect(glide.attachRide).toHaveBeenCalledTimes(1);
    const [scroller, fromPx, animations] = glide.attachRide.mock.calls[0];
    expect(scroller).toBe(t.el);
    expect(fromPx).toBe(358); // drawn 358 below its new place at the start of the rise
    expect(animations).toHaveLength(t.el.children.length);
    glide.attachRide.mockClear();
  });

  it('a screen with no riding piece captures nothing; nothing moved rides nothing', () => {
    expect(captureKeyboardRide(document, 250, 'ease-out')).toBeNull();
    const composer = rider('box');
    at(composer.el, 508);
    const capture = captureKeyboardRide(document, 250, 'ease-out')!;
    expect(startKeyboardRide(capture)).toBeNull();
    expect(composer.animate).not.toHaveBeenCalled();
  });
});

describe('keyboardRide - following rides frame by frame', () => {
  function frames() {
    const queue: Array<() => void> = [];
    return {
      raf: (cb: () => void) => queue.push(cb),
      step: () => queue.splice(0).forEach((cb) => cb()),
      pending: () => queue.length,
    };
  }

  it('re-reads on every frame until the ride settles, then once more, then stops', async () => {
    const f = frames();
    const onFrame = vi.fn();
    const follow = followKeyboardRides(onFrame, f.raf);
    let land!: () => void;
    follow.onRide(new Promise<void>((r) => (land = r)));
    f.step();
    f.step();
    expect(onFrame).toHaveBeenCalledTimes(2);
    land();
    await Promise.resolve();
    await Promise.resolve();
    expect(onFrame).toHaveBeenCalledTimes(3);
    f.step();
    expect(onFrame).toHaveBeenCalledTimes(3);
    expect(f.pending()).toBe(0);
  });

  it('a second ride started during the first keeps the loop running to ITS end', async () => {
    const f = frames();
    const onFrame = vi.fn();
    const follow = followKeyboardRides(onFrame, f.raf);
    let landFirst!: () => void;
    let landSecond!: () => void;
    follow.onRide(new Promise<void>((r) => (landFirst = r)));
    f.step();
    follow.onRide(new Promise<void>((r) => (landSecond = r)));
    landFirst();
    await Promise.resolve();
    await Promise.resolve();
    const afterFirst = onFrame.mock.calls.length;
    f.step();
    expect(onFrame.mock.calls.length).toBe(afterFirst + 1);
    landSecond();
    await Promise.resolve();
    await Promise.resolve();
    f.step();
    expect(f.pending()).toBe(0);
  });

  it('a ride started while an ended loop still has a frame queued runs ONE loop, not two', async () => {
    const f = frames();
    const onFrame = vi.fn();
    const follow = followKeyboardRides(onFrame, f.raf);
    follow.onRide(new Promise(() => {}));
    follow.stop();
    follow.onRide(new Promise(() => {}));
    expect(f.pending()).toBe(1);
    f.step();
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(f.pending()).toBe(1);

    const g = frames();
    const onFrame2 = vi.fn();
    const follow2 = followKeyboardRides(onFrame2, g.raf);
    let land!: () => void;
    follow2.onRide(new Promise<void>((r) => (land = r)));
    land();
    await Promise.resolve();
    await Promise.resolve();
    follow2.onRide(new Promise(() => {}));
    expect(g.pending()).toBe(1);
  });

  it('stop() ends the loop and ignores a later settle', async () => {
    const f = frames();
    const onFrame = vi.fn();
    const follow = followKeyboardRides(onFrame, f.raf);
    let land!: () => void;
    follow.onRide(new Promise<void>((r) => (land = r)));
    follow.stop();
    f.step();
    land();
    await Promise.resolve();
    await Promise.resolve();
    expect(onFrame).not.toHaveBeenCalled();
  });
});
