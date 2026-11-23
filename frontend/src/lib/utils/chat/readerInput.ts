/**
 * Whether the thread's READER is moving its pane, and when they last did - two of the facts
 * `scrollMeasurementResponse` needs to recognise the engine's own move of the pane around the
 * keyboard (docs/wiki/frontend/modules/chat.md, "the engine's keyboard move is put back, and only it").
 *
 * **DURABLE INPUT STATE, NEVER A CLOCK.** `moving` is raised by the reader's own input on the pane - a
 * touch, a pointer (a scrollbar drag), a wheel, a key, a scrolling key pressed with the focus on the
 * page itself (the pane has no tabindex, so PageUp lands on `body`) - or by a jump the reader asked for
 * (`declare`), and lowered only when the PAGE places the pane itself (`placed`) with no finger on it.
 * So a fling keeps it up through its momentum, after the finger has lifted. `lastInputTransition` is
 * the keyboard transition count (`keyboardTransition.ts`) at the reader's last input: a transition
 * started after it is one the reader did not follow with a move of their own.
 */
import { keyboardTransitionCount } from '$lib/stores/keyboardTransition';
import { Log } from '$lib/utils/Log';
import type { TouchHold } from './touchHold';

export interface ReaderInput {
  /** True from a reader's input on the pane until the page next places the pane with no finger on it. */
  readonly moving: boolean;
  /** `keyboardTransitionCount()` at the reader's last input (at the start of the tracking if none). */
  readonly lastInputTransition: number;
  /** The page placed the pane (a pin, a scroll to the end): the reader's move, if any, is over. */
  placed(): void;
  /** A move the reader asked for without touching the pane (a jump to a quoted message). */
  declare(): void;
  /** Removes the listeners. */
  dispose(): void;
}

/** The inputs by which a reader moves a scroller, heard on the scroller itself. */
const READER_EVENTS = ['touchstart', 'pointerdown', 'wheel', 'keydown'] as const;

/** The keys a browser scrolls the page's scroller with when nothing focusable has the focus. */
const SCROLLING_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/**
 * Whether `e` is a scrolling key pressed with the focus on the page itself (`body` or the root), which
 * the browser applies to the scroller under it - the thread's pane, on the chat screen.
 */
export function isPageScrollingKey(e: Pick<KeyboardEvent, 'key' | 'target'>): boolean {
  if (!SCROLLING_KEYS.has(e.key)) return false;
  return e.target === document.body || e.target === document.documentElement;
}

/**
 * Starts watching `el` for its reader's input.
 *
 * @param el the thread's scroller.
 * @param touch the touches on it: a placement under a finger does not end the reader's move.
 */
export function trackReaderInput(el: HTMLElement, touch: Pick<TouchHold, 'held'>): ReaderInput {
  let moving = false;
  let lastInputTransition = keyboardTransitionCount();
  const onInput = () => {
    moving = true;
    lastInputTransition = keyboardTransitionCount();
  };
  const onPageKey = (e: KeyboardEvent) => {
    if (isPageScrollingKey(e)) onInput();
  };
  for (const type of READER_EVENTS) el.addEventListener(type, onInput, { passive: true });
  document.addEventListener('keydown', onPageKey, { passive: true });
  return {
    get moving() {
      return moving;
    },
    get lastInputTransition() {
      return lastInputTransition;
    },
    placed() {
      if (touch.held) return;
      moving = false;
    },
    declare() {
      Log.d('readerInput', 'a move the reader asked for');
      onInput();
    },
    dispose() {
      for (const type of READER_EVENTS) el.removeEventListener(type, onInput);
      document.removeEventListener('keydown', onPageKey);
      moving = false;
    },
  };
}
