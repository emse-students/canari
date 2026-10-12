/**
 * WHERE AN OVERLAY OF THE CANAREELS EDITOR MAY BE (docs/wiki/frontend/modules/reel-editor.md): its
 * WHOLE box stays inside the frame, so the export never publishes it clipped at the frame edge, and
 * when the finger lets go its CENTRE is clear of the header and the tool tray, so the point a finger
 * grabs is never under a control (nor reachable only at the screen edge, where Android takes the
 * touch as its Back gesture). Pure geometry, so a test holds every rule.
 *
 * Units: an overlay's EXTENT is its unrotated box at scale 1 in units of the frame's SHORT side (the
 * unit `reelOverlays.ts` sizes everything in); its centre is in 0..1 of the frame, as everywhere else.
 */
import type { Transform } from '$lib/gestures/transformGesture';
import type { StageSize } from './reelFrame';
import { EMOJI_BASE_SIZE, type ReelOverlay } from './reelOverlays';
import { strokeBox } from './reelStrokes';

/** An overlay's unrotated box at scale 1, in units of the frame's short side. */
export interface OverlayExtent {
  width: number;
  height: number;
}

/**
 * The shares of the frame's height the controls cover: the header from the top, the tool tray from
 * the bottom. A finger released there would leave the overlay's centre under a control.
 */
export interface ControlBands {
  top: number;
  bottom: number;
}

/** No control covers the frame. */
export const NO_BANDS: ControlBands = { top: 0, bottom: 0 };

/**
 * An overlay's extent. An emoji and a stroke know theirs from the data; a text's depends on the
 * typeface's metrics, so the caller passes the box the screen drew (`measuredText`, CSS px at the
 * overlay's current scale) - the same font the export measures - and `shortSide`, the frame's short
 * side in the same px.
 */
export function overlayExtent(
  overlay: ReelOverlay,
  measuredText: StageSize | null,
  shortSide: number
): OverlayExtent {
  if (overlay.kind === 'emoji') return { width: EMOJI_BASE_SIZE, height: EMOJI_BASE_SIZE };
  if (overlay.kind === 'stroke') {
    const box = strokeBox(overlay);
    return { width: box.width, height: box.height };
  }
  if (!measuredText || shortSide <= 0 || overlay.scale <= 0) return { width: 0, height: 0 };
  const unit = shortSide * overlay.scale;
  return { width: measuredText.width / unit, height: measuredText.height / unit };
}

/**
 * The margin an overlay keeps from every frame edge, as a share of the short side: the frame's
 * rounded corners (`--radius-2xl`, 12 px) and a measured width rounded to whole pixels must never be
 * what decides whether its last glyph is published.
 */
export const OVERLAY_EDGE_INSET = 0.02;

/** The turned box's half-extents at scale 1 (shares of the frame) and the edge inset (same unit). */
function unitBox(extent: OverlayExtent, rotation: number, frame: StageSize) {
  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  const shortSide = Math.min(frame.width, frame.height);
  const boxWidth = (extent.width * cos + extent.height * sin) * shortSide;
  const boxHeight = (extent.width * sin + extent.height * cos) * shortSide;
  const inset = OVERLAY_EDGE_INSET * shortSide;
  return {
    x: boxWidth / 2 / frame.width,
    y: boxHeight / 2 / frame.height,
    insetX: inset / frame.width,
    insetY: inset / frame.height,
  };
}

/** How far the centre must stay from each edge at `scale`: half the turned box plus the inset. */
function halfExtents(extent: OverlayExtent, scale: number, rotation: number, frame: StageSize) {
  const unit = unitBox(extent, rotation, frame);
  return { x: unit.x * scale + unit.insetX, y: unit.y * scale + unit.insetY };
}

/**
 * The largest scale at which the overlay, turned by `rotation`, fits inside the frame less its edge
 * inset. Infinity for an overlay with no extent (a text the screen has not measured yet).
 */
export function fitScale(extent: OverlayExtent, rotation: number, frame: StageSize): number {
  const unit = unitBox(extent, rotation, frame);
  const limit = (half: number, inset: number) => (half > 0 ? (0.5 - inset) / half : Infinity);
  return Math.min(limit(unit.x, unit.insetX), limit(unit.y, unit.insetY));
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * The transform kept inside the frame: the scale no larger than {@link fitScale}, then the centre
 * moved so the whole turned box lies within the frame. Applied on every move of a gesture, so what
 * the member sees during the drag is what the export will paint - never a clipped overlay.
 */
export function keptInFrame(
  transform: Transform,
  extent: OverlayExtent,
  frame: StageSize
): Transform {
  if (frame.width <= 0 || frame.height <= 0) return transform;
  const scale = Math.min(transform.scale, fitScale(extent, transform.rotation, frame));
  const half = halfExtents(extent, scale, transform.rotation, frame);
  return {
    ...transform,
    scale,
    x: clamp(transform.x, half.x, 1 - half.x),
    y: clamp(transform.y, half.y, 1 - half.y),
  };
}

/**
 * Where an overlay settles when the finger lets go anywhere but the trash: inside the frame (as
 * {@link keptInFrame}) AND with its centre clear of the header and the tray, moved vertically to the
 * nearest such place. When the controls leave no room at all, the centre takes the middle of the
 * space between them, still inside the frame: never clipped is the rule that does not give way.
 */
export function settledClearOfControls(
  transform: Transform,
  extent: OverlayExtent,
  frame: StageSize,
  bands: ControlBands
): Transform {
  const kept = keptInFrame(transform, extent, frame);
  if (frame.width <= 0 || frame.height <= 0) return kept;
  const half = halfExtents(extent, kept.scale, kept.rotation, frame);
  const top = clamp(bands.top, 0, 1);
  const bottom = clamp(1 - bands.bottom, 0, 1);
  const low = Math.max(half.y, top);
  const high = Math.min(1 - half.y, bottom);
  const y = low <= high ? clamp(kept.y, low, high) : clamp((top + bottom) / 2, half.y, 1 - half.y);
  return { ...kept, y };
}

/**
 * The control bands from the boxes on screen: the share of the frame's height under the header's
 * bottom edge and above the tray's top edge. A control with no box (not laid out) covers nothing.
 */
export function controlBands(
  frame: { top: number; height: number },
  header: { bottom: number; height: number } | null,
  tray: { top: number; height: number } | null
): ControlBands {
  if (frame.height <= 0) return NO_BANDS;
  const top = header && header.height > 0 ? (header.bottom - frame.top) / frame.height : 0;
  const bottom = tray && tray.height > 0 ? (frame.top + frame.height - tray.top) / frame.height : 0;
  return { top: clamp(top, 0, 1), bottom: clamp(bottom, 0, 1) };
}
