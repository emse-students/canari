// @vitest-environment happy-dom
/**
 * THE REEL OVERLAY'S SINGLE TAP (`reelOverlayTap`, owner 2026-11-18): a single tap on the picture
 * hides or shows the overlay; a control's tap, a hold, a drag, a double tap and a keyboard
 * activation never do. Times are the events' `timeStamp`s from the faked clock, never a wall clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reelOverlayTap } from './reelOverlayTap';
import { DOUBLE_TAP_LIKES } from './doubleTapLike';
import { HOLD_TO_PAUSE_MS } from './videoGestures';
import { GESTURE } from '$lib/utils/viewerGestures';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function surface(likes = false) {
  document.body.innerHTML = `
    <div id="slide">
      <video id="picture"></video>
      <button id="heart" type="button">like</button>
      <a id="author" href="/u">author</a>
      <div data-video-controls><span id="line">line</span></div>
      <div data-no-double-tap><span id="region">region</span></div>
    </div>`;
  const node = document.getElementById('slide')!;
  if (likes) node.setAttribute(DOUBLE_TAP_LIKES, '');
  const onToggle = vi.fn();
  const action = reelOverlayTap(node, { onToggle });
  const el = (id: string) => document.getElementById(id)!;
  return { node, onToggle, action, el };
}

const pointer = (type: string, init: PointerEventInit = {}) =>
  new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...init });

/** A press and release of `heldMs`, then the click the engine makes of it. */
function tap(target: Element, heldMs = 0, detail = 1, at = { x: 100, y: 100 }) {
  target.dispatchEvent(pointer('pointerdown', { clientX: at.x, clientY: at.y }));
  vi.advanceTimersByTime(heldMs);
  target.dispatchEvent(pointer('pointerup', { clientX: at.x, clientY: at.y }));
  target.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: at.x,
      clientY: at.y,
      detail,
    })
  );
}

describe('reelOverlayTap', () => {
  it('a single tap on the picture toggles at once where nothing likes', () => {
    const { onToggle, el } = surface();
    tap(el('picture'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('where a double tap likes the single tap waits the window, and a pair toggles NOTHING', () => {
    const { onToggle, el } = surface(true);
    tap(el('picture'));
    expect(onToggle, 'a second tap could still make it a like').not.toHaveBeenCalled();
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS);
    expect(onToggle).toHaveBeenCalledTimes(1);

    tap(el('picture'));
    vi.advanceTimersByTime(40);
    tap(el('picture'));
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 2);
    expect(onToggle, 'the like is not an overlay toggle').toHaveBeenCalledTimes(1);
  });

  it('never fires for a control: a button, a link, the player line, a no-tap region', () => {
    const { onToggle, el } = surface();
    for (const id of ['heart', 'author', 'line', 'region']) tap(el(id));
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 2);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('a click with no pointer behind it (a key, a screen reader) is no tap', () => {
    const { onToggle, el } = surface();
    el('picture').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('the click of a press HELD to pause is no tap - the hold is the only pause', () => {
    const { onToggle, el } = surface();
    tap(el('picture'), HOLD_TO_PAUSE_MS);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('a press that travelled (a swipe, a drag) is no tap, and the next real tap still counts', () => {
    const { onToggle, el } = surface();
    const picture = el('picture');
    picture.dispatchEvent(pointer('pointerdown', { clientX: 100, clientY: 100 }));
    picture.dispatchEvent(pointer('pointermove', { clientX: 100, clientY: 220 }));
    picture.dispatchEvent(pointer('pointerup', { clientX: 100, clientY: 220 }));
    picture.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(onToggle).not.toHaveBeenCalled();
    tap(picture);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('a swipe with no click leaves nothing behind: the next tap is a plain tap', () => {
    const { onToggle, el } = surface();
    const picture = el('picture');
    picture.dispatchEvent(pointer('pointerdown', { clientX: 100, clientY: 100 }));
    picture.dispatchEvent(pointer('pointermove', { clientX: 100, clientY: 300 }));
    picture.dispatchEvent(pointer('pointercancel'));
    tap(picture);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('a press that LOST its release (pointercancel, lostpointercapture) is no tap and leaves nothing stuck', () => {
    const { onToggle, el } = surface();
    const picture = el('picture');
    for (const lost of ['pointercancel', 'lostpointercapture']) {
      picture.dispatchEvent(pointer('pointerdown', { pointerId: 7 }));
      picture.dispatchEvent(pointer(lost, { pointerId: 7 }));
      picture.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      expect(onToggle, lost).not.toHaveBeenCalled();
    }
    tap(picture);
    expect(onToggle, 'the next real tap still counts').toHaveBeenCalledTimes(1);
  });

  it('a stale press whose release never came is replaced by the next PRIMARY press', () => {
    const { onToggle, el } = surface();
    const picture = el('picture');
    picture.dispatchEvent(pointer('pointerdown', { pointerId: 3, isPrimary: true }));
    // No pointerup, no cancel: the target left the DOM. A new touch has a new id.
    picture.dispatchEvent(pointer('pointerdown', { pointerId: 4, isPrimary: true, clientX: 90 }));
    picture.dispatchEvent(pointer('pointerup', { pointerId: 4, isPrimary: true, clientX: 90 }));
    picture.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 90 }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('does not toggle when the player acts on the tap itself', () => {
    const { action, onToggle, el } = surface();
    const consumed = vi.fn(() => true);
    action.update({ onToggle, tapConsumed: consumed });
    tap(el('picture'));
    expect(consumed).toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('a second finger spoils the press (a pinch)', () => {
    const { onToggle, el } = surface();
    const picture = el('picture');
    picture.dispatchEvent(pointer('pointerdown', { pointerId: 1 }));
    picture.dispatchEvent(pointer('pointerdown', { pointerId: 2 }));
    picture.dispatchEvent(pointer('pointerup', { pointerId: 1 }));
    picture.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('is inert while disabled, and a pending single tap is dropped', () => {
    const { onToggle, el, action } = surface(true);
    tap(el('picture'));
    action.update({ onToggle, enabled: false });
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 2);
    tap(el('picture'));
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 2);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
