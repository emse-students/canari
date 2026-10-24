/**
 * The camera's zoom: a finger held on the shutter slides UP to zoom in and DOWN to zoom out
 * (user, 2026-10-22: Snapchat's and Instagram's gesture). The arithmetic is here, pure, so the
 * mapping, the clamp and the reset are tested without a camera.
 *
 * TWO MODES, ONE GESTURE (user decision, 2026-10-22 - not a fallback). A lens whose track lists a
 * `zoom` capability is zoomed by the HARDWARE (`applyConstraints`), so the sensor's own optics and
 * crop do the work and the preview and the take both receive the zoomed frame. A lens without one
 * (expected on iOS's WKWebView, which lists no `zoom`) is zoomed DIGITALLY: the preview is enlarged
 * by a CSS scale about its centre, and every capture (photo, thumbnail, take) draws the SAME centred
 * sub-rectangle of the preview's crop ({@link digitalZoomCrop}), so the file shows what the preview
 * showed. Which mode a lens got is a fact of the track, logged once per session per mode.
 */
import type { CropRect } from './framedCapture';

/** How the open lens is zoomed. */
export type ZoomMode = 'hardware' | 'digital';

/** The zoom a lens offers: its mode and the levels it may take. */
export interface ZoomRange {
  mode: ZoomMode;
  min: number;
  max: number;
}

/** The digital zoom's ceiling: past 5x a phone-screen crop is a few hundred pixels wide. */
export const DIGITAL_ZOOM_MAX = 5;

/**
 * How far the finger travels, in CSS px, to cross the WHOLE range. About a third of a phone's
 * height above the shutter, so the full range is reachable with the thumb that holds the take.
 */
export const ZOOM_DRAG_FULL_RANGE_PX = 300;

/** The digital range: 1x to {@link DIGITAL_ZOOM_MAX}. */
export const DIGITAL_ZOOM_RANGE: ZoomRange = { mode: 'digital', min: 1, max: DIGITAL_ZOOM_MAX };

/**
 * The range of `track`: its own `zoom` capability when it lists a usable one (`max > min`), the
 * digital range otherwise.
 */
export function zoomRangeFor(track: MediaStreamTrack | undefined): ZoomRange {
  if (!track || typeof track.getCapabilities !== 'function') return DIGITAL_ZOOM_RANGE;
  const caps = track.getCapabilities() as MediaTrackCapabilities & {
    zoom?: { min?: number; max?: number };
  };
  const min = caps.zoom?.min;
  const max = caps.zoom?.max;
  if (typeof min !== 'number' || typeof max !== 'number' || !(max > min) || !(min > 0)) {
    return DIGITAL_ZOOM_RANGE;
  }
  return { mode: 'hardware', min, max };
}

/** `level` brought inside the range. */
export function clampZoom(level: number, range: ZoomRange): number {
  if (!Number.isFinite(level)) return restingZoom(range);
  return Math.min(range.max, Math.max(range.min, level));
}

/** The level a lens rests at - 1x, inside its range - on a lens flip and on a new take. */
export function restingZoom(range: ZoomRange): number {
  return Math.min(range.max, Math.max(range.min, 1));
}

/**
 * The level after a drag of `upPx` (positive UP, negative down) that began at `startLevel`.
 *
 * LOGARITHMIC, so each pixel multiplies the zoom by the same factor: 1x to 2x takes the same travel as
 * 2x to 4x, which is how an optical zoom feels. Continuous - no steps - and clamped to the range.
 */
export function zoomFromDrag(startLevel: number, upPx: number, range: ZoomRange): number {
  if (range.max <= range.min) return range.min;
  const span = Math.log(range.max / range.min);
  const start = Math.log(clampZoom(startLevel, range) / range.min) / span;
  const t = Math.min(1, Math.max(0, start + upPx / ZOOM_DRAG_FULL_RANGE_PX));
  // The ends are the range's own numbers, never a float a hair short of them.
  if (t === 0) return range.min;
  if (t === 1) return range.max;
  return clampZoom(range.min * Math.exp(t * span), range);
}

/**
 * The centred part of `crop` a DIGITAL zoom of `level` shows: the preview's CSS scale about its centre
 * is exactly this sub-rectangle, so drawing it reproduces the preview. Level 1 (or below) is `crop`.
 */
export function digitalZoomCrop(crop: CropRect, level: number): CropRect {
  if (!(level > 1)) return crop;
  const sw = crop.sw / level;
  const sh = crop.sh / level;
  return { sx: crop.sx + (crop.sw - sw) / 2, sy: crop.sy + (crop.sh - sh) / 2, sw, sh };
}
