import { createTapDisambiguator, tapBelongsToInnerControl } from '$lib/utils/tapDisambiguator';
import { DOUBLE_TAP_LIKES, NO_DOUBLE_TAP } from '$lib/actions/doubleTapLike';
import { HOLD_TO_PAUSE_MS } from '$lib/actions/videoGestures';
import { GESTURE } from '$lib/utils/viewerGestures';
import { Log } from '$lib/utils/Log';

/**
 * A SINGLE TAP ON A FULL-SCREEN REEL HIDES OR SHOWS ITS OVERLAY (owner, 2026-11-18) - the caption,
 * the author row, the action rail and the viewer's top tabs with the close button. It no longer
 * pauses: the only pause is a press held on the picture (`videoGestures`).
 *
 * ONE SURFACE, EVERY PAGE: the slide's root, whatever it holds (a video, a photo, a carousel's strip, a
 * replay), so the video player does not carry a second copy of the rule. THE CLICK IS READ IN THE
 * CAPTURE PHASE, as `doubleTapLike` reads it, before the player stops it - and the rest of this file
 * is what is NOT a tap of this gesture, so no control toggles the overlay by accident:
 * - a link, a button, a form field, a slider - anything `tapBelongsToInnerControl` names - the
 *   player's bar and seek line (`[data-video-controls]`, a slider that selector does not name) and any `[data-no-double-tap]` region;
 * - a click with no pointer behind it (`detail` 0: Enter or Space on a control, a screen reader's
 *   activation) - the sr-only "show the controls" button is the accessible way back, and it is a button;
 * - the click a HELD press makes (a mouse does; the hold's pause is `videoGestures`'): a press that
 *   stayed down {@link HOLD_TO_PAUSE_MS} or travelled past `GESTURE.TAP_SLOP_PX` is not a tap;
 * - the click that ends a drag, which the viewer swallows in the window's capture phase before it
 *   reaches here.
 *
 * A DOUBLE TAP LIKES, so where it does (`data-double-tap-likes` on the surface) the single tap waits
 * the same window (`createTapDisambiguator`, `GESTURE.DOUBLE_TAP_MS`) and a pair toggles nothing - a
 * like never flashes the overlay. Where no double tap means anything the tap acts at once.
 *
 * EVERY DECISION LOGS ONE LINE (`[reelOverlayTap]`); nothing logs per move.
 */
export interface ReelOverlayTapParams {
  /** A single tap on the surface: hide or show the overlay. */
  onToggle: () => void;
  /** Off, the surface is inert (a slide that is not on screen). Default on. */
  enabled?: boolean;
}

/** Svelte action: the overlay toggle of a reel slide's single tap. */
export function reelOverlayTap(node: HTMLElement, initial: ReelOverlayTapParams) {
  let params = initial;
  const enabled = () => params.enabled !== false;

  /** The press under way: its pointer, where and when (`event.timeStamp`) it went down. */
  let press: { id: number; x: number; y: number; t: number; spoiled: boolean } | null = null;
  /**
   * The press that just ended, which the click about to come belongs to. `spoiled`: it travelled or a
   * second finger joined - a swipe, a pinch - and its click, if the engine makes one, is no tap.
   */
  let ended: { t: number; spoiled: boolean } | null = null;

  const taps = createTapDisambiguator({
    onSingle: () => {
      Log.d('reelOverlayTap', 'single tap - the overlay toggles');
      params.onToggle();
    },
    onDouble: () => Log.d('reelOverlayTap', 'double tap - the like is the surface'),
  });

  function onPointerDown(e: PointerEvent) {
    if (!enabled()) return;
    ended = null;
    if (press) {
      press.spoiled = true;
      return;
    }
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, spoiled: false };
  }

  function onPointerMove(e: PointerEvent) {
    if (!press || e.pointerId !== press.id || press.spoiled) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > GESTURE.TAP_SLOP_PX) {
      press.spoiled = true;
    }
  }

  function onPointerEnd(e: PointerEvent) {
    if (!press || e.pointerId !== press.id) return;
    ended = { t: press.t, spoiled: press.spoiled || e.type === 'pointercancel' };
    press = null;
  }

  function onClick(e: MouseEvent) {
    if (!enabled()) return;
    const down = ended;
    ended = null;
    // Keyboard and assistive activations are the controls' own, never a tap of the picture.
    if (e.detail === 0) return;
    const target = e.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;
    if (
      target.closest('[data-video-controls]') ||
      target.closest(`[${NO_DOUBLE_TAP}]`) ||
      tapBelongsToInnerControl(target, node)
    ) {
      taps.cancel();
      return;
    }
    if (down && (down.spoiled || e.timeStamp - down.t >= HOLD_TO_PAUSE_MS)) {
      Log.d('reelOverlayTap', 'the click of a hold or a drag - not a tap');
      taps.cancel();
      return;
    }
    if (node.hasAttribute(DOUBLE_TAP_LIKES)) {
      taps.tap({ x: e.clientX, y: e.clientY, t: e.timeStamp });
      return;
    }
    Log.d('reelOverlayTap', 'single tap - the overlay toggles');
    params.onToggle();
  }

  node.addEventListener('pointerdown', onPointerDown, { capture: true });
  node.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  node.addEventListener('pointerup', onPointerEnd, { capture: true });
  node.addEventListener('pointercancel', onPointerEnd, { capture: true });
  node.addEventListener('click', onClick, { capture: true });

  return {
    update(next: ReelOverlayTapParams) {
      params = next;
      if (!enabled()) {
        press = null;
        ended = null;
        taps.cancel();
      }
    },
    destroy() {
      taps.cancel();
      node.removeEventListener('pointerdown', onPointerDown, { capture: true });
      node.removeEventListener('pointermove', onPointerMove, { capture: true });
      node.removeEventListener('pointerup', onPointerEnd, { capture: true });
      node.removeEventListener('pointercancel', onPointerEnd, { capture: true });
      node.removeEventListener('click', onClick, { capture: true });
    },
  };
}
