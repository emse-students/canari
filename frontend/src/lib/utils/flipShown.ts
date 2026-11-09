import { flip, type AnimationConfig, type FlipParams } from 'svelte/animate';

/**
 * Whether a box has nothing to draw: `display: none` (its own or an ancestor's) reports a 0 x 0 rect.
 */
const isEmptyBox = (r: DOMRect): boolean => r.width === 0 || r.height === 0;

/**
 * `flip`, for a row that can be HIDDEN when its list changes - and no animation at all then.
 *
 * Svelte runs an `animate:` directive whenever a keyed list is reconciled and an item's box moved.
 * On a phone the community rail and the salon rows are `display: none` while a salon is open, and
 * the open itself hides them in the same flush that hands the list fresh objects (the listing
 * reconcile of a boot, an unread count). Every row's box then "moved" from where it was drawn to
 * 0 x 0, and `flip` divides by that 0: `translate(NaNpx, NaNpx) scale(Infinity, Infinity)`. The
 * engine refused each keyframe with a warning - 108 per salon open on the bench, the same storm the
 * Mi 9T's log carried (2026-11-02) - after `flip` had read each hidden row's computed style and
 * client size on the open's own task. A box that appears or disappears has no path to slide along,
 * so the honest animation is none: a zero duration, which Svelte answers without touching the
 * element.
 *
 * @param node The animated row.
 * @param rects Where it was before the reconcile and where it is after.
 * @param params `flip`'s own parameters, passed through when both boxes are drawn.
 */
export function flipShown(
  node: Element,
  rects: { from: DOMRect; to: DOMRect },
  params?: FlipParams
): AnimationConfig {
  if (isEmptyBox(rects.from) || isEmptyBox(rects.to)) return { duration: 0 };
  return flip(node, rects, params);
}
