// @vitest-environment happy-dom
/**
 * THE DOUBLE TAP THAT LIKES A POST (`doubleTapLike`, user 2026-10-19), driven with the events an
 * engine sends: the taps are `click`s (what the engine already called a tap), the drags and second
 * fingers are pointer events. A tap's time is its event's `timeStamp`, stamped from the faked
 * `performance` clock when the event is CREATED, so "too late" is a count of milliseconds and never a
 * wall clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doubleTapLike, type DoubleTapLikeParams } from './doubleTapLike';
import { GESTURE } from '$lib/utils/viewerGestures';
import { Log } from '$lib/utils/Log';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

/** A surface with post text, a link, a poll option, a held media opener and a no-tap region. */
function surface(params: Partial<DoubleTapLikeParams> = {}) {
  document.body.innerHTML = `
    <div id="card">
      <p id="text">Some post text</p>
      <a id="link" href="/elsewhere">a link</a>
      <button id="option" type="button">Option A</button>
      <button id="photo" type="button" data-double-tap-defers><img id="img" alt="" /></button>
      <div data-no-double-tap><span id="bar">action bar</span>
        <button id="comment-photo" type="button" data-double-tap-defers><img id="comment-img" alt="" /></button>
      </div>
      <a id="preview" href="/posts/other"><span id="preview-title">A shared post</span>
        <button id="preview-photo" type="button" data-double-tap-defers><img id="preview-img" alt="" /></button>
      </a>
    </div>`;
  // A link's default would navigate happy-dom away; the tests only read who took the click.
  document.getElementById('preview')!.addEventListener('click', (e) => e.preventDefault());
  const node = document.getElementById('card')!;
  const at = vi.fn();
  const action = doubleTapLike(node, { onDoubleTap: at, ...params });
  const el = (id: string) => document.getElementById(id)!;
  return { node, at, action, el };
}

/** A click as a tap produces it: a pointer behind it (`detail` 1+), at a point, stamped NOW. */
function click(x = 100, y = 100, detail = 1): MouseEvent {
  return new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    detail,
  });
}

/** A tap handled the instant it happens. */
function tap(target: Element, x = 100, y = 100, detail = 1): MouseEvent {
  const e = click(x, y, detail);
  target.dispatchEvent(e);
  return e;
}

/** happy-dom may not implement `PointerEvent`; a mouse event carrying `pointerId` is equivalent. */
function pointer(type: string, target: Element, x: number, y: number, pointerId = 1) {
  const Ctor = (globalThis as Record<string, unknown>).PointerEvent as
    | typeof PointerEvent
    | undefined;
  const e = Ctor
    ? new Ctor(type, {
        bubbles: true,
        clientX: x,
        clientY: y,
        pointerId,
        isPrimary: pointerId === 1,
      })
    : new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  if (!Ctor) Object.defineProperty(e, 'pointerId', { value: pointerId });
  target.dispatchEvent(e);
}

describe('doubleTapLike', () => {
  it('two taps inside the window and the slop are ONE double tap, reported where the second landed', () => {
    const { at, el, node } = surface();
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      top: 20,
    } as DOMRect);
    tap(el('text'), 100, 100);
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS - 50);
    tap(el('text'), 105, 104);
    expect(at).toHaveBeenCalledTimes(1);
    expect(at).toHaveBeenCalledWith({ x: 95, y: 84 });
  });

  it('a second tap QUEUED behind a slow first one is still a double: the gap is when they happened', () => {
    const { at, el } = surface();
    const first = click();
    vi.advanceTimersByTime(100);
    // The finger lands again 100 ms later, while the first click is still being handled: its event
    // is stamped now and waits in the queue.
    const second = click();
    // The first click's work - a render on a busy phone - takes 300 ms. The clock moves; the
    // window's timer has not had its turn, because the queued input is dispatched first.
    const slow = () => {
      const after = performance.now() + 300;
      vi.spyOn(performance, 'now').mockReturnValue(after);
    };
    el('text').addEventListener('click', slow, { once: true });
    el('text').dispatchEvent(first);
    el('text').dispatchEvent(second);
    vi.restoreAllMocks();
    // Handled 400 ms apart, tapped 100 ms apart: one double tap.
    expect(at).toHaveBeenCalledTimes(1);
  });

  it('a second tap too late is a new first tap, not a double', () => {
    const { at, el } = surface();
    tap(el('text'));
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS + 1);
    tap(el('text'));
    expect(at).not.toHaveBeenCalled();
  });

  it('a second tap too far away is not a double', () => {
    const { at, el } = surface();
    tap(el('text'), 0, 0);
    tap(el('text'), GESTURE.DOUBLE_TAP_SLOP_PX + 1, 0);
    expect(at).not.toHaveBeenCalled();
  });

  it('a third quick tap does not like a second time', () => {
    const { at, el } = surface();
    tap(el('text'));
    tap(el('text'));
    tap(el('text'));
    expect(at).toHaveBeenCalledTimes(1);
  });

  it('two taps on a link, a poll option or the action bar are theirs, never a like', () => {
    const { at, el } = surface();
    for (const id of ['link', 'option', 'bar']) {
      tap(el(id));
      tap(el(id));
    }
    expect(at).not.toHaveBeenCalled();
  });

  it('a tap on a control between two taps on the text ends the sequence', () => {
    const { at, el } = surface();
    tap(el('text'));
    tap(el('option'));
    tap(el('text'));
    expect(at).not.toHaveBeenCalled();
  });

  it('a click with no pointer behind it (keyboard, screen reader) is never counted', () => {
    const { at, el } = surface();
    tap(el('text'), 100, 100, 0);
    tap(el('text'), 100, 100, 0);
    expect(at).not.toHaveBeenCalled();
  });

  it('a second finger between the taps ends the sequence', () => {
    const { at, el } = surface();
    tap(el('text'));
    pointer('pointerdown', el('text'), 100, 100, 1);
    pointer('pointerdown', el('text'), 200, 200, 2);
    pointer('pointerup', el('text'), 200, 200, 2);
    pointer('pointerup', el('text'), 100, 100, 1);
    tap(el('text'));
    expect(at).not.toHaveBeenCalled();
  });

  it('a drag between the taps ends the sequence', () => {
    const { at, el } = surface();
    tap(el('text'));
    pointer('pointerdown', el('text'), 100, 100);
    pointer('pointermove', el('text'), 100, 100 + GESTURE.TAP_SLOP_PX + 1);
    pointer('pointerup', el('text'), 100, 100 + GESTURE.TAP_SLOP_PX + 1);
    tap(el('text'));
    expect(at).not.toHaveBeenCalled();
  });

  it('a press that stays inside the tap slop does not end the sequence', () => {
    const { at, el } = surface();
    pointer('pointerdown', el('text'), 100, 100);
    pointer('pointermove', el('text'), 103, 102);
    pointer('pointerup', el('text'), 103, 102);
    tap(el('text'));
    pointer('pointerdown', el('text'), 100, 100);
    pointer('pointerup', el('text'), 100, 100);
    tap(el('text'));
    expect(at).toHaveBeenCalledTimes(1);
  });

  it('the click ending a drag-selection of text is not a tap', () => {
    const { at, el } = surface();
    const range = document.createRange();
    range.selectNodeContents(el('text'));
    window.getSelection()!.addRange(range);
    tap(el('text'));
    tap(el('text'));
    expect(at).not.toHaveBeenCalled();
  });

  it('disabled, it counts nothing and holds nothing', () => {
    const { at, el } = surface({ enabled: false });
    const opened = vi.fn();
    el('photo').addEventListener('click', opened);
    tap(el('img'));
    expect(opened).toHaveBeenCalledTimes(1);
    tap(el('text'));
    tap(el('text'));
    expect(at).not.toHaveBeenCalled();
  });

  describe('a media opener (data-double-tap-defers)', () => {
    it('opens on a single tap once the window has passed, exactly once', () => {
      const { at, el } = surface();
      const opened = vi.fn();
      el('photo').addEventListener('click', opened);
      tap(el('img'));
      expect(opened).not.toHaveBeenCalled();
      vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS);
      expect(opened).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 4);
      expect(opened).toHaveBeenCalledTimes(1);
      expect(at).not.toHaveBeenCalled();
    });

    it('a double tap on it likes and opens nothing', () => {
      const { at, el } = surface();
      const opened = vi.fn();
      el('photo').addEventListener('click', opened);
      tap(el('img'));
      tap(el('img'));
      vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 4);
      expect(at).toHaveBeenCalledTimes(1);
      expect(opened).not.toHaveBeenCalled();
    });

    it('a third quick tap after a double opens nothing behind the heart', () => {
      const { at, el } = surface();
      const opened = vi.fn();
      el('photo').addEventListener('click', opened);
      tap(el('img'));
      tap(el('img'));
      tap(el('img'));
      vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 4);
      expect(at).toHaveBeenCalledTimes(1);
      expect(opened).not.toHaveBeenCalled();
    });

    it('inside a no-double-tap region (a comment picture) it opens AT ONCE, and two taps never like', () => {
      const { at, el } = surface();
      const opened = vi.fn();
      el('comment-photo').addEventListener('click', opened);
      tap(el('comment-img'));
      // No hold: the open is not waiting for the window.
      expect(opened).toHaveBeenCalledTimes(1);
      tap(el('comment-img'));
      expect(opened).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 4);
      expect(opened).toHaveBeenCalledTimes(2);
      expect(at).not.toHaveBeenCalled();
    });

    it("inside a link preview it is the link's: opens at once, two taps never like", () => {
      const { at, el } = surface();
      const opened = vi.fn();
      el('preview-photo').addEventListener('click', opened);
      tap(el('preview-img'));
      expect(opened).toHaveBeenCalledTimes(1);
      tap(el('preview-img'));
      tap(el('preview-title'));
      tap(el('preview-title'));
      vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 4);
      expect(opened).toHaveBeenCalledTimes(2);
      expect(at).not.toHaveBeenCalled();
    });

    it('a mouse double click on a comment picture is left to it (no word-selection guard)', () => {
      const { el } = surface();
      const second = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 2 });
      el('comment-img').dispatchEvent(second);
      expect(second.defaultPrevented).toBe(false);
    });

    it('Enter or a screen reader opens it at once', () => {
      const { el } = surface();
      const opened = vi.fn();
      el('photo').addEventListener('click', opened);
      tap(el('photo'), 0, 0, 0);
      expect(opened).toHaveBeenCalledTimes(1);
    });

    it('a drag after the tap drops the held open', () => {
      const { el } = surface();
      const opened = vi.fn();
      el('photo').addEventListener('click', opened);
      tap(el('img'));
      pointer('pointerdown', el('text'), 100, 100);
      pointer('pointercancel', el('text'), 100, 100);
      vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 4);
      expect(opened).not.toHaveBeenCalled();
    });

    it('an opener that left the page is not opened', () => {
      const { el } = surface();
      const opened = vi.fn();
      const photo = el('photo');
      photo.addEventListener('click', opened);
      tap(el('img'));
      photo.remove();
      vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS);
      expect(opened).not.toHaveBeenCalled();
    });

    it('destroying the surface drops a held open', () => {
      const { el, action } = surface();
      const opened = vi.fn();
      el('photo').addEventListener('click', opened);
      tap(el('img'));
      action.destroy();
      vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS);
      expect(opened).not.toHaveBeenCalled();
    });
  });

  it('logs what reached the surface: a press and its click per tap, and nothing for a lone scroll', () => {
    const { el } = surface();
    const log = vi.spyOn(Log, 'd');
    pointer('pointerdown', el('text'), 100, 100);
    pointer('pointercancel', el('text'), 100, 100);
    expect(log).not.toHaveBeenCalled();

    pointer('pointerdown', el('text'), 100, 100);
    pointer('pointerup', el('text'), 100, 100);
    tap(el('text'));
    const lines = log.mock.calls.map((c) => String(c[1]));
    expect(lines[0]).toMatch(/^press ended/);
    expect(lines[1]).toBe('click (detail 1, surface)');

    pointer('pointerdown', el('text'), 100, 100);
    pointer('pointercancel', el('text'), 100, 100);
    expect(String(log.mock.calls.at(-1)?.[1])).toBe('sequence ended: the engine took the press');
    log.mockRestore();
  });

  it("a mouse double click does not select the word under it, and leaves a control's alone", () => {
    const { el } = surface();
    const second = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 2 });
    el('text').dispatchEvent(second);
    expect(second.defaultPrevented).toBe(true);

    const first = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 1 });
    el('text').dispatchEvent(first);
    expect(first.defaultPrevented).toBe(false);

    const onLink = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 2 });
    el('link').dispatchEvent(onLink);
    expect(onLink.defaultPrevented).toBe(false);
  });
});
