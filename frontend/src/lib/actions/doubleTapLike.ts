import { createTapDisambiguator, tapBelongsToInnerControl } from '$lib/utils/tapDisambiguator';
import { GESTURE, type Point } from '$lib/utils/viewerGestures';
import { hasActiveTextSelection } from '$lib/utils/textSelection';
import { Log } from '$lib/utils/Log';

/**
 * A DOUBLE TAP (OR A MOUSE DOUBLE CLICK) ON A POST LIKES IT - the one gesture behind every post
 * card and every reel of the full-screen viewer (user, 2026-10-19). The contract, and what was
 * measured against what was only reasoned, is in `docs/wiki/frontend/modules/posts.md` ("A double
 * tap likes").
 *
 * THE TAPS ARE THE ENGINE'S `click`S, read in the CAPTURE phase on the surface. A click is what the
 * engine already decided was a tap - a press that scrolled, panned or pinched never makes one - and
 * the capture phase sees it before any child, `VideoPlayer`'s picture tap included (it stops its
 * click's propagation). Two clicks close in time and space are a double tap by the arithmetic the
 * media viewer and the message bubble already share (`isDoubleTap`, `GESTURE.DOUBLE_TAP_MS` and
 * `GESTURE.DOUBLE_TAP_SLOP_PX`, through `createTapDisambiguator`), never a second copy of it.
 *
 * A SINGLE TAP IS NEVER HELD, EXCEPT ON A MEDIA THAT OPENS A VIEWER. Elsewhere the first click goes
 * on to its target at once: on post text it does nothing, and on a reel it toggles the player's
 * controls, which the second click toggles back - the pair cancels itself, so nothing waits. A
 * picture, a feed video or a reel in the FEED opens a full-screen viewer on its tap, which no
 * second tap can take back; so a target marked {@link DOUBLE_TAP_DEFERS} has its click held for the
 * double-tap window (the disambiguator's one timer, whose reason is written there) and replayed
 * when no second tap came. That wait is paid on those targets only.
 *
 * WHAT IS NEVER A TAP OF THIS GESTURE, and acts at once as before:
 * - a link, a button, a form field, a poll option, a mention - anything `tapBelongsToInnerControl`
 *   names - and anything inside `[data-no-double-tap]` (the action bar, the comments), a media
 *   opener there included (a comment's picture opens at once);
 * - a media opener nested in another control: a link preview's picture belongs to its link;
 * - a click with no pointer behind it (`detail === 0`): Enter or Space on a focused control, and a
 *   screen reader's activation. The heart button stays the accessible way to like;
 * - the click that ends a drag-selection of text (a range is selected);
 * - a sequence a drag or a second finger interrupts: a press that travels past
 *   `GESTURE.TAP_SLOP_PX`, or two pointers down, ends it - a held media tap included.
 *
 * A MOUSE DOUBLE CLICK DOES NOT SELECT A WORD on a likeable surface: its second `mousedown` is
 * prevented. A drag still selects; only the word-on-double-click is given up there.
 *
 * EVERY DECISION LOGS ONE LINE (`[doubleTapLike]`), and nothing logs per move or per scroll: a
 * WebView nobody can inspect (the iOS TestFlight build) must show on a re-reading whether the PRESSES
 * reached the surface, whether their CLICKS followed, and why a sequence ended. A press that ended as
 * a tap logs `press ended`; each click logs `click` with what it was to the surface; a sequence that
 * was under way and ended logs why. A double tap on a phone that logs two `press ended` and no
 * `click` is the engine swallowing the clicks (DT-IOS, 2026-10-21 - not reproduced with real taps).
 */

/** Marks a media opener whose tap is held for the double-tap window (see above). */
export const DOUBLE_TAP_DEFERS = 'data-double-tap-defers';

/** Marks a region of a likeable surface where a tap is never part of a double tap. */
export const NO_DOUBLE_TAP = 'data-no-double-tap';

export interface DoubleTapLikeParams {
  /**
   * A double tap landed on the surface. `at` is the second tap, relative to the surface's box -
   * where the heart is drawn. The caller decides whether it likes; the gesture only reports.
   */
  onDoubleTap: (at: Point) => void;
  /** Off, the surface is inert: no click is held, none is counted. Default on. */
  enabled?: boolean;
}

/** What a click's target is to a likeable surface (see `classify`). */
type TapTarget = { kind: 'owned' } | { kind: 'opener'; el: HTMLElement } | { kind: 'surface' };

/** Svelte action: wires the double tap on `node`. */
export function doubleTapLike(node: HTMLElement, initial: DoubleTapLikeParams) {
  let params = initial;
  /** The media opener whose click the pending single tap holds, or null for a tap that acted. */
  let heldOpener: HTMLElement | null = null;
  /** True while a held click is being replayed, so the capture listener lets it through. */
  let replaying = false;
  /** Where each pointer currently down on the surface was pressed. */
  const presses = new Map<number, Point>();

  const taps = createTapDisambiguator(
    {
      onSingle: () => {
        const opener = heldOpener;
        heldOpener = null;
        if (opener) replay(opener);
      },
      onDouble: (tap) => {
        heldOpener = null;
        const box = node.getBoundingClientRect();
        Log.d('doubleTapLike', 'double tap');
        params.onDoubleTap({ x: tap.x - box.left, y: tap.y - box.top });
      },
    },
    // The third tap of a quick burst belongs to the same gesture: no viewer opens behind a heart.
    { quietAfterDouble: true }
  );

  const enabled = () => params.enabled !== false;

  /** Ends the sequence: a held media tap is dropped, the next tap starts afresh. */
  function reset(reason: string) {
    // Only a sequence under way is worth a line: a scroll with nothing pending ends nothing.
    if (heldOpener || taps.pending()) {
      Log.d(
        'doubleTapLike',
        `sequence ended: ${reason}${heldOpener ? ' (held media tap dropped)' : ''}`
      );
    }
    heldOpener = null;
    taps.cancel();
  }

  /** Lets a held media click reach its opener, once the window closed with no second tap. */
  function replay(opener: HTMLElement) {
    if (!opener.isConnected) {
      Log.d('doubleTapLike', 'held media tap dropped: its opener left the page');
      return;
    }
    replaying = true;
    try {
      opener.click();
    } finally {
      replaying = false;
    }
  }

  /**
   * What a click on `target` is to this surface, decided in ONE order:
   * 1. inside a `[data-no-double-tap]` region (the action bar, the comments): not ours, whatever it
   *    is - a comment's picture opens at once and never counts towards a like of the post;
   * 2. a media opener (`[data-double-tap-defers]`): held for the window - UNLESS it sits inside
   *    another control. A link preview is an `<a>` around a picture, and that picture is the link's:
   *    it opens at once as before, so link previews are outside the gesture;
   * 3. any other control (`tapBelongsToInnerControl`): not ours;
   * 4. otherwise the surface itself: counted, and it acts at once.
   */
  function classify(target: Element | null): TapTarget {
    if (!target || typeof target.closest !== 'function') return { kind: 'owned' };
    const region = target.closest(`[${NO_DOUBLE_TAP}]`);
    if (region && node.contains(region)) return { kind: 'owned' };
    const opener = target.closest<HTMLElement>(`[${DOUBLE_TAP_DEFERS}]`);
    if (opener && node.contains(opener)) {
      const outer = opener.parentElement;
      if (outer && tapBelongsToInnerControl(outer, node)) return { kind: 'owned' };
      return { kind: 'opener', el: opener };
    }
    return tapBelongsToInnerControl(target, node) ? { kind: 'owned' } : { kind: 'surface' };
  }

  function onClick(e: MouseEvent) {
    if (replaying || !enabled()) return;
    if (e.detail === 0) {
      reset('a click with no pointer (keyboard or assistive technology)');
      return;
    }
    const verdict = classify(e.target as Element | null);
    Log.d('doubleTapLike', `click (detail ${e.detail}, ${verdict.kind})`);
    if (verdict.kind === 'owned') {
      reset('a control took the tap');
      return;
    }
    if (hasActiveTextSelection()) {
      reset('text is selected');
      return;
    }
    const opener = verdict.kind === 'opener' ? verdict.el : null;
    if (opener) {
      // Held, never lost: replayed by the disambiguator's single, or spent on the double.
      e.preventDefault();
      e.stopPropagation();
    }
    heldOpener = opener;
    // WHEN THE TAP HAPPENED, never when it was handled: on a busy phone the second click waits
    // behind the first one's work, and a clock read here would count that work into the gap.
    taps.tap({ x: e.clientX, y: e.clientY, t: e.timeStamp });
  }

  function onPointerDown(e: PointerEvent) {
    if (!enabled()) return;
    presses.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (presses.size > 1) reset('a second pointer');
  }

  function onPointerMove(e: PointerEvent) {
    const from = presses.get(e.pointerId);
    if (!from) return;
    if (Math.hypot(e.clientX - from.x, e.clientY - from.y) < GESTURE.TAP_SLOP_PX) return;
    // Forgotten once moved, so the rest of the drag costs nothing and ends nothing twice.
    presses.delete(e.pointerId);
    reset('a drag');
  }

  function onPointerUp(e: PointerEvent) {
    // A press still listed never travelled nor was cancelled: it ended as a tap, whatever the
    // engine then does with its click. The line is what tells a swallowed click from a lost press.
    if (presses.delete(e.pointerId))
      Log.d('doubleTapLike', `press ended (${e.pointerType || 'pointer'})`);
  }

  /** The engine took the press - a scroll or a pan began: that is a drag too. */
  function onPointerCancel(e: PointerEvent) {
    if (!presses.delete(e.pointerId)) return;
    reset('the engine took the press');
  }

  /** A mouse double click would select the word under it; on a likeable surface it likes instead. */
  function onMouseDown(e: MouseEvent) {
    if (!enabled() || e.detail !== 2) return;
    if (classify(e.target as Element | null).kind === 'owned') return;
    e.preventDefault();
  }

  node.addEventListener('click', onClick, { capture: true });
  node.addEventListener('pointerdown', onPointerDown, { capture: true });
  node.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  node.addEventListener('pointerup', onPointerUp, { capture: true });
  node.addEventListener('pointercancel', onPointerCancel, { capture: true });
  node.addEventListener('mousedown', onMouseDown, { capture: true });

  return {
    update(next: DoubleTapLikeParams) {
      params = next;
      if (!enabled()) {
        presses.clear();
        reset('disabled');
      }
    },
    destroy() {
      node.removeEventListener('click', onClick, { capture: true });
      node.removeEventListener('pointerdown', onPointerDown, { capture: true });
      node.removeEventListener('pointermove', onPointerMove, { capture: true });
      node.removeEventListener('pointerup', onPointerUp, { capture: true });
      node.removeEventListener('pointercancel', onPointerCancel, { capture: true });
      node.removeEventListener('mousedown', onMouseDown, { capture: true });
      taps.cancel();
    },
  };
}
