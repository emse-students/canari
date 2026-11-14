/**
 * THE KEYBOARD'S HEIGHT, TOLD BY THE NATIVE SHELL (docs/wiki/frontend/keyboard-and-send-motion.md) -
 * Android's `MainActivity` and iOS's `canari_ios.mm` (`CanariHandKeyboardRiseToPage`), through ONE
 * hook, `window.canariImeTarget`, in two forms.
 *
 * - **A bare number: iOS's rise, a HAND-OFF.** The shell tells the page the keyboard's height before
 *   it shrinks the WebView, the page lays itself out as the shrink will measure, and the target is
 *   spent once the WebView has shrunk. The iPhone's WebView frame, animated with the keyboard, slid
 *   the page up BEHIND the keys otherwise (~150 ms, iPhone 12, 2026-11-13).
 * - **An object `{ px, durationMs?, curve? }`: Android, an OVERLAY (2026-11-14).** The shell never
 *   resizes the WebView: a resize showed the last frame cropped or stretched until the page drew again
 *   (8 frames on a rise, 13 on a fall). The keyboard covers the window's bottom, the layout keeps its
 *   full height, and the announcement is the ONE source of the keyboard's room for as long as the page
 *   lives - 0 included. `durationMs` and `curve` (the system interpolator sampled to points) are there
 *   when the keyboard moves animated, so the page can ride it (`keyboardRide.ts`).
 *
 * This module is the page's half of that contract, kept pure for its tests.
 */
import type { ViewportMeasurement } from './keyboardViewport.svelte';
import { linearEasing } from './keyboardRide';

/** How far a height may move and still be the same height, in CSS px - see `keyboardViewport`. */
const SAME_HEIGHT_PX = 2;

/** The keyboard animation the Android shell saw in `onPrepare`: its duration and its CSS easing. */
export type ImeAnimation = { durationMs: number; easing: string };

/** What `window.canariImeTarget` was told, parsed. */
export type ImeTarget =
  /** iOS's rise: the WebView will shrink by `px`, and the target is spent when it has. */
  | { kind: 'handoff'; px: number }
  /** Android: the keyboard covers `px` of the window, which is never resized for it. */
  | { kind: 'overlay'; px: number; animation: ImeAnimation | null };

export type ImeTargetResolution = {
  /** The measurement the keyboard store must read now. */
  measurement: ViewportMeasurement;
  /** True when the target is spent and must be forgotten. */
  drop: boolean;
};

/**
 * What the viewport measures while a target holds.
 *
 * A HAND-OFF lays the page out as it WILL be after the resize: the layout and visual viewports both
 * `baseline - px` tall, nothing panned. That is exactly what the resize then measures, so the resize
 * changes nothing on screen. It is spent - and the real measurement read - as soon as either viewport
 * has given up height of its own, or when the shell announces 0 (the keyboard fell).
 *
 * An OVERLAY is never spent by the viewport: the layout keeps the window's REAL height (`m.winH`,
 * `innerHeight`), the visual viewport is that height less `px`, and `overlayPx` tells
 * `computeSnapshot` that the keyboard covers the window rather than shrinking it. The real height and
 * not the baseline: the shell never resizes the WebView for the keyboard, so `innerHeight` is already
 * keyboard-free, and it is the only number that follows a window resized for any OTHER reason - split
 * screen, a freeform window, DeX, a foldable unfolding. The baseline only grows (it is the tallest
 * keyboard-free height seen), so a shell pinned to it stood 870 px tall in a 450 px window (review of
 * #3556, F1). What the WebView reports about its visual viewport is not read: the shell is the one
 * source of the keyboard's room.
 *
 * @param m the raw viewport measurement.
 * @param baselineHeight the tallest the layout viewport has been with no keyboard (the hand-off's).
 * @param target what the shell announced, or null.
 */
export function resolveImeTarget(
  m: ViewportMeasurement,
  baselineHeight: number,
  target: ImeTarget | null
): ImeTargetResolution {
  if (target === null) return { measurement: m, drop: false };
  if (target.kind === 'overlay') {
    const px = Math.min(target.px, m.winH);
    return {
      measurement: {
        winH: m.winH,
        vvHeight: m.winH - px,
        offsetTop: 0,
        scale: m.scale,
        overlayPx: px,
      },
      drop: false,
    };
  }
  if (!(target.px > 0)) return { measurement: m, drop: true };
  const reached =
    baselineHeight - m.winH > SAME_HEIGHT_PX || baselineHeight - m.vvHeight > SAME_HEIGHT_PX;
  if (reached) return { measurement: m, drop: true };
  const height = Math.max(0, baselineHeight - target.px);
  return {
    measurement: { winH: height, vvHeight: height, offsetTop: 0, scale: m.scale },
    drop: false,
  };
}

/** A finite, non-negative number. */
function finiteNonNegative(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * Parses what the shell passed to `window.canariImeTarget`, or null for anything else (the caller
 * logs it and answers `false`).
 *
 * A bare finite non-negative number is iOS's hand-off. An object needs a finite non-negative `px`,
 * and either no animation at all or BOTH a finite non-negative `durationMs` and a `curve` that
 * {@link linearEasing} accepts (2 to 64 finite points) - half an animation is a broken contract, not a
 * keyboard without one.
 */
export function parseImeTarget(value: unknown): ImeTarget | null {
  if (finiteNonNegative(value)) return { kind: 'handoff', px: value };
  if (typeof value !== 'object' || value === null) return null;
  const { px, durationMs, curve } = value as Record<string, unknown>;
  if (!finiteNonNegative(px)) return null;
  if (durationMs === undefined && curve === undefined) {
    return { kind: 'overlay', px, animation: null };
  }
  if (!finiteNonNegative(durationMs)) return null;
  const easing = linearEasing(curve);
  if (easing === null) return null;
  return { kind: 'overlay', px, animation: { durationMs, easing } };
}
