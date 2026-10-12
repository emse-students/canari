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
 * The range a centre may take on one axis, `half` from each edge, WIDENED to include `start` (where
 * the gesture began) when given. Never empty: a box wider than the frame has only the middle.
 */
function centreRange(half: number, start?: number): [number, number] {
  let low = half;
  let high = 1 - half;
  if (low > high) low = high = 0.5;
  if (start !== undefined) {
    low = Math.min(low, start);
    high = Math.max(high, start);
  }
  return [low, high];
}

/**
 * The transform kept inside the frame: the scale no larger than {@link fitScale}, then the centre
 * moved so the whole turned box lies within the frame. Applied on every move of a gesture, so what
 * the member sees during the drag is what the export will paint - never a clipped overlay.
 *
 * `from` is where the gesture began: the bounds are widened to include it, so a gesture never
 * pushes an overlay FURTHER out than it was and never makes it jump. That is the case of a stroke
 * drawn to the frame's edge, whose round cap and the inset stick out of the bounds from the start:
 * moved inwards it is held to the frame, and it was never placed outside by this rule.
 */
export function keptInFrame(
  transform: Transform,
  extent: OverlayExtent,
  frame: StageSize,
  from?: Transform
): Transform {
  if (frame.width <= 0 || frame.height <= 0) return transform;
  const fit = fitScale(extent, transform.rotation, frame);
  const scale = Math.min(transform.scale, from ? Math.max(fit, from.scale) : fit);
  const half = halfExtents(extent, scale, transform.rotation, frame);
  const [left, right] = centreRange(half.x, from?.x);
  const [top, bottom] = centreRange(half.y, from?.y);
  return {
    ...transform,
    scale,
    x: clamp(transform.x, left, right),
    y: clamp(transform.y, top, bottom),
  };
}

/**
 * Where an overlay settles when the finger lets go anywhere but the trash: inside the frame (as
 * {@link keptInFrame}, with the same `from`) AND with its centre clear of the header and the tray,
 * moved vertically to the nearest such place. When the controls leave no room at all, the centre
 * takes the middle of the space between them, still inside the frame: never clipped does not give way.
 */
export function settledClearOfControls(
  transform: Transform,
  extent: OverlayExtent,
  frame: StageSize,
  bands: ControlBands,
  from?: Transform
): Transform {
  const kept = keptInFrame(transform, extent, frame, from);
  if (frame.width <= 0 || frame.height <= 0) return kept;
  const half = halfExtents(extent, kept.scale, kept.rotation, frame);
  const [frameTop, frameBottom] = centreRange(half.y, from?.y);
  const top = clamp(bands.top, 0, 1);
  const bottom = clamp(1 - bands.bottom, 0, 1);
  const low = Math.max(frameTop, top);
  const high = Math.min(frameBottom, bottom);
  const y =
    low <= high ? clamp(kept.y, low, high) : clamp((top + bottom) / 2, frameTop, frameBottom);
  return { ...kept, y };
}

/**
 * Where an overlay goes after something changed its size without a finger on it (a restyle, a
 * reword). With the text field open, ONLY the frame rule ({@link keptInFrame}, no gesture to widen
 * the bounds): the keyboard is up and has shrunk the stage the tray rides on, so settling against
 * the controls then would answer for a layout that is about to change. Restyling to a wider face
 * (serif, a background box) used to push the box past the screen edge for the whole edit, and "OK"
 * then moved it 73 px at once (Mi 9T, 2026-10-12); kept in the frame as it grows, the commit's
 * settle has no width left to correct. With the field closed, the full release rule.
 */
export function placedAfterResize(
  transform: Transform,
  extent: OverlayExtent,
  frame: StageSize,
  bands: ControlBands,
  composing: boolean
): Transform {
  return composing
    ? keptInFrame(transform, extent, frame)
    : settledClearOfControls(transform, extent, frame, bands);
}

/**
 * Whether a release settles the overlay. NOT while the text field is open: the keyboard is up, and
 * the settle runs once on commit instead. NOT after a tap: a gesture that changed nothing moves
 * nothing and takes no undo step.
 */
export function settlesOnRelease(composing: boolean, layoutChanged: boolean): boolean {
  return !composing && layoutChanged;
}

/**
 * The control bands, as they stand with the keyboard CLOSED whatever it is doing now: the header
 * from its bottom edge, and the tray from its HEIGHT laid against the bottom of the latched stage.
 * The tray rides above the keyboard, so its top edge measures the keyboard; its height does not.
 * The frame is centred in the latched stage (`containFrame`), so that stage's bottom is the frame's
 * bottom plus the frame's offset from the stage's top. A control with no box covers nothing.
 */
export function controlBands(
  frame: { top: number; height: number },
  stageTop: number,
  header: { bottom: number; height: number } | null,
  trayHeight: number
): ControlBands {
  if (frame.height <= 0) return NO_BANDS;
  const stageBottom = frame.top + frame.height + (frame.top - stageTop);
  const top = header && header.height > 0 ? (header.bottom - frame.top) / frame.height : 0;
  const bottom =
    trayHeight > 0 ? (frame.top + frame.height - (stageBottom - trayHeight)) / frame.height : 0;
  return { top: clamp(top, 0, 1), bottom: clamp(bottom, 0, 1) };
}
