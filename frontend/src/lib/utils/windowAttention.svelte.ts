import { isMobileTauriRuntime } from './appVersion';
import { Log } from './Log';

/**
 * IS SOMEONE AT THIS WINDOW? - the attention signal behind every "the reader saw it" decision on web
 * and desktop (owner, 2026-11-11, [read-receipt-privacy](../../../../docs/wiki/read-receipt-privacy.md)).
 *
 * A browser window answers `visible` and `hasFocus()` for as long as it is left in front, whoever is
 * sitting there: a PC left on with Canari open marked every arrival read, told the sender "Vu", and
 * told this account's phone to drop its banner - the reader saw nothing, anywhere. The window's own
 * signals cannot say the person left; only the person's gestures can say they are there.
 *
 * THE TWO MINUTES ARE A PRODUCT DEFINITION, NOT A TIMEOUT. "Attending" is defined as "a gesture in
 * this window within the last {@link ATTENTION_WINDOW_MS}": long enough that reading a long message
 * without touching anything still counts, short enough that a window left alone stops claiming a
 * reader. NOTHING FIRES WHEN IT ELAPSES. The threshold is only ever read at a decision that is
 * already being made (a message arrives, the receipt effect runs), and the one edge this store
 * announces is the opposite one - a gesture after idleness - so a write is caused by a gesture or an
 * arrival, never by a clock. Its failure mode is a read marked LATER (the reader alt-tabs back and
 * reads without moving), never a read claimed for a message nobody saw.
 *
 * ONE PER WINDOW: a module singleton, so each tab - leader or follower - answers for its own window
 * and only a tab someone is attending may post a mark.
 *
 * NATIVE MOBILE IS EXEMPT (owner: "native apps keep today's rule"): a phone's screen sleeps by
 * itself and its foreground is stated by the shell (`appForeground.ts`). A desktop app window is
 * NOT exempt - it is a PC window left open exactly like a browser tab.
 */

/** How recent a gesture must be for the window to count as attended. See the module doc. */
export const ATTENTION_WINDOW_MS = 2 * 60 * 1000;

/**
 * The gestures that prove a person at the window. `scroll` is deliberately NOT one: it fires for the
 * app's own scroll to a new message, so an arrival would prove its own reader. `wheel`, touch, keys
 * and a scrollbar drag (`pointerdown`) cover every scroll a person makes.
 */
export const ATTENTION_GESTURES = [
  'pointerdown',
  'pointermove',
  'keydown',
  'wheel',
  'touchstart',
] as const;

/** Whether a gesture at `lastGestureAt` (null: none yet) still counts as attention at `now`. Pure. */
export function isAttentiveAt(lastGestureAt: number | null, now: number): boolean {
  return lastGestureAt !== null && now - lastGestureAt < ATTENTION_WINDOW_MS;
}

/**
 * Whether a DOM event is a person's gesture. Untrusted events come from script, not a person. A
 * `pointermove` with no movement is the browser re-evaluating hover after a layout or scroll change
 * (a new message pushing the list), not a hand on the mouse.
 */
export function isPersonGesture(event: Event): boolean {
  if (!event.isTrusted) return false;
  if (event.type === 'pointermove') {
    const move = event as PointerEvent;
    return (move.movementX ?? 0) !== 0 || (move.movementY ?? 0) !== 0;
  }
  return true;
}

/** The attention of one window. */
export interface AttentionSignal {
  /**
   * Whether someone is attending the window NOW. Reactive on the idle -> attended edge only: an
   * effect that reads it runs again at the first gesture after idleness, and never because the
   * threshold elapsed.
   */
  readonly attentive: boolean;
  /** Records a gesture. The listeners call it. */
  noteGesture(): void;
  /** Back to idle, as at load: no gesture known. */
  reset(): void;
  /** Removes the listeners. */
  destroy(): void;
}

/** What one window's attention signal is built from. */
export interface AttentionSource {
  /** Where the gesture listeners go (`window`), or `null` where there is none (SSR). */
  target: EventTarget | null;
  /** Answered at each read: `true` where attention is not asked (native mobile). */
  exempt: () => boolean;
  /** The clock the threshold is read against. */
  now?: () => number;
  /** Whether an event is a person's gesture ({@link isPersonGesture}). */
  isGesture?: (event: Event) => boolean;
}

/** Builds one window's attention signal and installs its passive listeners on `source.target`. */
export function createAttentionSignal(source: AttentionSource): AttentionSignal {
  const { target, exempt, now = () => Date.now(), isGesture = isPersonGesture } = source;
  let lastGestureAt: number | null = null;
  // Bumped on the idle -> attended edge only, so a gesture while attended re-runs nothing.
  let wakes = $state(0);

  function noteGesture(): void {
    const at = now();
    const wasAttentive = isAttentiveAt(lastGestureAt, at);
    lastGestureAt = at;
    if (wasAttentive) return;
    Log.d('[ATTENTION] a gesture after idleness - this window is attended again');
    wakes += 1;
  }

  const onEvent = (event: Event) => {
    if (isGesture(event)) noteGesture();
  };
  const options: AddEventListenerOptions = { passive: true, capture: true };
  for (const type of ATTENTION_GESTURES) target?.addEventListener(type, onEvent, options);

  return {
    get attentive() {
      void wakes;
      return exempt() || isAttentiveAt(lastGestureAt, now());
    },
    noteGesture,
    reset() {
      Log.d('[ATTENTION] reset - this window is idle until its next gesture');
      lastGestureAt = null;
    },
    destroy() {
      for (const type of ATTENTION_GESTURES) target?.removeEventListener(type, onEvent, options);
    },
  };
}

/**
 * THIS window's attention - installed when the module is first imported, which every route does
 * through `arrivalRuntime.ts`. It starts IDLE: a page load is not a gesture (a reload can be
 * automatic), so nothing loaded is read until the person touches the window.
 */
export const windowAttention: AttentionSignal = createAttentionSignal({
  target: typeof window === 'undefined' ? null : window,
  exempt: () => isMobileTauriRuntime(),
});

/**
 * What the receipt effect may do for the conversation on screen, from the window's state:
 * `away` - not in front (hidden, unfocused, the app in the background): nothing, silently;
 * `idle` - in front with nobody at it: nothing, and the withheld mark is reported;
 * `reading` - the mark moves. Pure: `MainChatPage` hands in its reactive state, so reading
 * `attentive` there is what re-runs the effect at the first gesture.
 */
export function windowReadVerdict(w: {
  focused: boolean;
  visible: boolean;
  foreground: boolean;
  attentive: boolean;
}): 'away' | 'idle' | 'reading' {
  if (!w.focused || !w.visible || !w.foreground) return 'away';
  return w.attentive ? 'reading' : 'idle';
}
