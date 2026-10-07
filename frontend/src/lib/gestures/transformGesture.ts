/**
 * THE ONE GESTURE MODEL FOR MOVING, RESIZING AND ROTATING A PICTURE-LIKE ELEMENT WITH FINGERS
 * (CanaReels editor, docs/wiki/frontend/modules/reel-editor.md): one finger drags, two fingers pinch
 * to resize and twist to rotate - Instagram's story editor. It is pure (no DOM, no clock), so every
 * rule below is a unit test, and a new kind of overlay needs no gesture code of its own: it hands
 * its {@link Transform} in and renders the one that comes out.
 *
 * It tracks pointers by id and is told about them by the caller's pointer events. It applies
 * INCREMENTS (this move's change of centroid, distance and angle), never a difference from a
 * start, so a finger lifting or landing mid-gesture simply restarts the reference without a jump,
 * and a twist past half a turn keeps turning instead of wrapping back.
 */

/** A point in whatever space the caller reports pointers in (client pixels). */
export interface Point {
  x: number;
  y: number;
}

/** An element's placement: its CENTRE in 0..1 of the stage, a scale (1 = base size), radians. */
export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

/** A pinch cannot shrink an element into nothing, nor grow it past what a hand can still grab. */
export const MIN_OVERLAY_SCALE = 0.3;
export const MAX_OVERLAY_SCALE = 8;

/** A pointer that travelled less than this (px) between down and up was a TAP, not a drag. */
export const TAP_SLOP_PX = 8;

/** Keeps a scale within what the editor allows. */
export function clampScale(scale: number): number {
  return Math.min(MAX_OVERLAY_SCALE, Math.max(MIN_OVERLAY_SCALE, scale));
}

/** An angle difference folded into (-PI, PI], so crossing the +-PI seam is a small step. */
export function wrapAngle(delta: number): number {
  let wrapped = delta;
  while (wrapped > Math.PI) wrapped -= 2 * Math.PI;
  while (wrapped <= -Math.PI) wrapped += 2 * Math.PI;
  return wrapped;
}

/** The centre stays on the stage: an element dragged fully off it could never be grabbed again. */
export function clampCentre(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** True when `point` lies in `rect`, grown by `margin` px on every side (a generous drop zone). */
export function pointInRect(
  point: Point,
  rect: { left: number; top: number; right: number; bottom: number },
  margin = 0
): boolean {
  return (
    point.x >= rect.left - margin &&
    point.x <= rect.right + margin &&
    point.y >= rect.top - margin &&
    point.y <= rect.bottom + margin
  );
}

interface Reference {
  centroid: Point;
  distance: number;
  angle: number;
}

function reference(points: Point[]): Reference {
  const [a, b] = points;
  if (!b) return { centroid: { ...a }, distance: 0, angle: 0 };
  return {
    centroid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    distance: Math.hypot(b.x - a.x, b.y - a.y),
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

/** One element's gesture: feed it the pointer events, read back the transform. */
export class TransformGesture {
  private readonly pointers = new Map<number, Point>();
  private transform: Transform = { x: 0.5, y: 0.5, scale: 1, rotation: 0 };
  private last: Reference | null = null;
  private travelled = 0;

  /** @param stageSize The stage's size in the same pixels as the pointers (read at each move). */
  constructor(private readonly stageSize: () => { width: number; height: number }) {}

  /** True while at least one finger is down. */
  get active(): boolean {
    return this.pointers.size > 0;
  }

  /** How many fingers are down (at most two are used). */
  get pointerCount(): number {
    return this.pointers.size;
  }

  /** The distance the gesture's pointers moved in total (px): a small one is a tap. */
  get travel(): number {
    return this.travelled;
  }

  /** Starts a gesture on an element placed at `from`. Only meaningful while no finger is down. */
  begin(from: Transform): void {
    this.transform = { ...from };
    this.travelled = 0;
    this.last = null;
  }

  /** A finger lands. A third one is ignored: two are all a pinch uses. */
  down(id: number, point: Point): void {
    if (this.pointers.size >= 2 && !this.pointers.has(id)) return;
    this.pointers.set(id, { ...point });
    this.last = reference([...this.pointers.values()]);
  }

  /** A finger moves; returns the element's new transform, or null for a finger it does not track. */
  move(id: number, point: Point): Transform | null {
    if (!this.pointers.has(id) || !this.last) return null;
    this.pointers.set(id, { ...point });
    const now = reference([...this.pointers.values()]);
    const { width, height } = this.stageSize();
    const dx = now.centroid.x - this.last.centroid.x;
    const dy = now.centroid.y - this.last.centroid.y;
    this.travelled += Math.hypot(dx, dy);
    const next = { ...this.transform };
    if (width > 0) next.x = clampCentre(next.x + dx / width);
    if (height > 0) next.y = clampCentre(next.y + dy / height);
    if (this.pointers.size === 2 && this.last.distance > 0 && now.distance > 0) {
      next.scale = clampScale(next.scale * (now.distance / this.last.distance));
      next.rotation += wrapAngle(now.angle - this.last.angle);
    }
    this.transform = next;
    this.last = now;
    return next;
  }

  /** A finger lifts; the remaining one (if any) carries on from where it is, without a jump. */
  up(id: number): void {
    if (!this.pointers.delete(id)) return;
    this.last = this.pointers.size > 0 ? reference([...this.pointers.values()]) : null;
  }

  /** The latest transform. */
  get current(): Transform {
    return this.transform;
  }

  /** The position of a tracked finger, for the drop-zone test at release. */
  position(id: number): Point | null {
    return this.pointers.get(id) ?? null;
  }
}
