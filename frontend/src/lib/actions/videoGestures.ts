import { createTapDisambiguator, tapBelongsToInnerControl } from '$lib/utils/tapDisambiguator';
import { GESTURE } from '$lib/utils/viewerGestures';
import { Log } from '$lib/utils/Log';

/**
 * THE VIDEO PLAYER'S GESTURES - THE SAME ON EVERY SURFACE (owner, 2026-11-09): a single TAP toggles
 * the sound, a PRESS HELD pauses while it is held and resumes on release, and a DOUBLE TAP is the
 * surface's like where likes exist and leaves the sound as it was. The player (`VideoPlayer`) wires
 * this on its picture; its controls (`button`, `[data-video-controls]`) are never part of it.
 *
 * THE TAP IS THE ENGINE'S `click`: a press that scrolled, panned or pinched never makes one, so a
 * swipe in the reel pager or the lightbox is never a sound toggle. A click with no pointer behind it
 * (`detail === 0`, Enter/Space on a focused control, a screen reader) is not a tap of this gesture;
 * the player's keyboard map answers those (`videoKeyAction`).
 *
 * THE HOLD is a press that stays down {@link HOLD_TO_PAUSE_MS} without travelling past
 * `GESTURE.TAP_SLOP_PX` - `GESTURE.TAP_MAX_MS`, the length past which the app already says a press
 * is not a tap, so the two can never both be true of one press. ONE timer, armed at the press and
 * cleared at its end: it is the gesture's definition of "held", not a guess about the network or a
 * retry (CLAUDE.md: a timer is never an idempotence or termination mechanism; this one decides
 * nothing but which gesture a press was). The click a held press may still produce (a mouse does,
 * an Android long press does not) is swallowed: the next press clears that flag, so a click that
 * never came can never eat a later tap. A second finger, or a travel past the slop, ends the hold
 * (a pinch, a swipe) and resumes.
 *
 * THE DOUBLE TAP. Where a double tap LIKES (`waitForDouble`: a reel, a feed post - `doubleTapLike`
 * on the surface around), the single tap waits for the double-tap window (`createTapDisambiguator`,
 * the same `GESTURE.DOUBLE_TAP_MS` that `doubleTapLike` reads, so the two always agree) and a pair is
 * reported as `onDoubleTap` instead - the sound is never flipped twice, never audible for a quarter
 * second. Where no double tap means anything the tap acts at once.
 *
 * EVERY DECISION LOGS ONE LINE (`[videoGestures]`); nothing logs per move.
 */

/** How long a press must stay down to be a hold: the length past which it is no longer a tap. */
export const HOLD_TO_PAUSE_MS = GESTURE.TAP_MAX_MS;

/** What, inside the player, is never part of its gestures: its controls own their presses. */
const CONTROLS = '[data-video-controls]';

export interface VideoGestureParams {
  /** A single tap on the picture. */
  onTap: () => void;
  /** A press became a hold: pause. */
  onHoldStart: () => void;
  /** The hold ended (release, a second finger, a drag): resume what the hold paused. */
  onHoldEnd: () => void;
  /** Two taps in the window, where `waitForDouble` is set. The like itself is the surface's. */
  onDoubleTap?: () => void;
  /** A double tap means something on this surface: the single tap waits for the window. */
  waitForDouble?: boolean;
  /** Off, the picture is inert. Default on. */
  enabled?: boolean;
}

/** Svelte action: the tap, hold and double-tap gestures of a video player's picture. */
export function videoGestures(node: HTMLElement, initial: VideoGestureParams) {
  let params = initial;
  const enabled = () => params.enabled !== false;

  /** The press under way: its pointer and where it went down. */
  let press: { id: number; x: number; y: number } | null = null;
  /** The hold timer of the press under way. */
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** The press under way became a hold and paused the video. */
  let holding = false;
  /** The press that just ended was a hold: the click it may produce is not a tap. */
  let swallowClick = false;

  const taps = createTapDisambiguator({
    onSingle: () => {
      Log.d('videoGestures', 'tap');
      params.onTap();
    },
    onDouble: () => {
      Log.d('videoGestures', 'double tap - the sound is left as it was');
      params.onDoubleTap?.();
    },
  });

  function isControl(target: EventTarget | null): boolean {
    if (!target || typeof (target as Element).closest !== 'function') return false;
    return (target as Element).closest(CONTROLS) !== null || tapBelongsToInnerControl(target, node);
  }

  function clearHoldTimer() {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
  }

  /** Ends the press under way; a hold resumes the video. */
  function endPress(reason: string) {
    clearHoldTimer();
    if (holding) {
      holding = false;
      swallowClick = true;
      Log.d('videoGestures', `hold ended: ${reason}`);
      params.onHoldEnd();
    }
    press = null;
  }

  function onPointerDown(e: PointerEvent) {
    if (!enabled()) return;
    // A new press: whatever the last hold left pending is void - its click came, or never will.
    swallowClick = false;
    if (press) {
      // A second finger: a pinch, never a hold.
      endPress('a second pointer');
      return;
    }
    if (e.button !== 0 || isControl(e.target)) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY };
    holdTimer = setTimeout(() => {
      holdTimer = null;
      holding = true;
      Log.d('videoGestures', 'hold started');
      params.onHoldStart();
    }, HOLD_TO_PAUSE_MS);
  }

  function onPointerMove(e: PointerEvent) {
    if (!press || e.pointerId !== press.id) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (Math.hypot(dx, dy) > GESTURE.TAP_SLOP_PX) endPress('the press travelled (a swipe)');
  }

  function onPointerEnd(e: PointerEvent) {
    if (!press || e.pointerId !== press.id) return;
    endPress(e.type === 'pointercancel' ? 'the engine took the press' : 'released');
  }

  function onClick(e: MouseEvent) {
    if (!enabled()) return;
    if (swallowClick) {
      swallowClick = false;
      Log.d('videoGestures', 'the click of a hold - not a tap');
      return;
    }
    if (e.detail === 0 || isControl(e.target)) return;
    if (params.waitForDouble) {
      taps.tap({ x: e.clientX, y: e.clientY, t: e.timeStamp });
      return;
    }
    Log.d('videoGestures', 'tap');
    params.onTap();
  }

  /** The long press of a phone opens a context menu (save video, copy): never on the picture. */
  function onContextMenu(e: Event) {
    if (enabled() && !isControl(e.target)) e.preventDefault();
  }

  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('pointermove', onPointerMove);
  node.addEventListener('pointerup', onPointerEnd);
  node.addEventListener('pointercancel', onPointerEnd);
  node.addEventListener('click', onClick);
  node.addEventListener('contextmenu', onContextMenu);

  return {
    update(next: VideoGestureParams) {
      params = next;
      if (!enabled()) {
        endPress('the gestures were turned off');
        taps.cancel();
      }
    },
    destroy() {
      // Silently: the player is leaving, and resuming its element now would play a video nobody sees.
      clearHoldTimer();
      holding = false;
      press = null;
      taps.cancel();
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', onPointerEnd);
      node.removeEventListener('pointercancel', onPointerEnd);
      node.removeEventListener('click', onClick);
      node.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
