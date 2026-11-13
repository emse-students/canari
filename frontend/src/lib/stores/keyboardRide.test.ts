// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureKeyboardRide,
  fallRefusal,
  followKeyboardRides,
  KEYBOARD_RIDE_EVENT,
  parseKeyboardFall,
  rideDistancePx,
  rideKeyframes,
  startKeyboardRide,
  UIKIT_KEYBOARD_CURVE_EASING,
  uikitCurveEasing,
} from './keyboardRide';

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
  it('a piece rides the distance IT moved down, and nothing for a rounding', () => {
    expect(rideDistancePx(508, 787)).toBe(279);
    expect(rideDistancePx(508, 508.6)).toBeNull();
    expect(rideDistancePx(508, 400)).toBeNull();
  });

  it('starts translated back up by the distance and ends with no transform left', () => {
    expect(rideKeyframes(279)).toEqual([
      { transform: 'translateY(-279px)' },
      { transform: 'none' },
    ]);
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
    vi.spyOn(el, 'getBoundingClientRect').mockImplementation(() => ({ top: current }) as DOMRect);
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
