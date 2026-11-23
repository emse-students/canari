/**
 * Whether the thread's READER is moving its pane - the one fact `scrollMeasurementResponse` needs to
 * tell the reader leaving the end of a thread from the engine moving the pane under them
 * (docs/wiki/frontend/modules/chat.md, "only a reader lowers the flag").
 *
 * **DURABLE INPUT STATE, NEVER A CLOCK.** It is raised by the reader's own input on the pane - a
 * touch, a pointer (a scrollbar drag), a wheel, a key - or by a jump the reader asked for
 * (`declare`), and it is lowered only when the PAGE places the pane itself (`placed`) with no finger
 * on it. So a fling keeps it up through its momentum, after the finger has lifted, until the page
 * next puts the pane somewhere; and a move nobody touched - WebKit scrolling an overflow scroller
 * around the keyboard - finds it down.
 */
import { Log } from '$lib/utils/Log';
import type { TouchHold } from './touchHold';

export interface ReaderInput {
  /** True from a reader's input on the pane until the page next places the pane with no finger on it. */
  readonly moving: boolean;
  /** The page placed the pane (a pin, a scroll to the end): the reader's move, if any, is over. */
  placed(): void;
  /** A move the reader asked for without touching the pane (a jump to a quoted message). */
  declare(): void;
  /** Removes the listeners. */
  dispose(): void;
}

/** The inputs by which a reader moves a scroller. */
const READER_EVENTS = ['touchstart', 'pointerdown', 'wheel', 'keydown'] as const;

/**
 * Starts watching `el` for its reader's input.
 *
 * @param el the thread's scroller.
 * @param touch the touches on it: a placement under a finger does not end the reader's move.
 */
export function trackReaderInput(el: HTMLElement, touch: Pick<TouchHold, 'held'>): ReaderInput {
  let moving = false;
  const onInput = () => {
    moving = true;
  };
  for (const type of READER_EVENTS) el.addEventListener(type, onInput, { passive: true });
  return {
    get moving() {
      return moving;
    },
    placed() {
      if (touch.held) return;
      moving = false;
    },
    declare() {
      Log.d('readerInput', 'a move the reader asked for');
      moving = true;
    },
    dispose() {
      for (const type of READER_EVENTS) el.removeEventListener(type, onInput);
      moving = false;
    },
  };
}
