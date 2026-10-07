/**
 * THE GEOMETRY OF A DRAWN STROKE (docs/wiki/frontend/modules/reel-editor.md): how a finger's path
 * becomes a `ReelStrokeOverlay`, how big its box is, whether an eraser touches it, and the layout
 * history behind undo. Pure, so the editor, the export and the tests read the same numbers.
 *
 * A stroke's points are in units of the frame's SHORT side relative to the stroke's own centre, so
 * the overlay's `{ x, y, scale, rotation }` moves it like a text or an emoji, and the preview (SVG
 * in `cqmin`) and the export (canvas, times `min(width, height)`) agree.
 */
import { newOverlayId, type ReelOverlay, type ReelStrokeOverlay } from './reelOverlays';

/** The pen widths of the width row, as shares of the short side: thin, medium, thick. */
export const STROKE_WIDTHS = [0.006, 0.012, 0.024] as const;
/** The eraser's reach, as a share of the short side. */
export const ERASER_RADIUS = 0.03;
/** How many undo steps are kept. */
export const MAX_UNDO_STEPS = 30;

/** A pointer position in the frame's own pixels. */
export interface FramePoint {
  x: number;
  y: number;
}

/**
 * The overlay for a finger path (frame pixels, in a frame of `width` x `height`), or null for a path
 * too short to be a line. The overlay's centre is the middle of the path's bounding box.
 */
export function createStrokeOverlay(
  path: FramePoint[],
  width: number,
  height: number,
  color: string,
  strokeWidth: number
): ReelStrokeOverlay | null {
  if (path.length < 2 || width <= 0 || height <= 0) return null;
  const xs = path.map((p) => p.x);
  const ys = path.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const short = Math.min(width, height);
  return {
    id: newOverlayId(),
    kind: 'stroke',
    color,
    width: strokeWidth,
    points: path.map((p) => ({ x: (p.x - cx) / short, y: (p.y - cy) / short })),
    x: cx / width,
    y: cy / height,
    scale: 1,
    rotation: 0,
  };
}

/** The box a stroke is drawn in, centred on its origin, padded by half a line width so caps never clip. */
export function strokeBox(stroke: Pick<ReelStrokeOverlay, 'points' | 'width'>) {
  const reach = (axis: 'x' | 'y') => Math.max(...stroke.points.map((p) => Math.abs(p[axis])), 0);
  // The path is centred on its bounding box, so |min| and |max| are equal up to rounding.
  const halfWidth = reach('x') + stroke.width / 2;
  const halfHeight = reach('y') + stroke.width / 2;
  return { x: -halfWidth, y: -halfHeight, width: 2 * halfWidth, height: 2 * halfHeight };
}

/** The distance from (px, py) to the segment (ax, ay)-(bx, by). */
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Whether an eraser at `point` (frame pixels) touches the stroke: the point is taken back through
 * the stroke's translation, rotation and scale into its own units, then compared with the line.
 */
export function strokeTouched(
  stroke: ReelStrokeOverlay,
  point: FramePoint,
  width: number,
  height: number,
  radius = ERASER_RADIUS
): boolean {
  const short = Math.min(width, height);
  const dx = point.x - stroke.x * width;
  const dy = point.y - stroke.y * height;
  const cos = Math.cos(-stroke.rotation);
  const sin = Math.sin(-stroke.rotation);
  const scaleBy = short * stroke.scale;
  const lx = (dx * cos - dy * sin) / scaleBy;
  const ly = (dx * sin + dy * cos) / scaleBy;
  const reach = radius / stroke.scale + stroke.width / 2;
  const pts = stroke.points;
  for (let i = 1; i < pts.length; i += 1) {
    if (distanceToSegment(lx, ly, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= reach) {
      return true;
    }
  }
  return false;
}

/** The overlays without every stroke the eraser at `point` touches; the same array when it touches none. */
export function erasedAt(
  overlays: ReelOverlay[],
  point: FramePoint,
  width: number,
  height: number
): ReelOverlay[] {
  const kept = overlays.filter(
    (overlay) => overlay.kind !== 'stroke' || !strokeTouched(overlay, point, width, height)
  );
  return kept.length === overlays.length ? overlays : kept;
}

/** Whether any overlay moved, scaled, turned, appeared or vanished between two layouts (order aside). */
export function layoutChanged(before: ReelOverlay[], after: ReelOverlay[]): boolean {
  if (before.length !== after.length) return true;
  const was = new Map(before.map((o) => [o.id, o]));
  return after.some((o) => {
    const prior = was.get(o.id);
    return (
      !prior ||
      prior.x !== o.x ||
      prior.y !== o.y ||
      prior.scale !== o.scale ||
      prior.rotation !== o.rotation
    );
  });
}

/** The undo stack with `overlays` pushed on it, oldest dropped past {@link MAX_UNDO_STEPS}. */
export function pushedHistory(history: ReelOverlay[][], overlays: ReelOverlay[]): ReelOverlay[][] {
  return [...history, overlays].slice(-MAX_UNDO_STEPS);
}
