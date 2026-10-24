// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTapDisambiguator, tapBelongsToInnerControl } from './tapDisambiguator';
import { GESTURE } from './viewerGestures';

describe('createTapDisambiguator', () => {
  let singles = 0;
  let doubles = 0;
  const make = () =>
    createTapDisambiguator({ onSingle: () => (singles += 1), onDouble: () => (doubles += 1) });

  beforeEach(() => {
    vi.useFakeTimers();
    singles = 0;
    doubles = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('confirms a single tap only once the window has passed', () => {
    const taps = make();
    taps.tap({ x: 0, y: 0, t: 0 });
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS - 1);
    expect(singles).toBe(0);
    vi.advanceTimersByTime(1);
    expect([singles, doubles]).toEqual([1, 0]);
  });

  it('a second tap inside the window is one double and no single', () => {
    const taps = make();
    taps.tap({ x: 0, y: 0, t: 0 });
    taps.tap({ x: 5, y: 5, t: 100 });
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 4);
    expect([singles, doubles]).toEqual([0, 1]);
  });

  it('a second tap too far away REPLACES the pending one: one single, for the newer tap', () => {
    const seen: number[] = [];
    const taps = createTapDisambiguator({
      onSingle: (t) => seen.push(t.x),
      onDouble: () => (doubles += 1),
    });
    taps.tap({ x: 0, y: 0, t: 0 });
    const far = GESTURE.DOUBLE_TAP_SLOP_PX * 3;
    taps.tap({ x: far, y: 0, t: 100 });
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 4);
    expect([seen, doubles]).toEqual([[far], 0]);
  });

  it('without quietAfterDouble, a third quick tap starts a fresh sequence (the viewer)', () => {
    const taps = make();
    taps.tap({ x: 0, y: 0, t: 0 });
    taps.tap({ x: 0, y: 0, t: 100 });
    taps.tap({ x: 0, y: 0, t: 200 });
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 4);
    expect([singles, doubles]).toEqual([1, 1]);
  });

  it('with quietAfterDouble, a third quick tap is swallowed by the double it follows', () => {
    const taps = createTapDisambiguator(
      { onSingle: () => (singles += 1), onDouble: () => (doubles += 1) },
      { quietAfterDouble: true }
    );
    taps.tap({ x: 0, y: 0, t: 0 });
    taps.tap({ x: 0, y: 0, t: 100 });
    taps.tap({ x: 0, y: 0, t: 200 });
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 4);
    expect([singles, doubles]).toEqual([0, 1]);
    // Past that window, a tap is a new sequence again.
    taps.tap({ x: 0, y: 0, t: 100 + GESTURE.DOUBLE_TAP_MS + 1 });
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS);
    expect([singles, doubles]).toEqual([1, 1]);
  });

  it('cancel drops a pending single tap', () => {
    const taps = make();
    taps.tap({ x: 0, y: 0, t: 0 });
    expect(taps.pending()).toBe(true);
    taps.cancel();
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 4);
    expect([singles, doubles, taps.pending()]).toEqual([0, 0, false]);
  });
});

describe('tapBelongsToInnerControl', () => {
  it('names a link or a button inside the surface, never the surface itself', () => {
    const surface = document.createElement('div');
    surface.setAttribute('role', 'button');
    surface.innerHTML = '<p><span id="t">x</span><a id="a" href="#"><b id="b">y</b></a></p>';
    document.body.appendChild(surface);
    expect(tapBelongsToInnerControl(surface.querySelector('#t'), surface)).toBe(false);
    expect(tapBelongsToInnerControl(surface.querySelector('#b'), surface)).toBe(true);
    expect(tapBelongsToInnerControl(surface, surface)).toBe(false);
    expect(tapBelongsToInnerControl(null, surface)).toBe(false);
    surface.remove();
  });
});
