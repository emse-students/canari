import { NO_DOUBLE_TAP } from '$lib/actions/doubleTapLike';
import { tapBelongsToInnerControl } from '$lib/utils/tapDisambiguator';
import { GESTURE, isDoubleTap, type Sample } from '$lib/utils/viewerGestures';

/**
 * A DOUBLE TAP ON THE CAMERA PREVIEW FLIPS THE LENS - before a take AND DURING ONE (user,
 * 2026-10-22). The arithmetic is the app's one double tap (`isDoubleTap`, `GESTURE.DOUBLE_TAP_MS`,
 * `GESTURE.DOUBLE_TAP_SLOP_PX`), never a second copy of it.
 *
 * WHY NOT `doubleTapLike`, THE POSTS' ACTION. It counts the engine's `click`s, and a take is filmed
 * with a finger HELD on the shutter: the flip is then a SECOND finger's tap, and an engine
 * synthesises no click for a tap made while another finger is down (the touch sequence is a
 * multi-touch one). So the taps here are read from the pointers themselves: a press that lifts within
 * `GESTURE.TAP_MAX_MS` and `GESTURE.TAP_SLOP_PX` is a tap, whatever other finger is down.
 *
 * A SINGLE TAP IS NEVER HELD. The preview has no single-tap action (no tap-to-focus), so nothing
 * waits for the double-tap window and no single tap is delayed or replayed.
 *
 * WHAT IS NEVER A TAP OF THIS GESTURE: a press that starts on a control (`tapBelongsToInnerControl`:
 * the close, the lens and torch buttons) or inside `[data-no-double-tap]` (the shutter row - so the
 * finger holding a take is never counted, and never ends a sequence either).
 */

/** What the action needs. */
export interface PreviewDoubleTapParams {
  /** Two taps landed close in time and space. */
  onDoubleTap: () => void;
  /** Off, every press is ignored (the preview is not live). Default on. */
  enabled?: boolean;
}

/** The pure part: presses in, a double tap out. Times are any monotonic clock in ms. */
export interface PreviewTapTracker {
  down(pointerId: number, at: Sample): void;
  /** Returns true when this lift completed a double tap. */
  up(pointerId: number, at: Sample): boolean;
  cancel(pointerId: number): void;
  reset(): void;
}

/** Builds the tracker: per-pointer presses, and the last tap a second one may pair with. */
export function createPreviewTapTracker(): PreviewTapTracker {
  const presses = new Map<number, Sample>();
  let lastTap: Sample | null = null;
  return {
    down(pointerId, at) {
      presses.set(pointerId, at);
    },
    up(pointerId, at) {
      const from = presses.get(pointerId);
      presses.delete(pointerId);
      if (!from) return false;
      const isTap =
        at.t - from.t <= GESTURE.TAP_MAX_MS &&
        Math.hypot(at.x - from.x, at.y - from.y) < GESTURE.TAP_SLOP_PX;
      if (!isTap) {
        lastTap = null;
        return false;
      }
      if (isDoubleTap(lastTap, at)) {
        lastTap = null;
        return true;
      }
      lastTap = at;
      return false;
    },
    cancel(pointerId) {
      presses.delete(pointerId);
    },
    reset() {
      presses.clear();
      lastTap = null;
    },
  };
}

/** Svelte action: a double tap on `node`'s preview calls `onDoubleTap`. */
export function previewDoubleTap(node: HTMLElement, initial: PreviewDoubleTapParams) {
  let params = initial;
  const taps = createPreviewTapTracker();
  const enabled = () => params.enabled !== false;

  /** A press on a control, or in the shutter row, is not the preview's. */
  function ours(target: EventTarget | null): boolean {
    if (!target || typeof (target as Element).closest !== 'function') return false;
    const region = (target as Element).closest(`[${NO_DOUBLE_TAP}]`);
    if (region && node.contains(region)) return false;
    return !tapBelongsToInnerControl(target, node);
  }

  function onDown(e: PointerEvent) {
    if (!enabled() || !ours(e.target)) return;
    taps.down(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
  }

  function onUp(e: PointerEvent) {
    if (!enabled()) return;
    if (taps.up(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp })) {
      console.debug('[camera] double tap on the preview');
      params.onDoubleTap();
    }
  }

  function onCancel(e: PointerEvent) {
    taps.cancel(e.pointerId);
  }

  node.addEventListener('pointerdown', onDown, { capture: true });
  node.addEventListener('pointerup', onUp, { capture: true });
  node.addEventListener('pointercancel', onCancel, { capture: true });

  return {
    update(next: PreviewDoubleTapParams) {
      params = next;
      if (!enabled()) taps.reset();
    },
    destroy() {
      node.removeEventListener('pointerdown', onDown, { capture: true });
      node.removeEventListener('pointerup', onUp, { capture: true });
      node.removeEventListener('pointercancel', onCancel, { capture: true });
    },
  };
}
