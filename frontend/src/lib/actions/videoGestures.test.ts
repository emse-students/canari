// @vitest-environment happy-dom
/**
 * TAP, HOLD AND DOUBLE TAP ON A VIDEO - one gesture map for every surface (owner, 2026-11-09).
 *
 * Pinned, with the pointer-event sequence and fake timers (never a wall clock):
 * - a click is a tap (the sound); a press held past the hold length pauses, its release resumes,
 *   and the click a held press may produce is not a tap;
 * - a press that travels, or a second finger, ends the hold - a swipe or a pinch is never a pause;
 * - where a double tap likes, two quick taps are one double tap and NO sound toggle, and a lone tap
 *   acts once the window has passed; where it does not, the tap acts at once;
 * - the player's controls and keyboard activations are never this gesture's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_TO_PAUSE_MS, videoGestures, type VideoGestureParams } from './videoGestures';
import { GESTURE } from '$lib/utils/viewerGestures';

let node: HTMLElement;
let control: HTMLButtonElement;
let destroy: () => void;
let update: (p: VideoGestureParams) => void;
const onTap = vi.fn();
const onHoldStart = vi.fn();
const onHoldEnd = vi.fn();
const onDoubleTap = vi.fn();

function wire(extra: Partial<VideoGestureParams> = {}) {
  const action = videoGestures(node, { onTap, onHoldStart, onHoldEnd, onDoubleTap, ...extra });
  destroy = action.destroy;
  update = action.update;
}

beforeEach(() => {
  vi.useFakeTimers();
  node = document.createElement('div');
  control = document.createElement('button');
  control.setAttribute('data-video-controls', '');
  node.appendChild(control);
  document.body.appendChild(node);
});

afterEach(() => {
  destroy?.();
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

function pointer(type: string, init: PointerEventInit = {}, target: Element = node) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      clientX: 100,
      clientY: 100,
      ...init,
    })
  );
}

/** A click as the engine makes one after a pointer press: `detail` 1. */
function click(target: Element = node, x = 100, timeStamp?: number) {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: x });
  if (timeStamp !== undefined) Object.defineProperty(e, 'timeStamp', { value: timeStamp });
  target.dispatchEvent(e);
}

/** A quick press and its click. */
function tap(x = 100, timeStamp?: number) {
  pointer('pointerdown', { clientX: x });
  pointer('pointerup', { clientX: x });
  click(node, x, timeStamp);
}

describe('where no double tap means anything', () => {
  beforeEach(() => wire());

  it('a tap acts at once', () => {
    tap();
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onHoldStart).not.toHaveBeenCalled();
  });

  it('a press held past the hold length pauses, the release resumes, and its click is no tap', () => {
    pointer('pointerdown');
    vi.advanceTimersByTime(HOLD_TO_PAUSE_MS - 1);
    expect(onHoldStart, 'one millisecond short of a hold is still a press').not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onHoldStart).toHaveBeenCalledTimes(1);
    pointer('pointerup');
    expect(onHoldEnd).toHaveBeenCalledTimes(1);
    click();
    expect(onTap, 'the click a mouse makes after a hold').not.toHaveBeenCalled();
  });

  it('a hold whose click never comes (an Android long press) does not eat the next tap', () => {
    pointer('pointerdown');
    vi.advanceTimersByTime(HOLD_TO_PAUSE_MS);
    pointer('pointerup');
    tap();
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('a press that travels past the slop is a swipe: no hold, and a hold under way resumes', () => {
    pointer('pointerdown');
    pointer('pointermove', { clientX: 100 + GESTURE.TAP_SLOP_PX + 1 });
    vi.advanceTimersByTime(HOLD_TO_PAUSE_MS * 2);
    expect(onHoldStart).not.toHaveBeenCalled();

    pointer('pointerup');
    pointer('pointerdown');
    vi.advanceTimersByTime(HOLD_TO_PAUSE_MS);
    expect(onHoldStart).toHaveBeenCalledTimes(1);
    pointer('pointermove', { clientY: 100 + GESTURE.TAP_SLOP_PX + 1 });
    expect(onHoldEnd).toHaveBeenCalledTimes(1);
  });

  it('a second finger ends the hold (a pinch), and the engine taking the press does too', () => {
    pointer('pointerdown');
    vi.advanceTimersByTime(HOLD_TO_PAUSE_MS);
    pointer('pointerdown', { pointerId: 2 });
    expect(onHoldEnd).toHaveBeenCalledTimes(1);

    pointer('pointerdown', { pointerId: 3 });
    vi.advanceTimersByTime(HOLD_TO_PAUSE_MS);
    pointer('pointercancel', { pointerId: 3 });
    expect(onHoldEnd).toHaveBeenCalledTimes(2);
  });

  it("the player's controls and a keyboard activation are never its taps or holds", () => {
    pointer('pointerdown', {}, control);
    vi.advanceTimersByTime(HOLD_TO_PAUSE_MS);
    expect(onHoldStart).not.toHaveBeenCalled();
    click(control);
    expect(onTap).not.toHaveBeenCalled();

    node.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(onTap).not.toHaveBeenCalled();
  });

  it("keeps the phone's long-press menu off the picture", () => {
    const e = new Event('contextmenu', { bubbles: true, cancelable: true });
    node.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('turned off, the picture is inert; destroyed mid-hold, it resumes nothing', () => {
    update({ onTap, onHoldStart, onHoldEnd, enabled: false });
    tap();
    expect(onTap).not.toHaveBeenCalled();

    update({ onTap, onHoldStart, onHoldEnd });
    pointer('pointerdown');
    vi.advanceTimersByTime(HOLD_TO_PAUSE_MS);
    destroy();
    expect(onHoldEnd).not.toHaveBeenCalled();
  });
});

describe('where a double tap likes', () => {
  beforeEach(() => wire({ waitForDouble: true }));

  it('two quick taps are one double tap and leave the sound alone', () => {
    tap(100, 1000);
    tap(105, 1000 + GESTURE.DOUBLE_TAP_MS - 50);
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 2);
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    expect(onTap).not.toHaveBeenCalled();
  });

  it('reads the surface around when the caller does not say (a liking `doubleTapLike`)', () => {
    destroy();
    const surface = document.createElement('div');
    surface.setAttribute('data-double-tap-likes', '');
    surface.appendChild(node);
    document.body.appendChild(surface);
    wire();
    tap(100, 1000);
    tap(100, 1100);
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 2);
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    expect(onTap).not.toHaveBeenCalled();

    surface.removeAttribute('data-double-tap-likes');
    tap();
    expect(onTap, 'a surface whose like is off: at once').toHaveBeenCalledTimes(1);
  });

  it('a lone tap acts once the double-tap window has passed, and not before', () => {
    tap(100, 1000);
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS - 1);
    expect(onTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });
});
