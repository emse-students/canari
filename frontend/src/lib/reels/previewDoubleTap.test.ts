// @vitest-environment happy-dom
/**
 * A double tap on the camera preview flips the lens (user, 2026-10-22), also while another finger
 * HOLDS the shutter - which is how a take is filmed, and why the taps are read from the pointers and
 * not from `click`s (no engine synthesises a click for a second finger's tap).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPreviewTapTracker, previewDoubleTap } from './previewDoubleTap';
import { GESTURE } from '$lib/utils/viewerGestures';

describe('createPreviewTapTracker', () => {
  const at = (x: number, y: number, t: number) => ({ x, y, t });

  it('two quick taps close together are a double tap', () => {
    const taps = createPreviewTapTracker();
    taps.down(1, at(100, 100, 0));
    expect(taps.up(1, at(100, 100, 80))).toBe(false);
    taps.down(1, at(110, 105, 200));
    expect(taps.up(1, at(110, 105, 260))).toBe(true);
  });

  it('a third quick tap starts a new sequence, never a second flip', () => {
    const taps = createPreviewTapTracker();
    taps.down(1, at(0, 0, 0));
    taps.up(1, at(0, 0, 50));
    taps.down(1, at(0, 0, 100));
    expect(taps.up(1, at(0, 0, 150))).toBe(true);
    taps.down(1, at(0, 0, 200));
    expect(taps.up(1, at(0, 0, 250))).toBe(false);
  });

  it('taps too far apart in time or space are two single taps', () => {
    const taps = createPreviewTapTracker();
    taps.down(1, at(0, 0, 0));
    taps.up(1, at(0, 0, 50));
    taps.down(1, at(0, 0, 50 + GESTURE.DOUBLE_TAP_MS + 1));
    expect(taps.up(1, at(0, 0, 60 + GESTURE.DOUBLE_TAP_MS + 1))).toBe(false);

    const far = createPreviewTapTracker();
    far.down(1, at(0, 0, 0));
    far.up(1, at(0, 0, 50));
    far.down(1, at(GESTURE.DOUBLE_TAP_SLOP_PX + 1, 0, 100));
    expect(far.up(1, at(GESTURE.DOUBLE_TAP_SLOP_PX + 1, 0, 150))).toBe(false);
  });

  it('a long press or a slide is not a tap, and ends the sequence', () => {
    const taps = createPreviewTapTracker();
    taps.down(1, at(0, 0, 0));
    taps.up(1, at(0, 0, 50));
    taps.down(1, at(0, 0, 100));
    expect(taps.up(1, at(GESTURE.TAP_SLOP_PX, 0, 150))).toBe(false);
    taps.down(1, at(0, 0, 200));
    expect(taps.up(1, at(0, 0, 200 + GESTURE.TAP_MAX_MS + 1))).toBe(false);
  });

  it('a cancelled press is forgotten', () => {
    const taps = createPreviewTapTracker();
    taps.down(1, at(0, 0, 0));
    taps.cancel(1);
    expect(taps.up(1, at(0, 0, 50))).toBe(false);
  });
});

describe('previewDoubleTap', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function surface() {
    document.body.innerHTML = `
      <section id="s">
        <video id="v"></video>
        <button id="b">switch</button>
        <div data-no-double-tap><button id="shutter">shutter</button></div>
      </section>`;
    const node = document.getElementById('s')!;
    const onDoubleTap = vi.fn();
    const action = previewDoubleTap(node, { onDoubleTap });
    const press = (id: string, type: string, pointerId: number, t: number) => {
      const event = new PointerEvent(type, { pointerId, bubbles: true, clientX: 50, clientY: 50 });
      Object.defineProperty(event, 'timeStamp', { value: t });
      document.getElementById(id)!.dispatchEvent(event);
    };
    const tapOn = (id: string, pointerId: number, t: number) => {
      press(id, 'pointerdown', pointerId, t);
      press(id, 'pointerup', pointerId, t + 40);
    };
    return { onDoubleTap, action, press, tapOn };
  }

  it('a double tap on the preview reports once, and a single tap reports nothing', () => {
    const { onDoubleTap, tapOn } = surface();
    tapOn('v', 1, 0);
    expect(onDoubleTap).not.toHaveBeenCalled();
    tapOn('v', 1, 120);
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
  });

  it('works with a finger HELD on the shutter row - the double tap of a take', () => {
    const { onDoubleTap, press, tapOn } = surface();
    press('shutter', 'pointerdown', 7, 0);
    tapOn('v', 8, 100);
    tapOn('v', 9, 220);
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    press('shutter', 'pointerup', 7, 400);
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
  });

  it('taps on a control or on the shutter row never count', () => {
    const { onDoubleTap, tapOn } = surface();
    tapOn('b', 1, 0);
    tapOn('b', 1, 100);
    tapOn('shutter', 1, 200);
    tapOn('shutter', 1, 300);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it('off, it counts nothing', () => {
    const { onDoubleTap, action, tapOn } = surface();
    action.update({ onDoubleTap, enabled: false });
    tapOn('v', 1, 0);
    tapOn('v', 1, 100);
    expect(onDoubleTap).not.toHaveBeenCalled();
    action.destroy();
  });
});
