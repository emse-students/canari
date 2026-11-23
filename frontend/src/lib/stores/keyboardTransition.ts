/**
 * THE KEYBOARD TRANSITIONS, COUNTED - the one fact a scroll measurement needs to recognise the
 * engine's own move of a thread pane around the soft keyboard (docs/wiki/frontend/modules/chat.md,
 * "the engine's keyboard move is put back, and only it").
 *
 * A transition starts when a field the keyboard serves takes focus on an OS with a virtual keyboard
 * (WebKit reveals the focused field as the keyboard is about to show, BEFORE the WebView is resized:
 * the iPhone's log reads the move against the reach of the keyboard-free layout), and whenever the
 * keyboard opens, closes or changes height. `keyboardViewport.svelte.ts` is the only writer; it already
 * knows both facts. A reader compares counts - durable state, ordered against its own events, no clock.
 */
import { Log } from '$lib/utils/Log';

let count = 0;

/** How many keyboard transitions have started in this document. */
export function keyboardTransitionCount(): number {
  return count;
}

/**
 * A keyboard transition starts now.
 *
 * @param why what started it, for the log.
 */
export function noteKeyboardTransition(why: string): void {
  count++;
  Log.d('keyboardTransition', `#${count}: ${why}`);
}
