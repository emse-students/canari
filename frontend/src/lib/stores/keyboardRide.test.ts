// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureKeyboardRide,
  KEYBOARD_RIDE_EVENT,
  parseKeyboardFall,
  restsAtBottom,
  rideDistancePx,
  rideKeyframes,
  startKeyboardRide,
  UIKIT_KEYBOARD_CURVE_EASING,
  uikitCurveEasing,
} from './keyboardRide';

describe('keyboardRide - what the iOS shell may send', () => {
  it('takes the keyboard animation parameters as they come from UIKit', () => {
    expect(parseKeyboardFall({ durationMs: 250, curve: 7 })).toEqual({ durationMs: 250, curve: 7 });
  });

  it('refuses anything else, so the shell just resizes', () => {
    for (const bad of [
      null,
      250,
      { durationMs: 0, curve: 7 },
      { durationMs: -1, curve: 7 },
      { durationMs: Number.NaN, curve: 7 },
      { durationMs: 250, curve: 7.5 },
      { durationMs: '250', curve: 7 },
      { durationMs: 250 },
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

describe('keyboardRide - the geometry', () => {
  it('rides the distance the anchor moved down, and nothing for a rounding', () => {
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

  it('only a scroll container resting on its last row rides', () => {
    expect(restsAtBottom(1457, 543, 2000)).toBe(true);
    expect(restsAtBottom(1455.5, 543, 2000)).toBe(true);
    expect(restsAtBottom(1200, 543, 2000)).toBe(false);
  });
});

describe('keyboardRide - capture before the resize, ride after it', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function place(el: HTMLElement, top: number) {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ top } as DOMRect);
  }

  function scroller(scrollTop: number) {
    const el = document.createElement('div');
    el.dataset.keyboardRide = 'when-at-bottom';
    Object.defineProperty(el, 'scrollTop', { value: scrollTop });
    Object.defineProperty(el, 'clientHeight', { value: 543 });
    Object.defineProperty(el, 'scrollHeight', { value: 2000 });
    return el;
  }

  it('rides the composer and a thread at its bottom over the keyboard timing, and says when it lands', async () => {
    const anchor = document.createElement('div');
    anchor.dataset.keyboardRide = 'anchor';
    const atBottom = scroller(1457);
    const scrolledUp = scroller(300);
    document.body.append(anchor, atBottom, scrolledUp);
    const animate = vi.fn(() => ({ finished: Promise.resolve() }));
    for (const el of [anchor, atBottom, scrolledUp])
      (el as unknown as { animate: typeof animate }).animate = animate;

    place(anchor, 508);
    const capture = captureKeyboardRide(document, { durationMs: 250, curve: 7 }, 'ease-out');
    expect(capture?.riders).toEqual([anchor, atBottom]);

    vi.restoreAllMocks();
    place(anchor, 787);
    const heard = vi.fn();
    window.addEventListener(KEYBOARD_RIDE_EVENT, heard, { once: true });
    expect(startKeyboardRide(capture!)).toBe(279);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate).toHaveBeenCalledWith(rideKeyframes(279), { duration: 250, easing: 'ease-out' });
    expect(heard).toHaveBeenCalledTimes(1);
    await expect(
      (heard.mock.calls[0][0] as CustomEvent<{ finished: Promise<unknown> }>).detail.finished
    ).resolves.toBeDefined();
  });

  it('a screen with no composer captures nothing', () => {
    document.body.append(scroller(1457));
    expect(captureKeyboardRide(document, { durationMs: 250, curve: 7 }, 'ease-out')).toBeNull();
  });

  it('an anchor that did not move rides nothing', () => {
    const anchor = document.createElement('div');
    anchor.dataset.keyboardRide = 'anchor';
    document.body.append(anchor);
    const animate = vi.fn();
    (anchor as unknown as { animate: typeof animate }).animate = animate;
    place(anchor, 508);
    const capture = captureKeyboardRide(document, { durationMs: 250, curve: 7 }, 'ease-out');
    expect(startKeyboardRide(capture!)).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });
});
