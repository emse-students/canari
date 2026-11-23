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
 * - in the iOS shell, the shell's `canariKeyboardAtRest` - on `UIKeyboardDidShow` / `DidHide` (on
 *   `DidChangeFrame` only for a height change while open), after WebKit's own observers and once its
 *   pending updates are on screen (`canari_ios.mm`, `CanariTellPageKeyboardAtRest`). WebKit reveals the
 *   focused field from its `_keyboardDidShow:`, after the WebView was resized (the iPhone's numbers: the
 *   pane 375 px short with the keyboard up, 96 pt short once it fell - 375 minus the 279 pt keyboard),
 *   and that order puts the rest after the page measured the scroll the reveal caused;
 * - everywhere else, in the same update that started it: the Android shell announces the keyboard's
 *   final inset, and a browser's viewport resize IS the keyboard where it stands.
 *
 * In the iOS shell a transition also starts at the shell's `canariKeyboardShows` (`UIKeyboardWillShow`):
 * an app returning with the keyboard up comes back at the WebView size it left with, so no resize
 * starts one, while WebKit's did-show reveal still scrolls the thread pane (iPhone 12, `1.8.0-alpha.4`,
 * 4 returns of 10 above the end). UIKit pairs every will-show with a did-show or did-hide, and either
 * rests it - a fact at both ends, so no transition is left moving.
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
  announceEdge('starts', why);
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
  announceEdge('at rest', why);
}

/** An edge of a keyboard transition, as {@link onKeyboardTransitionEdge} hands it. */
type KeyboardTransitionEdge = 'starts' | 'at rest';

type EdgeListener = (edge: KeyboardTransitionEdge, transition: number, why: string) => void;
const edgeListeners = new Set<EdgeListener>();

/**
 * Calls `listener` at every start and every rest of a keyboard transition - once per edge, never per
 * frame - so a thread pane can report its geometry where the keyboard moved it (`ChatArea`).
 *
 * @returns the unsubscribe.
 */
export function onKeyboardTransitionEdge(listener: EdgeListener): () => void {
  edgeListeners.add(listener);
  return () => edgeListeners.delete(listener);
}

function announceEdge(edge: KeyboardTransitionEdge, why: string): void {
  // One `try` per subscriber: a listener that throws never stops the next one hearing the edge.
  for (const listener of edgeListeners) {
    try {
      listener(edge, count, why);
    } catch (error) {
      Log.w('keyboardTransition', `an edge listener threw at #${count} ${edge}: ${String(error)}`);
    }
  }
}
