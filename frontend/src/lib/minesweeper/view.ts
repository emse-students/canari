/**
 * Pure geometry of the Minesweeper viewport: where the board sits, how far it may be dragged, how a
 * flick keeps travelling. Kept out of the component so the numbers are testable without a DOM.
 *
 * None of this touches the engine: the view is presentation only, so the move log the server
 * replays is unaffected by any of it.
 */

/** Zoom bounds. The lower one is relaxed to the fit scale on a screen too small for it. */
export const MIN_SCALE = 0.4;
export const MAX_SCALE = 3;

/** Factor over the fit scale a double-tap zooms to, before clamping. */
export const DOUBLE_TAP_SCALE = 2;

/** Space reserved around the board for the floating controls. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Where the board's top-left corner sits in the viewport, and at what scale. */
export interface View {
  scale: number;
  panX: number;
  panY: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Lowest scale the player may zoom to: `MIN_SCALE`, or the fit scale when that is smaller. */
export function minScaleFor(fitScale: number): number {
  return Math.min(MIN_SCALE, fitScale);
}

/**
 * The whole board, as large as the padded viewport allows (up to `MAX_SCALE`), centred in the
 * padded area. Unlike the old fit this may SCALE UP past 1x, so a small board fills a big screen.
 */
export function fitView(viewport: Size, board: Size, insets: Insets): View {
  if (board.width <= 0 || board.height <= 0) return { scale: 1, panX: 0, panY: 0 };
  const availW = Math.max(1, viewport.width - insets.left - insets.right);
  const availH = Math.max(1, viewport.height - insets.top - insets.bottom);
  const scale = Math.min(availW / board.width, availH / board.height, MAX_SCALE);
  return {
    scale,
    panX: insets.left + (availW - board.width * scale) / 2,
    panY: insets.top + (availH - board.height * scale) / 2,
  };
}

/** One axis of {@link clampView}. A board smaller than the viewport is centred, a larger one may overshoot by `margin`. */
function clampAxis(pan: number, viewportLen: number, boardLen: number, margin: number): number {
  if (boardLen + 2 * margin <= viewportLen) return (viewportLen - boardLen) / 2;
  return Math.min(margin, Math.max(viewportLen - boardLen - margin, pan));
}

/**
 * Keeps the board reachable: it can never be dragged or zoomed out of the viewport, which is how a
 * player ends up staring at an empty screen with no zoom button left to bring it back.
 */
export function clampView(view: View, viewport: Size, board: Size, margin: number): View {
  return {
    scale: view.scale,
    panX: clampAxis(view.panX, viewport.width, board.width * view.scale, margin),
    panY: clampAxis(view.panY, viewport.height, board.height * view.scale, margin),
  };
}

/** Rescales around a viewport point so that point stays fixed on screen. */
export function zoomAt(
  view: View,
  sx: number,
  sy: number,
  nextScale: number,
  minScale: number
): View {
  const scale = Math.min(MAX_SCALE, Math.max(minScale, nextScale));
  const contentX = (sx - view.panX) / view.scale;
  const contentY = (sy - view.panY) / view.scale;
  return { scale, panX: sx - contentX * scale, panY: sy - contentY * scale };
}

/** One pointer position sampled at time `t` (ms), for {@link releaseVelocity}. */
export interface Sample {
  t: number;
  x: number;
  y: number;
}

/** Only the last stretch of a drag says how fast the finger left. */
const VELOCITY_WINDOW_MS = 100;
/** Below this speed (px/ms) a flick is a stop, not a glide. */
const MIN_FLICK_SPEED = 0.15;
/** Time constant (ms) of the glide: speed falls to 1/e of itself every `GLIDE_TAU_MS`. */
const GLIDE_TAU_MS = 325;
/** Speed (px/ms) under which the glide is over. */
const GLIDE_STOP_SPEED = 0.02;

/** Velocity (px/ms) of a drag at release, from samples recorded in time order; zero when it stopped before lifting. */
export function releaseVelocity(
  samples: readonly Sample[],
  now: number
): { vx: number; vy: number } {
  const recent = samples.filter((s) => now - s.t <= VELOCITY_WINDOW_MS);
  if (recent.length < 2) return { vx: 0, vy: 0 };
  const first = recent[0];
  const last = recent[recent.length - 1];
  const dt = last.t - first.t;
  if (dt <= 0) return { vx: 0, vy: 0 };
  const vx = (last.x - first.x) / dt;
  const vy = (last.y - first.y) / dt;
  return Math.hypot(vx, vy) < MIN_FLICK_SPEED ? { vx: 0, vy: 0 } : { vx, vy };
}

/** Advances a glide by `dtMs`: the displacement to apply, and the velocity left (zero once it is over). */
export function glideStep(
  vx: number,
  vy: number,
  dtMs: number
): { dx: number; dy: number; vx: number; vy: number } {
  const decay = Math.exp(-dtMs / GLIDE_TAU_MS);
  const nvx = vx * decay;
  const nvy = vy * decay;
  const over = Math.hypot(nvx, nvy) < GLIDE_STOP_SPEED;
  return { dx: vx * dtMs, dy: vy * dtMs, vx: over ? 0 : nvx, vy: over ? 0 : nvy };
}
