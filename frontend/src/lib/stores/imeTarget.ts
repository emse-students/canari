/**
 * THE KEYBOARD'S HEIGHT, TOLD BY THE NATIVE SHELL BEFORE THE WEBVIEW IS RESIZED FOR IT
 * (docs/wiki/frontend/keyboard-and-send-motion.md) - Android's `MainActivity` and iOS's
 * `canari_ios.mm` (`CanariHandKeyboardRiseToPage`), on one contract.
 *
 * Messenger lays its screen out for the keyboard on the first frame of the rise. The Android app
 * cannot by resizing: the WebView shows its last frame cropped to the new size until the page has
 * drawn again (128 ms, 8 frames on the Mi 9T, 2026-11-13), and the composer is cut off meanwhile.
 * So `MainActivity` tells the page the keyboard's height FIRST (`window.canariImeTarget`), the page
 * lays itself out for it inside the full-size WebView, and the padding lands once that frame is
 * drawn. The iPhone shows the same defect in another shape - its WebView frame, animated with the
 * keyboard, slid the page up BEHIND the keyboard (~150 ms, iPhone 12, 2026-11-13) - and takes the
 * same cure. This module is the page's half of that contract, kept pure for its tests.
 */
import type { ViewportMeasurement } from './keyboardViewport.svelte';

/** How far a height may move and still be the same height, in CSS px - see `keyboardViewport`. */
const SAME_HEIGHT_PX = 2;

export type ImeTargetResolution = {
  /** The measurement the keyboard store must read now. */
  measurement: ViewportMeasurement;
  /** True when the target is spent and must be forgotten. */
  drop: boolean;
};

/**
 * What the viewport measures while an announced keyboard has not yet reached it.
 *
 * Until the real resize arrives, the page is laid out as it WILL be after it: the layout and visual
 * viewports both `baseline - target` tall, nothing panned. That is exactly what the resize then
 * measures, so the resize changes nothing on screen. The target is spent - and the real measurement
 * read - as soon as either viewport has given up height of its own (the padding landed, or the
 * WebView shrank its visual viewport by itself), or when the shell announces 0 (the keyboard fell).
 *
 * @param m the raw viewport measurement.
 * @param baselineHeight the tallest the layout viewport has been with no keyboard.
 * @param targetPx the keyboard height the shell announced, in CSS px, or null.
 */
export function resolveImeTarget(
  m: ViewportMeasurement,
  baselineHeight: number,
  targetPx: number | null
): ImeTargetResolution {
  if (targetPx === null) return { measurement: m, drop: false };
  if (!(targetPx > 0)) return { measurement: m, drop: true };
  const reached =
    baselineHeight - m.winH > SAME_HEIGHT_PX || baselineHeight - m.vvHeight > SAME_HEIGHT_PX;
  if (reached) return { measurement: m, drop: true };
  const height = Math.max(0, baselineHeight - targetPx);
  return {
    measurement: { winH: height, vvHeight: height, offsetTop: 0, scale: m.scale },
    drop: false,
  };
}

/**
 * Parses what the shell passed to `window.canariImeTarget`: a finite, non-negative number of CSS
 * px, or null for anything else (the caller logs it and answers `false`, so the shell pads at once).
 */
export function parseImeTarget(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
