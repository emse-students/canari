/**
 * The poster directory's font fit, as a function anything can call.
 *
 * It lived inside a `requestAnimationFrame` in `PosterCanvas.svelte`, which is exactly where an
 * export could not reach it: a browser throttles rAF in a hidden tab, so the first PDF exported on
 * 2026-09-27 captured the UNFITTED base size and three associations fell off the page. The export
 * runs it itself now, synchronously, before the capture.
 */
import { DIRECTORY_BASE_FONT } from './layout';
import { Log } from '$lib/utils/Log';

/** Marks the fixed-height, clipped directory body - the box the roster has to fit. */
export const DIRECTORY_BODY_ATTR = 'data-carte-directory-body';
/** Marks the multi-column content whose font size is stepped down. */
export const DIRECTORY_CONTENT_ATTR = 'data-carte-directory-content';

/** How far the fit may shrink the base size before it stops: half, and no further. */
const MIN_FIT_RATIO = 0.5;
/** One step of the ladder (px). */
const STEP = 0.5;

/** The two boxes the fit measures. Narrow on purpose, so a test can stand in for the DOM. */
export interface FittableDirectory {
  /** The clipping box's height. */
  readonly clientHeight: number;
  /** The content's laid-out height at the current font size. */
  readonly scrollHeight: number;
  /** Set imperatively - reactive state here would re-trigger the measurement loop. */
  readonly style: { fontSize: string };
}

/**
 * Shrinks the directory font until the whole roster fits its column.
 *
 * Idempotent: it starts from {@link DIRECTORY_BASE_FONT} every time, so running it again after the
 * layout settled yields the same answer rather than compounding the last one.
 *
 * @param body - The clipping box.
 * @param content - The list, whose font size is written. Item text is in em, so the wrapper's size
 *   scales the whole list.
 * @returns The size it settled on (px).
 */
export function fitDirectoryFont(body: FittableDirectory, content: FittableDirectory): number {
  let font = DIRECTORY_BASE_FONT;
  content.style.fontSize = `${font}px`;
  const floor = DIRECTORY_BASE_FONT * MIN_FIT_RATIO;
  while (content.scrollHeight > body.clientHeight && font > floor) {
    font -= STEP;
    content.style.fontSize = `${font}px`;
  }
  return font;
}

/**
 * Runs the fit on whichever directory a poster element contains.
 *
 * @param root - A poster stage.
 * @returns The size it settled on, or null when this poster draws no directory (the author can hide
 *   it), which is not a failure and is why nothing throws here.
 */
export function fitDirectoryFontIn(root: HTMLElement): number | null {
  const body = root.querySelector<HTMLElement>(`[${DIRECTORY_BODY_ATTR}]`);
  const content = root.querySelector<HTMLElement>(`[${DIRECTORY_CONTENT_ATTR}]`);
  if (!body || !content) {
    Log.d('carte.directoryFit skipped', { body: Boolean(body), content: Boolean(content) });
    return null;
  }
  const font = fitDirectoryFont(body, content);
  Log.d('carte.directoryFit fitted', { font });
  return font;
}
