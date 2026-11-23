/**
 * THE KEYBOARD TRANSITIONS: counted, and whether the latest one has come to rest - the one fact a scroll
 * measurement needs to recognise the engine's own move of a thread pane around the soft keyboard
 * (docs/wiki/frontend/modules/chat.md, "the engine's keyboard move is put back, and only it").
 *
 * A transition STARTS when the keyboard opens or closes (and, in the iOS shell, when its height
 * changes while open): `keyboardViewport.svelte.ts` is the only writer, once per change, never per
 * frame - a change arriving while one is still moving belongs to it. It COMES TO REST when the
 * keyboard does, by a fact and never by a clock:
 *
 * - in the iOS shell, the shell's `canariKeyboardAtRest` - `UIKeyboardDidChangeFrame`, relayed once
 *   WebKit has put its pending updates on screen. WebKit reveals the focused field when the keyboard
 *   has shown, after the WebView was resized (the iPhone's numbers: the pane 375 px short with the
 *   keyboard up, 96 pt short once it fell - 375 minus the 279 pt keyboard), and the proof orders the
 *   rest after the scroll that reveal caused;
 * - everywhere else, in the same update that started it: the Android shell announces the keyboard's
 *   final inset, and a browser's viewport resize IS the keyboard where it stands.
 *
 * A reader compares counts - durable state, ordered against its own events.
 */
import { Log } from '$lib/utils/Log';

let count = 0;
let restingThrough = 0;

/** How many keyboard transitions have started in this document. */
export function keyboardTransitionCount(): number {
  return count;
}

/** Whether the latest keyboard transition is still moving (started, not yet at rest). */
export function keyboardTransitionMoving(): boolean {
  return count > restingThrough;
}

/**
 * A keyboard transition starts now - unless one is still moving, which this change belongs to.
 *
 * @param why what started it, for the log (one line per transition).
 */
export function noteKeyboardTransition(why: string): void {
  if (keyboardTransitionMoving()) return;
  count++;
  Log.d('keyboardTransition', `#${count} starts: ${why}`);
}

/**
 * The keyboard is at rest: the transition moving, if any, is over.
 *
 * @param why what said so, for the log.
 */
export function noteKeyboardAtRest(why: string): void {
  if (!keyboardTransitionMoving()) return;
  restingThrough = count;
  Log.d('keyboardTransition', `#${count} at rest: ${why}`);
}
